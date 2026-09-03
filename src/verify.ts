/**
 * Verification gate: one or more verifier subagents re-check every candidate
 * finding against the diff and drop the ones not concretely provable. This
 * stage is the product's false-positive moat; candidates without a verdict
 * default to dropped.
 * @module xiezhi/verify
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { isPublishableVerdict, type ChecklistVerdict, type DiffAnchorValidator, type EvidenceBackedFinding, type VerificationStatus } from './evidence.ts'
import type { ModelRoute } from './roles.ts'
import type { Finding } from './schema.ts'
import { addUsage, sumRunUsage, type UsageSummary } from './usage.ts'

export interface Candidate {
  readonly index: number
  readonly role: string
  readonly finding: Finding
}

export interface VerifiedFinding {
  readonly role: string
  readonly finding: EvidenceBackedFinding
}

export type VerificationCounts = Readonly<Record<VerificationStatus, number>>

export const EMPTY_VERIFICATION_COUNTS: VerificationCounts = {
  confirmed: 0,
  plausible: 0,
  inconclusive: 0,
  rejected: 0,
}

interface AppliedVerdicts {
  readonly kept: readonly VerifiedFinding[]
  readonly droppedCount: number
  readonly statusCounts: VerificationCounts
}

export interface VerifyOutcome {
  readonly kept: readonly VerifiedFinding[]
  readonly droppedCount: number
  readonly statusCounts: VerificationCounts
  readonly usage: UsageSummary
}

const VERDICT_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer', description: 'Candidate index this verdict refers to' },
          status: { type: 'string', enum: ['confirmed', 'plausible', 'inconclusive', 'rejected'], description: 'Conclusion-first verification status' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'], description: 'Corrected severity, when the candidate over- or under-states it' },
          claim: { type: 'string', description: 'Concise defect claim supported by the evidence' },
          trigger: { type: 'string', description: 'Concrete input, state, or execution path that triggers the issue' },
          impact: { type: 'string', description: 'Observable incorrect behavior or security consequence' },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                kind: { type: 'string', enum: ['diff', 'intent', 'repository', 'static', 'test'] },
                path: { type: 'string', description: 'Repository-relative file path when applicable' },
                line: { type: 'integer', description: 'New-file line number when applicable' },
                detail: { type: 'string', description: 'What this evidence proves' },
              },
              required: ['kind', 'detail'],
            },
          },
          checklist: {
            type: 'object',
            additionalProperties: false,
            properties: {
              locationAnchored: { type: 'boolean', description: 'The cited location is a changed line that supports the claim' },
              triggerExplained: { type: 'boolean', description: 'A concrete trigger is stated without speculation' },
              impactExplained: { type: 'boolean', description: 'An observable impact is stated' },
              evidenceSufficient: { type: 'boolean', description: 'The visible evidence proves the claim without hidden assumptions' },
            },
            required: ['locationAnchored', 'triggerExplained', 'impactExplained', 'evidenceSufficient'],
          },
          reason: { type: 'string', description: 'One sentence explaining the status decision' },
        },
        required: ['index', 'status', 'claim', 'trigger', 'impact', 'evidence', 'checklist', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const VERIFIER_PERSONA = 'You are the verification gate of a code review team: strict, evidence-driven, and biased toward dropping unproven claims.'

const MAX_VERIFY_CANDIDATES = 48

function buildBatchPrompt(batch: readonly Candidate[], prContext: string): ContentBlock[] {
  const listing = batch.map(candidate => {
    const f = candidate.finding
    const fields = [
      `- index: ${candidate.index}`,
      `  role: ${candidate.role}`,
      `  location: ${f.file}:${f.line}`,
      `  claimed severity: ${f.severity} (${f.category})`,
      `  title: ${f.title}`,
      `  description: ${f.description}`,
    ]
    if (f.suggestion !== undefined) fields.push(`  suggestion: ${f.suggestion}`)
    return fields.join('\n')
  }).join('\n')
  const text = [
    'Candidate review findings are listed below, each with an index. For EVERY index output one verdict.',
    'For every candidate, build an Evidence Pack and choose a conclusion-first status:',
    '- confirmed: the visible diff directly proves the trigger and impact; every checklist item is true;',
    '- plausible: the claim is credible but depends on code or behavior not visible here;',
    '- inconclusive: the available evidence cannot decide the claim;',
    '- rejected: the shown code contradicts the claim or it is merely stylistic.',
    'Only confirmed findings are publishable. A confirmed verdict MUST cite at least one exact diff path and new-file line.',
    'Set each checklist item independently. Never mark evidence sufficient based on the candidate wording alone.',
    'Use intent or repository evidence only when it is actually present in the supplied context; never invent tool results.',
    'Do not confirm a finding when any of these holds:',
    '- it is speculative ("might", "could", "consider verifying") rather than demonstrable;',
    '- the cited behavior depends on code not visible in the diff;',
    '- it misreads the shown code, or the line it cites does not support the claim;',
    '- it is a matter of taste or style, not a defect.',
    'Use the optional severity field only to correct an obviously wrong claimed severity.',
    '',
    '## Candidates',
    listing,
    '',
    prContext,
  ].join('\n')
  return [{ type: 'text', text }]
}

function asVerdictsOutput(value: unknown): readonly ChecklistVerdict[] {
  if (typeof value !== 'object' || value === null) return []
  const verdicts = (value as { verdicts?: unknown }).verdicts
  return Array.isArray(verdicts) ? verdicts as readonly ChecklistVerdict[] : []
}

/** Apply checklist verdicts with fail-closed handling for missing or malformed confirmations. */
export function applyChecklistVerdicts(
  candidates: readonly Candidate[],
  verdicts: readonly ChecklistVerdict[],
  isChangedLine: DiffAnchorValidator,
  droppedByCap = 0,
): AppliedVerdicts {
  const byIndex = new Map(verdicts.map(verdict => [verdict.index, verdict]))
  const kept: VerifiedFinding[] = []
  let dropped = droppedByCap
  const counts: Record<VerificationStatus, number> = { ...EMPTY_VERIFICATION_COUNTS, inconclusive: droppedByCap }
  for (const candidate of candidates) {
    const verdict = byIndex.get(candidate.index)
    if (verdict === undefined) {
      counts.inconclusive++
      dropped++
      continue
    }
    if (!isPublishableVerdict(verdict, candidate.finding, isChangedLine)) {
      counts[verdict.status === 'confirmed' ? 'inconclusive' : verdict.status]++
      dropped++
      continue
    }
    counts.confirmed++
    kept.push({
      role: candidate.role,
      finding: {
        ...candidate.finding,
        ...(verdict.severity === undefined ? {} : { severity: verdict.severity }),
        evidencePack: {
          status: verdict.status,
          claim: verdict.claim,
          trigger: verdict.trigger,
          impact: verdict.impact,
          evidence: verdict.evidence,
          checklist: verdict.checklist,
          reason: verdict.reason,
        },
      },
    })
  }
  return { kept, droppedCount: dropped, statusCounts: counts }
}

