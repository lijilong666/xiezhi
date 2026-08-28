/**
 * Structured findings contract shared by every reviewer role.
 * Field names align with public benchmark truth formats
 * (file/line/severity/category) so evaluation adapters stay trivial.
 * @module xiezhi/schema
 */

import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools'

export type Severity = 'critical' | 'major' | 'minor' | 'info'

export interface Finding {
  readonly file: string
  readonly line: number
  readonly severity: Severity
  readonly category: string
  readonly title: string
  readonly description: string
  readonly suggestion?: string
}

export interface FindingsOutput {
  readonly findings: readonly Finding[]
}

/**
 * Object-rooted JSON Schema within the enforced subset accepted by
 * `ctx.subagents.start({ outputSchema })`. Every reviewer subagent must
 * terminate with this shape.
 */
export const FINDINGS_OUTPUT_SCHEMA: ObjectJsonSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          file: { type: 'string', description: 'Changed file path as shown in the diff header' },
          line: { type: 'integer', description: 'Line number in the new file version' },
          severity: { type: 'string', enum: ['critical', 'major', 'minor', 'info'] },
          category: { type: 'string', description: 'Short category tag, e.g. logic, security, tests, style' },
          title: { type: 'string', description: 'One-line summary of the issue' },
          description: { type: 'string', description: 'What is wrong and why, citing the diff' },
          suggestion: { type: 'string', description: 'Concrete fix direction' },
        },
        required: ['file', 'line', 'severity', 'category', 'title', 'description'],
      },
    },
  },
  required: ['findings'],
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, major: 1, minor: 2, info: 3 }

/** Stable order: severity first, then file, then line. */
export function compareFindings(a: Finding, b: Finding): number {
  return SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
    || a.file.localeCompare(b.file)
    || a.line - b.line
}

/** Narrow the schema-validated `structured` payload to typed findings. */
export function asFindingsOutput(value: unknown): FindingsOutput | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const findings = (value as { findings?: unknown }).findings
  if (!Array.isArray(findings)) return undefined
  return { findings: findings as readonly Finding[] }
}

/** A finding attributed to the roles that reported it. */
export interface AggregatedFinding extends Finding {
  readonly roles: readonly string[]
}

const LINE_MERGE_WINDOW = 3

/**
 * Deterministic dedup: same file with lines within the merge window collapse
 * into one entry carrying the union of roles, the most severe severity, and
 * the most specific category. Order is stable per {@link compareFindings}.
 */
export function aggregateFindings(candidates: readonly { role: string, finding: Finding }[]): readonly AggregatedFinding[] {
  const sorted = [...candidates].sort((a, b) => compareFindings(a.finding, b.finding))
  const merged: AggregatedFinding[] = []
  for (const { role, finding } of sorted) {
    const target = merged.find(existing =>
      existing.file === finding.file
      && Math.abs(existing.line - finding.line) <= LINE_MERGE_WINDOW)
    if (target === undefined) {
      merged.push({ ...finding, roles: [role] })
      continue
    }
    if (!target.roles.includes(role)) target.roles = [...target.roles, role]
    if (compareFindings(finding, target) < 0) {
      Object.assign(target, finding, { roles: target.roles })
    }
  }
  return merged
}
