export type Gauge = { percent: number; tokens: number; window: number; usd: number | null; model: string }
export type Life = { tokens: number; usd: number; inTok: number; outTok: number; inUsd: number; outUsd: number; sid: number; last: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    sidebar: { gauge: Gauge | null; limits: Limit[]; lifetime: Omit<Life, 'sid' | 'last'>; tab: 'main' | 'usage'; frame: number }
  }
}
