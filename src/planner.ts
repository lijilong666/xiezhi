/**
 * Adaptive review planning: deterministic Risk Profiler + rule-based Hybrid
 * Router producing an auditable ReviewPlan. Pure functions only — no model
 * calls, no I/O; the optional LLM planner stage (for uncertain cases) is a
 * future seam and the default path never depends on it. Invalid or disabled
 * plans fall back to the fixed three-role team.
 * @module xiezhi/planner
 */

import type { PrData, PrFile } from './github.ts'
import { ROLES } from './roles.ts'

export type RiskLevel = 'low' | 'medium' | 'high'
export type ModelTier = 'flash' | 'balanced' | 'pro'
export type VerificationDepth = 'light' | 'standard' | 'strict'

export const PLAN_VERSION = 1

/** Hard ceilings every plan is clamped to before execution. */
export const HARD_LIMITS = {
  maxRoles: 4,
  maxTokenBudget: 400_000,
  minBatchSize: 1,
  maxBatchSize: 32,
} as const

export interface RiskProfile {
  readonly changedLines: number
  readonly fileCount: number
  readonly languages: readonly string[]
  readonly testRatio: number
  readonly sensitivePaths: readonly string[]
  readonly dependencyChanges: readonly string[]
  readonly infraChanges: readonly string[]
  readonly patchTruncated: boolean
  readonly docsOnly: boolean
  readonly riskSignals: readonly string[]
  readonly score: number
}

export interface ReviewPlan {
  readonly planVersion: number
  readonly riskLevel: RiskLevel
  readonly riskSignals: readonly string[]
  readonly selectedRoles: readonly string[]
  readonly modelTier: ModelTier
  readonly tokenBudget: number
  readonly verificationDepth: VerificationDepth
  readonly batchSize: number
  readonly fallbackReason?: string
}

/** Per-repo scale calibration: shifts the large/wide thresholds relative to a
 * repository's historical median, so an ordinary PR in a big repo (keycloak)
 * is not always flagged while the same size elsewhere would be. */
export interface RepoCalibration {
  readonly repo: string
  readonly medianChangedLines?: number
  readonly medianFiles?: number
}

export interface BudgetEnforcement {
  readonly exceeded: boolean
  readonly verifierBatchSize: number
  readonly allowEscalation: boolean
}

const SENSITIVE_PATTERN = /(^|[/_.-])(auth|oauth|oidc|saml|jwt|session|token|credential|password|login|permission|rbac|acl|crypto|cipher|secret)([/_.-]|$)/i
const DEPENDENCY_PATTERN = /(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|pom\.xml|build\.gradle[^/]*|Cargo\.toml|Gemfile|composer\.json|pnpm-workspace\.yaml)$/
const INFRA_PATTERN = /(^|\/)(\.github\/workflows\/|Dockerfile|docker-compose[^/]*\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml|migrations?\/|db\/migrate\/|schema\.prisma)/i
const TEST_PATH_PATTERN = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[cm]?[jt]sx?$/i
const DOCS_PATTERN = /\.(mdx?|txt|rst|adoc)$/i
const TRUNCATION_MARKER = '(patch truncated)'

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.py': 'python', '.java': 'java', '.go': 'go', '.rb': 'ruby', '.rs': 'rust',
  '.cs': 'csharp', '.php': 'php', '.kt': 'kotlin', '.swift': 'swift',
}

const SIGNAL_WEIGHTS: Readonly<Record<string, number>> = {
  'sensitive-paths': 3,
  'dependency-change': 2,
  'infra-change': 2,
  'large-change': 2,
  'patch-truncated': 2,
  'cross-file-break': 2,
  'wide-change': 1,
  'thin-tests': 1,
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot === -1 ? '' : filename.slice(dot).toLowerCase()
}

/** Extract "owner/repo" from a PR html URL; empty string when unparseable. */
export function repoSlug(data: PrData): string {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/.exec(data.htmlUrl)
  return match === null ? '' : `${match[1]}/${match[2]}`
}

/** Effective scale thresholds: global floors widened by the repo's medians. */
export function effectiveThresholds(calibration?: RepoCalibration): { largeChange: number, wideChange: number } {
  return {
    largeChange: Math.max(400, Math.round((calibration?.medianChangedLines ?? 0) * 1.25)),
    wideChange: Math.max(10, Math.round((calibration?.medianFiles ?? 0) * 1.5)),
  }
}

/** True when the fetched view of the PR is provably incomplete. */
export function detectPatchTruncation(files: readonly PrFile[], skippedFileCount: number): boolean {
  if (skippedFileCount > 0) return true
  return files.some(file => (file.patch ?? '').includes(TRUNCATION_MARKER))
}

/**
 * Extract deterministic risk features from fetched PR data. Same input always
 * yields the same profile; every signal is checkable against the diff list.
 * @param data - fetched PR metadata and budgeted file list.
 * @param calibration - optional per-repo scale baselines from plan-only replay.
 * @returns the risk profile with weighted score and signal ids.
 */
