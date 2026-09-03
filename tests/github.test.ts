/**
 * rightSideRanges / buildInlineComments behavior: hunk parsing and the
 * anchorable/unanchored split.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EvidencePack } from '../src/evidence.ts'
import { buildInlineComments, isChangedLine, rightSideRanges, type PrFile } from '../src/github.ts'

test('parses right-side ranges from hunk headers', () => {
  const patch = [
    '@@ -10,7 +10,7 @@ class A {',
    ' context',
    '@@ -40,3 +44,1 @@ class B {',
    ' context',
    '@@ -1,1 +50 @@ tail',
    ' context',
  ].join('\n')
  assert.deepEqual(rightSideRanges(patch), [[10, 16], [44, 44], [50, 50]])
})

test('a zero-length right side contributes no range', () => {
  assert.deepEqual(rightSideRanges('@@ -5,2 +9,0 @@'), [])
})

test('validates a location against fetched new-file diff hunks', () => {
  const files: PrFile[] = [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -10,2 +10,2 @@\n-old\n+new' }]
  assert.equal(isChangedLine(files, 'src/a.ts', 11), true)
  assert.equal(isChangedLine(files, 'src/a.ts', 99), false)
  assert.equal(isChangedLine(files, 'src/missing.ts', 11), false)
})

test('anchors findings inside hunks and reports the rest as unanchored', () => {
  const files: PrFile[] = [{
    filename: 'src/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n old\n new\n ctx',
  }]
  const evidencePack: EvidencePack = {
    status: 'confirmed',
    claim: 'The branch returns the wrong value.',
    trigger: 'The changed branch executes.',
    impact: 'The caller receives an incorrect result.',
    evidence: [{ kind: 'diff', path: 'src/a.ts', line: 11, detail: 'The changed return is visible here.' }],
    checklist: { locationAnchored: true, triggerExplained: true, impactExplained: true, evidenceSufficient: true },
    reason: 'The diff directly proves the claim.',
  }
  const finding = (line: number) => ({
    file: 'src/a.ts', line, severity: 'major', category: 'logic',
    title: 't', description: 'd', suggestion: 's', roles: ['bug-hunter'], evidencePack,
  })
  const { inline, unanchored } = buildInlineComments([finding(11), finding(99), { ...finding(1), file: 'other.ts' }], files)
  assert.equal(inline.length, 1)
  assert.equal(inline[0]?.line, 11)
  assert.equal(inline[0]?.path, 'src/a.ts')
  assert.match(inline[0]?.body ?? '', /\*\*Evidence Pack\*\*/)
  assert.equal(unanchored.length, 2)
})
