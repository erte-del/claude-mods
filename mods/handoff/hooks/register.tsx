import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { HandoffRun } from '../types'

export const IDLE: HandoffRun = { phase: 'idle', summary: '', path: '' }

const run = atom({ plugin: 'handoff', key: 'run' } as const, IDLE)

export const PROMPT = `My context is getting full. Before we stop, write a handoff.md in the project root so a new session with zero memory of this conversation can pick up exactly where we left off. If handoff.md already exists, overwrite it completely — don't append, this one replaces it. Keep it short and concrete, not a full doc. Include:

What we're doing: the task/feature in one or two sentences.
Current state: what's done, what's half-done, what's broken right now.
Next step: the exact next thing to do, specific enough to act on immediately.
Decisions made: anything we chose along the way that isn't obvious from the code (and why, if it matters).
Gotchas: anything that tripped us up or that the next session needs to know to avoid repeating a mistake.
Open questions: anything still unresolved.
Don't pad it or restate things that are obvious from reading the code. If something's already clear from the repo, skip it.`

export const continuePrompt = (path: string) =>
  `Read ${path} — it is the handoff from the previous session, which had to be cleared because its context was full. Then continue exactly where it left off, starting with its "Next step".`

// Turns that may end before ours does (a turn already running when the button was pressed).
const MAX_MISSES = 2

// The flow in flight; module-level so a /clear in the middle of it doesn't lose it.
let pending: { since: number; paths: string[]; misses: number } | null = null

const join = (dir: string, name: string) => `${dir.replace(/[\\/]+$/, '')}${dir.includes('\\') ? '\\' : '/'}${name}`

async function set($: any, next: HandoffRun): Promise<void> {
  await update($, run, () => next)
}

// The handoff.md written since `since`, if any (project root first, then cwd).
async function written($: any, paths: string[], since: number): Promise<string | null> {
  for (const p of paths) {
    try {
      const s = await $.fs.stat(p)
      // a little slack for file-system timestamp rounding
      if (s.kind === 'file' && s.size > 0 && s.mtimeMs >= since - 2000) return p
    } catch {
      // not there
    }
  }
  return null
}

async function start($: any): Promise<string> {
  if (pending) return 'handoff: already in progress, waiting for handoff.md'
  const root: string = await $.session.root()
  const cwd: string = await $.session.cwd()
  const paths = [...new Set([join(root, 'handoff.md'), join(cwd, 'handoff.md')])]
  pending = { since: await $.clock.now(), paths, misses: 0 }
  await set($, { phase: 'writing', summary: 'Claude is writing handoff.md…', path: paths[0] as string })
  // A command hook can't submit (the submit would wait on the turn the hook holds), so a timer does.
  $.clock.after(1, () => void $.prompt.submit({ text: PROMPT, asUser: true }))
  return `handoff: asked Claude to write ${paths[0]}; will /clear and continue once it exists`
}

// /clear, then hand the fresh chat the file. Runs after the turn that wrote it has ended.
async function clearAndContinue($: any, path: string): Promise<void> {
  try {
    await set($, { phase: 'clearing', summary: 'handoff.md written, clearing…', path })
    await $.command.run({ command: 'clear' })
    await $.prompt.submit({ text: continuePrompt(path), asUser: true })
    await set($, { phase: 'done', summary: 'New chat is continuing from handoff.md', path })
  } catch (err: any) {
    await set($, { phase: 'error', summary: `handoff: ${String(err?.message ?? err)}`, path })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'handoff',
      description: 'Have Claude write handoff.md, then /clear and continue from it in a fresh chat',
    })
    return next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => ({ text: await start($) }))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const p = pending
    if (!p) return result
    const path = await written($, p.paths, p.since)
    if (path) {
      pending = null
      // on a timer: /clear can't run inside the turn's own completion
      $.clock.after(300, () => void clearAndContinue($, path))
    } else if (e.reason === 'aborted' || e.reason === 'error' || e.reason === 'refusal') {
      pending = null
      await set($, { phase: 'error', summary: `Handoff stopped: the turn ended (${e.reason}) before handoff.md was written`, path: p.paths[0] as string })
    } else if (++p.misses >= MAX_MISSES) {
      pending = null
      await set($, { phase: 'error', summary: 'Handoff stopped: Claude finished without writing handoff.md', path: p.paths[0] as string })
    }
    return result
  })
}

