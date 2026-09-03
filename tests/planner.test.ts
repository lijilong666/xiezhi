import { test } from 'node:test'
import assert from 'node:assert/strict'
import { detectPatchTruncation, fixedPlan, HARD_LIMITS, planReview, profileRisk, validatePlan, PLAN_VERSION, type ReviewPlan } from '../src/planner.ts'
import type { PrData, PrFile } from '../src/github.ts'

function file(filename: string, additions = 10, deletions = 0, patch = '@@ -1,2 +1,3 @@\n context\n+x'): PrFile {
  return { filename, status: 'modified', additions, deletions, patch }
}

function prData(files: readonly PrFile[], skippedFileCount = 0): PrData {
  return { title: 't', body: '', htmlUrl: 'https://example.com', headSha: 's', files, skippedFileCount }
}

function planOf(files: readonly PrFile[], skippedFileCount = 0): ReviewPlan {
  return planReview(prData(files, skippedFileCount), true, 8)
}

test('low risk: small single-file change plans one flash reviewer with light verification', () => {
  const plan = planOf([file('src/util.ts', 40, 2)])
  assert.equal(plan.riskLevel, 'low')
  assert.deepEqual(plan.selectedRoles, ['bug-hunter'])
  assert.equal(plan.modelTier, 'flash')
  assert.equal(plan.verificationDepth, 'light')
  assert.equal(plan.batchSize, 16)
  assert.equal(plan.tokenBudget, 60_000)
  assert.equal(plan.fallbackReason, undefined)
})

test('medium risk with sensitive path adds the security role (security floor)', () => {
  const plan = planOf([file('src/auth/session.ts', 60, 5)])
  assert.equal(plan.riskLevel, 'medium')
  assert.ok(plan.riskSignals.includes('sensitive-paths'))
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'security'])
  assert.equal(plan.modelTier, 'balanced')
  assert.equal(plan.verificationDepth, 'standard')
})

test('medium risk without targeted signals pairs bug-hunter with nitpicker', () => {
  const plan = planOf([file('src/big.ts', 380, 30)])
  assert.equal(plan.riskLevel, 'medium')
  assert.ok(plan.riskSignals.includes('large-change'))
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'nitpicker'])
})

test('high risk: sensitive + large change enables the full team, pro tier, strict verification', () => {
  const plan = planOf([file('src/oauth/token_store.ts', 300, 80), file('src/oauth/jwt.ts', 120, 30)])
  assert.equal(plan.riskLevel, 'high')
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'security', 'nitpicker'])
  assert.equal(plan.modelTier, 'pro')
  assert.equal(plan.verificationDepth, 'strict')
  assert.equal(plan.batchSize, 4)
  assert.equal(plan.tokenBudget, 320_000)
})

test('docs-only change routes to the lightweight nitpicker alone', () => {
  const plan = planOf([file('README.md', 30, 10), file('docs/guide.mdx', 20, 0)])
  assert.ok(plan.riskSignals.length === 0)
  assert.equal(plan.riskLevel, 'low')
  assert.deepEqual(plan.selectedRoles, ['nitpicker'])
  assert.equal(plan.modelTier, 'flash')
})

test('dependency and infra changes are detected and target the security role', () => {
  const plan = planOf([file('package.json', 8, 1), file('.github/workflows/ci.yml', 12, 4)])
  assert.ok(plan.riskSignals.includes('dependency-change'))
  assert.ok(plan.riskSignals.includes('infra-change'))
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'security'])
})

test('skipped files mark the patch as truncated and lift risk', () => {
  const plan = planOf([file('src/a.ts', 20, 0)], 7)
  assert.ok(plan.riskSignals.includes('patch-truncated'))
  assert.equal(plan.riskLevel, 'medium')
})

test('in-patch truncation marker is also detected', () => {
  const files = [file('src/a.ts', 20, 0, '@@ -1,1 +1,1 @@\n+x\n… (patch truncated)')]
  assert.equal(detectPatchTruncation(files, 0), true)
  assert.ok(profileRisk(prData(files)).patchTruncated)
})

