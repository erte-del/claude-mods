import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { ActiveRepo, Repo } from '../types'

const PANE = 'repo'
const SHOWN = 100
const LIST_LIMIT = 200
const CACHE_MS = 5 * 60 * 1000

const active = atom({ plugin: 'repo', key: 'active' } as const, null as ActiveRepo | null)
const matches = atom({ plugin: 'repo', key: 'matches' } as const, [] as Repo[])
const status = atom({ plugin: 'repo', key: 'status' } as const, '')
const busy = atom({ plugin: 'repo', key: 'busy' } as const, false)

type Options = { owner?: string; cloneDir?: string; openOnStart?: boolean }
let opts: Options = {}

// The repo list and the gh login, cached for a few minutes (module-level: a reload just refetches).
let cache: { owner: string; at: number; repos: Repo[] } | null = null
let ghLogin: string | null = null

type Out = { code: number; out: string; err: string }

async function run($: any, argv: string[], cwd?: string, timeoutMs = 60000): Promise<Out> {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: '0' } })
    return { code: r.exitCode, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim() }
  } catch (e: any) {
    return { code: 127, out: '', err: String(e?.message ?? e) }
  }
}

async function home($: any): Promise<string> {
  const h: string | undefined = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return (h ?? '').replace(/[\\/]+$/, '')
}

const join = (base: string, ...parts: string[]) => {
  const sep = base.includes('\\') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

async function tilde($: any, path: string): Promise<string> {
  const h = await home($)
  return h && path.toLowerCase().startsWith(h.toLowerCase()) ? `~${path.slice(h.length)}` : path
}

// Whose repos to list: the `owner` setting, else whoever is logged in to gh.
async function owner($: any): Promise<string> {
  if (opts.owner?.trim()) return opts.owner.trim()
  if (ghLogin) return ghLogin
  const r = await run($, ['gh', 'api', 'user', '--jq', '.login'])
  if (r.code === 127) throw new Error('the GitHub CLI (gh) is not installed or not on PATH')
  if (r.code !== 0 || !r.out) throw new Error(`gh is not logged in (run: gh auth login)${r.err ? ` — ${r.err}` : ''}`)
  ghLogin = r.out
  return ghLogin
}

async function listRepos($: any): Promise<Repo[]> {
  const who = await owner($)
  const now = await $.clock.now()
  if (cache && cache.owner === who && now - cache.at < CACHE_MS) return cache.repos
  const r = await run($, ['gh', 'repo', 'list', who, '--limit', String(LIST_LIMIT), '--json', 'name,description,isPrivate'])
  if (r.code !== 0) {
    if (/auth|login|token/i.test(r.err)) throw new Error(`gh is not authenticated (run: gh auth login) — ${r.err}`)
    throw new Error(`gh repo list failed: ${r.err || r.out}`)
  }
  const repos: Repo[] = (JSON.parse(r.out || '[]') as any[]).map(x => ({
    name: String(x.name),
    description: String(x.description ?? ''),
    isPrivate: Boolean(x.isPrivate),
  }))
  cache = { owner: who, at: now, repos }
  return repos
}

// Lower is better; null means no match.
export function score(q: string, repo: Repo): number | null {
  const name = repo.name.toLowerCase()
  const desc = repo.description.toLowerCase()
  if (name === q) return 0
  const i = name.indexOf(q)
  if (i === 0) return 1
  if (i > 0) return 2 + i / 100
  // Fuzzy: query letters appear in order in the name; tighter spans score better.
  let pos = -1
  let first = -1
  let ok = true
  for (const c of q) {
    if (c === ' ') continue
    pos = name.indexOf(c, pos + 1)
    if (pos < 0) {
      ok = false
      break
    }
    if (first < 0) first = pos
  }
  if (ok && first >= 0) return 3 + (pos - first) / 100
  if (desc && desc.includes(q)) return 4
  const words = q.split(' ').filter(Boolean)
  if (words.length > 1 && words.every(w => `${name} ${desc}`.includes(w))) return 5
  return null
}

export function rank(query: string, repos: Repo[]): Repo[] {
  const q = query.trim().toLowerCase()
  return repos
    .map(r => ({ r, s: q ? score(q, r) : 6 }))
    .filter((x): x is { r: Repo; s: number } => x.s !== null)
    .sort((a, b) => a.s - b.s || a.r.name.localeCompare(b.r.name))
    .map(x => x.r)
}

// owner/repo plus a clone URL (when one was given) from a name, owner/repo, or git URL.
export async function parseTarget(
  target: string,
  defaultOwner: () => Promise<string>,
): Promise<{ full: string; url: string | null }> {
  const t = target.trim()
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(t)) {
    const m = /[:/]([^/:]+)\/([^/]+?)(\.git)?\/?$/.exec(t)
    if (!m) throw new Error(`can't read owner/repo from URL: ${t}`)
    return { full: `${m[1]}/${m[2]}`, url: t }
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(t)) return { full: t, url: null }
  if (/^[\w.-]+$/.test(t)) return { full: `${await defaultOwner()}/${t}`, url: null }
  throw new Error(`not a repo name, owner/repo or git URL: ${t}`)
}

