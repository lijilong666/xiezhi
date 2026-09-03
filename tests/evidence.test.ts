/** Evidence Pack publication gate, verdict application, and rendering. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPublishableVerdict, renderEvidencePack, type ChecklistVerdict } from '../src/evidence.ts'
import type { Finding } from '../src/schema.ts'
import { applyChecklistVerdicts, type Candidate } from '../src/verify.ts'

const finding: Finding = {
  file: 'src/auth.ts',
  line: 42,
  severity: 'major',
  category: 'security',
  title: 'Authorization check is bypassed',
  description: 'The new branch returns before checking the caller role.',
}

const isChangedLine = (path: string, line: number) => path === 'src/auth.ts' && line === 42

function verdict(overrides: Partial<ChecklistVerdict> = {}): ChecklistVerdict {
  return {
    index: 0,
    status: 'confirmed',
    claim: 'The new branch bypasses authorization.',
    trigger: 'A non-admin caller selects the new branch.',
    impact: 'The caller receives data without authorization.',
    evidence: [{ kind: 'diff', path: 'src/auth.ts', line: 42, detail: 'The return precedes the role check.' }],
    checklist: {
      locationAnchored: true,
      triggerExplained: true,
      impactExplained: true,
      evidenceSufficient: true,
    },
    reason: 'The changed control flow directly demonstrates the bypass.',
    ...overrides,
  }
}

test('publishes only a complete confirmed verdict with nearby direct diff evidence', () => {
  assert.equal(isPublishableVerdict(verdict(), finding, isChangedLine), true)
  assert.equal(isPublishableVerdict(verdict({ status: 'plausible' }), finding, isChangedLine), false)
  assert.equal(isPublishableVerdict(verdict({ checklist: { ...verdict().checklist, triggerExplained: false } }), finding, isChangedLine), false)
  assert.equal(isPublishableVerdict(verdict({ evidence: [{ kind: 'diff', path: 'src/other.ts', line: 42, detail: 'Wrong file.' }] }), finding, isChangedLine), false)
  assert.equal(isPublishableVerdict(verdict({ evidence: [{ kind: 'diff', path: 'src/auth.ts', line: 43, detail: 'Not a changed line.' }] }), finding, isChangedLine), false)
  assert.equal(isPublishableVerdict(verdict({ evidence: [{ kind: 'diff', path: 'src/auth.ts', line: 60, detail: 'Too far away.' }] }), finding, isChangedLine), false)
})

test('applies four-state verdicts and treats malformed confirmations as inconclusive', () => {
  const candidates: Candidate[] = [0, 1, 2, 3].map(index => ({ index, role: 'security', finding }))
  const result = applyChecklistVerdicts(candidates, [
    verdict({ index: 0, severity: 'critical' }),
    verdict({ index: 1, status: 'plausible' }),
    verdict({ index: 2, evidence: [] }),
  ], isChangedLine, 1)

  assert.equal(result.kept.length, 1)
  assert.equal(result.kept[0]?.finding.severity, 'critical')
  assert.equal(result.kept[0]?.finding.evidencePack.status, 'confirmed')
  assert.equal(result.droppedCount, 4)
  assert.deepEqual(result.statusCounts, { confirmed: 1, plausible: 1, inconclusive: 3, rejected: 0 })
})

test('renders claim, trigger, impact, evidence location, and verifier reason', () => {
  const rendered = renderEvidencePack(verdict()).join('\n')
  assert.match(rendered, /\*\*Evidence Pack\*\*/)
  assert.match(rendered, /Trigger: A non-admin caller/)
  assert.match(rendered, /`src\/auth\.ts:42`/)
  assert.match(rendered, /Verifier: The changed control flow/)
})
