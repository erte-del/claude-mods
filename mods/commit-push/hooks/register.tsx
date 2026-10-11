import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { CommitPushRun } from '../types'

export const IDLE: CommitPushRun = {
  phase: 'idle',
  step: '',
  repo: '',
  branch: '',
  message: '',
  sha: '',
  target: '',
  summary: '',
  detail: '',
}

const run = atom({ plugin: 'commit-push', key: 'run' } as const, IDLE)

const TYPES = 'feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert'
const RULES = `You write git commit messages. Reply with ONE line only: a conventional commit subject,
"<type>(<optional scope>): <summary>", type one of ${TYPES.split('|').join(', ')}.
Imperative mood, lower case after the colon, no trailing period, at most 72 characters.
Describe what the change does, not which files changed. No quotes, no code fences, nothing else.`

// ---- git side:  Plain `git` calls through $.process.run, so it behaves the same on
// Windows, macOS and Linux. Never force-pushes; stops on conflicts, a merge/rebase in progress,
// a detached HEAD, or a branch that is behind its upstream.

const MAX_DIFF = 30000

export type Prepared = {
  ok: true
  repo: string
  branch: string
  upstream: string | null
  stat: string
  names: string
  diff: string
  truncated: boolean
}
export type Refused = { ok: false; kind: 'nothing' | 'blocked' | 'error'; error: string }
export type Committed = { ok: true; sha: string; branch: string; target: string; setUpstream: boolean; output: string }
export type Failed = { ok: false; stage: 'commit' | 'push'; sha?: string; target?: string; error: string; hint?: string }

type Out = { code: number; out: string; err: string; text: string }

// One git call: stdout and stderr kept apart, `text` is both (stderr carries push/fetch errors).
async function git($: any, cwd: string, args: string[], stdin?: string): Promise<Out> {
  try {
    const r = await $.process.run(['git', ...args], { cwd, stdin, timeoutMs: 120000, env: { GIT_TERMINAL_PROMPT: '0' } })
    const out = String(r.stdout ?? '').trim()
    const err = String(r.stderr ?? '').trim()
    return { code: r.exitCode, out, err, text: [err, out].filter(Boolean).join('\n') }
  } catch (e: any) {
    const err = String(e?.message ?? e)
    return { code: 127, out: '', err, text: err }
  }
}

const refuse = (kind: Refused['kind'], error: string): Refused => ({ ok: false, kind, error })

