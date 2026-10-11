export type Gauge = { percent: number; tokens: number; window: number; usd: number | null; model: string }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    sidebar: { gauge: Gauge | null; limits: Limit[] }
  }
}
