#!/usr/bin/env node
/**
 * Batch runner: reviews every golden PR through the installed xiezhi plugin
 * (headless profile) and saves each markdown report for judging.
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

const REPOS = ['sentry', 'grafana', 'cal_dot_com', 'discourse', 'keycloak']
const args = process.argv.slice(2)
const sampleFlag = readFlag('--sample')
const limitFlag = readFlag('--limit')

function readFlag(name) {
  const idx = args.indexOf(name)
  return idx === -1 ? undefined : Number(args[idx + 1])
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
  const endTokens = ['[ELIFECYCLE]', 'node --import']
  for (const token of endTokens) {
    const end = report.indexOf(token)
    if (end > 0) report = report.slice(0, end)
  }
  return report.trimEnd() + '\n'
}

const targets = loadTargets()
const pending = targets.filter(target => !existsSync(resultPath(target)))
console.log(`targets: ${targets.length}, pending: ${pending.length} (results/ provides resume)`)

for (const target of pending) {
  const label = `${target.repo}-${String(target.idx).padStart(2, '0')}`
  console.log(`[${new Date().toLocaleTimeString()}] reviewing ${label}: ${target.url} (${target.title})`)
  try {
    const { stdout } = await run('cmd.exe', ['/c', 'pnpm.cmd', 'dsh', '--profile', 'headless', '--patch', './xiezhi/dev.patch.yml',
      `Use the review_pull_request tool to review PR ${target.url}, then output the full markdown report verbatim.`],
      { cwd: harnessRoot, encoding: 'utf8', timeout: 35 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 })
    const report = extractReport(stdout)
    if (report === undefined) {
      console.log(`  ${label}: NO REPORT MARKER FOUND, skipping (inspect manually)`)
      continue
    }
    writeFileSync(resultPath(target), report)
    const findingCount = (report.match(/^### \[/gm) ?? []).length
    console.log(`  ${label}: saved (${findingCount} findings, golden: ${target.goldenCount})`)
  } catch (error) {
    console.log(`  ${label}: FAILED — ${String(error.message).slice(0, 160)}`)
  }
}
console.log('batch complete')
