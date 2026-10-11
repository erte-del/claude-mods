import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Gauge, Limit } from '../types'

const PANE = 'sidebar'
const gauge =atom({ plugin: 'sidebar', key: 'gauge' } as const, null)
const limits = atom({ plugin: 'sidebar', key: 'limits' } as const, [] as Limit[])
// Owned by the commit-push mod; the sidebar only draws it and presses its command.
const commitPush = atom({ plugin: 'commit-push', key: 'run' } as const, {
  phase: 'idle', step: '', repo: '', branch: '', message: '', sha: '', target: '', summary: '', detail: '',
})
// Owned by the handoff mod.
const handoff = atom({ plugin: 'handoff', key: 'run' } as const, { phase: 'idle', summary: '', path: '' })

// ---- speedometer: two concentric half circles drawn with braille dots (2x4 per cell) ----
const DW = 34 // dial grid width in dots (17 cells); the arcs use the left 30 dots
const CX = 15 // arc centre in dots, left of the grid's middle so the dial sits left
const DH = 16 // dial height in dots (4 cells)
const BIT = [[0x01, 0x02, 0x04, 0x40], [0x08, 0x10, 0x20, 0x80]]
const RINGS = [
  { lo: 12, hi: 14.5 }, // outer: weekly
  { lo: 4.5, hi: 7 }, // inner: 5 hour
]

const eta = (iso?: string): string => {
  if (!iso) return ''
  const ms = Date.parse(iso) - Date.now()
  if (!(ms > 0)) return 'now'
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${String(m % 60).padStart(2, '0')}m`
  return `${Math.floor(h / 24)}d${h % 24}h`
}

// pcts[i] is the fill (0-100) of RINGS[i], or null for "no data" (ring drawn empty).
function dial(pcts: (number | null)[]): { ch: string; ring: number; lit: boolean }[][] {
  const rows: { ch: string; ring: number; lit: boolean }[][] = []
  for (let cy = 0; cy < DH / 4; cy++) {
    const row: { ch: string; ring: number; lit: boolean }[] = []
    for (let cx = 0; cx < DW / 2; cx++) {
      let bits = 0
      const count = RINGS.map(() => ({ on: 0, lit: 0 }))
      for (let i = 0; i < 2; i++) {
        for (let j = 0; j < 4; j++) {
          const x = cx * 2 + i
          const y = cy * 4 + j
          const dx = x + 0.5 - CX
          const dy = DH - (y + 0.5)
          const r = Math.hypot(dx, dy)
          const ri = RINGS.findIndex((g) => r >= g.lo && r <= g.hi)
          if (ri < 0) continue
          const frac = 1 - Math.atan2(dy, dx) / Math.PI // 0 at the left end, 1 at the right
          const p = pcts[ri]
          bits |= BIT[i][j]
          count[ri].on++
          if (p !== null && frac <= p / 100) count[ri].lit++
        }
      }
      const ring = count[0].on >= count[1].on ? 0 : 1
      row.push({
        ch: bits === 0 ? ' ' : String.fromCharCode(0x2800 + bits),
        ring,
        lit: count[ring].lit * 2 >= count[ring].on && count[ring].lit > 0,
      })
    }
    rows.push(row)
  }
  return rows
}

const colorFor = (percent: number): string =>
  percent >= 85 ? 'red' : percent >= 60 ? 'yellow' : 'green'

// claude-opus-5-5 -> Opus 5.5; unknown ids are shown trimmed.
const badge = (id: string): string => {
  const m = /(opus|sonnet|haiku|fable)-(\d+(?:-\d+)*)/i.exec(id)
  if (m === null) return id.replace(/^claude-/, '').slice(0, 16)
  return `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} ${m[2].replace(/-/g, '.')}`
}

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`)

