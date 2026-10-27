import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Gauge, Life, Limit } from '../types'

const PANE = 'sidebar'
const gauge =atom({ plugin: 'sidebar', key: 'gauge' } as const, null)
const limits = atom({ plugin: 'sidebar', key: 'limits' } as const, [] as Limit[])
const life = atom({ plugin: 'sidebar', key: 'lifetime' } as const, { tokens: 0, usd: 0, inTok: 0, outTok: 0, inUsd: 0, outUsd: 0 } as Omit<Life, 'sid' | 'last'>)
const tab = atom({ plugin: 'sidebar', key: 'tab' } as const, 'main' as 'main' | 'usage')
// Animation frame for the Usage scene; ticks only while a turn runs.
const frame = atom({ plugin: 'sidebar', key: 'frame' } as const, 0)
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

const big = (n: number): string => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : k(n))

// Estimated output price, $ per million tokens, fitted from recorded session costs; input cost is the exact remainder.
const outPrice = (model: string): number =>
  /opus/.test(model) ? 18.8 : /sonnet-5-5/.test(model) ? 9 : /haiku-4/.test(model) ? 4.5 : /haiku/.test(model) ? 2.1 : 10

// Adds this turn's tokens and the session-cost growth since last time to the persisted lifetime totals.
// ponytail: a session id change or a cost drop (e.g. /clear) is treated as a fresh counter; exact ledger if that drifts.
async function accrue($: any, turn: { inp: number; out: number; model: string }, usage: any): Promise<void> {
  // Durable copy lives beside the plugin dirs (~/.claude/sidebar-lifetime.json), so it outlives reinstalls; the store is the fallback.
  const file = `${String($.plugin.root).split('/plugins/')[0]}/sidebar-lifetime.json`
  const zero: Life = { tokens: 0, usd: 0, inTok: 0, outTok: 0, inUsd: 0, outUsd: 0, sid: 0, last: 0 }
  let s: Life = { ...zero, ...(await $.store.get('life')) }
  try {
    const f: Life = JSON.parse(await $.fs.read(file))
    if (f.tokens >= s.tokens) s = { ...zero, ...f }
  } catch {}
  const usd: number = usage.cost?.usd ?? 0
  const base = s.sid === usage.startedAt ? s.last : 0
  const d = usd >= base ? usd - base : usd
  const out = Math.min(d, (turn.out * outPrice(turn.model)) / 1e6)
  s.tokens += turn.inp + turn.out
  s.inTok += turn.inp
  s.outTok += turn.out
  s.usd += d
  s.outUsd += out
  s.inUsd += d - out
  s.sid = usage.startedAt
  s.last = usd
  await $.store.set('life', s)
  await $.fs.write(file, JSON.stringify(s))
  await update($, life, () => s)
}

const k = (n: number): string => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : `${n}`)

