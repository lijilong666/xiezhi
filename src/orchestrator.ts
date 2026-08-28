/**
 * Review pipeline: PR ingestion -> parallel role subagents -> verification
 * gate -> deterministic aggregation -> markdown report (with cost table) ->
 * optional GitHub posting with inline line comments. Each stage is an
 * independent function so later stages slot in without rework.
 * @module xiezhi/orchestrator
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { buildInlineComments, fetchPullRequest, postReviewComment, renderPrContext, type PrRef } from './github.ts'
import { ROLES, VERIFIER_ROUTE } from './roles.ts'
import { aggregateFindings, asFindingsOutput, compareFindings, FINDINGS_OUTPUT_SCHEMA, type AggregatedFinding, type Finding } from './schema.ts'
import { verifyFindings, type Candidate } from './verify.ts'
import { addUsage, formatTokens, sumRunUsage, type UsageSummary } from './usage.ts'

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
  readonly model: string
  readonly findings: readonly Finding[]
  readonly usage: UsageSummary
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
    ...role.route !== undefined ? { agentOptions: { provider: role.route.provider, model: role.route.model } } : {},
  })
  try {
    const result = await run.result
    const usage = sumRunUsage(run)
    if (result.stopReason !== 'completed') {
      return { roleId: role.id, roleTitle: role.title, model: role.route?.model ?? 'inherited', findings: [], usage, error: result.stopReason }
    }
    const output = asFindingsOutput(result.structured)
    return { roleId: role.id, roleTitle: role.title, model: role.route?.model ?? 'inherited', findings: output?.findings ?? [], usage }
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
  readonly verifierUsage: UsageSummary
}

function renderCostSection(roleOutcomes: readonly RoleOutcome[], stats: PipelineStats): string {
  const header = '| role | model | calls | input | output | cache read | cache write |'
  const rule = '|---|---|---|---|---|---|---|'
  const row = (label: string, model: string, usage: UsageSummary) =>
    `| ${label} | ${model} | ${usage.calls} | ${formatTokens(usage.inputTokens)} | ${formatTokens(usage.outputTokens)} | ${formatTokens(usage.cacheReadTokens)} | ${formatTokens(usage.cacheWriteTokens)} |`
  const roleRows = roleOutcomes.map(outcome => row(outcome.roleTitle, outcome.model, outcome.usage))
  const verifierRow = stats.verifierUsed
    ? [row('verifier', VERIFIER_ROUTE.model, stats.verifierUsage)]
    : []
  const total = roleOutcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), stats.verifierUsage)
  const totalRow = `| **total** | — | ${total.calls} | ${formatTokens(total.inputTokens)} | ${formatTokens(total.outputTokens)} | ${formatTokens(total.cacheReadTokens)} | ${formatTokens(total.cacheWriteTokens)} |`
  return ['## Cost', '', header, rule, ...roleRows, ...verifierRow, totalRow].join('\n')
}

function renderReport(
  title: string,
  htmlUrl: string,
  findings: readonly AggregatedFinding[],
  stats: PipelineStats,
  roleOutcomes: readonly RoleOutcome[],
): string {
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
  lines.push('', renderCostSection(roleOutcomes, stats))
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
      return {
        roleId: role.id,
        roleTitle: role.title,
        model: role.route?.model ?? 'inherited',
        findings: [],
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        error: String(error),
      }
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
    : {
        kept: candidates.map(candidate => ({ role: candidate.role, finding: candidate.finding })),
        droppedCount: 0,
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }

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
    verifierUsage: verified.usage,
  }
  let report = renderReport(data.title, data.htmlUrl, aggregated, stats, roleOutcomes)

  if (config.post === 'comment') {
    const { inline } = buildInlineComments(aggregated, data.files)
    const url = await postReviewComment(ref, report, inline, signal)
    report = `${report}\n\n---\nPosted as a review: ${url} (${inline.length} inline comments)`
  }
  return report
}
