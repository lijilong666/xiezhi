/**
 * Token usage accounting over a subagent's durable session log, so every
 * review reports its own cost breakdown per role and model.
 * @module xiezhi/usage
 */

import type { SubagentRun } from '@deepseek-ai/dsh-subagent'

export interface UsageSummary {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
}

const ZERO: UsageSummary = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** Sum token usage over the run's assistant messages; zero summary when the run has no local session. */
export function sumRunUsage(run: SubagentRun): UsageSummary {
  const session = run.localAgent?.session
  if (session === undefined) return ZERO
  let calls = 0, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0
  for (const event of session.events) {
    if (event.type !== 'assistant/message') continue
    const usage = event.data.usage
    if (usage === undefined) continue
    calls++
    inputTokens += usage.inputTokens
    outputTokens += usage.outputTokens
    cacheReadTokens += usage.cacheReadTokens ?? 0
    cacheWriteTokens += usage.cacheWriteTokens ?? 0
  }
  return { calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

export function addUsage(a: UsageSummary, b: UsageSummary): UsageSummary {
  return {
    calls: a.calls + b.calls,
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  }
}

/** Compact per-thousands rendering for the report footer. */
export function formatTokens(count: number): string {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}
