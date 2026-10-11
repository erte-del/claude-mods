export type CommitPushPhase = 'idle' | 'running' | 'done' | 'nothing' | 'blocked' | 'error'

export type CommitPushRun = {
  phase: CommitPushPhase
  step: string // what it is doing while running
  repo: string // repo folder
  branch: string
  message: string // commit message used
  sha: string // short sha once committed
  target: string // remote/branch pushed to
  summary: string // one line result
  detail: string // error text or hint
}

declare module 'claude-code' {
  interface PluginState {
    'commit-push': { run: CommitPushRun }
  }
}
