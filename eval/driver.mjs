#!/usr/bin/env node
/**
 * Batch runner: reviews every golden PR through the installed xiezhi plugin
 * (headless profile) and saves each markdown report for judging. A crash-safe
 * manifest in results/ records per-PR timing, status, and finding counts; a
 * closing summary prints P50/P95 latency and failure rates.
 *
 * Usage (from the harness repo root):
 *   node xiezhi/eval/driver.mjs                # all 50 PRs, resumes from results/
 *   node xiezhi/eval/driver.mjs --sample 1     # first PR per repo (pilot)
 *   node xiezhi/eval/driver.mjs --limit 4      # first 4 PRs overall
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const harnessRoot = join(here, '..', '..')
const resultsDir = join(here, 'results')
mkdirSync(resultsDir, { recursive: true })
const manifestPath = join(resultsDir, 'manifest.json')

const REPOS = ['sentry', 'grafana', 'cal_dot_com', 'discourse', 'keycloak']
const args = process.argv.slice(2)
const sampleFlag = readFlag('--sample')
const limitFlag = readFlag('--limit')

function readFlag(name) {
  const idx = args.indexOf(name)
  return idx === -1 ? undefined : Number(args[idx + 1])
}

function loadManifest() {
  if (!existsSync(manifestPath)) return new Map()
  return new Map(Object.entries(JSON.parse(readFileSync(manifestPath, 'utf8'))))
}

function saveManifest(manifest) {
  writeFileSync(manifestPath, JSON.stringify(Object.fromEntries([...manifest.entries()].sort(([a], [b]) => a.localeCompare(b))), null, 2))
}

function percentile(sortedDurations, p) {
  if (sortedDurations.length === 0) return 'n/a'
  const index = Math.min(sortedDurations.length - 1, Math.ceil((p / 100) * sortedDurations.length) - 1)
  return `${(sortedDurations[index] / 60_000).toFixed(1)}min`
}

function loadTargets() {
  const targets = []
  for (const repo of REPOS) {
    const golden = JSON.parse(readFileSync(join(here, 'golden', `${repo}.json`), 'utf8'))
    const arr = Array.isArray(golden) ? golden : [golden]
    const take = sampleFlag !== undefined ? arr.slice(0, sampleFlag) : arr
    take.forEach((entry, idx) => {
      targets.push({ repo, idx, url: entry.url, title: entry.pr_title ?? '', goldenCount: (entry.comments ?? []).length })
    })
  }
  return limitFlag !== undefined ? targets.slice(0, limitFlag) : targets
}

function resultPath(target) {
  return join(resultsDir, `${target.repo}-${String(target.idx).padStart(2, '0')}.md`)
}

function extractReport(stdout) {
  const marker = '# xiezhi review:'
  const start = stdout.indexOf(marker)
  if (start === -1) return undefined
  let report = stdout.slice(start)
  for (const token of ['[ELIFECYCLE]', 'node --import']) {
    const end = report.indexOf(token)
    if (end > 0) report = report.slice(0, end)
  }
  return report.trimEnd() + '\n'
}

const targets = loadTargets()
const pending = targets.filter(target => !existsSync(resultPath(target)))
console.log(`targets: ${targets.length}, pending: ${pending.length} (results/ provides resume)`)
const manifest = loadManifest()

for (const target of pending) {
  const label = `${target.repo}-${String(target.idx).padStart(2, '0')}`
  console.log(`[${new Date().toLocaleTimeString()}] reviewing ${label}: ${target.url} (${target.title})`)
  const startedAt = Date.now()
  let entry = { url: target.url, title: target.title, goldenCount: target.goldenCount, startedAt: new Date(startedAt).toISOString(), status: 'running' }
  manifest.set(label, entry)
  saveManifest(manifest)
  try {
    const { stdout } = await run('cmd.exe', ['/c', 'pnpm.cmd', 'dsh', '--profile', 'headless', '--patch', './xiezhi/dev.patch.yml',
      `Use the review_pull_request tool to review PR ${target.url}, then output the full markdown report verbatim.`],
      { cwd: harnessRoot, encoding: 'utf8', timeout: 35 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
    const report = extractReport(stdout)
    if (report === undefined) {
      manifest.set(label, { ...entry, status: 'no-report', durationMs: Date.now() - startedAt })
      saveManifest(manifest)
      console.log(`  ${label}: NO REPORT MARKER FOUND, skipping (inspect manually)`)
      continue
    }
    writeFileSync(resultPath(target), report)
    const findingCount = (report.match(/^### \[/gm) ?? []).length
    manifest.set(label, { ...entry, status: 'ok', durationMs: Date.now() - startedAt, findings: findingCount })
    saveManifest(manifest)
    console.log(`  ${label}: saved (${findingCount} findings, golden: ${target.goldenCount}, ${((Date.now() - startedAt) / 60_000).toFixed(1)}min)`)
  } catch (error) {
    manifest.set(label, { ...entry, status: 'failed', durationMs: Date.now() - startedAt, error: String(error.message).slice(0, 300) })
    saveManifest(manifest)
    console.log(`  ${label}: FAILED — ${String(error.message).slice(0, 160)}`)
  }
}

const entries = [...manifest.values()]
const ok = entries.filter(record => record.status === 'ok')
const durations = ok.map(record => record.durationMs).sort((a, b) => a - b)
console.log('\n== batch summary ==')
console.log(`records: ${entries.length} | ok: ${ok.length} | failed: ${entries.filter(r => r.status === 'failed').length} | no-report: ${entries.filter(r => r.status === 'no-report').length}`)
console.log(`latency (ok runs): P50 ${percentile(durations, 50)} | P95 ${percentile(durations, 95)} | max ${percentile(durations, 100)}`)
console.log('batch complete')