export function profileRisk(data: PrData, calibration?: RepoCalibration): RiskProfile {
  const files = data.files
  const thresholds = effectiveThresholds(calibration)
  const changedLines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const languages = [...new Set(files.map(file => LANGUAGE_BY_EXTENSION[extensionOf(file.filename)] ?? 'other'))]
  const testFiles = files.filter(file => TEST_PATH_PATTERN.test(file.filename)).length
  const codeFiles = files.filter(file => LANGUAGE_BY_EXTENSION[extensionOf(file.filename)] !== undefined).length
  const testRatio = files.length === 0 ? 0 : testFiles / files.length
  const sensitivePaths = files.map(file => file.filename).filter(name => SENSITIVE_PATTERN.test(name))
  const dependencyChanges = files.map(file => file.filename).filter(name => DEPENDENCY_PATTERN.test(name))
  const infraChanges = files.map(file => file.filename).filter(name => INFRA_PATTERN.test(name))
  const patchTruncated = detectPatchTruncation(files, data.skippedFileCount)
  const docsOnly = files.length > 0 && files.every(file => DOCS_PATTERN.test(file.filename) && file.status !== 'removed')

  const riskSignals: string[] = []
  if (sensitivePaths.length > 0) riskSignals.push('sensitive-paths')
  if (dependencyChanges.length > 0) riskSignals.push('dependency-change')
  if (infraChanges.length > 0) riskSignals.push('infra-change')
  if (changedLines > thresholds.largeChange) riskSignals.push('large-change')
  if (files.length > thresholds.wideChange) riskSignals.push('wide-change')
  if (changedLines > 200 && codeFiles > 0 && testRatio < 0.1) riskSignals.push('thin-tests')
  if (patchTruncated) riskSignals.push('patch-truncated')

  const score = riskSignals.reduce((sum, signal) => sum + (SIGNAL_WEIGHTS[signal] ?? 0), 0)
  return {
    changedLines, fileCount: files.length, languages, testRatio,
    sensitivePaths, dependencyChanges, infraChanges, patchTruncated, docsOnly,
    riskSignals, score,
  }
}

/** The legacy behavior: every whitelisted role, standard depth, config batch size. */
export function fixedPlan(batchSize: number, fallbackReason?: string): ReviewPlan {
  return {
    planVersion: PLAN_VERSION,
    riskLevel: 'medium',
    riskSignals: [],
    selectedRoles: ROLES.map(role => role.id),
    modelTier: 'balanced',
    tokenBudget: HARD_LIMITS.maxTokenBudget,
    verificationDepth: 'standard',
    batchSize,
    fallbackReason,
  }
}

function teamFor(level: RiskLevel, profile: RiskProfile): readonly string[] {
  if (profile.docsOnly) return ['nitpicker']
  if (level === 'low') return ['bug-hunter']
  if (level === 'high') return ROLES.map(role => role.id)
  const targeted = profile.riskSignals.some(signal => signal === 'sensitive-paths' || signal === 'dependency-change' || signal === 'infra-change')
  return targeted ? ['bug-hunter', 'security'] : ['bug-hunter', 'nitpicker']
}

function levelFor(profile: RiskProfile): RiskLevel {
  if (profile.docsOnly) return 'low'
  if (profile.sensitivePaths.length > 0 && profile.score >= 5) return 'high'
  if (profile.score >= 5) return 'high'
  if (profile.sensitivePaths.length > 0 || profile.score >= 2) return 'medium'
  return 'low'
}

/** Gray zone: scores one step from the medium/high boundary, where an LLM
 * planner second opinion pays for itself; rules stay authoritative outside it. */
export function isGrayZone(profile: RiskProfile): boolean {
  return profile.score >= 4 && profile.score <= 6
}

/** Profile for planning, optionally merged with externally detected signals (e.g. cross-file breaks). */
export function riskProfileFor(data: PrData, calibrations: readonly RepoCalibration[] = [], extraSignals: readonly string[] = []): RiskProfile {
  const calibration = calibrations.find(entry => entry.repo === repoSlug(data))
  const profile = profileRisk(data, calibration)
  if (extraSignals.length === 0) return profile
  const merged = [...new Set([...profile.riskSignals, ...extraSignals])]
  const score = merged.reduce((sum, signal) => sum + (SIGNAL_WEIGHTS[signal] ?? 0), 0)
  return { ...profile, riskSignals: merged, score }
}

const TOKEN_BUDGET_BY_LEVEL: Readonly<Record<RiskLevel, number>> = { low: 60_000, medium: 160_000, high: 320_000 }
const BATCH_SIZE_BY_DEPTH: Readonly<Record<VerificationDepth, number>> = { light: 16, standard: 8, strict: 4 }
const TIER_BY_LEVEL: Readonly<Record<RiskLevel, ModelTier>> = { low: 'flash', medium: 'balanced', high: 'pro' }

/** Rule-derived budget/batch knobs for a level+depth pair; planners never set these directly. */
export function planKnobs(riskLevel: RiskLevel, depth: VerificationDepth): { tokenBudget: number, batchSize: number } {
  return { tokenBudget: TOKEN_BUDGET_BY_LEVEL[riskLevel], batchSize: BATCH_SIZE_BY_DEPTH[depth] }
}

