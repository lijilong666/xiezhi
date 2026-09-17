import { test } from 'node:test'
import assert from 'node:assert/strict'
import { asVerdictsOutput, escalationCandidates } from '../src/verify.ts'
import type { ChecklistVerdict } from '../src/evidence.ts'
import type { Candidate } from '../src/verify.ts'
import type { Finding } from '../src/schema.ts'

function finding(severity: Finding['severity']): Finding {
  return { severity, category: 'logic', title: 't', description: 'd', file: 'src/a.ts', line: 3 }
}

function candidate(index: number, severity: Finding['severity']): Candidate {
  return { index, role: 'bug-hunter', finding: finding(severity) }
}

function verdict(index: number, status: ChecklistVerdict['status']): ChecklistVerdict {
  return { index, status, claim: 'c', trigger: 't', impact: 'i', evidence: [], checklist: { locationAnchored: true, triggerExplained: true, impactExplained: true, evidenceSufficient: true }, reason: 'r' }
}

test('escalation selects plausible critical/major candidates only', () => {
  const candidates = [candidate(0, 'major'), candidate(1, 'minor'), candidate(2, 'critical'), candidate(3, 'major')]
  const verdicts = [verdict(0, 'plausible'), verdict(1, 'plausible'), verdict(2, 'plausible'), verdict(3, 'confirmed')]
  const selected = escalationCandidates(candidates, verdicts)
  assert.deepEqual(selected.map(entry => entry.index), [0, 2])
})

test('confirmed, rejected, and missing verdicts are never escalated', () => {
  const candidates = [candidate(0, 'major'), candidate(1, 'major'), candidate(2, 'major')]
  const verdicts = [verdict(0, 'confirmed'), verdict(1, 'rejected')]
  assert.deepEqual(escalationCandidates(candidates, verdicts).map(entry => entry.index), [])
})

test('minor and info plausibles stay dropped without escalation', () => {
  const candidates = [candidate(0, 'minor'), candidate(1, 'info')]
  const verdicts = [verdict(0, 'plausible'), verdict(1, 'plausible')]
  assert.deepEqual(escalationCandidates(candidates, verdicts), [])
})

test('verdict parsing accepts GLM self-selected top-level key names', () => {
  const verdictList = [verdict(0, 'confirmed'), verdict(1, 'rejected')]
  assert.deepEqual(asVerdictsOutput({ verdicts: verdictList }), verdictList)
  assert.deepEqual(asVerdictsOutput({ pairs: verdictList }), verdictList)
  assert.deepEqual(asVerdictsOutput({ matches: [...verdictList] }), verdictList)
  assert.deepEqual(asVerdictsOutput({ result: { verdicts: verdictList } }), [])
})

test('verdict parsing rejects arrays without verdict-shaped entries', () => {
  assert.deepEqual(asVerdictsOutput({ pairs: [{ index: 0, note: 'x' }] }), [])
  assert.deepEqual(asVerdictsOutput({ verdicts: 'not-an-array' }), [])
  assert.deepEqual(asVerdictsOutput(null), [])
  assert.deepEqual(asVerdictsOutput([1, 2, 3].map(n => ({ index: n }))), [])
})