// Real figures from the last API response: input + cache reads/writes (system prompt, tool results, history).
async function refresh($: any, answered?: string): Promise<void> {
  const model: string = answered ?? (await $.session.model())
  const { context, cost, rateLimits } = await $.session.usage()
  const next: Gauge | null =
    context.tokens === undefined
      ? null
      : {
          percent: Math.min(100, context.percent ?? Math.round((context.tokens / context.window) * 100)),
          tokens: context.tokens,
          window: context.window,
          usd: cost?.usd ?? null,
          model,
        }
  await update($, gauge, () => next)
  await update($, limits, () => rateLimits ?? [])
  $.ui.status(next === null ? undefined : `ctx ${next.percent}%${next.usd === null ? '' : ` · $${next.usd.toFixed(2)}`}`)
}

// Docked pane (top-right, beside the logo) stacks the widgets; the band above the prompt is the fallback.
async function draw($: any, e: any, vertical: boolean, options: any) {
  const isAscii = options?.ascii === true
  const { Box, Text, Button } = $.ui.resolve(e)
  const g = await read($, gauge)
  const budget = typeof options?.budgetUsd === 'number' && options.budgetUsd > 0 ? options.budgetUsd : 5
  const W = vertical ? 10 : 12

  const bar = (fraction: number): [string, string] => {
    const n = Math.round(Math.min(1, Math.max(0, fraction)) * W)
    return [(isAscii ? '#' : '█').repeat(n), (isAscii ? '-' : '░').repeat(W - n)]
  }

  const pct = g?.percent ?? 0
  const [ctxOn, ctxOff] = bar(pct / 100)
  const ctxColor = colorFor(pct)

  const usd = g?.usd ?? null
  const costPct = usd === null ? 0 : Math.round((usd / budget) * 100)
  const [costOn, costOff] = bar(costPct / 100)
  const costColor = colorFor(costPct)

  const lims: Limit[] = await read($, limits)
  const week = lims.find((l) => l.kind === 'seven_day') ?? null
  const five = lims.find((l) => l.kind === 'five_hour') ?? null
  const WEEK_COLOR = 'magenta'
  const FIVE_COLOR = 'cyan'
  const fmt = (l: Limit | null): string => (l === null ? '--' : `${Math.round(l.percentUsed)}%`)

  let speedo: any = null
  if (vertical && !isAscii) {
    const colors = [WEEK_COLOR, FIVE_COLOR]
    const rows = dial([week?.percentUsed ?? null, five?.percentUsed ?? null])
    speedo = (
      <Box flexDirection="column" marginTop={1} alignItems="center">
        {rows.map((row, ri) => (
          <Box key={ri}>
            {row.map((c, ci) =>
              c.lit ? (
                <Text key={ci} color={colors[c.ring]}>{c.ch}</Text>
              ) : (
                <Text key={ci} dimColor>{c.ch}</Text>
              ),
            )}
          </Box>
        ))}
        <Box marginRight={4}>
          <Text color={WEEK_COLOR} bold>{`7d ${fmt(week)}`}</Text>
          <Text>{'   '}</Text>
          <Text color={FIVE_COLOR} bold>{`5h ${fmt(five)}`}</Text>
        </Box>
        <Box marginBottom={1} marginRight={4}>
          <Text dimColor>{`↻${week?.resetsAt ? eta(week.resetsAt) : '--'}`}</Text>
          <Text>{'   '}</Text>
          <Text dimColor>{`↻${five?.resetsAt ? eta(five.resetsAt) : '--'}`}</Text>
        </Box>
      </Box>
    )
  } else {
    speedo = (
      <Box marginTop={vertical ? 1 : 0}>
        <Text color={FIVE_COLOR} bold>{`5h ${fmt(five)}`}</Text>
        <Text dimColor>{' · '}</Text>
        <Text color={WEEK_COLOR} bold>{`7d ${fmt(week)}`}</Text>
      </Box>
    )
  }

  const cp = await read($, commitPush)
  const cpBusy = cp.phase === 'running'
  const cpColor = cp.phase === 'done' ? 'green' : cp.phase === 'nothing' ? undefined : cp.phase === 'blocked' ? 'yellow' : 'red'
  const cpMark = cp.phase === 'done' ? '✓ ' : cp.phase === 'nothing' ? '· ' : cp.phase === 'blocked' ? '! ' : '✗ '
  const commitButton = (
    <Button key="commit-push" onPress={() => void (cpBusy ? undefined : $.command.run({ command: 'commit-push' }))}>
      {cpBusy ? '… Committing' : '⇡ Commit & Push'}
    </Button>
  )
  const commitResult = cpBusy ? (
    <Text dimColor>{cp.step}</Text>
  ) : cp.phase === 'idle' ? null : (
    <Box flexDirection="column">
      <Text color={cpColor} bold>{`${cpMark}${cp.summary}`}</Text>
      {cp.message ? <Text>{cp.message}</Text> : null}
      {cp.detail ? <Text dimColor>{cp.detail.length > 500 ? `${cp.detail.slice(0, 499)}…` : cp.detail}</Text> : null}
    </Box>
  )

  const ho = await read($, handoff)
  const hoBusy = ho.phase === 'writing' || ho.phase === 'clearing'
  const hoColor = ho.phase === 'done' ? 'green' : ho.phase === 'error' ? 'red' : undefined
  const handoffButton = (
    <Button key="handoff" onPress={() => void (hoBusy ? undefined : $.command.run({ command: 'handoff' }))}>
      {hoBusy ? '… Handing off' : '⇄ Handoff'}
    </Button>
  )
  const handoffResult = ho.phase === 'idle' ? null : <Text color={hoColor} dimColor={hoBusy}>{ho.summary}</Text>

  const sep = vertical ? null : <Text dimColor>{'  │  '}</Text>
  return (
    <Box flexDirection={vertical ? 'column' : 'row'}>
      <Box>
        <Text color="cyan" bold>{g === null ? 'model --' : `● ${badge(g.model)}`}</Text>
      </Box>
      {sep}
      <Box marginTop={vertical ? 1 : 0}>
        <Text bold>{'Context '}</Text>
        <Text color={ctxColor}>{ctxOn}</Text>
        <Text dimColor>{ctxOff}</Text>
        <Text color={ctxColor} bold>{g === null ? ' --' : ` ${pct}%`}</Text>
        <Text dimColor>{g === null || vertical ? '' : ` ${k(g.tokens)}/${k(g.window)}`}</Text>
      </Box>
      {sep}
      <Box marginTop={vertical ? 1 : 0}>
        <Text bold>{'Cost '}</Text>
        <Text color={costColor}>{costOn}</Text>
        <Text dimColor>{costOff}</Text>
        <Text color={costColor} bold>{usd === null ? ' --' : ` $${usd.toFixed(usd < 10 ? 3 : 2)}`}</Text>
        {vertical ? null : <Text dimColor>{` of $${budget}`}</Text>}
      </Box>
      {sep}
      {speedo}
      {vertical ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" marginTop={1}>
          {commitResult}
          {commitButton}
          {handoffResult}
          {handoffButton}
          <Button key="reload" onPress={() => void $.command.run({ command: 'reload-plugins' })}>
            {'↻ Reload plugins'}
          </Button>
        </Box>
      ) : (
        <Box>
          {sep}
          {commitButton}
          {cpBusy || cp.phase === 'idle' ? null : <Text color={cpColor}>{` ${cpMark}${cp.summary}`}</Text>}
          <Text> </Text>
          {handoffButton}
        </Box>
      )}
    </Box>
  )
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    void $.ui.open({ id: PANE, title: 'Sidebar' })
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($, e.usage?.model)
    return result
  })

  on('session.measure', async ($, e, next) => {
    await update($, limits, () => e.rateLimits ?? [])
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => draw($, e, true, options))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const panes = await $.ui.panes()
    if (panes.some((p: any) => p.id === PANE && p.isPlaced)) return next(e)
    return draw($, e, false, options)
  })
}