/**
 * Repair an arbitrary plan against the static whitelist and hard limits;
 * anything unfixable degrades to the fixed full team with a recorded reason.
 * @param plan - candidate plan (may come from a future LLM planner).
 * @returns a plan guaranteed executable by the current pipeline.
 */
export function validatePlan(plan: ReviewPlan): ReviewPlan {
  const whitelist = new Set(ROLES.map(role => role.id))
  const selectedRoles = [...new Set(plan.selectedRoles.filter(id => whitelist.has(id)))]
  if (selectedRoles.length === 0) return fixedPlan(BATCH_SIZE_BY_DEPTH.standard, `fallback: no whitelisted role in plan (${plan.selectedRoles.join(', ') || 'empty'})`)
  const trimmed = selectedRoles.slice(0, HARD_LIMITS.maxRoles)
  const reason = trimmed.length < selectedRoles.length ? `fallback: role count clamped to ${HARD_LIMITS.maxRoles}` : plan.fallbackReason
  return {
    ...plan,
    selectedRoles: trimmed,
    tokenBudget: Math.min(plan.tokenBudget, HARD_LIMITS.maxTokenBudget),
    batchSize: Math.min(Math.max(Math.trunc(plan.batchSize), HARD_LIMITS.minBatchSize), HARD_LIMITS.maxBatchSize),
    fallbackReason: reason,
  }
}

/**
 * Decide runtime budget enforcement from tokens already spent by the role
 * stage: once the plan budget is exceeded, verification batches coarsen
 * (fewer, larger calls) and the escalation pass is skipped.
 * @param plan - the plan being executed.
 * @param spentTokens - input+output tokens consumed by the role stage.
 * @returns enforcement decisions applied to the verification stage.
 */
export function budgetEnforcement(plan: ReviewPlan, spentTokens: number): BudgetEnforcement {
  const exceeded = spentTokens > plan.tokenBudget
  return {
    exceeded,
    verifierBatchSize: exceeded ? Math.min(HARD_LIMITS.maxBatchSize, plan.batchSize * 2) : plan.batchSize,
    allowEscalation: !exceeded,
  }
}

/**
 * Plan a review: profile risk, route by rules, then validate. With adaptive
 * routing off this returns the fixed plan and behavior matches the legacy
 * three-role pipeline exactly.
 * @param data - fetched PR metadata and budgeted file list.
 * @param adaptive - whether rule-based adaptive routing is enabled.
 * @param configBatchSize - configured verifier batch size (legacy knob).
 * @param calibrations - optional per-repo scale baselines.
 * @param extraSignals - externally detected signals merged into the profile (e.g. cross-file-break).
 * @returns an executable, auditable ReviewPlan.
 */
export function planReview(data: PrData, adaptive: boolean, configBatchSize: number, calibrations: readonly RepoCalibration[] = [], extraSignals: readonly string[] = []): ReviewPlan {
  if (!adaptive) return fixedPlan(configBatchSize, 'adaptive-off')
  const profile = riskProfileFor(data, calibrations, extraSignals)
  const riskLevel = levelFor(profile)
  const plan: ReviewPlan = {
    planVersion: PLAN_VERSION,
    riskLevel,
    riskSignals: profile.riskSignals,
    selectedRoles: teamFor(riskLevel, profile),
    modelTier: TIER_BY_LEVEL[riskLevel],
    tokenBudget: TOKEN_BUDGET_BY_LEVEL[riskLevel],
    verificationDepth: riskLevel === 'low' ? 'light' : riskLevel === 'high' ? 'strict' : 'standard',
    batchSize: BATCH_SIZE_BY_DEPTH[riskLevel === 'low' ? 'light' : riskLevel === 'high' ? 'strict' : 'standard'],
  }
  return validatePlan(plan)
}

/** Render the plan as an auditable report section (why these roles/models/budget). */
export function renderPlanSection(plan: ReviewPlan, actualTokens: number, budgetExceeded = false): readonly string[] {
  const budgetUse = plan.tokenBudget > 0 ? Math.round(actualTokens / plan.tokenBudget * 100) : 0
  return [
    '## Review Plan',
    `- plan v${plan.planVersion} · risk ${plan.riskLevel} (score signals: ${plan.riskSignals.length > 0 ? plan.riskSignals.join(', ') : 'none'})`,
    `- team: ${plan.selectedRoles.join(', ')} · tier ${plan.modelTier} · verification ${plan.verificationDepth} (batch ${plan.batchSize})`,
    `- token budget ${plan.tokenBudget.toLocaleString('en-US')} — actual ${actualTokens.toLocaleString('en-US')} (${budgetUse}%)`,
    ...(budgetExceeded ? ['- budget exceeded before verification: batches coarsened, escalation pass skipped'] : []),
    ...(plan.fallbackReason !== undefined ? [`- ${plan.fallbackReason}`] : []),
  ]
}
