/**
 * Reviewer role registry. Adding a role here is the only edit needed to
 * widen the team; each role becomes one parallel spawn subagent. The
 * optional route implements cost-aware routing: deep reasoning roles pin
 * the pro model, high-volume mechanical roles pin the flash model.
 * @module xiezhi/roles
 */

export interface ModelRoute {
  readonly provider: string
  readonly model: string
}

export interface ReviewerRole {
  readonly id: string
  readonly title: string
  /** Shadows `deployment:persona` for this child alone. */
  readonly persona: string
  /** Focused scope handed to the role inside the task prompt. */
  readonly instruction: string
  /** Explicit provider/model route; omit to inherit the parent agent's. */
  readonly route?: ModelRoute
  /** Cheaper same-family route the planner uses for the flash model tier. */
  readonly flashRoute?: ModelRoute
}

/** The verification gate's route: high volume, mechanical evidence checks. */
export const VERIFIER_ROUTE: ModelRoute = { provider: 'zhipu', model: 'glm-5.3-flash' }

export const ROLES: readonly ReviewerRole[] = [
  {
    id: 'bug-hunter',
    title: 'Bug hunter',
    persona: 'You are a meticulous senior engineer who hunts logic defects in code changes.',
    instruction: [
      'Hunt correctness defects only: logic errors, off-by-one, inverted conditions, unhandled null/undefined,',
      'wrong operator, missing return, broken edge cases, race-prone sequences, incorrect error handling,',
      'and tests that fail to exercise the change they claim to cover.',
      'Do NOT report style, naming, documentation, or speculative "might fail in the future" issues.',
    ].join(' '),
    route: { provider: 'zhipu', model: 'glm-5.3' },
    flashRoute: { provider: 'zhipu', model: 'glm-5.3-flash' },
  },
  {
    id: 'security',
    title: 'Security scanner',
    persona: 'You are an application security reviewer focused on introduced vulnerabilities.',
    instruction: [
      'Find security regressions only: injection (command/SQL/path), broken authorization checks, secrets or',
      'credentials in the diff, unsafe deserialization, weak cryptography, SSRF, unsanitized input reaching sinks.',
      'Do NOT report generic robustness or style issues.',
    ].join(' '),
    route: { provider: 'zhipu', model: 'glm-5.3' },
    flashRoute: { provider: 'zhipu', model: 'glm-5.3-flash' },
  },
  {
    id: 'nitpicker',
    title: 'Nitpicker',
    persona: 'You are a fastidious maintainer who flags small quality issues in code changes.',
    instruction: [
      'Flag mechanical quality issues only: misleading names, dead code, magic numbers, duplicated logic,',
      'stale comments or docs contradicting the change, missing type narrowing.',
      'Report ONLY info/minor severity. Do NOT report bugs, security issues, or architecture opinions —',
      'other roles own those.',
    ].join(' '),
    route: { provider: 'zhipu', model: 'glm-5.3-flash' },
  },
]
