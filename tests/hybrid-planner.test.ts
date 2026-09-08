import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planFromLlmOutput, REVIEW_PLAN_OUTPUT_SCHEMA } from '../src/hybrid-planner.ts'
import { planReview, type ReviewPlan } from '../src/planner.ts'
import type { PrData, PrFile } from '../src/github.ts'

const RULE_PLAN: ReviewPlan = planReview(prData([file('src/auth/a.ts', 500, 60)]), true, 8)

function file(filename: string, additions = 10, deletions = 0): PrFile {
  return { filename, status: 'modified', additions, deletions, patch: '@@ -1,2 +1,3 @@\n+x' }
}

function prData(files: readonly PrFile[], skippedFileCount = 0): PrData {
  return { title: 't', body: '', htmlUrl: 'https://github.com/o/r/pull/1', headSha: 'h', baseSha: 'b', files, skippedFileCount }
}

test('valid high-confidence planner output maps to a rule-budgeted plan', () => {
  const plan = planFromLlmOutput({
    riskLevel: 'high', selectedRoles: ['bug-hunter', 'security'], modelTier: 'pro',
    verificationDepth: 'strict', confidence: 0.85, reasoning: 'auth change plus wide blast radius',
  }, RULE_PLAN)
  assert.equal(plan.riskLevel, 'high')
  assert.deepEqual(plan.selectedRoles, ['bug-hunter', 'security'])
  assert.equal(plan.tokenBudget, 320_000)
  assert.equal(plan.batchSize, 4)
  assert.ok(plan.fallbackReason?.startsWith('llm-planner (confidence 0.85)'))
})

test('planner cannot set budgets or invent roles: budgets derive from level, unknown roles are dropped', () => {
  const plan = planFromLlmOutput({
    riskLevel: 'low', selectedRoles: ['bug-hunter', 'made-up'], modelTier: 'flash',
    verificationDepth: 'light', confidence: 0.9, reasoning: 'small docs-ish change',
  }, RULE_PLAN)
  assert.deepEqual(plan.selectedRoles, ['bug-hunter'])
  assert.equal(plan.tokenBudget, 60_000)
  assert.equal(plan.batchSize, 16)
})

test('low-confidence or malformed output keeps the rule plan with a recorded reason', () => {
  const lowConfidence = planFromLlmOutput({
    riskLevel: 'high', selectedRoles: ['security'], modelTier: 'pro',
    verificationDepth: 'strict', confidence: 0.4, reasoning: 'unsure',
  }, RULE_PLAN)
  assert.equal(lowConfidence.riskLevel, RULE_PLAN.riskLevel)
  assert.ok(lowConfidence.fallbackReason?.includes('confidence 0.40'))
  const malformed = planFromLlmOutput({ nonsense: true }, RULE_PLAN)
  assert.equal(malformed.selectedRoles, RULE_PLAN.selectedRoles)
  assert.ok(malformed.fallbackReason?.includes('malformed'))
})

test('output schema enumerates exactly the whitelisted roles', () => {
  const roleEnum = (REVIEW_PLAN_OUTPUT_SCHEMA.properties as Record<string, { items?: { enum?: readonly string[] } }>).selectedRoles?.items?.enum
  assert.deepEqual(roleEnum, ['bug-hunter', 'security', 'nitpicker'])
})

test('cross-file-break signal merges into planning and lifts risk', () => {
  const files = [file('src/small.ts', 30, 5)]
  const plain = planReview(prData(files), true, 8)
  assert.equal(plain.riskLevel, 'low')
  const withBreak = planReview(prData(files), true, 8, [], ['cross-file-break'])
  assert.ok(withBreak.riskSignals.includes('cross-file-break'))
  assert.equal(withBreak.riskLevel, 'medium')
})
