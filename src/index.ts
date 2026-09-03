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
import { runReview, type ReviewConfig } from './orchestrator.ts'

export const name = 'xiezhi'

export const inject = ['tools', 'subagents']

export interface Config extends ReviewConfig {}

export const Config: Schema<Config> = Schema.object({
  adaptive: Schema.boolean().default(false).description('Plan the team from deterministic PR risk features (risk level -> roles/tier/budget/verification depth); off keeps the fixed three-role pipeline. Experimental: not yet validated against the paid benchmark'),
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
})

export function apply(ctx: Context, config: Config) {
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
      return await runReview(ctx, parent, exec.signal, args.pr, config)
    },
  }))
}
