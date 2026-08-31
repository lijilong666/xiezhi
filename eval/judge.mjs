#!/usr/bin/env node
/**
 * Scorer: parses saved xiezhi reports into findings, then asks an LLM judge
 * (same methodology as withmartian/code-review-benchmark: "do these describe
 * the same underlying issue?") to 1:1 match them against the golden comments,
 * and prints precision / recall tables.
 *
 * Usage (needs DEEPSEEK_API_KEY in env or in ~/.dsh/.credentials.yaml):
 *   node xiezhi/eval/judge.mjs                 # judge everything in results/
 *   node xiezhi/eval/judge.mjs --dry           # parse + local metrics only
 *   node xiezhi/eval/judge.mjs --results-dir <path> --output <path>
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const REPOS = ['sentry', 'grafana', 'cal_dot_com', 'discourse', 'keycloak']
const args = process.argv.slice(2)
const dry = args.includes('--dry')
const resultsDirFlag = readValueFlag('--results-dir')
const outputFlag = readValueFlag('--output')
const resultsDir = resultsDirFlag === undefined ? join(here, 'results') : resolve(resultsDirFlag)

function readValueFlag(name) {
  const idx = args.indexOf(name)
  if (idx === -1) return undefined
  const value = args[idx + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a path`)
  return value
}

function apiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  const credPath = join(homedir(), '.dsh', '.credentials.yaml')
  if (existsSync(credPath)) {
    const match = /api[_-]?key:\s*['"]?([\w-]+)['"]?/i.exec(readFileSync(credPath, 'utf8'))
    if (match) return match[1]
  }
  throw new Error('DEEPSEEK_API_KEY not found (env or ~/.dsh/.credentials.yaml)')
}

/** Parse "### [sev] title — `file:line`" blocks plus their description paragraph. */
function parseFindings(report) {
  const findings = []
  const lines = report.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const heading = /^### \[(\w+)\] (.+?) — `(.+?):(\d+)`/.exec(lines[i])
    if (heading === null) continue
    let description = ''
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j]
      if (line.startsWith('### ') || line.startsWith('## ')) break
      if (line.startsWith('category:') || line.startsWith('> ') || line.trim() === '') continue
      description += (description === '' ? '' : ' ') + line.trim()
    }
    findings.push({ severity: heading[1], title: heading[2], file: heading[3], line: Number(heading[4]), description })
  }
  return findings
}

async function judgePairs(pairs) {
  if (pairs.length === 0) return []
  const listing = pairs.map((pair, idx) => [
    `PAIR ${idx}:`,
    `GOLDEN [${pair.golden.severity}/${pair.golden.category ?? 'n/a'}]: ${pair.golden.comment}`,
    `OURS   [${pair.ours.severity}]: ${pair.ours.title} (${pair.ours.file}:${pair.ours.line}) ${pair.ours.description}`,
    '',
  ].join('\n')).join('\n')
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        {
          role: 'system',
          content: 'You judge code review comments. Two comments describe the SAME issue when they point at the same underlying problem in the same change, even with different wording, location, or severity. Location overlap is strong evidence; a different behavior or problem means NOT the same. Answer with strict JSON only.',
        },
        { role: 'user', content: `${listing}\nFor every PAIR output one verdict. Respond ONLY with the object {"verdicts":[{"index":0,"same":true}, ...]} covering every pair index.` },
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    }),
  })
  if (!response.ok) throw new Error(`judge API ${response.status}: ${await response.text()}`)
  const body = await response.json()
  const content = JSON.parse(body.choices[0].message.content)
  const arr = Array.isArray(content) ? content : content.verdicts ?? content.pairs ?? content.matches ?? content.result ?? Object.values(content).find(Array.isArray) ?? []
  const byIndex = new Map()
  arr.forEach((entry, position) => {
    if (typeof entry?.index === 'number') byIndex.set(entry.index, Boolean(entry.same))
    else if (byIndex.has(position) === false) byIndex.set(position, Boolean(entry?.same))
  })
  return pairs.map((_, i) => byIndex.get(i) ?? false)
}

