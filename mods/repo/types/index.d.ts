export type Repo = { name: string; description: string; isPrivate: boolean }
export type ActiveRepo = { full: string; path: string }

declare module 'claude-code' {
  interface PluginState {
    repo: {
      active: ActiveRepo | null
      matches: Repo[]
      status: string
      busy: boolean
    }
  }
}