/** Verify candidates in parallel batches; unresolved indices are dropped. */
export async function verifyFindings(
  subagents: SubagentRuntime,
  parent: Agent,
  prContext: string,
  candidates: readonly Candidate[],
  signal: AbortSignal,
  batchSize: number,
  route: ModelRoute,
  isChangedLine: DiffAnchorValidator,
): Promise<VerifyOutcome> {
  if (candidates.length === 0) return { kept: [], droppedCount: 0, statusCounts: EMPTY_VERIFICATION_COUNTS, usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
  const capped = candidates.slice(0, MAX_VERIFY_CANDIDATES)
  const droppedByCap = candidates.length - capped.length
  const batches: Candidate[][] = []
  for (let start = 0; start < capped.length; start += batchSize) {
    batches.push(capped.slice(start, start + batchSize))
  }

  const outcomes = await Promise.all(batches.map(async batch => {
    const run = await subagents.start('spawn', {
      label: `xiezhi:verify:${batch[0]?.index ?? 0}`,
      prompt: buildBatchPrompt(batch, prContext),
      parent,
      signal,
      outputSchema: VERDICT_OUTPUT_SCHEMA,
      persona: VERIFIER_PERSONA,
      toolFilter: { allow: [] },
      agentOptions: { provider: route.provider, model: route.model },
    })
    try {
      const result = await run.result
      const usage = sumRunUsage(run)
      if (result.stopReason !== 'completed') return { verdicts: [] as readonly ChecklistVerdict[], usage }
      return { verdicts: asVerdictsOutput(result.structured), usage }
    } finally {
      await run.dispose()
    }
  }))

  const usage = outcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies UsageSummary)
  const applied = applyChecklistVerdicts(capped, outcomes.flatMap(outcome => outcome.verdicts), isChangedLine, droppedByCap)
  return { ...applied, usage }
}
