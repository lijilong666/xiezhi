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
import { renderEvidencePack } from './evidence.ts'
import { prepareEvidence, setActiveStore, type PreparedEvidence } from './evidence-tools.ts'
import { findCrossFileBreaks, renderCrossBreaks } from './crosschange.ts'
import { applySuppressions, renderSuppressionSection, type SuppressionRule } from './feedback.ts'
import { executeVerification, type ExecVerOutcome } from './execver.ts'
import { llmReviewPlan } from './hybrid-planner.ts'
import { buildInlineComments, fetchCompareSince, fetchPullRequest, ghFetch, isChangedLine, postReviewComment, renderIncrementalContext, renderPrContext, SKIP_PATTERN, type PrRef } from './github.ts'
import { fetchRepoContext, renderRepoContext } from './context.ts'
import { budgetEnforcement, isGrayZone, planReview, renderPlanSection, riskProfileFor, type RepoCalibration, type ReviewPlan } from './planner.ts'
import { PLANNER_ROUTE, ROLES, VERIFIER_ROUTE, type ModelRoute, type ReviewerRole } from './roles.ts'
import { ProviderBreaker } from './resilience.ts'
import { aggregateFindings, asFindingsOutput, compareFindings, FINDINGS_OUTPUT_SCHEMA, type AggregatedFinding, type Finding } from './schema.ts'
import { EMPTY_VERIFICATION_COUNTS, verifyFindings, type Candidate, type VerificationCounts } from './verify.ts'
import { addUsage, formatTokens, sumRunUsage, type UsageSummary } from './usage.ts'

/** Config consumed from the cordis.yml row; defaults live in the schema. */
export interface ReviewConfig {
  readonly adaptive: boolean
  readonly hybridPlanner: boolean
  readonly evidence: boolean
  readonly execver: boolean
  readonly verifier: boolean
  readonly batchSize: number
  readonly post: 'off' | 'comment'
  readonly maxFindings: number
  /** Repository-context mode: full changed-file contents at the PR head. */
  readonly repoContext: 'off' | 'changed'
  /** Per-role provider/model overrides keyed by role id; `verifier` names the gate. */
  readonly routes: readonly { id: string, provider: string, model: string }[]
  /** Per-repo scale baselines that widen the large/wide risk thresholds. */
  readonly repoCalibrations: readonly RepoCalibration[]
  /** Transparent feedback suppressions applied at the publishing boundary. */
  readonly suppressions: readonly SuppressionRule[]
  /** Consecutive provider failures before routes degrade to the fallback. */
  readonly circuitThreshold: number
  /** Cross-provider fallback route for degraded/retried spawns. */
  readonly fallbackRoute: ModelRoute
  /** Per-role wall-clock budget; a role that exceeds it is cancelled. */
  readonly roleTimeoutMs: number
}

/** Resolve one role's route: config override first, then the tier-aware role default. */
function resolveRoute(config: ReviewConfig, role: ReviewerRole, tier: ReviewPlan['modelTier']): ModelRoute | undefined {
  const tierDefault = tier === 'flash' && role.flashRoute !== undefined ? role.flashRoute : role.route
  return config.routes.find(route => route.id === role.id) ?? tierDefault
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
  route: ModelRoute | undefined,
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
    ...route !== undefined ? { agentOptions: { provider: route.provider, model: route.model } } : {},
  })
  try {
    const result = await run.result
    const usage = sumRunUsage(run)
    if (result.stopReason !== 'completed') {
      return { roleId: role.id, roleTitle: role.title, model: route?.model ?? 'inherited', findings: [], usage, error: result.stopReason }
    }
    const output = asFindingsOutput(result.structured)
    return { roleId: role.id, roleTitle: role.title, model: route?.model ?? 'inherited', findings: output?.findings ?? [], usage }
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
  readonly verificationCounts: VerificationCounts
  readonly verifierUsed: boolean
  readonly verifierModel: string
  readonly verifierUsage: UsageSummary
  readonly budgetExceeded: boolean
  readonly escalationEligible: boolean
}