async function exists($: any, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path)
  } catch {
    return false
  }
}

// An existing checkout in the usual places, else a fresh clone into the clone folder.
async function openRepo($: any, target: string): Promise<{ full: string; path: string; cloned: boolean }> {
  const { full, url } = await parseTarget(target, () => owner($))
  const name = full.split('/')[1] as string
  const h = await home($)
  const cloneDir = opts.cloneDir?.trim() ? opts.cloneDir.trim().replace(/^~(?=$|[\\/])/, h) : join(h, 'repos')
  const roots = [
    cloneDir,
    ...['Documents', 'Desktop', 'code', 'Code', 'projects', 'Projects', 'dev', 'src', 'git', 'GitHub', 'workspace'].map(d => join(h, d)),
    join(h, 'Documents', 'GitHub'),
    join(h, 'source', 'repos'),
    join(h, 'OneDrive', 'Documents'),
    join(h, 'OneDrive', 'Desktop'),
    h,
  ]
  for (const root of roots) {
    const p = join(root, name)
    if (await exists($, join(p, '.git'))) return { full, path: p, cloned: false }
  }

  const path = join(cloneDir, name)
  if (await exists($, path)) throw new Error(`${path} exists but is not a git checkout; move it or set another clone folder`)
  const gh = url ? null : await run($, ['gh', 'repo', 'clone', full, path], undefined, 600000)
  if (gh && gh.code === 0) return { full, path, cloned: true }
  // No gh (or a URL was given): plain git.
  const source = url ?? `https://github.com/${full}.git`
  const g = await run($, ['git', 'clone', source, path], undefined, 600000)
  if (g.code !== 0) throw new Error(`clone of ${full} failed: ${g.err || gh?.err || 'unknown error'}`)
  return { full, path, cloned: true }
}

// Moves the session into the folder: the built-in /cd when this build has it, else a shell cd.
async function cdInto($: any, path: string): Promise<void> {
  const commands: { name: string }[] = await $.command.list()
  if (commands.some(c => c.name === 'cd')) {
    await $.command.run({ command: 'cd', args: path })
  } else {
    await $.tool.call({ tool: 'Bash', command: `cd "${path.replace(/\\/g, '/')}"`, description: 'Enter the selected repo' })
  }
}

async function select($: any, target: string, fromCommand: boolean): Promise<string> {
  await update($, busy, () => true)
  await update($, status, () => `opening ${target}…`)
  let r: { full: string; path: string; cloned: boolean }
  try {
    r = await openRepo($, target)
  } catch (err: any) {
    await update($, busy, () => false)
    const msg = `repo: ${String(err?.message ?? err)}`
    await update($, status, () => msg)
    return msg
  }
  await update($, busy, () => false)
  await update($, active, () => ({ full: r.full, path: r.path }))
  await update($, matches, () => [])
  await update($, status, () => '')
  const line = `-> now in ${r.full} (${await tilde($, r.path)})${r.cloned ? ' — freshly cloned' : ''}`
  $.ui.status(`repo: ${r.full}`)
  // A command hook can't wait on another command, so the cd is queued for when the session is idle.
  const cd = cdInto($, r.path).catch((err: any) =>
    $.ui.log(`repo: couldn't cd into ${r.path}: ${String(err?.message ?? err)}`),
  )
  if (!fromCommand) {
    await cd
    $.ui.log(line)
    await $.ui.close({ id: PANE })
  }
  return line
}

