#!/usr/bin/env node
/**
 * Zero-API replay: fetch each baseline-20 PR, run the deterministic Risk
 * Profiler + Hybrid Router, and write the plan distribution for threshold
 * calibration. GitHub REST only — no model calls.
 *
 * Usage (from the harness repo root):
 *   node --import tsx/esm xiezhi/eval/plan-only.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchPullRequest } from '../src/github.ts'
import { isGrayZone, planReview, riskProfileFor } from '../src/planner.ts'

const here = dirname(fileURLToPath(import.meta.url))
const baseline = JSON.parse(readFileSync(join(here, 'baseline-20.json'), 'utf8'))
function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

function slugOf(data) {
  const match = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/.exec(data.htmlUrl)
  return match === null ? '' : match[1]
}

const cachePath = join(here, '.cache-plan-only.json')
const urlCache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) : {}
const cached = []
for (const pr of baseline.prs) {
  if (urlCache[pr.url] === undefined) {
    try {
      const { data } = await fetchPullRequest(pr.url, AbortSignal.timeout(30_000))
      urlCache[pr.url] = data
      writeFileSync(cachePath, JSON.stringify(urlCache))
    } catch (error) {
      console.log(`skip ${pr.url}: ${String(error).slice(0, 120)}`)
      continue
    }
  }
  cached.push({ pr, data: urlCache[pr.url] })
}

if (cached.length === 0) {
  console.log('no cached/fetched PRs (rate limited?) — refusing to overwrite plan-distribution.json')
  process.exit(1)
}

const byRepo = new Map()
for (const entry of cached) {
  const slug = slugOf(entry.data)
  if (!byRepo.has(slug)) byRepo.set(slug, [])
  byRepo.get(slug).push(entry)
}

const calibrations = []
for (const [repo, entries] of byRepo) {
  calibrations.push({
    repo,
    medianChangedLines: median(entries.map(({ data }) => data.files.reduce((sum, file) => sum + file.additions + file.deletions, 0))),
    medianFiles: median(entries.map(({ data }) => data.files.length)),
  })
}
const calibrationFor = data => calibrations.find(entry => entry.repo === slugOf(data))

const rows = cached.map(({ pr, data }) => {
  const changedLines = data.files.reduce((sum, file) => sum + file.additions + file.deletions, 0)
  const plan = planReview(data, true, 8)
  const profile = riskProfileFor(data)
  const calibration = calibrationFor(data)
  const calibratedPlan = planReview(data, true, 8, [calibration])
  const calibratedProfile = riskProfileFor(data, [calibration])
  return {
    repo: pr.repo, url: pr.url, changedLines, fileCount: data.files.length,
    signals: plan.riskSignals, level: plan.riskLevel,
    roles: plan.selectedRoles, tier: plan.modelTier, depth: plan.verificationDepth,
    grayZone: isGrayZone(profile),
    levelCalibrated: calibratedPlan.riskLevel, grayZoneCalibrated: isGrayZone(calibratedProfile),
  }
})

for (const row of rows) {
  console.log(`${row.repo}: ${row.changedLines} lines / ${row.fileCount} files -> ${row.level} [${row.signals.join(',') || '-'}] team ${row.roles.length} (${row.tier})${row.grayZone ? ' GRAY' : ''}${row.levelCalibrated !== row.level ? ` => ${row.levelCalibrated} (calibrated)` : ''}`)
}

const count = (level, key = 'level') => rows.filter(row => row[key] === level).length
console.log('\n== distribution (uncalibrated) ==')
console.log(`low: ${count('low')} | medium: ${count('medium')} | high: ${count('high')}`)
console.log(`gray zone (score 4-6, llm-planner eligible): ${rows.filter(row => row.grayZone).length}/${rows.length}`)

console.log('\n== with repo calibrations ==')
console.log(`low: ${count('low', 'levelCalibrated')} | medium: ${count('medium', 'levelCalibrated')} | high: ${count('high', 'levelCalibrated')}`)
console.log(`gray zone: ${rows.filter(row => row.grayZoneCalibrated).length}/${rows.length} · level shifts: ${rows.filter(row => row.levelCalibrated !== row.level).length}`)

console.log('\n== per-repo medians (candidate repoCalibrations) ==')
for (const calibration of calibrations) {
  console.log(`- repo: ${calibration.repo} # median ${calibration.medianChangedLines} lines / ${calibration.medianFiles} files`)
}

writeFileSync(join(here, 'plan-distribution.json'), JSON.stringify({
  generated: new Date().toISOString(),
  source: 'baseline-20.json', adaptive: true, batchSize: 8,
  distribution: { low: count('low'), medium: count('medium'), high: count('high') },
  grayZone: { uncalibrated: rows.filter(row => row.grayZone).length, calibrated: rows.filter(row => row.grayZoneCalibrated).length },
  perPr: rows, calibrations,
}, null, 2))
console.log('\nwritten: xiezhi/eval/plan-distribution.json')
