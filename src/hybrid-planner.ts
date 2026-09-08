/**
 * Hybrid planner: a single cheap structured flash call that re-decides the
 * review plan only for gray-zone PRs (score near the medium/high boundary).
 * Its output is untrusted — every field is constrained to the static
 * whitelist, budgets/batch sizes are re-derived by rule, and the result goes
 * through validatePlan. Any failure, timeout, or low confidence keeps the
 * rule plan untouched with a recorded fallbackReason.
 * @module xiezhi/hybrid-planner
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'
import { validatePlan, planKnobs, type ModelTier, type ReviewPlan, type RiskLevel, type VerificationDepth } from './planner.ts'
import { ROLES, type ModelRoute } from './roles.ts'
import { sumRunUsage } from './usage.ts'

export const REVIEW_PLAN_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
    selectedRoles: { type: 'array', items: { type: 'string', enum: [...ROLES.map(role => role.id)] } },
    modelTier: { type: 'string', enum: ['flash', 'balanced', 'pro'] },
    verificationDepth: { type: 'string', enum: ['light', 'standard', 'strict'] },
    confidence: { type: 'number', description: '0-1 self-assessed confidence in this plan' },
    reasoning: { type: 'string', description: 'One sentence on why this plan fits the PR' },
  },
  required: ['riskLevel', 'selectedRoles', 'modelTier', 'verificationDepth', 'confidence', 'reasoning'],
}

const PLANNER_PERSONA = 'You are the review planner of a code review team: you size pull requests and pick the smallest review team that covers their real risk.'

const MIN_CONFIDENCE = 0.6

interface PlannerOutput {
  readonly riskLevel: RiskLevel
  readonly selectedRoles: readonly string[]
  readonly modelTier: ModelTier
  readonly verificationDepth: VerificationDepth
  readonly confidence: number
  readonly reasoning: string
}

function asPlannerOutput(value: unknown): PlannerOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Partial<PlannerOutput>
  if (typeof raw.riskLevel !== 'string' || typeof raw.modelTier !== 'string' || typeof raw.verificationDepth !== 'string') return undefined
  if (!Array.isArray(raw.selectedRoles)) return undefined
  if (typeof raw.confidence !== 'number' || typeof raw.reasoning !== 'string') return undefined
  return raw as PlannerOutput
}

/**
 * Map untrusted planner output onto an executable plan: budgets and batch
 * sizes come from rules (never the model), the role list is whitelisted via
 * validatePlan, and low confidence or malformed output returns the rule plan.
 * @param output - structured model output (untrusted).
 * @param rulePlan - the deterministic plan to keep on any doubt.
 * @returns an executable ReviewPlan.
 */
export function planFromLlmOutput(output: unknown, rulePlan: ReviewPlan): ReviewPlan {
  const parsed = asPlannerOutput(output)
  if (parsed === undefined) return { ...rulePlan, fallbackReason: 'llm-planner-failed: malformed output, rule plan kept' }
  if (parsed.confidence < MIN_CONFIDENCE) return { ...rulePlan, fallbackReason: `llm-planner-fallback: confidence ${parsed.confidence.toFixed(2)} < ${MIN_CONFIDENCE}, rule plan kept` }
  const knobs = planKnobs(parsed.riskLevel, parsed.verificationDepth)
  return validatePlan({
    planVersion: rulePlan.planVersion,
    riskLevel: parsed.riskLevel,
    riskSignals: rulePlan.riskSignals,
    selectedRoles: parsed.selectedRoles,
    modelTier: parsed.modelTier,
    tokenBudget: knobs.tokenBudget,
    verificationDepth: parsed.verificationDepth,
    batchSize: knobs.batchSize,
    fallbackReason: `llm-planner (confidence ${parsed.confidence.toFixed(2)}): ${parsed.reasoning.slice(0, 160)}`,
  })
}

function buildPlannerPrompt(profile: { readonly changedLines: number, readonly fileCount: number, readonly testRatio: number, readonly riskSignals: readonly string[], readonly docsOnly: boolean }, rulePlan: ReviewPlan): ContentBlock[] {
  const text = [
    'Size this pull request for a review team. The rule-based router provisionally planned:',
    `risk ${rulePlan.riskLevel}, team ${rulePlan.selectedRoles.join('/') || 'none'}, tier ${rulePlan.modelTier}, verification ${rulePlan.verificationDepth}.`,
    'Deterministic profile:',
    `- changed lines: ${profile.changedLines}, files: ${profile.fileCount}, test ratio: ${(profile.testRatio * 100).toFixed(0)}%`,
    `- signals: ${profile.riskSignals.length > 0 ? profile.riskSignals.join(', ') : 'none'}`,
    profile.docsOnly ? '- all changed files are documentation' : '',
    '',
    'You may keep or adjust the plan. Rules you cannot break:',
    `- roles only from: ${ROLES.map(role => role.id).join(', ')} (1 role for low risk, 2 targeted for medium, all for high)`,
    '- sensitive-paths, dependency-change or infra-change signals require the security role;',
    '- documentation-only changes never need more than the nitpicker;',
    '- prefer the cheaper option when genuinely unsure.',
    'Answer with the structured plan only.',
  ].filter(line => line !== '').join('\n')
  return [{ type: 'text', text }]
}

/**
 * Run the gray-zone LLM planner as one tool-less structured spawn.
 * @param subagents - dsh subagent runtime.
 * @param parent - calling agent for lineage.
 * @param signal - cancellation shared with the review.
 * @param profile - deterministic risk profile of the PR.
 * @param rulePlan - the deterministic plan (kept on any failure).
 * @param route - provider/model for the planner call.
 * @returns the final plan, plus planner token usage.
 */
export async function llmReviewPlan(
  subagents: SubagentRuntime,
  parent: Agent,
  signal: AbortSignal,
  profile: Parameters<typeof buildPlannerPrompt>[0],
  rulePlan: ReviewPlan,
  route: ModelRoute,
): Promise<{ plan: ReviewPlan, plannerUsageText: string }> {
  const run = await subagents.start('spawn', {
    label: 'xiezhi:planner',
    prompt: buildPlannerPrompt(profile, rulePlan),
    parent,
    signal,
    outputSchema: REVIEW_PLAN_OUTPUT_SCHEMA,
    persona: PLANNER_PERSONA,
    toolFilter: { allow: [] },
    agentOptions: { provider: route.provider, model: route.model },
  })
  try {
    const result = await run.result
    const usage = sumRunUsage(run)
    const plannerUsageText = `planner tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`
    if (result.stopReason !== 'completed') return { plan: { ...rulePlan, fallbackReason: `llm-planner-failed: ${result.stopReason}, rule plan kept` }, plannerUsageText }
    return { plan: planFromLlmOutput(result.structured, rulePlan), plannerUsageText }
  } finally {
    await run.dispose()
  }
}
