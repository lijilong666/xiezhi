import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectTsProject, diffErrors, executeVerification, parseTscOutput } from '../src/execver.ts'
import { EvidenceStore } from '../src/evidence-tools.ts'
import type { Candidate } from '../src/verify.ts'

const REF = { owner: 'o', repo: 'r', number: 1 }

function tsProject(withError: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), withError ? 'xiezhi-ts-head-' : 'xiezhi-ts-base-'))
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ['*.ts'] }))
  writeFileSync(join(dir, 'a.ts'), withError ? 'export const broken: number = "not a number"\n' : 'export const broken: number = 41\n')
  writeFileSync(join(dir, 'other.ts'), 'export const other = 1\n')
  return dir
}

function store(dir: string): EvidenceStore {
  return new EvidenceStore(dir, REF, 'base')
}

function candidate(file: string, severity: 'critical' | 'major' | 'minor' = 'major'): Candidate {
  return { index: 0, role: 'bug-hunter', finding: { severity, category: 'logic', title: 'type error', description: 'd', file, line: 1 } }
}

test('parseTscOutput relativizes paths and extracts line numbers', () => {
  const stdout = [
    'src/a.ts(12,5): error TS2322: Type \'"s"\' is not assignable to type \'number\'.',
    'src/deep/b.ts(3,1): error TS2339: Property \'x\' does not exist on type \'Y\'.',
    'plain line without position is ignored',
  ].join('\n')
  const errors = parseTscOutput(stdout, 'D:/snap/root')
  assert.equal(errors.length, 2)
  assert.deepEqual(errors[0], { file: 'src/a.ts', line: 12, message: 'TS2322: Type \'"s"\' is not assignable to type \'number\'.' })
})

test('diffErrors keeps only errors the PR introduced', () => {
  const base = [{ file: 'a.ts', line: 5, message: 'TS2304: Cannot find module deps.' }]
  const head = [
    { file: 'a.ts', line: 5, message: 'TS2304: Cannot find module deps.' },
    { file: 'a.ts', line: 9, message: 'TS2322: bad assign' },
  ]
  const diff = diffErrors(base, head)
  assert.equal(diff.length, 1)
  assert.equal(diff[0]!.line, 9)
  assert.deepEqual(diffErrors(base, base), [])
})

test('detectTsProject requires a root tsconfig.json', () => {
  assert.equal(detectTsProject(store(tsProject(true))), true)
  const bare = mkdtempSync(join(tmpdir(), 'xiezhi-bare-'))
  writeFileSync(join(bare, 'a.ts'), 'x')
  assert.equal(detectTsProject(store(bare)), false)
})

test('executeVerification upgrades a matching plausible major to executed proof', async () => {
  const outcome = await executeVerification([candidate('a.ts')], store(tsProject(true)), store(tsProject(false)), AbortSignal.timeout(120_000))
  assert.equal(outcome.status, 'ran')
  assert.equal(outcome.upgrades.length, 1)
  const pack = outcome.upgrades[0]!.finding.evidencePack!
  assert.equal(pack.proofLevel, 'executed')
  assert.equal(pack.status, 'confirmed')
  assert.ok(pack.artifact?.includes('absent at base, present at head'))
  assert.equal(pack.evidence[0]!.kind, 'static')
})

test('executeVerification does not upgrade when the error is in another file', async () => {
  const outcome = await executeVerification([candidate('other.ts')], store(tsProject(true)), store(tsProject(false)), AbortSignal.timeout(120_000))
  assert.equal(outcome.status, 'ran')
  assert.equal(outcome.upgrades.length, 0)
})

test('executeVerification returns off for non-TypeScript snapshots', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'xiezhi-bare2-'))
  mkdirSync(bare, { recursive: true })
  writeFileSync(join(bare, 'main.py'), 'x = 1')
  const outcome = await executeVerification([candidate('main.py')], store(bare), store(bare), AbortSignal.timeout(60_000))
  assert.equal(outcome.status, 'off')
  assert.deepEqual(outcome.upgrades, [])
})

test('executeVerification env-fails (verdicts untouched) when the run is aborted', async () => {
  const outcome = await executeVerification([candidate('a.ts')], store(tsProject(true)), store(tsProject(false)), AbortSignal.abort())
  assert.equal(outcome.status, 'env-failed')
  assert.deepEqual(outcome.upgrades, [])
  assert.ok(outcome.summary.includes('verdicts unchanged'))
})
