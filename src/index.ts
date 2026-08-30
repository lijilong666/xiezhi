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
  verifier: Schema.boolean().default(true).description('Re-check every candidate finding against the diff before reporting'),
  batchSize: Schema.number().default(8).description('Candidate findings per verifier subagent batch'),
  post: Schema.union(['off', 'comment']).default('off').description('"off" returns the report only; "comment" also posts it as a PR review (needs GITHUB_TOKEN)'),
  maxFindings: Schema.number().default(30).description('Report cap after aggregation'),
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
      + '(bug hunter + security scanner, then an evidence verification gate) and return a '
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