const perRepo = []
for (const repo of REPOS) {
  const goldenArr = JSON.parse(readFileSync(join(here, 'golden', `${repo}.json`), 'utf8'))
  const rows = []
  for (const file of readdirSync(resultsDir)) {
    const match = new RegExp(`^${repo}-(\\d+)\\.md$`).exec(file)
    if (match === null) continue
    rows.push({ idx: Number(match[1]), report: readFileSync(join(resultsDir, file), 'utf8') })
  }
  rows.sort((a, b) => a.idx - b.idx)
  for (const row of rows) {
    const golden = goldenArr[row.idx]
    if (golden === undefined) continue
    const ours = parseFindings(row.report)
    const goldens = golden.comments ?? []
    const matchedGolden = new Set()
    if (!dry && ours.length > 0 && goldens.length > 0) {
      const usedOurs = new Set()
      for (let gi = 0; gi < goldens.length; gi++) {
        const pairs = ours.map((oursFinding, oursIdx) => ({ golden: goldens[gi], ours: oursFinding, oursIdx }))
        // Self-consistency: three independent judge calls, majority per pair
        // (temperature 0 does not guarantee cross-request determinism).
        const votes = await Promise.all([0, 1, 2].map(() => judgePairs(pairs)))
        const majorityOurs = pairs
          .filter((_, oi) => votes.filter(vote => vote[oi] === true).length >= 2)
          .map(pair => pair.oursIdx)
        const pick = majorityOurs.find(oi => !usedOurs.has(oi))
        if (pick !== undefined) {
          usedOurs.add(pick)
          matchedGolden.add(gi)
        }
      }
    }
    perRepo.push({
      repo, idx: row.idx, title: golden.pr_title ?? '',
      oursCount: ours.length, goldenCount: goldens.length, matchedCount: dry ? null : matchedGolden.size,
    })
    console.log(`${repo}-${String(row.idx).padStart(2, '0')}: ours ${ours.length} / golden ${goldens.length} / matched ${dry ? 'n/a' : matchedGolden.size}`)
  }
}

const total = perRepo.reduce((sum, row) => ({
  ours: sum.ours + row.oursCount, golden: sum.golden + row.goldenCount, matched: sum.matched + (row.matchedCount ?? 0),
}), { ours: 0, golden: 0, matched: 0 })
const precision = !dry && total.ours > 0 ? `${(total.matched / total.ours * 100).toFixed(1)}%` : 'n/a'
const recall = !dry && total.golden > 0 ? `${(total.matched / total.golden * 100).toFixed(1)}%` : 'n/a'
console.log('\n| repo | PRs | ours | golden | matched | precision | recall |')
console.log('|---|---|---|---|---|---|---|')
for (const repo of REPOS) {
  const rows = perRepo.filter(row => row.repo === repo)
  if (rows.length === 0) continue
  const agg = rows.reduce((s, r) => ({ o: s.o + r.oursCount, g: s.g + r.goldenCount, m: s.m + (r.matchedCount ?? 0) }), { o: 0, g: 0, m: 0 })
  const repoPrecision = !dry && agg.o ? `${(agg.m / agg.o * 100).toFixed(1)}%` : 'n/a'
  const repoRecall = !dry && agg.g ? `${(agg.m / agg.g * 100).toFixed(1)}%` : 'n/a'
  console.log(`| ${repo} | ${rows.length} | ${agg.o} | ${agg.g} | ${dry ? 'n/a' : agg.m} | ${repoPrecision} | ${repoRecall} |`)
}
console.log(`| **total** | ${perRepo.length} | ${total.ours} | ${total.golden} | ${dry ? 'n/a' : total.matched} | ${precision} | ${recall} |`)

if (outputFlag !== undefined) {
  const outputPath = resolve(outputFlag)
  writeFileSync(outputPath, `${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    dryRun: dry,
    resultsDir,
    judge: dry ? null : { provider: 'deepseek', model: 'deepseek-chat', votesPerPair: 3, majorityThreshold: 2 },
    perPr: perRepo,
    totals: {
      prs: perRepo.length,
      ours: total.ours,
      golden: total.golden,
      matched: dry ? null : total.matched,
      precision: !dry && total.ours > 0 ? total.matched / total.ours : null,
      recall: !dry && total.golden > 0 ? total.matched / total.golden : null,
    },
  }, null, 2)}\n`)
  console.log(`wrote ${outputPath}`)
}
