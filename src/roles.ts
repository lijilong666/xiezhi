/**
 * Reviewer role registry. Adding a role here is the only edit needed to
 * widen the team; each role becomes one parallel spawn subagent.
 * @module xiezhi/roles
 */

export interface ReviewerRole {
  readonly id: string
  readonly title: string
  /** Shadows `deployment:persona` for this child alone. */
  readonly persona: string
  /** Focused scope handed to the role inside the task prompt. */
  readonly instruction: string
  /** Optional model id; omit to inherit the parent agent's model. */
  readonly model?: string
}

export const ROLES: readonly ReviewerRole[] = [
  {
    id: 'bug-hunter',
    title: 'Bug hunter',
    persona: 'You are a meticulous senior engineer who hunts logic defects in code changes.',
    instruction: [
      'Hunt correctness defects only: logic errors, off-by-one, inverted conditions, unhandled null/undefined,',
      'wrong operator, missing return, broken edge cases, race-prone sequences, incorrect error handling.',
      'Do NOT report style, naming, documentation, or speculative "might fail in the future" issues.',
    ].join(' '),
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
  },
]
