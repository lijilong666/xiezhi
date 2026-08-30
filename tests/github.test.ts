/**
 * rightSideRanges / buildInlineComments behavior: hunk parsing and the
 * anchorable/unanchored split.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildInlineComments, rightSideRanges, type PrFile } from '../src/github.ts'

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

test('anchors findings inside hunks and reports the rest as unanchored', () => {
  const files: PrFile[] = [{
    filename: 'src/a.ts',
    status: 'modified',
    additions: 3,
    deletions: 1,
    patch: '@@ -10,3 +10,3 @@\n old\n new\n ctx',
  }]
  const finding = (line: number) => ({
    file: 'src/a.ts', line, severity: 'major', category: 'logic',
    title: 't', description: 'd', suggestion: 's', roles: ['bug-hunter'],
  })
  const { inline, unanchored } = buildInlineComments([finding(11), finding(99), { ...finding(1), file: 'other.ts' }], files)
  assert.equal(inline.length, 1)
  assert.equal(inline[0]?.line, 11)
  assert.equal(inline[0]?.path, 'src/a.ts')
  assert.equal(unanchored.length, 2)
})