const IN_PROGRESS: [string, string][] = [
  ['MERGE_HEAD', 'a merge'],
  ['rebase-merge', 'a rebase'],
  ['rebase-apply', 'a rebase'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick'],
  ['REVERT_HEAD', 'a revert'],
]

async function upstreamOf($: any, repo: string): Promise<string | null> {
  const u = await git($, repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
  return u.code === 0 && u.out ? u.out : null
}

// Checks the repo, stages everything (git add -A) and returns the staged diff.
export async function prepare($: any, dir: string): Promise<Prepared | Refused> {
  const top = await git($, dir, ['rev-parse', '--show-toplevel'])
  if (top.code === 127) return refuse('error', `git is not installed or not on PATH (${top.err})`)
  if (top.code !== 0 || !top.out) return refuse('error', `not a git repository: ${dir}`)
  const repo = top.out

  const gitDir = (await git($, repo, ['rev-parse', '--absolute-git-dir'])).out
  for (const [file, what] of IN_PROGRESS) {
    if (gitDir && (await $.fs.exists(`${gitDir}/${file}`))) {
      return refuse('blocked', `${what} is in progress. Finish or abort it yourself, then try again.`)
    }
  }
  const unmerged = (await git($, repo, ['diff', '--name-only', '--diff-filter=U'])).out
  if (unmerged) {
    const files = unmerged.split('\n').slice(0, 10).join(', ')
    return refuse('blocked', `unresolved merge conflicts in: ${files}. Resolve them yourself, then try again.`)
  }

  const head = await git($, repo, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (head.code !== 0 || !head.out) return refuse('blocked', 'HEAD is detached (not on a branch). Check out a branch first.')
  const branch = head.out

  const status = await git($, repo, ['status', '--porcelain'])
  if (!status.out) return refuse('nothing', `nothing to commit on ${branch} (working tree clean)`)

  const upstream = await upstreamOf($, repo)
  if (upstream) {
    const configured = await git($, repo, ['config', '--get', `branch.${branch}.remote`])
    const remote = configured.out || upstream.split('/')[0]
    const fetched = await git($, repo, ['fetch', '--quiet', remote as string])
    if (fetched.code !== 0) {
      return refuse('error', `couldn't fetch ${remote} to check whether ${branch} is behind: ${fetched.text}`)
    }
    const behind = Number((await git($, repo, ['rev-list', '--count', 'HEAD..@{u}'])).out) || 0
    if (behind > 0) {
      return refuse(
        'blocked',
        `${branch} is behind ${upstream} by ${behind} commit(s). Pull (and resolve any conflicts) yourself, then try again. Nothing was staged or committed.`,
      )
    }
  }

  const add = await git($, repo, ['add', '-A'])
  if (add.code !== 0) return refuse('error', `git add -A failed: ${add.text}`)

  const stat = (await git($, repo, ['diff', '--cached', '--stat'])).out
  if (!stat) return refuse('nothing', `nothing to commit on ${branch} (only ignored or no staged changes)`)
  const names = (await git($, repo, ['diff', '--cached', '--name-status'])).out
  let diff = (await git($, repo, ['-c', 'core.quotepath=off', 'diff', '--cached', '--no-color', '--no-ext-diff'])).out
  const truncated = diff.length > MAX_DIFF
  if (truncated) diff = diff.slice(0, MAX_DIFF)
  return { ok: true, repo, branch, upstream, stat, names, diff, truncated }
}

export function pushHint(text: string): string | undefined {
  if (/rejected|non-fast-forward|fetch first|Updates were rejected/i.test(text)) {
    return 'The remote has commits you do not have. Pull (and resolve any conflicts) yourself, then push again. Nothing was force-pushed.'
  }
  if (/Could not resolve host|unable to access|Failed to connect|timed out|Connection (refused|reset)|network/i.test(text)) {
    return 'Network problem reaching the remote. The commit is saved locally; push again once you are online.'
  }
  if (/Authentication failed|Permission denied|403|401|could not read Username|terminal prompts disabled|denied to/i.test(text)) {
    return 'Authentication problem. Sign in to git (e.g. gh auth login, or the Git Credential Manager), then push again.'
  }
  if (/protected branch|hook declined|pre-receive/i.test(text)) {
    return 'The remote refused the push (protected branch or server hook).'
  }
  return undefined
}

// Commits what prepare() staged with `message`, then pushes (-u when there is no upstream yet).
export async function commitAndPush($: any, repo: string, message: string): Promise<Committed | Failed> {
  const head = await git($, repo, ['symbolic-ref', '--short', '-q', 'HEAD'])
  if (head.code !== 0 || !head.out) return { ok: false, stage: 'commit', error: 'HEAD is detached (not on a branch)' }
  const branch = head.out

  const c = await git($, repo, ['commit', '-F', '-', '--cleanup=strip'], `${message.trim()}\n`)
  if (c.code !== 0) return { ok: false, stage: 'commit', error: c.text }
  const sha = (await git($, repo, ['rev-parse', '--short', 'HEAD'])).out

  const upstream = await upstreamOf($, repo)
  let target: string
  let setUpstream = false
  let p: Out
  if (upstream) {
    target = upstream
    p = await git($, repo, ['push'])
  } else {
    const remotes = (await git($, repo, ['remote'])).out.split('\n').filter(Boolean)
    if (remotes.length === 0) {
      return { ok: false, stage: 'push', sha, error: 'this repository has no remote to push to', hint: 'Add one with: git remote add origin <url>' }
    }
    const remote = remotes.includes('origin') ? 'origin' : (remotes[0] as string)
    target = `${remote}/${branch}`
    setUpstream = true
    p = await git($, repo, ['push', '-u', remote, branch])
  }
  if (p.code !== 0) return { ok: false, stage: 'push', sha, target, error: p.text, hint: pushHint(p.text) }
  return { ok: true, sha, branch, target, setUpstream, output: p.text }
}

// Turns the model's reply into one clean conventional-commit line.
export function cleanMessage(reply: string): string {
  const line =
    reply
      .split('\n')
      .map(l => l.trim().replace(/^[`"'*\s]+|[`"'*\s]+$/g, ''))
      .find(l => l.length > 0) ?? ''
  const subject = line.replace(/\.$/, '')
  if (!subject) return ''
  const conventional = new RegExp(`^(${TYPES})(\\([^)]+\\))?!?: \\S`)
  return conventional.test(subject) ? subject : `chore: ${subject}`
}

// Used when the model gives no answer: names what changed from `git diff --name-status`.
export function fallbackMessage(names: string): string {
  const files = names
    .split('\n')
    .map(l => l.split('\t').pop()?.trim() ?? '')
    .filter(Boolean)
    .map(p => p.split('/').pop() as string)
  if (files.length === 0) return 'chore: update files'
  if (files.length <= 3) return `chore: update ${files.join(', ')}`
  return `chore: update ${files.slice(0, 2).join(', ')} and ${files.length - 2} more files`
}

async function writeMessage($: any, p: any): Promise<string> {
  const prompt =
    `Branch: ${p.branch}\n\nFiles:\n${p.names}\n\nStat:\n${p.stat}\n\nDiff${p.truncated ? ' (truncated)' : ''}:\n${p.diff}`
  try {
    const r = await $.model.complete({ model: 'haiku', system: RULES, prompt, maxTokens: 120, effort: 'low', timeoutMs: 45000 })
    if (r.isAnswered) {
      const msg = cleanMessage(r.text)
      if (msg) return msg
    }
  } catch {
    // fall through to the file-based message
  }
  return fallbackMessage(p.names)
}

async function set($: any, patch: Partial<CommitPushRun>): Promise<void> {
  await update($, run, prev => ({ ...(prev ?? IDLE), ...patch }))
}

// The whole click: prepare (checks + git add -A) -> message from Claude -> commit + push.
async function runFlow($: any): Promise<string> {
  const current = await read($, run)
  if (current.phase === 'running') return 'commit-push: already running'

  await update($, run, () => ({ ...IDLE, phase: 'running', step: 'checking git status…' }))
  const dir: string = await $.session.cwd()

  const p: any = await prepare($, dir)
  if (!p.ok) {
    const phase = p.kind === 'nothing' || p.kind === 'blocked' ? p.kind : 'error'
    const summary = phase === 'nothing' ? 'Nothing to commit' : phase === 'blocked' ? 'Stopped, needs you' : 'Failed'
    await set($, { phase, step: '', summary, detail: p.error ?? '' })
    return phase === 'nothing' ? `commit-push: ${p.error}` : `commit-push: ${summary.toLowerCase()} — ${p.error}`
  }

  await set($, { repo: p.repo, branch: p.branch, step: 'writing commit message…' })
  const message = await writeMessage($, p)

  await set($, { message, step: p.upstream ? `committing & pushing to ${p.upstream}…` : 'committing & pushing (setting upstream)…' })
  const c: any = await commitAndPush($, p.repo, message)

  if (c.ok) {
    const summary = `Pushed ${c.sha} → ${c.target}${c.setUpstream ? ' (upstream set)' : ''}`
    await set($, { phase: 'done', step: '', sha: c.sha, target: c.target, summary, detail: '' })
    $.ui.toast(`✓ ${message}`)
    return `commit-push: ${summary}\n  ${message}`
  }
  if (c.stage === 'push') {
    const summary = `Committed ${c.sha} locally, push failed`
    const detail = [c.hint, c.error].filter(Boolean).join('\n')
    await set($, { phase: 'error', step: '', sha: c.sha ?? '', target: c.target ?? '', summary, detail })
    return `commit-push: ${summary}\n  ${message}\n${detail}`
  }
  const summary = 'Commit failed (changes are staged)'
  await set($, { phase: 'error', step: '', summary, detail: c.error ?? '' })
  return `commit-push: ${summary}\n${c.error ?? ''}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'commit-push',
      description: 'Stage all changes in the current repo, commit with a Claude-written message, and push',
    })
    return next(e)
  })

  on('command.run', { command: 'commit-push' }, async $ => ({ text: await runFlow($) }))
}
