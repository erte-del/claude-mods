import { test, expect } from 'claude-code/testing'

type Reply = { code?: number; out?: string; err?: string }

// Stands in for git (and the model) beneath the plugin. `git` maps "arg arg arg" prefixes to replies.
function fakeEngine(on: any, git: Record<string, Reply>, calls: string[][], inputs: string[] = [], reply = 'fix(picker): handle empty repo list') {
  on('process.run', async (_$: any, e: any) => {
    const args: string[] = e.argv.slice(1)
    calls.push(args)
    if (e.init?.stdin ?? e.stdin) inputs.push(e.init?.stdin ?? e.stdin)
    const key = Object.keys(git).find(k => args.join(' ').startsWith(k))
    const r = key ? git[key]! : {}
    return { value: { exitCode: r.code ?? 0, stdout: r.out ?? '', stderr: r.err ?? '' } }
  })
  on('fs.exists', async () => ({ value: false }))
  on('session.cwd', async () => ({ value: '/home/me/app' }))
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply, usage: {} } }))
  on('ui.toast', async () => ({ value: undefined }))
}

const READY: Record<string, Reply> = {
  'rev-parse --show-toplevel': { out: '/home/me/app' },
  'rev-parse --absolute-git-dir': { out: '/home/me/app/.git' },
  'diff --name-only': { out: '' },
  'symbolic-ref': { out: 'main' },
  'status --porcelain': { out: ' M src/picker.ts' },
  'rev-parse --abbrev-ref': { out: 'origin/main' },
  'config --get': { out: 'origin' },
  'rev-list --count': { out: '0' },
  'diff --cached --stat': { out: ' src/picker.ts | 2 +-' },
  'diff --cached --name-status': { out: 'M\tsrc/picker.ts' },
  '-c core.quotepath=off diff': { out: '-a\n+b' },
  'rev-parse --short': { out: 'abc1234' },
}

test('commits with the generated message and reports the push', async ($, on) => {
  const calls: string[][] = []
  const inputs: string[] = []
  fakeEngine(on, READY, calls, inputs)
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toBe('commit-push: Pushed abc1234 → origin/main\n  fix(picker): handle empty repo list')
  expect(calls.some(a => a[0] === 'add' && a[1] === '-A')).toBe(true)
  expect(calls.some(a => a[0] === 'push' && a.length === 1)).toBe(true)
  expect(inputs).toEqual(['fix(picker): handle empty repo list\n'])
})

test('no upstream: pushes with -u to origin', async ($, on) => {
  const calls: string[][] = []
  fakeEngine(on, { ...READY, 'rev-parse --abbrev-ref': { code: 128, err: 'no upstream' }, remote: { out: 'origin' } }, calls)
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toBe('commit-push: Pushed abc1234 → origin/main (upstream set)\n  fix(picker): handle empty repo list')
  expect(calls.some(a => a.join(' ') === 'push -u origin main')).toBe(true)
})

test('nothing to commit stops after the check', async ($, on) => {
  const calls: string[][] = []
  fakeEngine(on, { ...READY, 'status --porcelain': { out: '' } }, calls)
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toBe('commit-push: nothing to commit on main (working tree clean)')
  expect(calls.some(a => a[0] === 'add' || a[0] === 'commit')).toBe(false)
})

test('behind the upstream: stops before staging, never pushes', async ($, on) => {
  const calls: string[][] = []
  fakeEngine(on, { ...READY, 'rev-list --count': { out: '2' } }, calls)
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toContain('stopped, needs you — main is behind origin/main by 2 commit(s)')
  expect(calls.some(a => a[0] === 'add' || a[0] === 'commit' || a[0] === 'push')).toBe(false)
})

test('unresolved conflicts stop it', async ($, on) => {
  const calls: string[][] = []
  fakeEngine(on, { ...READY, 'diff --name-only': { out: 'a.txt\nb.txt' } }, calls)
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toContain('unresolved merge conflicts in: a.txt, b.txt')
})

test('a failed push shows the hint and the error text', async ($, on) => {
  const calls: string[][] = []
  fakeEngine(
    on,
    { ...READY, push: { code: 128, err: 'fatal: unable to access x: Could not resolve host: github.com' } },
    calls,
    [],
    'Add picker guard.',
  )
  const r = await $.command.run({ command: 'commit-push', args: '' } as any)
  expect(r.text).toBe(
    'commit-push: Committed abc1234 locally, push failed\n  chore: Add picker guard\nNetwork problem reaching the remote. The commit is saved locally; push again once you are online.\nfatal: unable to access x: Could not resolve host: github.com',
  )
})