test('boundary: 400 changed lines stays medium, 401 and 410 both count as large-change', () => {
  assert.ok(!planOf([file('src/a.ts', 400, 0)]).riskSignals.includes('large-change'))
  assert.ok(planOf([file('src/a.ts', 401, 0)]).riskSignals.includes('large-change'))
  assert.ok(planOf([file('src/a.ts', 205, 205)]).riskSignals.includes('large-change'))
})

test('boundary: 10 files stays low-risk width, 11 files is wide-change', () => {
  const ten = Array.from({ length: 10 }, (_, i) => file(`src/m${i}.ts`, 5, 0))
  const eleven = [...ten, file('src/m10.ts', 5, 0)]
  assert.ok(!planOf(ten).riskSignals.includes('wide-change'))
  assert.ok(planOf(eleven).riskSignals.includes('wide-change'))
})

test('thin-tests: code-heavy change without tests raises the signal', () => {
  const profile = profileRisk(prData([file('src/core.ts', 300, 40)]))
  assert.ok(profile.riskSignals.includes('thin-tests'))
  assert.equal(profile.testRatio, 0)
  const withTests = profileRisk(prData([file('src/core.ts', 300, 40), file('src/core.test.ts', 80, 0)]))
  assert.ok(!withTests.riskSignals.includes('thin-tests'))
})

test('adaptive off keeps the legacy fixed plan: full team, config batch size, no tier override', () => {
  const plan = planReview(prData([file('src/auth/a.ts', 500, 100)]), false, 11)
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'security', 'nitpicker'])
  assert.equal(plan.modelTier, 'balanced')
  assert.equal(plan.batchSize, 11)
  assert.equal(plan.fallbackReason, 'adaptive-off')
})

test('validatePlan drops unknown roles, dedupes, clamps budget and batch size', () => {
  const repaired = validatePlan({
    planVersion: PLAN_VERSION, riskLevel: 'medium', riskSignals: [],
    selectedRoles: ['security', 'made-up', 'security'],
    modelTier: 'balanced', tokenBudget: 99_999_999, verificationDepth: 'standard', batchSize: 0.5,
  })
  assert.deepEqual(repaired.selectedRoles, ['security'])
  assert.equal(repaired.tokenBudget, HARD_LIMITS.maxTokenBudget)
  assert.equal(repaired.batchSize, HARD_LIMITS.minBatchSize)
})

test('validatePlan falls back to the full team when no whitelisted role survives', () => {
  const repaired = validatePlan({
    planVersion: PLAN_VERSION, riskLevel: 'low', riskSignals: [],
    selectedRoles: [], modelTier: 'flash', tokenBudget: 1, verificationDepth: 'light', batchSize: 4,
  })
  assert.deepEqual(repaired.selectedRoles, ['bug-hunter', 'security', 'nitpicker'])
  assert.ok(repaired.fallbackReason?.startsWith('fallback:'))
})

test('planning is deterministic: identical input yields an identical plan', () => {
  const data = prData([file('src/auth/session.ts', 500, 60), file('package.json', 4, 4)], 2)
  assert.deepEqual(planReview(data, true, 8), planReview(data, true, 8))
})

test('empty file list plans the single main reviewer without throwing', () => {
  const plan = planOf([])
  assert.deepEqual(plan.selectedRoles, ['bug-hunter'])
  assert.equal(plan.riskLevel, 'low')
})

test('fixedPlan records its reason and never exceeds hard limits', () => {
  const plan = fixedPlan(8, 'adaptive-off')
  assert.equal(plan.fallbackReason, 'adaptive-off')
  assert.ok(plan.selectedRoles.length <= HARD_LIMITS.maxRoles)
  assert.ok(plan.tokenBudget <= HARD_LIMITS.maxTokenBudget)
})
