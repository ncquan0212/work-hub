// Bản 1's free comparison of two versions over install days (D0 rates by version at install, daily facts), kept
// beside the comparison runs: /track/version. Moved from index.ts unchanged.
import type { DatabaseSync } from 'node:sqlite'
import { APPS } from '../../config.ts'
import { DEFAULT_APP } from './runs.ts'
import { board, empty, esc, pill, section } from '../../core/html.ts'
import type { Tone, View } from '../../core/types.ts'
import { addDays, utcDay } from '../../lib/days.ts'
import { CMP, compare, totals, type CmpDef, type GroupFacts } from './compare.ts'
import type { Dim } from './queries.ts'

const DAY = 86_400_000
type TrackData = { crashByVersion: Record<string, { version: string; build: string; crashFree: number | null; users: number }[]> }

export function loadGroups(db: DatabaseSync, app: string, dim: Dim, from: string) {
  const out = new Map<string, GroupFacts>()
  for (const r of db.prepare('select cohort, val, rd, key, value from track_facts where app = ? and dim = ? and cohort >= ?').all(app, dim, from) as
    { cohort: string; val: string; rd: number; key: string; value: number }[]) {
    let g = out.get(r.val); if (!g) out.set(r.val, g = new Map())
    let c = g.get(r.cohort); if (!c) g.set(r.cohort, c = new Map())
    let k = c.get(r.rd); if (!k) c.set(r.rd, k = new Map())
    k.set(r.key, r.value)
  }
  return out
}

/** Last bucket day pulled for this split (per dim: 'ver' can succeed while 'exp' fails). */
export const lastCohortDay = (db: DatabaseSync, app: string, dim: Dim = 'ver') =>
  ((db.prepare(`select max(day) d from track_ran where app = ? and dim = ?`).get(app, dim) as { d: string | null })?.d) ?? null
const ranDays = (db: DatabaseSync, app: string, dim: Dim) =>
  new Set((db.prepare('select day from track_ran where app = ? and dim = ?').all(app, dim) as { day: string }[]).map(r => r.day))

/** New users per group over the window, newest versions first. */
function groupSizes(groups: Map<string, GroupFacts>, from: string, to: string) {
  const first: CmpDef = CMP.find(c => c.id === 'onboard')!
  return [...groups].map(([val, g]) => ({ val, users: totals(g, { ...first, num: 'first_open.users' }, from, to, to).den }))
    .filter(x => x.users > 0).sort((a, b) => b.users - a.users)
}

// ───────────── rendering helpers ─────────────

