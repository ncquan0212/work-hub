// E5 · market-tool health: launchd service, warnings in its log, last C1 message, the C1 paper book.
// Reads its log incrementally and opens its state.db read-only.
import { execFile } from 'node:child_process'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { CODE, HOME } from '../config.ts'
import { ago, cut, empty, esc, pill, section, stale, TZ } from '../core/html.ts'
import type { Alert, Module } from '../core/types.ts'

const run = promisify(execFile)
const MT = join(CODE, 'market-tool')
const MT_LOG = join(HOME, 'Library/Logs/market-tool.log')
const DAY = 86_400_000

type Warn = { t: number; kind: string; err: string }

// display formats: "15:10", "06/11", "−10,06%" (a true minus), "61,1"
const hm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
const dmT = (t: number) => new Date(t).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit' })
const dm = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}`
const signed = (x: number) => x.toLocaleString('vi-VN', { style: 'percent', minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: 'exceptZero' }).replace('-', '−')
const price = (x: number) => Number(x).toLocaleString('vi-VN', { maximumFractionDigits: 2 })

export function parseLogLines(text: string) {
  const warns: Warn[] = []; let lastAt = 0
  for (const line of text.split('\n')) {
    let o: any; try { o = JSON.parse(line) } catch { continue }
    // market-tool's stderr shares this file, so a line can be any JSON value (`null`, a number)
    if (!o || typeof o !== 'object') continue
    const t = Date.parse(o.t); if (!t) continue
    lastAt = t
    if (o.level !== 'info') warns.push({ t, kind: o.voter ? `${o.msg} (${o.voter})` : o.msg, err: String(o.err ?? '').slice(0, 160) })
  }
  return { warns, lastAt }
}

// Incremental log reader: remembers how far it got, reads only whole new lines.
let logOffset = 0, logWarns: Warn[] = [], logLastAt = 0
function readNewLog() {
  const { size } = statSync(MT_LOG)
  if (size < logOffset) { logOffset = 0; logWarns = [] } // rotated or truncated
  if (size === logOffset) return
  const buf = Buffer.alloc(size - logOffset), fd = openSync(MT_LOG, 'r')
  try { readSync(fd, buf, 0, buf.length, logOffset) } finally { closeSync(fd) }
  const end = buf.lastIndexOf(10) + 1 // only whole lines; a half-written line waits for the next tick
  const { warns, lastAt } = parseLogLines(buf.subarray(0, end).toString('utf8'))
  logWarns.push(...warns); if (lastAt) logLastAt = lastAt
  logOffset += end
}

export type MarketData = {
  service: string; pid: string | null; logLastAt: number
  warns: { kind: string; n24: number; n7: number; lastAt: number; err: string }[]
  lastC1At: number | null
  open: { sym: string; entry_day: string; entry_px: number }[]
  equity: { day: string; equity: number }[]
}

export const market: Module<MarketData> = {
  id: 'market', title: 'market-tool', group: 'ops', every: 60, timeout: 30,

  async collect({ now, signal }) {
    let service = 'not loaded', pid: string | null = null
    try {
      // owner-only, macOS: elsewhere there is no getuid (Windows) or no launchctl, and the service reads "not loaded"
      if (!process.getuid) throw new Error('no launchd')
      const out = (await run('launchctl', ['print', `gui/${process.getuid()}/com.market-tool.live`], { encoding: 'utf8', timeout: 10_000, signal })).stdout
      service = out.match(/^\s*state = (\w+)/m)?.[1] ?? '?'
      pid = out.match(/^\s*pid = (\d+)/m)?.[1] ?? null
    } catch { /* not loaded */ }

    readNewLog()
    logWarns = logWarns.filter(w => now - w.t < 7 * DAY)
    const byKind = new Map<string, { n24: number; n7: number; lastAt: number; err: string }>()
    for (const w of logWarns) {
      const k = byKind.get(w.kind) ?? { n24: 0, n7: 0, lastAt: 0, err: '' }
      k.n7++; if (now - w.t < DAY) k.n24++
      if (w.t >= k.lastAt) { k.lastAt = w.t; k.err = w.err }
      byKind.set(w.kind, k)
    }

    const db = new DatabaseSync(join(MT, 'data/state.db'), { readOnly: true })
    try {
      return {
        service, pid, logLastAt,
        warns: [...byKind].map(([kind, v]) => ({ kind, ...v })).sort((a, b) => b.n24 - a.n24 || b.n7 - a.n7),
        lastC1At: (db.prepare(`select max(sent_at) v from alerts where instance = 'c1' and status = 'sent'`).get() as any)?.v ?? null,
        open: db.prepare(`select sym, entry_day, entry_px from paper_trades where book = 'c1' and exit_day is null order by entry_day`).all() as any,
        equity: db.prepare(`select day, equity from paper_days where book = 'c1' order by day desc limit 2`).all() as any,
      }
    } finally { db.close() }
  },

  css: String.raw`