// One entry from the prompt: a number picks from the list, a URL / owner/repo / exact name selects, else filter.
async function handle($: any, raw: string, fromCommand: boolean): Promise<string> {
  const v = raw.trim()
  if (!v) return ''
  const list = await read($, matches)
  if (/^\d+$/.test(v) && list.length > 0) {
    const n = Number(v)
    if (n >= 1 && n <= list.length) return select($, (list[n - 1] as Repo).name, fromCommand)
  }
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(v) || /^[\w.-]+\/[\w.-]+$/.test(v)) return select($, v, fromCommand)

  // "list" shows every repo instead of filtering on the word.
  const listAll = v.toLowerCase() === 'list'
  await update($, busy, () => true)
  let found: Repo[]
  try {
    found = rank(listAll ? '' : v, await listRepos($))
  } catch (err: any) {
    await update($, busy, () => false)
    const msg = `repo: couldn't list your GitHub repos — ${String(err?.message ?? err)}. Type owner/repo or a git URL instead.`
    await update($, status, () => msg)
    return msg
  }
  await update($, busy, () => false)
  const exact = listAll ? undefined : found.find(x => x.name.toLowerCase() === v.toLowerCase())
  if (exact) return select($, exact.name, fromCommand)
  await update($, matches, () => found)
  const msg = found.length === 0 ? `no repo matches "${v}"` : ''
  await update($, status, () => msg)
  if (fromCommand) {
    return found.length === 0
      ? msg
      : found.slice(0, SHOWN).map((x, i) => `${i + 1}. ${x.name}${x.description ? ` - ${x.description}` : ''}`).join('\n') +
          '\n\nPick with /repo <number>, narrow with /repo <more letters>, or use the repo pane.'
  }
  return msg
}

async function openPicker($: any): Promise<void> {
  await $.ui.open({ id: PANE, title: 'repo', focus: true, closeOnEscape: true, rows: 12 })
}

export const register: Register = (on, options) => {
  opts = (options ?? {}) as Options

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'repo',
      description: 'Pick the GitHub repo to work in (fuzzy match, clone if missing, cd into it)',
    })
    const started = await next(e)
    const current = await read($, active)
    if (current) $.ui.status(`repo: ${current.full}`)
    else if (e.isInteractive && opts.openOnStart !== false) await openPicker($)
    return started
  })

  on('command.run', { command: 'repo' }, async ($, e) => {
    if (!e.args.trim()) {
      await update($, matches, () => [])
      await update($, status, () => '')
      await openPicker($)
      return { text: 'Type a repo in the repo pane.' }
    }
    const text = await handle($, e.args, true)
    const now = await read($, active)
    return now && text.startsWith('->')
      ? { text, context: [`The active repo is now ${now.full}, checked out at ${now.path}. Work in that folder.`] }
      : { text }
  })

  // Keeps the model aware of which repo "the repo" means.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const repo = await read($, active)
    if (!repo) return composed
    return {
      sections: [
        ...composed.sections,
        {
          id: 'repo:active',
          scope: 'session',
          text: `# Active repo\nThe user picked GitHub repo ${repo.full} for this session; it is checked out at ${repo.path}. Unless told otherwise, "the repo" means this one and work happens in that folder.`,
        },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Input } = $.ui.resolve(e)
    const list = await read($, matches)
    const msg = await read($, status)
    const working = await read($, busy)
    const current = await read($, active)
    const width = Math.max(20, (e.viewport?.columns ?? 80) - 4)
    const clip = (s: string) => (s.length > width ? `${s.slice(0, width - 1)}…` : s)

    return (
      <Box flexDirection="column">
        {current && <Text dimColor>{clip(`active: ${current.full}`)}</Text>}
        <Input
          key="q"
          label="repo -> "
          placeholder="name, number, owner/repo or git URL (list = all)"
          autoFocus
          onSubmit={(value: string) => void handle($, value, false)}
        />
        {working && <Text dimColor>working…</Text>}
        {msg !== '' && <Text color={msg.startsWith('repo:') ? 'red' : undefined}>{clip(msg)}</Text>}
        {list.slice(0, SHOWN).map((r, i) => (
          <Text key={r.name}>
            {clip(`${i + 1}. ${r.name}${r.description ? ` - ${r.description}` : ''}`)}
          </Text>
        ))}
        {list.length > SHOWN && <Text dimColor>{`…${list.length - SHOWN} more, type more letters`}</Text>}
        {list.length > 0 && <Text dimColor>number to pick · more letters to narrow · full name to select</Text>}
      </Box>
    )
  })
}
