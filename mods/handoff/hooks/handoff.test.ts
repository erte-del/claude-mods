import { test, expect } from 'claude-code/testing'

import { PROMPT, continuePrompt } from './register'

const ROOT = 'C:\\Users\\me\\repos\\app'
const FILE = `${ROOT}\\handoff.md`

// Stands in for the engine: the prompt box, /clear, the clock and the file system.
function fakeEngine(on: any, log: string[], file: { mtimeMs: number } | null) {
  on('session.root', async () => ({ value: ROOT }))
  on('session.cwd', async () => ({ value: ROOT }))
  on('clock.now', async () => ({ value: 100000 }))
  on('prompt.submit', async (_$: any, e: any) => {
    log.push(`submit:${e.text}`)
    return { text: e.text }
  })
  on('command.run', { command: 'clear' }, async () => {
    log.push('clear')
    return { text: '' }
  })
  on('fs.stat', async (_$: any, e: any) => {
    if (!file || e.path !== FILE) throw new Error('ENOENT')
    return { value: { kind: 'file', size: 300, mtimeMs: file.mtimeMs, isLink: false } }
  })
  on('turn.complete', async () => ({ text: '' }))
  on('clock.after', async () => ({ value: undefined }))
}

const turn = (reason: string) => ({ reason, answer: '', durationMs: 1, isAborted: reason === 'aborted', turnId: 't' }) as any

const settle = () => new Promise(r => setTimeout(r, 20))

test('submits the prompt, then clears and continues once handoff.md is written', async ($, on) => {
  const log: string[] = []
  const file = { mtimeMs: 0 } // old file: not this run's
  fakeEngine(on, log, file)
  await $.command.run({ command: 'handoff', args: '' } as any)
  await settle()
  expect(log).toEqual([`submit:${PROMPT}`])

  await $.turn.complete(turn('answer')) // a turn that was already running
  await settle()
  expect(log.length).toBe(1)

  file.mtimeMs = 100500 // Claude wrote it
  await $.turn.complete(turn('answer'))
  await settle()
  expect(log).toEqual([`submit:${PROMPT}`, 'clear', `submit:${continuePrompt(FILE)}`])
})

test('an interrupted turn stops the handoff without clearing', async ($, on) => {
  const log: string[] = []
  fakeEngine(on, log, null)
  await $.command.run({ command: 'handoff', args: '' } as any)
  await $.turn.complete(turn('aborted'))
  await settle()
  expect(log).toEqual([`submit:${PROMPT}`])
})
