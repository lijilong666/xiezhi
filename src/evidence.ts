/**
 * Evidence Pack types and deterministic publication checks.
 * @module xiezhi/evidence
 */

import type { Finding, Severity } from './schema.ts'

export type VerificationStatus = 'confirmed' | 'plausible' | 'inconclusive' | 'rejected'
export type EvidenceKind = 'diff' | 'intent' | 'repository' | 'static' | 'test'

export interface EvidenceReference {
  readonly kind: EvidenceKind
  readonly path?: string
  readonly line?: number
  readonly detail: string
}

export interface VerificationChecklist {
  readonly locationAnchored: boolean
  readonly triggerExplained: boolean
  readonly impactExplained: boolean
  readonly evidenceSufficient: boolean
}

export interface EvidencePack {
  readonly status: VerificationStatus
  readonly claim: string
  readonly trigger: string
  readonly impact: string
  readonly evidence: readonly EvidenceReference[]
  readonly checklist: VerificationChecklist
  readonly reason: string
}

export interface ChecklistVerdict extends EvidencePack {
  readonly index: number
  readonly severity?: Severity
}

export interface EvidenceBackedFinding extends Finding {
  readonly evidencePack: EvidencePack
}

export type DiffAnchorValidator = (path: string, line: number) => boolean

/** Require a confirmed verdict, a complete checklist, and direct nearby diff evidence. */
export function isPublishableVerdict(verdict: ChecklistVerdict, finding: Finding, isChangedLine: DiffAnchorValidator): boolean {
  const checklist = verdict.checklist
  if (verdict.status !== 'confirmed'
    || !checklist.locationAnchored
    || !checklist.triggerExplained
    || !checklist.impactExplained
    || !checklist.evidenceSufficient) return false
  if (verdict.claim.trim() === '' || verdict.trigger.trim() === '' || verdict.impact.trim() === '') return false
  return verdict.evidence.some(reference =>
    reference.kind === 'diff'
    && reference.path === finding.file
    && reference.line !== undefined
    && Math.abs(reference.line - finding.line) <= 3
    && isChangedLine(reference.path, reference.line)
    && reference.detail.trim() !== '')
}

/** Render a compact, auditable Evidence Pack for reports and inline comments. */
export function renderEvidencePack(pack: EvidencePack): readonly string[] {
  const evidence = pack.evidence.map(reference => {
    const location = reference.path === undefined
      ? ''
      : ` \`${reference.path}${reference.line === undefined ? '' : `:${reference.line}`}\``
    return `- ${reference.kind}${location}: ${reference.detail}`
  })
  return [
    '**Evidence Pack**',
    `- Status: ${pack.status}`,
    `- Claim: ${pack.claim}`,
    `- Trigger: ${pack.trigger}`,
    `- Impact: ${pack.impact}`,
    '- Evidence:',
    ...evidence.map(line => `  ${line}`),
    `- Verifier: ${pack.reason}`,
  ]
}
