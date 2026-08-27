/**
 * Review pipeline: PR ingestion -> parallel role subagents -> verification
 * gate -> deterministic aggregation -> markdown report -> optional GitHub
 * posting. Each stage is an independent function so later stages slot in
 * without rework.
 * @module xiezhi/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { fetchPullRequest, postReviewComment, renderPrContext, type PrRef } from './github.ts'
import { ROLES } from './roles.ts'
import { aggregateFindings, asFindingsOutput, compareFindings, FINDINGS_OUTPUT_SCHEMA, type AggregatedFinding, type Finding } from './schema.ts'
import { verifyFindings, type Candidate } from './verify.ts'

/** Config consumed from the cordis.yml row; defaults live in the schema. */
export interface ReviewConfig {
  readonly verifier: boolean
  readonly batchSize: number
  readonly post: 'off' | 'comment'
  readonly maxFindings: number
}

interface RoleOutcome {
  readonly roleId: string
  readonly roleTitle: string
  readonly findings: readonly Finding[]
  readonly error?: string
}

function buildPrompt(roleTitle: string, instruction: string, prContext: string): ContentBlock[] {
  const text = [
    `You are the ${roleTitle} on a pull-request review team.`,
    `${instruction}`,
    'Report only findings provable from the diff below. Cite the new-file line number.',
    'If you find nothing, return an empty findings array. Do not pad with weak observations.',
    '',
    prContext,
  ].join('\n')
  return [{ type: 'text', text }]
}

/** Run one role as a tool-less spawn subagent with structured output. */
async function runRole(
  subagents: SubagentRuntime,
  parent: Agent,
  role: (typeof ROLES)[number],
  prContext: string,
  signal: AbortSignal,
): Promise<RoleOutcome> {
  const run = await subagents.start('spawn', {
    label: `xiezhi:${role.id}`,
    prompt: buildPrompt(role.title, role.instruction, prContext),
    parent,
    signal,
    outputSchema: FINDINGS_OUTPUT_SCHEMA,
    persona: role.persona,
    toolFilter: { allow: [] },
    ...role.model !== undefined ? { agentOptions: { model: role.model } } : {},
  })
  try {
    const result = await run.result
    if (result.stopReason !== 'completed') {
      return { roleId: role.id, roleTitle: role.title, findings: [], error: result.stopReason }
    }
    const output = asFindingsOutput(result.structured)
    return { roleId: role.id, roleTitle: role.title, findings: output?.findings ?? [] }
  } finally {
    await run.dispose()
  }
}

interface PipelineStats {
  readonly rolesCompleted: number
  readonly rolesTotal: number
  readonly roleFailures: readonly { title: string, reason: string }[]
  readonly candidateCount: number
  readonly droppedCount: number
  readonly verifierUsed: boolean
}

function renderReport(title: string, htmlUrl: string, findings: readonly AggregatedFinding[], stats: PipelineStats): string {
  const count = (severity: string) => findings.filter(finding => finding.severity === severity).length
  const lines: string[] = [
    `# xiezhi review: ${title}`,
    htmlUrl,
    '',
    `Roles: ${stats.rolesCompleted}/${stats.rolesTotal} completed. `
      + `Candidates: ${stats.candidateCount}; verifier dropped ${stats.droppedCount}${stats.verifierUsed ? '' : ' (verifier off)'}. `
      + `Findings: ${count('critical')} critical, ${count('major')} major, ${count('minor')} minor, ${count('info')} info.`,
  ]
  for (const failure of stats.roleFailures) {
    lines.push(`- role ${failure.title} ended early (${failure.reason}); its findings were dropped`)
  }
  if (findings.length > 0) {
    lines.push('', '## Findings')
    for (const finding of findings) {
      lines.push('', `### [${finding.severity}] ${finding.title} — \`${finding.file}:${finding.line}\``)
      lines.push(`category: ${finding.category} · via ${finding.roles.join(', ')}`)
      lines.push(finding.description)
      if (finding.suggestion !== undefined) lines.push(`> ${finding.suggestion}`)
    }
  } else {
    lines.push('', '## Findings', '', 'No findings survived the review.')
  }
  return lines.join('\n')
}

/**
 * Execute the full review pipeline and return the markdown report.
 * @param ctx - plugin context providing the subagent registry.
 * @param parent - the calling agent; reviewer subagents derive lineage from it.
 * @param signal - cancellation shared with the tool execution.
 * @param prRef - "owner/repo#123" or a github.com PR URL.
 * @param config - validated plugin config.
 * @returns the aggregated markdown review report.
 */
export async function runReview(ctx: Context, parent: Agent, signal: AbortSignal, prRef: string, config: ReviewConfig): Promise<string> {
  const { ref, data } = await fetchPullRequest(prRef, signal)
  const prContext = renderPrContext(ref, data)

  const roleOutcomes = await Promise.all(ROLES.map(async role => {
    try {
      return await runRole(ctx.subagents, parent, role, prContext, signal)
    } catch (error) {
      return { roleId: role.id, roleTitle: role.title, findings: [], error: String(error) }
    }
  }))

  const candidates: Candidate[] = []
  roleOutcomes.forEach((outcome, roleIdx) => {
    for (const finding of outcome.findings) {
      candidates.push({ index: candidates.length, role: ROLES[roleIdx]?.id ?? outcome.roleId, finding })
    }
  })

  const verified = config.verifier && candidates.length > 0
    ? await verifyFindings(ctx.subagents, parent, prContext, candidates, signal, config.batchSize)
    : { kept: candidates.map(candidate => ({ role: candidate.role, finding: candidate.finding })), droppedCount: 0 }

  const aggregated = aggregateFindings(verified.kept)
    .slice(0, config.maxFindings)
    .sort(compareFindings)

  const stats: PipelineStats = {
    rolesCompleted: roleOutcomes.filter(outcome => outcome.error === undefined).length,
    rolesTotal: roleOutcomes.length,
    roleFailures: roleOutcomes
      .filter((outcome): outcome is RoleOutcome & { error: string } => outcome.error !== undefined)
      .map(outcome => ({ title: outcome.roleTitle, reason: outcome.error })),
    candidateCount: candidates.length,
    droppedCount: verified.droppedCount,
    verifierUsed: config.verifier,
  }
  let report = renderReport(data.title, data.htmlUrl, aggregated, stats)

  if (config.post === 'comment') {
    const url = await postReviewComment(ref, report, signal)
    report = `${report}\n\n---\nPosted as a review: ${url}`
  }
  return report
}
