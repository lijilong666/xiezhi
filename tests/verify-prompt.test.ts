import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentRuntime } from '@deepseek-ai/dsh-subagent'
import { verifyFindings, type Candidate } from '../src/verify.ts'

interface CapturedStart {
  readonly prompt: readonly ContentBlock[]
  readonly toolFilter: unknown
}

function candidate(index: number): Candidate {
  return {
    index,
    role: 'bug-hunter',
    finding: { severity: 'major', category: 'logic', title: 't', description: 'd', file: 'src/a.ts', line: 3 },
  }
}

function runtime(captured: CapturedStart[]): SubagentRuntime {
  return {
    async start(_name: string, request: { prompt: ContentBlock[], toolFilter?: unknown }) {
      captured.push({ prompt: request.prompt, toolFilter: request.toolFilter })
      return {
        id: 'verify-child',
        localAgent: undefined,
        result: Promise.resolve({ stopReason: 'completed', structured: { verdicts: [] } }),
        dispose: async () => {},
      }
    },
  } as unknown as SubagentRuntime
}

function promptText(prompt: readonly ContentBlock[]): string {
  return prompt.map(block => block.type === 'text' ? block.text : '').join('\n')
}

async function verify(allowTools: boolean, evidenceBlock: string): Promise<CapturedStart> {
  const captured: CapturedStart[] = []
  await verifyFindings(
    runtime(captured),
    undefined as unknown as Agent,
    'PR context',
    [candidate(0)],
    new AbortController().signal,
    8,
    { provider: 'zhipu', model: 'glm-5.3-flash' },
    () => true,
    false,
    evidenceBlock,
    allowTools,
  )
  assert.equal(captured.length, 1)
  return captured[0]!
}

test('verify prompt builds without tool instructions when repository tools are off', async () => {
  const captured = await verify(false, 'SNAPSHOT EVIDENCE')
  assert.ok(!promptText(captured.prompt).includes('## Repository evidence tools'))
  assert.deepEqual(captured.toolFilter, { allow: [] })
})

test('verify prompt carries repository tool instructions when tools are allowed', async () => {
  const captured = await verify(true, 'SNAPSHOT EVIDENCE')
  const text = promptText(captured.prompt)
  assert.ok(text.includes('## Repository evidence tools'))
  assert.ok(text.includes('SNAPSHOT EVIDENCE'))
  const allow = (captured.toolFilter as { allow: readonly string[] }).allow
  assert.equal(allow.length, 5)
  assert.ok(allow.includes('xiezhi_read_file'))
})
