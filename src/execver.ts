/**
 * Executable verification: deterministic TypeScript type-checking across the
 * base/head snapshots. The verifier LLM never receives a shell — this module
 * runs the plugin-resolved `tsc` with a fixed flag set and upgrades plausible
 * critical/major candidates to executed-proof confirmations only when the PR
 * itself introduces a new compiler error in the cited file (base clean, head
 * error). Missing-dependency noise cancels because it appears identically on
 * both sides; environment failures downgrade to "not executed" and never
 * confirm or reject a finding on their own.
 * @module xiezhi/execver
 */

import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { EvidenceStore } from './evidence-tools.ts'
import type { Candidate, VerifiedFinding } from './verify.ts'

const run = promisify(execFile)

export type ExecVerStatus = 'off' | 'ran' | 'env-failed'

export interface ExecVerOutcome {
  readonly status: ExecVerStatus
  readonly reason?: string
  readonly upgrades: readonly VerifiedFinding[]
  readonly summary: string
}

export interface TscError {
  readonly file: string
  readonly line: number
  readonly message: string
}

const TSC_TIMEOUT_MS = 180_000
const MAX_ERRORS_KEPT = 400

/** Resolve the plugin's own TypeScript compiler; throws when not installed. */
export function resolveTscBin(): string {
  return createRequire(import.meta.url).resolve('typescript/lib/tsc.js')
}

/** A TypeScript project is executable-checkable when a root tsconfig exists. */
export function detectTsProject(store: EvidenceStore): boolean {
  return existsSync(join(store.rootDir, 'tsconfig.json'))
}

/**
 * Parse `tsc --pretty false` output into normalized errors.
 * @param stdout - raw compiler output.
 * @param rootDir - snapshot root to relativize absolute paths against.
 * @returns parsed errors (path, 1-based line, message), capped.
 */
export function parseTscOutput(stdout: string, rootDir: string): readonly TscError[] {
  const errors: TscError[] = []
  const normalizedRoot = rootDir.replace(/\\/g, '/')
  for (const match of stdout.matchAll(/^(.+?)\((\d+),(?:\d+)\): error (TS\d+: .+)$/gm)) {
    const file = match[1]!.replace(/\\/g, '/').replace(normalizedRoot + '/', '')
    errors.push({ file, line: Number(match[2]), message: match[3]!.slice(0, 300) })
    if (errors.length >= MAX_ERRORS_KEPT) break
  }
  return errors
}

function errorKey(error: TscError): string {
  return `${error.file}:${error.line}:${error.message}`
}

/** Errors present at head but absent at base — what the PR introduced. */
export function diffErrors(base: readonly TscError[], head: readonly TscError[]): readonly TscError[] {
  const baseKeys = new Set(base.map(errorKey))
  return head.filter(error => !baseKeys.has(errorKey(error)))
}

async function runTsc(rootDir: string, signal: AbortSignal): Promise<{ errors: readonly TscError[] }> {
  try {
    const { stdout } = await run(process.execPath, [resolveTscBin(), '--project', join(rootDir, 'tsconfig.json'), '--noEmit', '--pretty', 'false'], { timeout: TSC_TIMEOUT_MS, signal, maxBuffer: 16 * 1024 * 1024 })
    return { errors: parseTscOutput(stdout, rootDir) }
  } catch (error) {
    // tsc exits non-zero when it found errors; that failure still carries stdout.
    // A numeric exit code separates a finished compiler run from abort/ENOENT/timeout.
    const failure = error as { stdout?: string, code?: number | string }
    if (typeof failure.stdout === 'string' && typeof failure.code === 'number') return { errors: parseTscOutput(failure.stdout, rootDir) }
    throw error
  }
}

function buildExecutedFinding(candidate: Candidate, error: TscError): VerifiedFinding {
  return {
    role: candidate.role,
    finding: {
      ...candidate.finding,
      evidencePack: {
        status: 'confirmed',
        proofLevel: 'executed',
        artifact: `tsc ${error.message} (${error.file}:${error.line}) — absent at base, present at head`,
        claim: candidate.finding.title,
        trigger: 'TypeScript compiler check at the PR head snapshot',
        impact: error.message,
        evidence: [{ kind: 'static', path: error.file, line: error.line, detail: `compiler: ${error.message}` }],
        checklist: { locationAnchored: true, triggerExplained: true, impactExplained: true, evidenceSufficient: true },
        reason: 'executable verification: base/head tsc diff proves the PR introduces this error',
      },
    },
  }
}

/**
 * Run the deterministic tsc base/head diff and upgrade matching plausible
 * candidates to executed-proof confirmations.
 * @param candidates - plausible critical/major candidates from the LLM gate.
 * @param headStore - head snapshot (must contain tsconfig.json).
 * @param baseStore - base snapshot for differencing.
 * @param signal - cancellation shared with the review.
 * @returns status plus the upgraded findings and a human-readable summary.
 */
export async function executeVerification(candidates: readonly Candidate[], headStore: EvidenceStore, baseStore: EvidenceStore, signal: AbortSignal): Promise<ExecVerOutcome> {
  if (!detectTsProject(headStore)) {
    return { status: 'off', reason: 'no root tsconfig.json', upgrades: [], summary: 'execver: off — no root tsconfig.json (non-TypeScript project)' }
  }
  let head: readonly TscError[]
  let base: readonly TscError[]
  try {
    const [baseRun, headRun] = await Promise.all([runTsc(baseStore.rootDir, signal), runTsc(headStore.rootDir, signal)])
    base = baseRun.errors
    head = headRun.errors
  } catch (error) {
    return { status: 'env-failed', reason: String(error).slice(0, 160), upgrades: [], summary: `execver: env-failed (${String(error).slice(0, 120)}) — verdicts unchanged, evidence level not affected` }
  }
  const introduced = diffErrors(base, head)
  const upgrades: VerifiedFinding[] = []
  for (const candidate of candidates) {
    const match = introduced.find(error => error.file === candidate.finding.file)
    if (match !== undefined) upgrades.push(buildExecutedFinding(candidate, match))
  }
  const upgradedRoles = upgrades.map(upgrade => upgrade.role).join(', ')
  return {
    status: 'ran',
    upgrades,
    summary: `execver: tsc ran — base ${base.length} error(s), head ${head.length}, introduced ${introduced.length}; upgraded ${upgrades.length}/${candidates.length} plausible candidate(s)${upgrades.length > 0 ? ` (${upgradedRoles})` : ''}`,
  }
}
