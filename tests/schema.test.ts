/**
 * aggregateFindings / compareFindings behavior: same-file line-window merge
 * regardless of category, severity precedence, role union, stable order.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aggregateFindings, compareFindings, type Finding } from '../src/schema.ts'

function finding(overrides: Partial<Finding> & { file: string, line: number }): Finding {
  return {
    severity: 'minor',
    category: 'logic',
    title: 't',
    description: 'd',
    ...overrides,
  }
}

test('merges same file and line across categories, keeping the more severe severity and unioning roles', () => {
  const merged = aggregateFindings([
    { role: 'nitpicker', finding: finding({ file: 'a.ts', line: 10, severity: 'minor', category: 'style' }) },
    { role: 'bug-hunter', finding: finding({ file: 'a.ts', line: 10, severity: 'major', category: 'logic' }) },
  ])
  assert.equal(merged.length, 1)
  assert.equal(merged[0]?.severity, 'major')
  assert.equal(merged[0]?.category, 'logic')
  // Candidates are severity-sorted before merging, so the major's role lands first.
  assert.deepEqual([...merged[0]?.roles ?? []], ['bug-hunter', 'nitpicker'])
})

test('merges within the ±3 line window but not beyond', () => {
  const merged = aggregateFindings([
    { role: 'a', finding: finding({ file: 'a.ts', line: 10 }) },
    { role: 'b', finding: finding({ file: 'a.ts', line: 13 }) },
    { role: 'c', finding: finding({ file: 'a.ts', line: 17 }) },
  ])
  assert.equal(merged.length, 2)
})

test('keeps different files apart', () => {
  const merged = aggregateFindings([
    { role: 'a', finding: finding({ file: 'a.ts', line: 10 }) },
    { role: 'b', finding: finding({ file: 'b.ts', line: 10 }) },
  ])
  assert.equal(merged.length, 2)
})

test('orders by severity first, then file, then line', () => {
  const merged = aggregateFindings([
    { role: 'a', finding: finding({ file: 'b.ts', line: 1, severity: 'info' }) },
    { role: 'b', finding: finding({ file: 'a.ts', line: 9, severity: 'minor' }) },
    { role: 'c', finding: finding({ file: 'a.ts', line: 2, severity: 'critical' }) },
  ])
  assert.deepEqual(merged.map(entry => entry.severity), ['critical', 'minor', 'info'])
  assert.deepEqual(merged.map(entry => entry.line), [2, 9, 1])
})

test('compareFindings ranks critical above info', () => {
  assert.ok(compareFindings(finding({ file: 'x', line: 1, severity: 'critical' }), finding({ file: 'x', line: 1, severity: 'info' })) < 0)
})