// Real figures from the last API response: input + cache reads/writes (system prompt, tool results, history).
async function refresh($: any, answered?: string, turn = { inp: 0, out: 0 }): Promise<void> {
  const model: string = answered ?? (await $.session.model())
  const usage = await $.session.usage()
  const { context, cost, rateLimits } = usage
  await accrue($, { ...turn, model }, usage)
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

  const lt = await read($, life)
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
  const newChatButton = (
    <Button key="new-chat" onPress={() => void $.command.run({ command: 'clear' })}>
      {'＋ New chat'}
    </Button>
  )
  const handoffResult = ho.phase === 'idle' ? null : <Text color={hoColor} dimColor={hoBusy}>{ho.summary}</Text>

  const sep = vertical ? null : <Text dimColor>{'  │  '}</Text>
  const body = (
    <Box flexDirection={vertical ? 'column' : 'row'} flexGrow={1}>
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
      {vertical ? null : (
        <Box>
          <Text bold>{'Lifetime '}</Text>
          <Text color="cyan" bold>{`${big(lt.tokens)} tok`}</Text>
          <Text bold>{` · $${lt.usd.toFixed(2)}`}</Text>
        </Box>
      )}
      {vertical ? null : sep}
      {speedo}
      {vertical ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="flex-end" marginTop={1}>
          {commitResult}
          {commitButton}
          {handoffResult}
          {handoffButton}
          {newChatButton}
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
          <Text> </Text>
          {newChatButton}
        </Box>
      )}
    </Box>
  )
  if (!vertical) return body

  const t = await read($, tab)
  const CLAUDE = '#D97757'
  const GOLD = 'yellow' // named theme colour: hex values were not rendering as gold
  // Usage scene: Claude drops tokens into an IN tube and an OUT tube; both drain into a tub with Claude lying in it.
  const ctr = (x: string, w: number): string => {
    const l = Math.floor((w - x.length) / 2)
    return ' '.repeat(Math.max(0, l)) + x + ' '.repeat(Math.max(0, w - x.length - l))
  }
  const money = (n: number): string => (n >= 1e4 ? `$${(n / 1e3).toFixed(1)}k` : `$${n.toFixed(2)}`)
  const line = (...p: [string, string?][]) => (
    <Box>{p.map(([x, c], i) => (c ? <Text key={i} color={c}>{x}</Text> : <Text key={i}>{x}</Text>))}</Box>
  )
  const tube = (label: string, tok: number, cost: number, c: string): [string, string][] => [
    [`│${ctr(label, 8)}│`, c], [`│${ctr(big(tok), 8)}│`, c], [`│${ctr(money(cost), 8)}│`, c],
  ]
  // Six gold coins drop from Claude's hands (columns 6 and 14) down into the tubes. Each runs 7-frame cycles with a
  // hashed start delay and sideways drift, so the order looks random; row 0 is Claude's feet row, row 4 is inside the tube.
  const hash = (a: number, b: number): number => {
    let x = Math.imul(a, 374761393) + Math.imul(b, 668265263)
    x = Math.imul(x ^ (x >>> 13), 1274126177)
    return (x ^ (x >>> 16)) >>> 0
  }
  const f = await read($, frame)
  const feet = '        ▘▘ ▝▝'
  // Runs of equal colour become one Text, so blank cells never draw as their own styled boxes.
  const segments = (cells: { ch: string; c?: string }[]): [string, string?][] => {
    const out: [string, string?][] = []
    for (const x of cells) {
      const last = out[out.length - 1]
      if (last && last[1] === x.c) last[0] += x.ch
      else out.push([x.ch, x.c])
    }
    return out
  }
  const drops = [0, 1, 2, 3].map((row) => {
    const cells = Array.from({ length: 22 }, (_, i) => ({ ch: (row === 0 ? feet[i] : ' ') ?? ' ', c: row === 0 ? CLAUDE : undefined as string | undefined }))
    for (let i = 0; i < 6 && f > 0; i++) {
      const t = f + i * 2
      const cycle = Math.floor(t / 7)
      const at = (t % 7) - (hash(cycle, i) % 3)
      if (at !== row) continue
      const col = (i % 2 ? 14 : 6) + ((hash(cycle, i + 9) % 3) - 1) * Math.min(row, 2)
      cells[col] = { ch: '•', c: GOLD }
    }
    return cells
  })
  const jig = f % 2 ? '·  ◦  ·   ◦  · ◦' : '◦  ·  ◦   ·  ◦ ◦'
  const inT = tube('IN', lt.inTok, lt.inUsd, 'cyan')
  const outT = tube('OUT', lt.outTok, lt.outUsd, 'magenta')
  const usage = (
    <Box flexDirection="column" flexGrow={1} marginTop={1}>
      {line(['       ▐▛███▜▌', CLAUDE])}
      {line(['      ▝▜█████▛▘', CLAUDE])}
      {drops.map((d) => line(...segments(d)))}
      {line([' ┌────────┐', 'cyan'], ['┌────────┐', 'magenta'])}
      {inT.map((t, i) => line([' ' + t[0], 'cyan'], [outT[i][0], 'magenta']))}
      {line([' └────┬───┘', 'cyan'], ['└────┬───┘', 'magenta'])}
      {line(['      │         │'])}
      {line(['      └────┬────┘'])}
      {line(['           │'])}
      {line([' ╭─────────┴────────╮'])}
      {line([' │ ', ], [jig, GOLD], [' │'])}
      {line([' │', ], ['≈', 'cyan'], ['◦ ', GOLD], ['▐▛███▜▌', CLAUDE], [' ◦ ', GOLD], ['≈◦≈≈≈', 'cyan'], ['│'])}
      {line([' ╰──────────────────╯'])}
      {line([` ${big(lt.tokens)} tok · ${money(lt.usd)}`, 'yellow'])}
      <Text dimColor>{'\n In = prompt + cache.\n Out cost is estimated.'}</Text>
    </Box>
  )
  const tabBtn = (id: 'main' | 'usage', label: string) => (
    <Button key={id} onPress={() => void update($, tab, () => id)}>
      {`${t === id ? '●' : '○'} ${label}`}
    </Button>
  )
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Box>
        {tabBtn('main', 'Overview')}
        <Text>{'  '}</Text>
        {tabBtn('usage', 'Usage')}
      </Box>
      {t === 'usage' ? usage : body}
    </Box>
  )
}

export const register: Register = (on, options) => {
  let timer: { cancel: () => void } | undefined

  on('turn.start', ($, e, next) => {
    if (!e.agentId && !timer) {
      void update($, frame, () => 1) // frame 0 means idle: no coins
      timer = $.clock.every(250, () => void update($, frame, (n) => n + 1))
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    void $.ui.open({ id: PANE, title: 'Sidebar' })
    await refresh($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      timer?.cancel()
      timer = undefined
      void update($, frame, () => 0)
    }
    const result = await next(e)
    const u = e.usage
    await refresh($, u?.model, u ? { inp: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens, out: u.output_tokens } : undefined)
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
