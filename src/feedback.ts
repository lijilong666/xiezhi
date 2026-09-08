/**
 * Transparent feedback suppression: developer-dismissed categories of
 * findings are filtered at the publishing boundary by explicit, editable
 * cordis.yml rules (file glob + optional category). Nothing is learned or
 * hidden — the report always states how many findings each rule suppressed.
 * @module xiezhi/feedback
 */

export interface SuppressionRule {
  readonly filePattern: string
  readonly category?: string
  readonly reason: string
}

export interface SuppressionMatch {
  readonly rule: SuppressionRule
  readonly finding: { readonly file: string, readonly category: string, readonly title: string, readonly severity: string }
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\{([^{}]+)\}/g, (_match, group: string) => `(?:${group.split(',').join('|')})`)
    .replace(/\*\*\//g, '\u0001')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/\u0001/g, '(?:[^/]*/)*')
    .replace(/\u0000/g, '.*')
  return new RegExp(`^${source}$`)
}

/**
 * Split findings into (kept, suppressed); the first matching rule wins and is recorded per finding.
 * @param findings - aggregated findings headed for the report.
 * @param rules - transparent suppression rules from cordis.yml.
 * @returns kept findings plus the suppressed ones with the rule that caught them.
 */
export function applySuppressions(
  findings: readonly SuppressionMatch['finding'][],
  rules: readonly SuppressionRule[],
): { kept: readonly SuppressionMatch['finding'][], suppressed: readonly SuppressionMatch[] } {
  const compiled = rules.map(rule => ({ rule, regex: globToRegExp(rule.filePattern) }))
  const kept: SuppressionMatch['finding'][] = []
  const suppressed: SuppressionMatch[] = []
  for (const finding of findings) {
    const hit = compiled.find(({ rule, regex }) => regex.test(finding.file) && (rule.category === undefined || rule.category === finding.category))
    if (hit === undefined) kept.push(finding)
    else suppressed.push({ rule: hit.rule, finding })
  }
  return { kept, suppressed }
}

/** Render the suppression accounting line(s) for the report. */
export function renderSuppressionSection(suppressed: readonly SuppressionMatch[]): readonly string[] {
  if (suppressed.length === 0) return []
  const byReason = new Map<string, number>()
  for (const { rule } of suppressed) {
    const key = `${rule.filePattern}${rule.category === undefined ? '' : ` [${rule.category}]`}`
    byReason.set(key, (byReason.get(key) ?? 0) + 1)
  }
  return ['## Suppressed by feedback rules', ...[...byReason.entries()].map(([key, count]) => `- ${key}: ${count}`)]
}
