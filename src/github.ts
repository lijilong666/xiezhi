/**
 * GitHub PR ingestion over the public REST API: ref parsing, paginated file
 * listing, and budget-bounded diff assembly. Token optional via GITHUB_TOKEN.
 * @module xiezhi/github
 */

export interface PrRef {
  readonly owner: string
  readonly repo: string
  readonly number: number
}

export interface PrFile {
  readonly filename: string
  readonly status: string
  readonly additions: number
  readonly deletions: number
  readonly patch?: string
}

export interface PrData {
  readonly title: string
  readonly body: string
  readonly htmlUrl: string
  readonly files: readonly PrFile[]
  readonly skippedFileCount: number
}

const MAX_FILES = 60
const MAX_PATCH_CHARS_PER_FILE = 8000
const MAX_TOTAL_PATCH_CHARS = 60000
const MAX_BODY_CHARS = 2000
const SKIP_PATTERN = /(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|\.min\.(js|css)$|\/dist\/|\/vendor\/|\.snap$)/

export function parsePrRef(input: string): PrRef {
  const trimmed = input.trim()
  const urlMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(trimmed)
  if (urlMatch) return { owner: urlMatch[1], repo: urlMatch[2], number: Number(urlMatch[3]) }
  const shortMatch = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(trimmed)
  if (shortMatch) return { owner: shortMatch[1], repo: shortMatch[2], number: Number(shortMatch[3]) }
  throw new Error(`Cannot parse PR reference: ${input} (expected "owner/repo#123" or a github.com PR URL)`)
}

async function ghFetch(path: string, signal: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'xiezhi',
  }
  const token = process.env.GITHUB_TOKEN
  if (token !== undefined && token !== '') headers.Authorization = `Bearer ${token}`
  const response = await fetch(`https://api.github.com${path}`, { headers, signal })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} on ${path}: ${await response.text()}`)
  }
  return response.json()
}

/** Post the review report as one PR review comment; requires GITHUB_TOKEN. */
export async function postReviewComment(ref: PrRef, body: string, signal: AbortSignal): Promise<string> {
  const token = process.env.GITHUB_TOKEN
  if (token === undefined || token === '') {
    throw new Error('post: comment requires GITHUB_TOKEN in the environment (read+write on pull requests)')
  }
  const response = await fetch(`https://api.github.com/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'xiezhi',
    },
    body: JSON.stringify({ body, event: 'COMMENT' }),
    signal,
  })
  if (!response.ok) {
    throw new Error(`GitHub API ${response.status} posting review: ${await response.text()}`)
  }
  const result = await response.json() as { html_url?: string }
  if (result.html_url === undefined) throw new Error('GitHub API posted the review but returned no html_url')
  return result.html_url
}

/** Fetch PR metadata plus changed files within the review budget. */
export async function fetchPullRequest(refInput: string, signal: AbortSignal): Promise<{ ref: PrRef, data: PrData }> {
  const ref = parsePrRef(refInput)
  const base = `/repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`
  const meta = await ghFetch(base, signal) as { title: string, body: string | null, html_url: string }
  if (meta.title === undefined) throw new Error(`PR not found: ${refInput}`)

  const files: PrFile[] = []
  for (let page = 1; page <= 3; page++) {
    const batch = await ghFetch(`${base}/files?per_page=100&page=${page}`, signal) as PrFile[]
    if (!Array.isArray(batch) || batch.length === 0) break
    files.push(...batch)
    if (batch.length < 100) break
  }

  const accepted: PrFile[] = []
  let skipped = 0
  let totalPatchChars = 0
  for (const file of files) {
    if (accepted.length >= MAX_FILES) { skipped++; continue }
    if (SKIP_PATTERN.test(file.filename)) { skipped++; continue }
    if (file.patch === undefined) { skipped++; continue }
    let patch = file.patch.length > MAX_PATCH_CHARS_PER_FILE
      ? `${file.patch.slice(0, MAX_PATCH_CHARS_PER_FILE)}\n… (patch truncated)`
      : file.patch
    if (totalPatchChars + patch.length > MAX_TOTAL_PATCH_CHARS) {
      patch = patch.slice(0, Math.max(0, MAX_TOTAL_PATCH_CHARS - totalPatchChars))
      accepted.push({ ...file, patch })
      skipped = files.length - accepted.length
      break
    }
    totalPatchChars += patch.length
    accepted.push({ ...file, patch })
  }

  return {
    ref,
    data: {
      title: meta.title,
      body: (meta.body ?? '').slice(0, MAX_BODY_CHARS),
      htmlUrl: meta.html_url,
      files: accepted,
      skippedFileCount: Math.max(skipped, files.length - accepted.length),
    },
  }
}

/** Render the PR as one bounded markdown context block for reviewers. */
export function renderPrContext(ref: PrRef, data: PrData): string {
  const sections = data.files.map(file =>
    `### ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})\n\`\`\`diff\n${file.patch}\n\`\`\``)
  const skippedNote = data.skippedFileCount > 0
    ? `\n(${data.skippedFileCount} files skipped: budget or filter)` : ''
  return [
    `## Pull request: ${data.title}`,
    data.htmlUrl,
    data.body === '' ? '' : `## Description\n${data.body}`,
    `## Changed files${skippedNote}`,
    sections.join('\n\n'),
  ].filter(part => part !== '').join('\n\n')
}
