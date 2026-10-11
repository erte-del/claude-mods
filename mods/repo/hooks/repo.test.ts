import { test, expect } from 'claude-code/testing'

const REPOS = [
  { name: 'homework_manager', description: 'collects the homework of students to one app', isPrivate: true },
  { name: 'Jarvis', description: 'Merging OpenJarvis + adewaskar/jarvis', isPrivate: false },
]

// Stands in for gh, git, the file system and the engine's /cd beneath the plugin.
// `checkouts` are folders that already hold a .git; everything else is cloned.
function fakeEngine(on: any, cds: string[], calls: string[][], checkouts: string[] = []) {
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    calls.push(argv)
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '' } })
    if (argv.join(' ') === 'gh api user --jq .login') return ok('octo')
    if (argv[0] === 'gh' && argv[1] === 'repo' && argv[2] === 'list') return ok(JSON.stringify(REPOS))
    if (argv[0] === 'gh' && argv[1] === 'repo' && argv[2] === 'clone') return ok('')
    return { value: { exitCode: 1, stdout: '', stderr: 'unexpected' } }
  })
  on('fs.exists', async (_$: any, e: any) => ({
    value: checkouts.some(c => String(e.path).split('\\').join('/').endsWith(`${c}/.git`)),
  }))
  on('clock.now', async () => ({ value: 1 }))
  on('command.list', async () => ({ value: [{ name: 'cd' }] }))
  on('env.get', async (_$: any, e: any) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('ui.log', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('ui.close', async () => ({ value: undefined }))
  on('ui.open', async () => ({ value: { isPlaced: true } }))
  on('command.run', { command: 'cd' }, async (_$: any, e: any) => {
    cds.push(e.args)
    return { text: '' }
  })
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane: filter, then pick by number (${surface})`, async ($, on) => {
    const cds: string[] = []
    const calls: string[][] = []
    fakeEngine(on, cds, calls)
    const ui = await $.ui.mount({ plugin: 'repo', surface, component: 'Pane', props: { title: 'repo' } as any, requestId: 'repo' } as any)
    await ui.input({ key: 'q', text: 'a' })
    expect(await ui.find({ type: 'Text', text: '2. homework_manager - collects the homework of students to one app' } as any)).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1. Jarvis - Merging OpenJarvis + adewaskar/jarvis' } as any)).toBeDefined()
    await ui.input({ key: 'q', text: '1' })
    expect(cds).toEqual(['/home/me/repos/Jarvis'])
    expect(calls).toContainEqual(['gh', 'repo', 'list', 'octo', '--limit', '200', '--json', 'name,description,isPrivate'])
    expect(calls).toContainEqual(['gh', 'repo', 'clone', 'octo/Jarvis', '/home/me/repos/Jarvis'])
    expect(await ui.find({ type: 'Text', text: 'active: octo/Jarvis' } as any)).toBeDefined()
  })
}

test('/repo with a full name uses an existing checkout instead of cloning', async ($, on) => {
  const cds: string[] = []
  const calls: string[][] = []
  fakeEngine(on, cds, calls, ['/me/projects/homework_manager'])
  const r = await $.command.run({ command: 'repo', args: 'homework_manager' } as any)
  expect(r.text).toBe('-> now in octo/homework_manager (~/projects/homework_manager)')
  expect(calls.some(a => a[2] === 'clone')).toBe(false)
})

test('the owner setting replaces the gh login', { options: { owner: 'some-org' } } as any, async ($: any, on: any) => {
  const calls: string[][] = []
  fakeEngine(on, [], calls)
  await $.command.run({ command: 'repo', args: 'list' } as any)
  expect(calls.some(a => a.join(' ') === 'gh api user --jq .login')).toBe(false)
  expect(calls.some(a => a[3] === 'some-org')).toBe(true)
})
