/**
 * Repo-context selection and rendering: budget behavior, removal/filter
 * exclusion, addition-priority ordering, fence language detection, and the
 * injected-fetch failure/truncation paths.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fetchRepoContext, renderRepoContext, selectContextFiles } from '../src/context.ts'
import { SKIP_PATTERN, type PrFile, type PrRef } from '../src/github.ts'

function file(filename: string, additions: number, status = 'modified'): PrFile {
  return { filename, status, additions, deletions: 1, patch: '@@ -1 +1 @@' }
}

const REF: PrRef = { owner: 'o', repo: 'r', number: 1 }
const SIGNAL = new AbortController().signal

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n')
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

test('fetches at the head ref and decodes newline-wrapped base64', async () => {
  const paths: string[] = []
  const contents = await fetchRepoContext(async path => {
    paths.push(path)
    return { content: b64('const x = 1'), encoding: 'base64' }
  }, REF, 'deadbeef', [file('src/a.ts', 5)], SKIP_PATTERN, SIGNAL)
  assert.equal(paths[0], '/repos/o/r/contents/src/a.ts?ref=deadbeef')
  assert.equal(contents.length, 1)
  assert.equal(contents[0]?.content, 'const x = 1')
})

test('a failing fetch or non-base64 payload skips that file only', async () => {
  const contents = await fetchRepoContext(async path => {
    if (path.includes('gone.ts')) throw new Error('HTTP 404')
    if (path.includes('raw.ts')) return { content: 'plain', encoding: 'none' }
    return { content: b64('ok'), encoding: 'base64' }
  }, REF, 'sha', [file('gone.ts', 30), file('raw.ts', 20), file('ok.ts', 10)], SKIP_PATTERN, SIGNAL)
  assert.deepEqual(contents.map(entry => entry.filename), ['ok.ts'])
})

test('missing content payload is skipped', async () => {
  const contents = await fetchRepoContext(async () => ({ encoding: 'base64' }), REF, 'sha', [file('a.ts', 1)], SKIP_PATTERN, SIGNAL)
  assert.equal(contents.length, 0)
})

test('oversized per-file content is truncated with a marker', async () => {
  const big = 'x'.repeat(20_000)
  const contents = await fetchRepoContext(async () => ({ content: b64(big), encoding: 'base64' }), REF, 'sha', [file('a.ts', 1)], SKIP_PATTERN, SIGNAL)
  const text = contents[0]?.content ?? ''
  assert.ok(text.length <= 16_100)
  assert.ok(text.includes('… (file truncated)'))
})

test('the total budget truncates the last file and stops fetching', async () => {
  const files = [file('a.ts', 30), file('b.ts', 20), file('c.ts', 10)]
  const big = 'y'.repeat(20_000)
  const contents = await fetchRepoContext(async () => ({ content: b64(big), encoding: 'base64' }), REF, 'sha', files, SKIP_PATTERN, SIGNAL)
  const total = contents.reduce((sum, entry) => sum + entry.content.length, 0)
  assert.ok(total <= 48_000)
  assert.equal(contents.length, 3)
  assert.ok((contents[2]?.content.length ?? 0) < 20_000)
})
