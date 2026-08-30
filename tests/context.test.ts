/**
 * Repo-context selection and rendering: budget behavior, removal/filter
 * exclusion, addition-priority ordering, fence language detection.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderRepoContext, selectContextFiles } from '../src/context.ts'
import { SKIP_PATTERN } from '../src/github.ts'
import type { PrFile } from '../src/github.ts'

function file(filename: string, additions: number, status = 'modified'): PrFile {
  return { filename, status, additions, deletions: 1, patch: '@@ -1 +1 @@' }
}

test('selects by additions, drops removals and filtered paths, caps the count', () => {
  const selected = selectContextFiles([
    file('small.ts', 2),
    file('big.ts', 400),
    file('deleted.ts', 500, 'removed'),
    file('dist/bundle.js', 900),
    ...Array.from({ length: 12 }, (_, index) => file(`f${index}.ts`, 10)),
  ], SKIP_PATTERN)
  assert.equal(selected[0]?.filename, 'big.ts')
  assert.ok(!selected.some(entry => entry.filename === 'deleted.ts'))
  assert.ok(!selected.some(entry => entry.filename === 'dist/bundle.js'))
  assert.ok(selected.length <= 10)
})

test('renders a fenced section per file with language detection', () => {
  const section = renderRepoContext([
    { filename: 'src/a.ts', content: 'const x = 1' },
    { filename: 'Makefile', content: 'all:' },
  ])
  assert.ok(section.includes('## Full content of changed files at the PR head'))
  assert.ok(section.includes('```ts\nconst x = 1\n```'))
  assert.ok(section.includes('### Makefile'))
  assert.ok(section.includes('```\nall:\n```'))
})

test('renders an empty string for no contents', () => {
  assert.equal(renderRepoContext([]), '')
})