const vi = (x: number, digits: number) => x.toLocaleString('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
const n0 = (x: number) => x.toLocaleString('vi-VN')

function fmt(d: CmpDef, v: number | null) {
  if (v == null || !Number.isFinite(v)) return '—'
  return d.unit === 'pct' ? `${vi(v * 100, v < 0.1 ? 2 : 1)}%` : d.unit === 'usd3' ? `$${vi(v, 4)}` : vi(v, 2)
}

/** Two-sided sign test: the chance that B wins at least this many of `days` days (or loses as many) when A
 *  and B are alike. Ties count as days B did not win. The evidence behind a verdict on a per-day mean. */
export function signP(wins: number, days: number) {
  const k = Math.max(wins, days - wins)
  let c = 1, tail = 0 // c = C(days, i), walking i down from days
  for (let i = days; i >= k; i--) { tail += c; c = (c * i) / (days - i + 1) }
  return Math.min(1, (2 * tail) / 2 ** days)
}

/** B against A in words. Better or worse only when the test clears p < 0.05 (z-test for rates, sign test on
 *  the days for means); otherwise "not sure yet". Every D0 metric here is better when higher. */
function verdict(r: ReturnType<typeof compare>, d: CmpDef): { tone: Tone; word: string; ev: string } {
  const p = d.kind === 'prop' ? r.p ?? null : r.days ? signP(r.wins ?? 0, r.days) : null
  const ev = d.kind === 'prop' ? (r.p == null ? '' : r.p < 0.001 ? 'p < 0,001' : `p = ${vi(r.p, r.p < 0.05 ? 3 : 2)}`)
    : r.days ? `B hơn A ${r.wins}/${r.days}\u00a0ngày` : ''
  if (r.a.value == null || r.b.value == null) return { tone: 'mute', word: 'Chưa có số', ev }
  if (p == null || p >= 0.05 || r.a.value === r.b.value) return { tone: 'mute', word: 'Chưa chắc', ev }
  return r.b.value > r.a.value ? { tone: 'ok', word: 'B tốt hơn', ev } : { tone: 'bad', word: 'B kém hơn', ev }
}

/** A against B: the two groups and their new users, then a table (wide box) that restacks into two lines a
 *  metric in a narrow one (container query in the module CSS). */
export function cmpTable(app: string, a: GroupFacts | undefined, b: GroupFacts | undefined, la: string, lb: string, from: string, to: string, last: string, ran: Set<string>, opts: { only?: string[]; noRetention?: boolean } = {}) {
  const defs = CMP.filter(d => (!d.apps || d.apps.includes(app)) && (!opts.only || opts.only.includes(d.id)) && !(opts.noRetention && d.rd))
  const base = (g: GroupFacts | undefined) => totals(g, { ...CMP[0], num: 'first_open.users' }, from, to, to).den
  const baseA = base(a), baseB = base(b)
  const rows = defs.map(d => {
    const r = compare(a, b, d, from, to, last, ran)
    if (!r.a.den && !r.b.den) return ''
    const c = verdict(r, d), t = c.tone === 'ok' ? 'ok-t' : c.tone === 'bad' ? 'bad-t' : 'muted'
    const lift = r.lift == null ? '<span class="muted">—</span>' : `<span class="delta ${t}">${r.lift > 0 ? '▲' : r.lift < 0 ? '▼' : ''}${vi(Math.abs(r.lift * 100), 1)}%</span>`
    return `<tr><th scope="row">${esc(d.label)}</th><td class="num track-a">${esc(fmt(d, r.a.value))}<span class="track-n${r.a.den !== baseA ? ' track-n-diff' : ''}">n=${n0(r.a.den)}</span></td>
      <td class="num track-b">${esc(fmt(d, r.b.value))}<span class="track-n${r.b.den !== baseB ? ' track-n-diff' : ''}">n=${n0(r.b.den)}</span></td><td class="num track-lift">${lift}</td>
      <td class="track-call">${c.tone === 'mute' ? `<span class="muted">${esc(c.word)}</span>` : pill(c.tone, c.word)}</td><td class="track-ev">${esc(c.ev)}</td></tr>`
  }).join('')
  if (!rows) return empty('Chưa có số cho khoảng này.')
  const size = (g: GroupFacts | undefined) => n0(totals(g, { ...CMP[0], num: 'first_open.users' }, from, to, to).den)
  return `<p class="track-pair"><span><b>A</b> <span class="tag">${esc(la)}</span> <span class="muted">${size(a)} user mới</span></span><span><b>B</b> <span class="tag">${esc(lb)}</span> <span class="muted">${size(b)} user mới</span></span></p>
    <div class="track-cmp"><table><thead><tr><th scope="col">Chỉ số</th><th scope="col" class="num">A</th><th scope="col" class="num">B</th><th scope="col" class="num">B so với A</th><th scope="col">Kết luận</th><th scope="col">Căn cứ</th></tr></thead><tbody>${rows}</tbody></table></div>`
}

const appName = (k: string) => APPS.find(a => a.key === k)?.name ?? k
const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`
const RULE = 'Kết luận khi p < 0,05: tỉ lệ dùng kiểm định z hai tỉ lệ, trung bình dùng kiểm định dấu trên số ngày B hơn A.'

export function versionPage(v: View, q: URLSearchParams) {
  const app = APPS.some(a => a.key === q.get('app')) ? q.get('app')! : DEFAULT_APP
  const last = lastCohortDay(v.db, app, 'ver') ?? utcDay(v.now - DAY)
  const to = /^\d{4}-\d{2}-\d{2}$/.test(q.get('to') ?? '') ? q.get('to')! : last
  const from = /^\d{4}-\d{2}-\d{2}$/.test(q.get('from') ?? '') ? q.get('from')! : addDays(to, -13)
  const groups = loadGroups(v.db, app, 'ver', addDays(from, -1)), sizes = groupSizes(groups, from, to)
  const a = sizes.some(s => s.val === q.get('a')) ? q.get('a')! : sizes[1]?.val ?? sizes[0]?.val ?? ''
  const b = sizes.some(s => s.val === q.get('b')) ? q.get('b')! : sizes[0]?.val ?? ''
  const opt = (sel: string) => sizes.map(s => `<option value="${esc(s.val)}"${s.val === sel ? ' selected' : ''}>${esc(s.val)} (${s.users.toLocaleString('vi-VN')} user mới)</option>`).join('')
  const form = `<form method="get" action="/track/version" class="track-fields">
    <label>App<select name="app">${APPS.map(x => `<option value="${esc(x.key)}"${x.key === app ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
    <label>Version A<select name="a">${opt(a)}</select></label><label>Version B<select name="b">${opt(b)}</select></label>
    <label>Cài từ ngày<input type="date" name="from" value="${esc(from)}"></label><label>Đến ngày<input type="date" name="to" value="${esc(to)}"></label>
    <button type="submit">So sánh</button></form>`
  const crash = (v.slot<TrackData>('track')?.data?.crashByVersion?.[app] ?? []).filter(c => c.version === a || c.version === b)
  const crashList = crash.length ? `<h3>Crash-free theo version</h3><p class="sub muted">FATAL, 14 ngày gần nhất, theo Crashlytics.</p>
    <dl class="kv">${crash.map(c => `<div><dt><span class="tag">${esc(c.version)}</span></dt><dd><b>${c.crashFree == null ? '—' : `${vi(c.crashFree, 2)}%`}</b> <span class="muted">trên ${n0(c.users)} user</span></dd></div>`).join('')}</dl>` : ''
  const method = `<details class="track-method"><summary>Cách so sánh</summary><p>User cài mới trong khoảng đã chọn (ngày UTC), chia theo version lúc cài.</p><p>${RULE}</p>
    <p>Không so retention theo version: user cập nhật bản giữa chừng nên tử số chạy sang bản mới (cần funnel first_open mới tách đúng).</p></details>`
  return board(section('Chọn hai version', form + method, '', '', { cls: 'track-aside' })
    + section(appName(app), `${a && b ? cmpTable(app, groups.get(a), groups.get(b), a, b, from, to, last, ranDays(v.db, app, 'ver'), { noRetention: true }) : empty('Chưa có hai version nào có user mới trong khoảng này.')}${crashList}`,
      `cài từ ${ddmm(from)} đến ${ddmm(to)}`, '', { span: 2, cls: 'track-result' }))
}
