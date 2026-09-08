import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCrossFileBreaks, importTargets, parseImports, renderCrossBreaks, vanishedPaths } from '../src/crosschange.ts'
import { EvidenceStore } from '../src/evidence-tools.ts'

const REF = { owner: 'o', repo: 'r', number: 1 }

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'xiezhi-cross-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app.ts'), 'import { helper } from "./helper"\nimport gone from "../gone"\nexport const app = helper(1) + gone\n')
  writeFileSync(join(root, 'src', 'helper.ts'), 'export const helper = (x: number) => x\n')
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'deep.ts'), 'export const deep = 1\n')
  return root
}

function prFile(filename: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { filename, status, additions: 1, deletions: 1, ...extra }
}

test('parseImports extracts ES and require specifiers per line', () => {
  const source = [
    'import a from "./a"',
    'import type { B } from "./b"',
    'export { c } from "./c"',
    'const d = require("../d")',
    'import "side-effect"',
    'const notImport = 1',
  ].join('\n')
  assert.deepEqual(parseImports(source), ['./a', './b', './c', '../d', 'side-effect'])
})

test('importTargets resolves relative specifiers with extension and index fallbacks', () => {
  assert.deepEqual(importTargets('./helper', 'src/app.ts'), ['src/helper', 'src/helper.ts', 'src/helper.tsx', 'src/helper.js', 'src/helper.jsx', 'src/helper.mjs', 'src/helper.cjs', 'src/helper/index.ts', 'src/helper/index.tsx', 'src/helper/index.js', 'src/helper/index.jsx'])
  assert.deepEqual(importTargets('../gone', 'src/app.ts').at(0), 'gone')
  assert.deepEqual(importTargets('lodash', 'src/app.ts'), [])
})

test('vanishedPaths collects removed files and rename sources', () => {
  assert.deepEqual(
    vanishedPaths([prFile('a.ts', 'modified'), prFile('b.ts', 'removed'), prFile('c.ts', 'renamed', { previous_filename: 'old/c.ts' })]),
    [{ path: 'b.ts', kind: 'removed-import' }, { path: 'old/c.ts', kind: 'renamed-import' }],
  )
})

test('findCrossFileBreaks flags snapshot imports of removed paths', () => {
  const root = fixture()
  const store = new EvidenceStore(root, REF, 'base')
  const breaks = findCrossFileBreaks(store, [prFile('gone.ts', 'removed'), prFile('lib/deep.ts', 'removed')])
  assert.equal(breaks.length, 1)
  assert.equal(breaks[0]!.importer, 'src/app.ts')
  assert.equal(breaks[0]!.line, 2)
  assert.equal(breaks[0]!.oldPath, 'gone.ts')
  rmSync(root, { recursive: true, force: true })
})

test('findCrossFileBreaks returns empty without removals or with healthy imports', () => {
  const root = fixture()
  const store = new EvidenceStore(root, REF, 'base')
  assert.deepEqual(findCrossFileBreaks(store, [prFile('src/helper.ts', 'modified')]), [])
  assert.deepEqual(findCrossFileBreaks(store, [prFile('src/app.ts', 'removed')]).length, 0)
  rmSync(root, { recursive: true, force: true })
})

test('renderCrossBreaks wraps detected breaks as untrusted data', () => {
  const rendered = renderCrossBreaks([{ kind: 'removed-import', oldPath: 'gone.ts', importer: 'src/app.ts', line: 2 }])
  assert.ok(rendered.startsWith('<cross-change-analysis'))
  assert.ok(rendered.includes('src/app.ts:2 imports gone.ts'))
  assert.equal(renderCrossBreaks([]), '')
})
