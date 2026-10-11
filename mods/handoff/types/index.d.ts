export type HandoffPhase = 'idle' | 'writing' | 'clearing' | 'done' | 'error'

export type HandoffRun = {
  phase: HandoffPhase
  summary: string // one line shown in the sidebar
  path: string // handoff.md being waited on
}

declare module 'claude-code' {
  interface PluginState {
    handoff: { run: HandoffRun }
  }
}