.market-panel .act { display: inline-flex; align-items: center; gap: var(--space-xs) }
.market-body { container: market / inline-size; display: grid; gap: var(--space-lg); min-width: 0 }
.market-stats { display: grid; margin: 0; min-width: 0 }
.market-stats > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-sm); padding: var(--space-xs) 0; border-top: 1px solid var(--rule); min-width: 0 }
.market-stats dt { color: var(--muted); font-size: var(--text-sm); font-weight: 500; flex-shrink: 0 }
.market-stats dd { margin: 0; min-width: 0; text-align: right; font-variant-numeric: tabular-nums }
.market-stats .market-v { font-weight: 600 }
.market-stats > .market-lead { display: grid; justify-content: start; gap: var(--space-2xs); border-top: 0; padding: 0 0 var(--space-sm) }
.market-stats > .market-lead dd { text-align: left }
.market-warn { display: grid; gap: var(--space-xs); min-width: 0 }
.market-warns .market-hot { font-weight: 600; color: var(--ink) }
.market-warns code { font-size: var(--text-xs); color: var(--muted); overflow-wrap: anywhere }
@container market (min-width: 36rem) {
  .market-stats { grid-template-columns: minmax(0, 1.4fr) repeat(3, minmax(0, 1fr)); column-gap: var(--space-lg) }
  .market-stats > div, .market-stats > .market-lead { display: grid; align-content: start; justify-content: stretch; gap: var(--space-2xs); padding: var(--space-sm) 0 0; border-top: 1px solid var(--rule) }
  .market-stats dd { text-align: left }
  .market-stats .market-v { font-size: var(--text-xl); letter-spacing: -0.01em }
}
@container market (max-width: 45.99rem) {
  .market-warns thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
  .market-warns, .market-warns tbody { display: block }
  .market-warns tbody tr { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-3xs) var(--space-md); padding: var(--space-sm) 0; border-bottom: 1px solid var(--rule) }
  .market-warns tbody tr:first-child { padding-top: 0 }
  .market-warns tbody tr:last-child { border-bottom: 0; padding-bottom: 0 }
  .market-warns tbody tr > td { display: block; padding: 0; border: 0; text-align: left; white-space: normal; min-width: 0 }
  .market-warns tbody tr > td:first-child, .market-warns tbody tr > td.wrap { flex-basis: 100%; position: static; box-shadow: none; background: none; padding: 0 }
  .market-warns tbody tr > td:first-child { font-weight: 600 }
  .market-warns tbody tr > td:empty { display: none }
  .market-warns td[data-label]::before { content: attr(data-label) " "; color: var(--muted); font-weight: 400 }
}
`,

  panel(s, v) {
    const m = s?.data
    const o = { cls: 'market-panel', span: 2 as const }
    if (!m) return section(this.title, `${stale(s, v.now)}${empty('Đang lấy lần đầu…')}`, '', 'market', o)
    const eq = m.equity ?? [] // paper_days.equity is a ratio of starting capital (1.0)
    const total = eq[0] ? eq[0].equity - 1 : null
    const last = eq.length === 2 ? eq[0].equity / eq[1].equity - 1 : null
    const dirty = v.slot<{ key: string; dirty?: number; error?: string }[]>('repos')?.data?.find(x => x.key === 'market')
    const running = m.service === 'running'
    const act = `${pill(running ? 'ok' : 'bad', running ? 'đang chạy' : m.service)}${m.pid ? `<span class="muted">pid ${esc(m.pid)}</span>` : ''}`
    const stat = (label: string, value: string, sub = '', cls = '') => `<div${cls ? ` class="${cls}"` : ''}><dt>${label}</dt><dd>${value}${sub}</dd></div>`
    const stats = [
      stat('Sổ paper C1, từ đầu', total == null ? '<span class="fig muted">—</span>' : `<span class="fig${total < 0 ? ' bad-t' : ''}">${esc(signed(total))}</span>`,
        eq[0] ? `<div class="sub muted">đến ${esc(dm(eq[0].day))}${last != null ? `, phiên trước <span class="${last < 0 ? 'bad-t' : 'ok-t'}">${esc(signed(last))}</span>` : ''}</div>` : '', 'market-lead'),
      stat('Tin C1 gần nhất', m.lastC1At ? `<span class="market-v">${esc(hm(m.lastC1At))}</span> <span class="muted">${esc(dmT(m.lastC1At))}</span>` : '<span class="muted">chưa có</span>',
        m.lastC1At ? `<div class="sub muted">${esc(ago(m.lastC1At, v.now))}</div>` : ''),
      stat('Vị thế mở', m.open.length ? `<span class="market-v">${m.open.map(p => esc(p.sym)).join(', ')}</span>` : '<span class="muted">không có</span>',
        m.open.map(p => `<div class="sub muted">${m.open.length > 1 ? `${esc(p.sym)} ` : ''}vào ${esc(dm(p.entry_day))}, giá ${esc(price(p.entry_px))}</div>`).join('')),
      stat('Log cuối', `<span class="market-v">${esc(ago(m.logLastAt, v.now))}</span>`,
        dirty && !dirty.error ? `<div class="sub muted">${dirty.dirty ? `${esc(dirty.dirty)} file chưa commit` : 'không có file chưa commit'}</div>` : ''),
    ].join('')
    const warns = m.warns.map(w => `<tr><td>${esc(w.kind)}</td><td class="num${w.n24 ? ' market-hot' : ' muted'}" data-label="24 giờ">${w.n24}</td>
        <td class="num${w.n7 ? '' : ' muted'}" data-label="7 ngày">${w.n7}</td><td class="muted" data-label="Lần cuối">${esc(ago(w.lastAt, v.now))}</td>
        <td class="wrap">${w.err ? `<code>${esc(cut(w.err, 120))}</code>` : ''}</td></tr>`).join('')
    return section(this.title, `${stale(s, v.now)}<div class="market-body"><dl class="market-stats">${stats}</dl>
      <div class="market-warn"><h3>Cảnh báo trong log <span class="muted">7 ngày</span></h3>
      ${warns ? `<div class="scroll"><table class="market-warns"><thead><tr><th>Loại</th><th class="num">24 giờ</th><th class="num">7 ngày</th><th>Lần cuối</th><th>Lỗi gần nhất</th></tr></thead><tbody>${warns}</tbody></table></div>`
        : '<p class="calm">Không có cảnh báo nào trong 7 ngày.</p>'}</div></div>`, '', 'market', { ...o, act })
  },

  alerts(s) {
    const m = s?.data
    if (!m) return []
    const out: Alert[] = m.service !== 'running' ? [{ tone: 'bad', text: `market-tool không chạy (${m.service})`, href: '/ops' }] : []
    for (const w of m.warns) if (w.n24 && /send failed|aivote failed/.test(w.kind)) out.push({ tone: 'warn', text: `market-tool: ${w.kind} ×${w.n24} trong 24h`, href: '/ops' })
    return out
  },
}
