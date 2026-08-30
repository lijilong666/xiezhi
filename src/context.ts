/**
 * Data-plane repository context: full content of the most-changed files at
 * the PR head ref, fetched from the GitHub contents API and rendered into
 * the reviewer prompt under a budget. The agentic follow-up (reviewers with
 * read tools over a checkout) targets the CI path; this module works
 * everywhere with zero checkout.
 * @module xiezhi/context
 */

import type { PrFile, PrRef } from './github.ts'

const MAX_CONTEXT_FILES = 10
const MAX_CHARS_PER_FILE = 16_000
const MAX_TOTAL_CHARS = 48_000

export interface RepoFileContent {
  readonly filename: string
  readonly content: string
}

const FENCE_LANGUAGE: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', java: 'java', go: 'go', rs: 'rust', rb: 'ruby', php: 'php',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  sql: 'sql', sh: 'bash', ps1: 'powershell', yml: 'yaml', yaml: 'yaml', json: 'json', md: 'markdown',
}

function fenceLanguage(filename: string): string {
  const extension = filename.slice(filename.lastIndexOf('.') + 1)
  return FENCE_LANGUAGE[extension] ?? ''
}

/** Select files worth fetching: skip removals and filters, prefer biggest additions. */
export function selectContextFiles(files: readonly PrFile[], skipPattern: RegExp): readonly PrFile[] {
  return files
    .filter(file => file.status !== 'removed' && !skipPattern.test(file.filename))
    .slice()
    .sort((a, b) => b.additions - a.additions)
    .slice(0, MAX_CONTEXT_FILES)
}

/** Fetch full contents at the head ref; per-file and total budgets apply. */
export async function fetchRepoContext(
  ghFetch: (path: string, signal: AbortSignal) => Promise<unknown>,
  ref: PrRef,
  headSha: string,
  files: readonly PrFile[],
  skipPattern: RegExp,
  signal: AbortSignal,
): Promise<readonly RepoFileContent[]> {
  let totalChars = 0
  const contents: RepoFileContent[] = []
  for (const file of selectContextFiles(files, skipPattern)) {
    if (totalChars >= MAX_TOTAL_CHARS) break
    const path = `/repos/${ref.owner}/${ref.repo}/contents/${encodeURI(file.filename)}?ref=${headSha}`
    let entry: { content?: string, encoding?: string }
    try {
      entry = await ghFetch(path, signal) as { content?: string, encoding?: string }
    } catch {
      continue
    }
    if (entry.encoding !== 'base64' || typeof entry.content !== 'string') continue
    let text: string
    try {
      text = Buffer.from(entry.content.replace(/\n/g, ''), 'base64').toString('utf8')
    } catch {
      continue
    }
    if (text.length > MAX_CHARS_PER_FILE) text = `${text.slice(0, MAX_CHARS_PER_FILE)}\n… (file truncated)`
    if (totalChars + text.length > MAX_TOTAL_CHARS) {
      text = text.slice(0, Math.max(0, MAX_TOTAL_CHARS - totalChars))
    }
    totalChars += text.length
    contents.push({ filename: file.filename, content: text })
    if (totalChars >= MAX_TOTAL_CHARS) break
  }
  return contents
}

/**
 * Render the repository-context markdown section; pure over its inputs.
 * @param contents - fetched file contents in fetch order.
 * @returns one bounded markdown section, or an empty string when nothing was fetched.
 */
export function renderRepoContext(contents: readonly RepoFileContent[]): string {
  if (contents.length === 0) return ''
  const sections = contents.map(({ filename, content }) =>
    `### ${filename}\n\`\`\`${fenceLanguage(filename)}\n${content}\n\`\`\``)
  return ['## Full content of changed files at the PR head', ...sections].join('\n\n')
}
