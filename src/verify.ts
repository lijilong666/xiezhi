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
import { VERIFIER_ROUTE } from './roles.ts'
import type { Finding, Severity } from './schema.ts'
import { addUsage, sumRunUsage, type UsageSummary } from './usage.ts'

export interface Candidate {
  readonly index: number
  readonly role: string
  readonly finding: Finding
}

export interface VerifiedFinding {
  readonly role: string
  readonly finding: Finding
}

export interface VerifyOutcome {
  readonly kept: readonly VerifiedFinding[]
  readonly droppedCount: number
  readonly usage: UsageSummary
}

interface Verdict {
  readonly index: number
  readonly keep: boolean
  readonly severity?: Severity
  readonly reason: string
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
          keep: { type: 'boolean', description: 'True only when the diff concretely proves the issue' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'], description: 'Corrected severity, when the candidate over- or under-states it' },
          reason: { type: 'string', description: 'One sentence: the evidence line, or why it is dropped' },
        },
        required: ['index', 'keep', 'reason'],
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
    'KEEP a finding only when the diff itself concretely demonstrates the problem at or near the cited line:',
    'you can point at the exact changed line(s) that make it real.',
    'DROP it when any of these holds:',
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

function asVerdictsOutput(value: unknown): readonly Verdict[] {
  if (typeof value !== 'object' || value === null) return []
  const verdicts = (value as { verdicts?: unknown }).verdicts
  return Array.isArray(verdicts) ? verdicts as readonly Verdict[] : []
}

/** Verify candidates in parallel batches; unresolved indices are dropped. */
export async function verifyFindings(
  subagents: SubagentRuntime,
  parent: Agent,
  prContext: string,
  candidates: readonly Candidate[],
  signal: AbortSignal,
  batchSize: number,
): Promise<VerifyOutcome> {
  if (candidates.length === 0) return { kept: [], droppedCount: 0, usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
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
      agentOptions: { provider: VERIFIER_ROUTE.provider, model: VERIFIER_ROUTE.model },
    })
    try {
      const result = await run.result
      const usage = sumRunUsage(run)
      if (result.stopReason !== 'completed') return { verdicts: [] as readonly Verdict[], usage }
      return { verdicts: asVerdictsOutput(result.structured), usage }
    } finally {
      await run.dispose()
    }
  }))

  const byIndex = new Map<number, Verdict>()
  const usage = outcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies UsageSummary)
  for (const outcome of outcomes) {
    for (const verdict of outcome.verdicts) byIndex.set(verdict.index, verdict)
  }

  const kept: VerifiedFinding[] = []
  let dropped = droppedByCap
  for (const candidate of capped) {
    const verdict = byIndex.get(candidate.index)
    if (verdict === undefined || !verdict.keep) { dropped++; continue }
    kept.push({
      role: candidate.role,
      finding: verdict.severity === undefined
        ? candidate.finding
        : { ...candidate.finding, severity: verdict.severity },
    })
  }
  return { kept, droppedCount: dropped, usage }
}