function renderCostSection(roleOutcomes: readonly RoleOutcome[], stats: PipelineStats): string {
  const header = '| role | model | calls | input | output | cache read | cache write |'
  const rule = '|---|---|---|---|---|---|---|'
  const row = (label: string, model: string, usage: UsageSummary) =>
    `| ${label} | ${model} | ${usage.calls} | ${formatTokens(usage.inputTokens)} | ${formatTokens(usage.outputTokens)} | ${formatTokens(usage.cacheReadTokens)} | ${formatTokens(usage.cacheWriteTokens)} |`
  const roleRows = roleOutcomes.map(outcome => row(outcome.roleTitle, outcome.model, outcome.usage))
  const verifierRow = stats.verifierUsed
    ? [row('verifier', stats.verifierModel, stats.verifierUsage)]
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
  plan: ReviewPlan,
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
  if (stats.verifierUsed) {
    const counts = stats.verificationCounts
    lines.push(`Verification: ${counts.confirmed} confirmed, ${counts.plausible} plausible, ${counts.inconclusive} inconclusive, ${counts.rejected} rejected.`)
  }
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
      if (finding.evidencePack !== undefined) lines.push('', ...renderEvidencePack(finding.evidencePack))
    }
  } else {
    lines.push('', '## Findings', '', 'No findings survived the review.')
  }
  const actualTokens = roleOutcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), stats.verifierUsage)
  lines.push('', ...renderPlanSection(plan, actualTokens.inputTokens + actualTokens.outputTokens, stats.budgetExceeded))
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
export async function runReview(ctx: Context, parent: Agent, signal: AbortSignal, prRef: string, config: ReviewConfig, since?: string): Promise<string> {
  const { ref, data } = await fetchPullRequest(prRef, signal)
  let prContext = renderPrContext(ref, data)
  let incrementalNote = ''
  if (since !== undefined && since !== data.headSha && since !== data.baseSha) {
    const sinceFiles = await fetchCompareSince(ref, since, data.headSha, signal)
    if (sinceFiles === undefined) {
      incrementalNote = `incremental: cannot compare ${since.slice(0, 8)}...head — full review instead`
    } else if (sinceFiles.length === 0) {
      return `# xiezhi review: ${data.title}\n${data.htmlUrl}\n\nNo changes since ${since.slice(0, 8)}; nothing to review.\nPreviously posted inline comments may reference outdated code.`
    } else {
      prContext = renderIncrementalContext(ref, data, sinceFiles)
      incrementalNote = `incremental: reviewing ${sinceFiles.length} file(s) changed since ${since.slice(0, 8)}; prior inline comments may reference outdated code`
    }
  }
  if (config.repoContext === 'changed') {
    const repoContext = await fetchRepoContext(ghFetch, ref, data.headSha, data.files, SKIP_PATTERN, signal)
    const section = renderRepoContext(repoContext)
    if (section !== '') prContext = `${prContext}\n\n${section}`
  }

  let evidence: PreparedEvidence | undefined
  if (config.evidence) {
    evidence = await prepareEvidence(ref, data, signal, config.execver)
  }
  const crossBreaks = evidence?.store !== undefined ? findCrossFileBreaks(evidence.store, data.files) : []
  const extraSignals = crossBreaks.length > 0 ? ['cross-file-break'] : []
  const profile = riskProfileFor(data, config.repoCalibrations, extraSignals)
  let plan = planReview(data, config.adaptive, config.batchSize, config.repoCalibrations, extraSignals)
  let plannerUsageText = ''
  if (config.adaptive && config.hybridPlanner && isGrayZone(profile)) {
    const plannerRoute = config.routes.find(route => route.id === 'planner') ?? PLANNER_ROUTE
    try {
      const planned = await llmReviewPlan(ctx.subagents, parent, AbortSignal.any([signal, AbortSignal.timeout(60_000)]), profile, plan, plannerRoute)
      plan = planned.plan
      plannerUsageText = planned.plannerUsageText
    } catch (error) {
      plan = { ...plan, fallbackReason: `llm-planner-failed: ${String(error).slice(0, 120)}, rule plan kept` }
    }
  }
  const activeRoles = ROLES.filter(role => plan.selectedRoles.includes(role.id))

  setActiveStore(evidence?.store)
  try {

  const breaker = new ProviderBreaker({ threshold: config.circuitThreshold, fallback: config.fallbackRoute })
  const roleSignal = AbortSignal.any([signal, AbortSignal.timeout(config.roleTimeoutMs)])
  const zeroUsage: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const attemptRole = async (role: (typeof ROLES)[number], route: ModelRoute | undefined, tag: string): Promise<RoleOutcome> => {
    try {
      const outcome = await runRole(ctx.subagents, parent, role, route, prContext, roleSignal)
      breaker.record(route?.provider ?? 'inherited', outcome.error === undefined)
      return outcome
    } catch (error) {
      breaker.record(route?.provider ?? 'inherited', false)
      return { roleId: role.id, roleTitle: role.title, model: route?.model ?? 'inherited', findings: [], usage: zeroUsage, error: `${tag}: ${String(error).slice(0, 200)}` }
    }
  }
  const roleOutcomes = await Promise.all(activeRoles.map(async role => {
    const primary = resolveRoute(config, role, plan.modelTier)
    const initial = breaker.routeFor(primary)
    const first = await attemptRole(role, initial.route, initial.degraded ? 'spawn (degraded)' : 'spawn')
    if (first.error === undefined) return first
    const retry = breaker.retryRoute(initial.route)
    if (retry === undefined) return first
    const second = await attemptRole(role, retry, 'fallback retry')
    return second.error === undefined
      ? { ...second, model: `${first.model} -> ${retry.model}` }
      : { ...second, model: `${first.model} -> ${retry.model}`, error: `${first.error} | ${second.error}` }
  }))

  const candidates: Candidate[] = []
  roleOutcomes.forEach(outcome => {
    for (const finding of outcome.findings) {
      candidates.push({ index: candidates.length, role: outcome.roleId, finding })
    }
  })

  const roleSpent = roleOutcomes.reduce((sum, outcome) => addUsage(sum, outcome.usage), { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies UsageSummary)
  const enforcement = budgetEnforcement(plan, roleSpent.inputTokens + roleSpent.outputTokens)

  const verifierRoute = config.routes.find(route => route.id === 'verifier') ?? VERIFIER_ROUTE
  const evidenceEnabled = evidence?.store !== undefined
  const crossBreaksBlock = renderCrossBreaks(crossBreaks)
  const evidenceBlock = evidenceEnabled
    ? [evidence?.rulesBlock === '' ? '(no repository rule files found in snapshot)' : evidence?.rulesBlock, crossBreaksBlock === '' ? '' : `${crossBreaksBlock}`].filter(block => block !== '').join('\n\n')
    : undefined
  const execverActive = config.execver && evidence?.store !== undefined && evidence?.baseStore !== undefined
  const verified = config.verifier && candidates.length > 0
    ? await verifyFindings(ctx.subagents, parent, prContext, candidates, signal, enforcement.verifierBatchSize, verifierRoute, (path, line) => isChangedLine(data.files, path, line), enforcement.allowEscalation && plan.verificationDepth === 'light' && !execverActive, evidenceBlock)
    : {
        kept: candidates.map(candidate => ({ role: candidate.role, finding: candidate.finding })),
        droppedCount: 0,
        statusCounts: EMPTY_VERIFICATION_COUNTS,
        usage: { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        plausibleCandidates: [],
      }

  let execverOutcome: ExecVerOutcome | undefined
  if (execverActive && verified.plausibleCandidates.length > 0) {
    execverOutcome = await executeVerification(verified.plausibleCandidates, evidence!.store!, evidence!.baseStore!, signal)
  }
  let keptFindings = verified.kept
  let statusCounts = verified.statusCounts
  let droppedCount = verified.droppedCount
  if (execverOutcome !== undefined && execverOutcome.upgrades.length > 0) {
    keptFindings = [...keptFindings, ...execverOutcome.upgrades]
    statusCounts = { ...statusCounts, plausible: statusCounts.plausible - execverOutcome.upgrades.length, confirmed: statusCounts.confirmed + execverOutcome.upgrades.length }
    droppedCount = Math.max(0, droppedCount - execverOutcome.upgrades.length)
  }

  const { kept: publishable, suppressed } = applySuppressions(aggregateFindings(keptFindings), config.suppressions)
  const aggregated = publishable
    .slice(0, config.maxFindings)
    .sort(compareFindings)

  const stats: PipelineStats = {
    rolesCompleted: roleOutcomes.filter(outcome => outcome.error === undefined).length,
    rolesTotal: roleOutcomes.length,
    roleFailures: roleOutcomes
      .filter((outcome): outcome is RoleOutcome & { error: string } => outcome.error !== undefined)
      .map(outcome => ({ title: outcome.roleTitle, reason: outcome.error })),
    candidateCount: candidates.length,
    droppedCount,
    verificationCounts: statusCounts,
    verifierUsed: config.verifier,
    verifierModel: verifierRoute.model,
    verifierUsage: verified.usage,
    budgetExceeded: enforcement.exceeded,
    escalationEligible: enforcement.allowEscalation && plan.verificationDepth === 'light',
  }
  let report = renderReport(data.title, data.htmlUrl, aggregated, stats, roleOutcomes, plan)
  const suppressionLines = renderSuppressionSection(suppressed)
  if (suppressionLines.length > 0) {
    report = `${report}\n\n${suppressionLines.join('\n')}`
  }
  if (config.evidence) {
    const evidenceLines = evidence?.store !== undefined
      ? evidence.store.renderReportSection()
      : ['## Evidence', `- degraded: ${evidence?.degradedReason ?? 'unknown reason'} — diff-only verification`]
    report = `${report}\n\n${evidenceLines.join('\n')}`
  }
  if (execverOutcome !== undefined) {
    report = `${report}\n${execverOutcome.summary}`
  } else if (config.execver && !execverActive && evidence !== undefined) {
    report = `${report}\nexecver: skipped — ${evidence.baseStore === undefined ? 'base snapshot unavailable' : 'no plausible critical/major candidates'}`
  }
  if (crossBreaks.length > 0) {
    report = `${report}\ncross-change: ${crossBreaks.length} stale import(s) after removal/rename (signal cross-file-break)`
  }
  if (plannerUsageText !== '') {
    report = `${report}\n${plannerUsageText}`
  }
  const tripped = breaker.trippedProviders()
  if (tripped.length > 0) {
    report = `${report}\ncircuit breaker: provider(s) ${tripped.join(', ')} degraded to ${config.fallbackRoute.provider}/${config.fallbackRoute.model}`
  }
  if (incrementalNote !== '') {
    report = `${report}\n${incrementalNote}`
  }

  if (config.post === 'comment') {
    const { inline } = buildInlineComments(aggregated, data.files)
    const url = await postReviewComment(ref, report, inline, signal)
    report = `${report}\n\n---\nPosted as a review: ${url} (${inline.length} inline comments)`
  }
  return report
  } finally {
    setActiveStore(undefined)
    evidence?.store?.dispose()
    evidence?.baseStore?.dispose()
  }
}
