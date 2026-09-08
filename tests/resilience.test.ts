import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderBreaker } from '../src/resilience.ts'
import { renderIncrementalContext } from '../src/github.ts'
import type { PrData, PrFile } from '../src/github.ts'

const FALLBACK = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
const ZHIPU_PRO = { provider: 'zhipu', model: 'glm-5.3' }

function breaker(threshold = 3): ProviderBreaker {
  return new ProviderBreaker({ threshold, fallback: FALLBACK })
}

test('breaker stays closed below the threshold', () => {
  const circuit = breaker(3)
  circuit.record('zhipu', false)
  circuit.record('zhipu', false)
  assert.deepEqual(circuit.routeFor(ZHIPU_PRO), { route: ZHIPU_PRO, degraded: false })
  assert.deepEqual(circuit.trippedProviders(), [])
})

test('breaker trips after threshold consecutive failures and degrades routes', () => {
  const circuit = breaker(3)
  for (let i = 0; i < 3; i++) circuit.record('zhipu', false)
  assert.deepEqual(circuit.routeFor(ZHIPU_PRO), { route: FALLBACK, degraded: true })
  assert.deepEqual(circuit.trippedProviders(), ['zhipu'])
})

test('a single success resets the failure count', () => {
  const circuit = breaker(3)
  circuit.record('zhipu', false)
  circuit.record('zhipu', false)
  circuit.record('zhipu', true)
  circuit.record('zhipu', false)
  assert.equal(circuit.tripped('zhipu'), false)
})

test('the fallback provider never degrades to itself', () => {
  const circuit = breaker(1)
  circuit.record('deepseek-official', false)
  assert.deepEqual(circuit.routeFor(FALLBACK), { route: FALLBACK, degraded: false })
  assert.equal(circuit.retryRoute(FALLBACK), undefined)
})

test('retryRoute offers the fallback only for other providers', () => {
  const circuit = breaker(3)
  assert.deepEqual(circuit.retryRoute(ZHIPU_PRO), FALLBACK)
  assert.equal(circuit.retryRoute(undefined), undefined)
})

test('undefined primary routes inherit unchanged', () => {
  const circuit = breaker(1)
  assert.deepEqual(circuit.routeFor(undefined), { route: undefined, degraded: false })
})

function prFile(filename: string, patch = '@@ -1,1 +1,2 @@\n+x'): PrFile {
  return { filename, status: 'modified', additions: 3, deletions: 1, patch }
}

function prData(): PrData {
  return {
    title: 'fix: increment', body: '', htmlUrl: 'https://github.com/o/r/pull/9',
    headSha: 'head', baseSha: 'base', files: [prFile('src/full.ts')], skippedFileCount: 0,
  }
}

test('renderIncrementalContext shows only the since-files and wraps the title', () => {
  const context = renderIncrementalContext({ owner: 'o', repo: 'r', number: 9 }, prData(), [prFile('src/new.ts')])
  assert.ok(context.includes('incremental since prior review'))
  assert.ok(context.includes('Changed since previous review (1 file(s))'))
  assert.ok(context.includes('### src/new.ts'))
  assert.ok(!context.includes('src/full.ts'))
  assert.ok(context.includes('<untrusted-data source="title'))
})
