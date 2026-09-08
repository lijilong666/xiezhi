/**
 * xiezhi: multi-agent pull-request review team for DeepSeek Harness.
 * Registers one model-facing tool that runs the review pipeline
 * (roles -> verifier -> aggregation -> optional posting) and returns a
 * markdown report; the whole review lands in the calling session's
 * durable log for replay.
 * @module xiezhi
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { getActiveStore } from './evidence-tools.ts'
import { runReview, type ReviewConfig } from './orchestrator.ts'

export const name = 'xiezhi'

export const inject = ['tools', 'subagents']

export interface Config extends ReviewConfig {}

export const Config: Schema<Config> = Schema.object({
  adaptive: Schema.boolean().default(false).description('Plan the team from deterministic PR risk features (risk level -> roles/tier/budget/verification depth); off keeps the fixed three-role pipeline. Experimental: not yet validated against the paid benchmark'),
  hybridPlanner: Schema.boolean().default(false).description('Let a flash-model planner re-decide the plan for gray-zone PRs (risk score 4-6); its output is whitelisted, rule-budgeted, and any failure keeps the rule plan. Requires adaptive. Experimental'),
  evidence: Schema.boolean().default(false).description('Fetch a read-only head snapshot and give the verifier repository retrieval tools (read/search/references/tests/history) for cross-file evidence, with tool-trace telemetry. Degrades to diff-only on oversize or failure. Experimental'),
  execver: Schema.boolean().default(false).description('Executable verification: run the plugin TypeScript compiler over base/head snapshots and upgrade plausible critical/major candidates to executed-proof confirmations when the PR itself introduces the compiler error. Env failures never change a verdict. Experimental'),
  verifier: Schema.boolean().default(true).description('Build an Evidence Pack and checklist-verify every candidate before reporting'),
  batchSize: Schema.number().default(8).description('Candidate findings per verifier subagent batch'),
  post: Schema.union(['off', 'comment']).default('off').description('"off" returns the report only; "comment" also posts it as a PR review (needs GITHUB_TOKEN)'),
  maxFindings: Schema.number().default(30).description('Report cap after aggregation'),
  repoContext: Schema.union(['off', 'changed']).default('off').description('"changed" injects full changed-file contents at the PR head into reviewer context; "off" reviews the diff only. A/B test on express#7377 showed full-file injection dilutes diff focus — keep off unless verified for your workload'),
  routes: Schema.array(Schema.object({
    id: Schema.string().required().description('Role id (bug-hunter, security, nitpicker, verifier)'),
    provider: Schema.string().required(),
    model: Schema.string().required(),
  })).default([]).description('Per-role provider/model overrides; omit an id to keep its built-in route'),
  repoCalibrations: Schema.array(Schema.object({
    repo: Schema.string().required().description('owner/repo'),
    medianChangedLines: Schema.number().description('Median changed lines from plan-only replay; raises the large-change threshold to max(400, 1.25x median)'),
    medianFiles: Schema.number().description('Median changed files; raises the wide-change threshold to max(10, 1.5x median)'),
  })).default([]).description('Per-repo scale baselines so ordinary PRs in large repos are not always high-risk'),
  suppressions: Schema.array(Schema.object({
    filePattern: Schema.string().required().description('File glob, e.g. "src/generated/**"'),
    category: Schema.string().description('Optional finding category to narrow the rule'),
    reason: Schema.string().required().description('Why this class of findings is suppressed (shown in the report)'),
  })).default([]).description('Transparent feedback suppressions applied at the publishing boundary; the report always states what was suppressed'),
  circuitThreshold: Schema.number().default(3).description('Consecutive provider failures before spawns degrade to the fallback route'),
  fallbackRoute: Schema.object({
    provider: Schema.string().required(),
    model: Schema.string().required(),
  }).default({ provider: 'deepseek-official', model: 'deepseek-v4-flash' }).description('Cross-provider fallback for tripped providers and one-shot role retries'),
  roleTimeoutMs: Schema.number().default(900_000).description('Per-role wall-clock budget in milliseconds'),
})

function activeStore() {
  const store = getActiveStore()
  if (store === undefined) throw new Error('xiezhi evidence store unavailable: repository snapshot was not prepared for this review (evidence off or degraded)')
  return store
}

function summarizeHits(hits: readonly { path: string, line: number }[]): string {
  return `${hits.length} hit(s)${hits.length > 0 ? ` e.g. ${hits[0]!.path}:${hits[0]!.line}` : ''}`
}

export function apply(ctx: Context, config: Config) {
  ctx.tools.register(defineTool({
    name: 'xiezhi_read_file',
    description: 'Read a window of a repository file from the PR head snapshot (read-only). Returns content, total lines, truncated flag.',
    parameters: {
      path: { type: 'string', required: true, description: 'Repository-relative path' },
      start: { type: 'number', description: '1-based first line (default 1)' },
      end: { type: 'number', description: 'Inclusive last line (default start+199)' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const read = activeStore().readFile(String(args.path), Number(args.start ?? 1), Number(args.end ?? Number(args.start ?? 1) + 199))
      if (read === undefined) return `not found or excluded: ${args.path}`
      activeStore().record('xiezhi_read_file', `${args.path}:${args.start ?? 1}-${args.end ?? ''}`, `${read.totalLines} lines total, returning ${read.content.split('\n').length}${read.truncated ? ' (truncated)' : ''}`)
      return `total ${read.totalLines} lines${read.truncated ? ' (truncated)' : ''}\n${read.content}`
    },
  }))
  ctx.tools.register(defineTool({
    name: 'xiezhi_search_code',
    description: 'Search the PR head snapshot for code or text (whole-word by default). Returns up to 20 file:line hits with the matching line.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search text (or regex when regex=true)' },
      regex: { type: 'boolean', description: 'Treat query as a case-insensitive regex' },
      glob: { type: 'string', description: 'Optional path glob filter, e.g. "src/**/*.ts"' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const hits = activeStore().searchCode(String(args.query), { regex: args.regex === true, glob: args.glob === undefined ? undefined : String(args.glob) })
      activeStore().record('xiezhi_search_code', JSON.stringify(args), summarizeHits(hits))
      return hits.length === 0 ? 'no hits' : hits.map(hit => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'xiezhi_find_references',
    description: 'Find whole-word references to a symbol across the head snapshot; source files rank before tests.',
    parameters: { symbol: { type: 'string', required: true, description: 'Identifier to look up' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const hits = activeStore().findReferences(String(args.symbol))
      activeStore().record('xiezhi_find_references', String(args.symbol), summarizeHits(hits))
      return hits.length === 0 ? 'no references found' : hits.map(hit => `${hit.path}:${hit.line}: ${hit.text}`).join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'xiezhi_related_tests',
    description: 'List test files related to a source path by naming convention, with a basename search fallback.',
    parameters: { path: { type: 'string', required: true, description: 'Repository-relative source path' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) {
      const tests = activeStore().relatedTests(String(args.path))
      activeStore().record('xiezhi_related_tests', String(args.path), `${tests.length} test file(s)`)
      return tests.length === 0 ? 'no related tests found' : tests.join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'xiezhi_git_history',
    description: 'Recent commits (max 5) touching a path, queried at the PR base sha.',
    parameters: { path: { type: 'string', required: true, description: 'Repository-relative path' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const commits = await activeStore().gitHistory(String(args.path), exec.signal)
      activeStore().record('xiezhi_git_history', String(args.path), `${commits.length} commit(s)`)
      return commits.length === 0 ? 'no history found' : commits.map(commit => `${commit.sha} ${commit.date} ${commit.message}`).join('\n')
    },
  }))
  ctx.tools.register(defineTool({
    name: 'review_pull_request',
    description: 'Review a GitHub pull request with a parallel multi-agent reviewer team '
      + '(bug hunter + security scanner, then a checklist-driven Evidence Pack gate) and return a '
      + 'severity-ranked markdown review report.',
    parameters: {
      pr: {
        type: 'string',
        required: true,
        description: 'PR reference: "owner/repo#123" or a github.com pull-request URL',
      },
      since: {
        type: 'string',
        description: 'Prior reviewed head commit sha: review only changes since it (incremental re-review); omit for a full review',
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) {
        throw new Error('review_pull_request requires a calling agent (exec.agent was undefined)')
      }
      return await runReview(ctx, parent, exec.signal, args.pr, config, typeof args.since === 'string' && args.since !== '' ? args.since : undefined)
    },
  }))
}
