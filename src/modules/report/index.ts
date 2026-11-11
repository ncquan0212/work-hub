// C · Report: daily numbers per app from Databuckets (+ Crashlytics per day), stored in SQLite, with
// MA7/MA28 computed here (Databuckets has no window functions). Runs once a day; `npm run report:backfill`
// fills the past 35 days once. Owner rules: UTC days, 4 Databuckets calls a day for this module
// (Theo dõi uses the other 2 of the 6 the owner accepted).
import { existsSync } from 'node:fs'
import { APPS, rcKeyPath } from '../../config.ts'
import { ago, board, boardHead, cut, empty, esc, pill, section, brief } from '../../core/html.ts'
import { NotConfigured, type Alert, type Module, type View } from '../../core/types.ts'
import { summary } from '../../lib/crashlytics.ts'
import { runEql } from '../../lib/databuckets.ts'
import { getJson, serviceAccountProject, serviceAccountToken } from '../../lib/google.ts'
import { movingAvg, outlier, ptValue, type Pt } from '../../lib/stats.ts'
import { bigChart, lineChart, sparkline, type Marker } from '../../lib/svg.ts'
import { axisUnit, COHORT, cohortPoint, fmtUnit, GROUP_LABEL, METRICS, metricsFor, point, type CohortDef, type MetricDef } from './metrics.ts'
import { addDays, COLS, cohortQueries, eql, formatQueries, toCohort, toFacts, utcDay, type Fact } from './queries.ts'
import { initStore, lastDay, loadCohort, loadEvents, loadFacts, saveCohort, saveEvents, saveFacts } from './store.ts'

const DAY = 86_400_000
const WINDOW = 90 // days shown on charts
// daily cohort pull: 4 buckets × 4 apps × 31 rd × 2 events = 992 rows, just under the 1,000-row cap;
// a 5th app splits it per app pair (cohortQueries)
const RDS_DAILY = Array.from({ length: 31 }, (_, i) => i)

type Run = { name: string; ok: boolean; ms: number; facts?: number; error?: string }
export type ReportData = { runs: Run[] }

// ───────────── collecting ─────────────

/** Crash-free / ANR for whole UTC days, `days` complete days back from yesterday. */
export async function crashDays(db: Parameters<typeof saveFacts>[0], now: number, days: number, signal: AbortSignal) {
  const facts: Fact[] = []
  const today = Date.parse(utcDay(now) + 'T00:00:00Z')
  for (const a of APPS.filter(x => x.appId)) {
    for (let i = 1; i <= days; i++) {
      const start = today - i * DAY, s = await summary(a.appId!, start, start + DAY, signal)
      if (!s.totalUsers) continue
      const day = utcDay(start)
      facts.push({ app: a.key, day, key: 'crash.total', value: s.totalUsers }, { app: a.key, day, key: 'crash.users', value: s.crashUsers },
        { app: a.key, day, key: 'anr.users', value: s.anrUsers })
    }
  }
  saveFacts(db, facts)
  return facts.length
}

/** Remote Config publish days, as chart markers. */
async function rcEvents(db: Parameters<typeof saveFacts>[0], signal: AbortSignal) {
  let n = 0
  for (const a of APPS) {
    const file = rcKeyPath(a)
    if (!file || !existsSync(file)) continue // no RC key on this machine: that app gets no RC markers, the run goes on
    const j = await getJson(`https://firebaseremoteconfig.googleapis.com/v1/projects/${serviceAccountProject(file)}/remoteConfig:listVersions?pageSize=100`, await serviceAccountToken(file), signal)
    const ev = (j.versions ?? []).map((v: any) => ({ app: a.key, day: utcDay(Date.parse(v.updateTime)), kind: 'rc', label: `RC v${v.versionNumber}` }))
    saveEvents(db, ev); n += ev.length
  }
  return n
}

async function step(runs: Run[], name: string, signal: AbortSignal, f: () => Promise<number>, fresh = false) {
  const t = Date.now()
  try { runs.push({ name, ok: true, ms: Date.now() - t, facts: await f() }); runs.at(-1)!.ms = Date.now() - t } catch (e) {
    if (signal.aborted) throw e
    // a source this copy has not set up (no Firebase login…) is noted on the step, not a failed run; once the report
    // has numbers it is a failure: the source worked and was lost (review 11/11)
    runs.push({ name, ok: e instanceof NotConfigured && fresh, ms: Date.now() - t, error: (e as Error).message })
  }
}

// ───────────── reading ─────────────

type Series = { days: string[]; pts: Pt[]; values: (number | null)[]; ma7: (number | null)[]; ma28: (number | null)[] }

function daysUpTo(last: string, n: number) { return Array.from({ length: n }, (_, i) => addDays(last, i - n + 1)) }

/** How many days the app has stored, its first day to `last`. */
function storedDays(db: Parameters<typeof lastDay>[0], app: string, last: string) {
  const first = (db.prepare(`select min(day) d from report_facts where app = ? and key = 'session_start.users'`).get(app) as { d: string | null }).d ?? last
  return Math.max(2, Math.round((Date.parse(last) - Date.parse(first)) / DAY) + 1)
}

/** Chart window: up to WINDOW days ending at `last`, starting no earlier than the app's first stored day. */
function windowDays(db: Parameters<typeof lastDay>[0], app: string, last: string) {
  return daysUpTo(last, Math.min(WINDOW, storedDays(db, app, last)))
}

function series(m: MetricDef, facts: Map<string, Map<string, number>>, days: string[]): Series {
  const pts = days.map(d => point(m, facts.get(d)))
  return { days, pts, values: pts.map(ptValue), ma7: movingAvg(pts, 7), ma28: movingAvg(pts, 28) }
}

function cohortSeries(d: CohortDef, cells: Map<string, Map<number, { users: number; rev: number }>>, last: string, days: string[], facts: Map<string, Map<string, number>>): Series {
  const pts = days.map(c => cohortPoint(d, c, facts.get(c)?.get('first_open.users'), cells.get(c), last))
  return { days, pts, values: pts.map(ptValue), ma7: movingAvg(pts, 7), ma28: movingAvg(pts, 28) }
}

/** Latest value, the MA7 that ended the day before, and the same weekday a week earlier. */
function headline(s: Series) {
  const i = s.values.findLastIndex(v => v != null)
  if (i < 0) return null
  const v = s.values[i]!, base = s.ma7[i - 1] ?? null, week = s.values[i - 7] ?? null
  return { day: s.days[i], v, ma7: s.ma7[i], vsMa7: base ? v / base - 1 : null, vsWeek: week ? v / week - 1 : null }
}

const BETTER_DOWN = new Set(['anr'])
function delta(x: number | null, id: string, label: string) {
  if (x == null || !Number.isFinite(x)) return ''
  const good = BETTER_DOWN.has(id) ? x < 0 : x > 0
  const tone = Math.abs(x) < 0.02 ? 'muted' : good ? 'ok-t' : 'bad-t'
  const pct = Math.abs(x * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: 1 })
  return `<span class="delta ${tone}">${x > 0 ? '▲' : x < 0 ? '▼' : ''}${pct}%</span>${label ? ` <span class="muted">${esc(label)}</span>` : ''}`
}

function appSummary(v: View, app: string) {
  const last = lastDay(v.db, app)
  if (!last) return null
  const days = daysUpTo(last, 60), facts = loadFacts(v.db, app, days[0])
  const key = METRICS.filter(m => m.key).map(m => ({ m, s: series(m, facts, days) }))
  const { cells, last: cl } = loadCohort(v.db, app, addDays(last, -60))
  const d1 = cohortSeries(COHORT.find(c => c.id === 'd1')!, cells, cl, daysUpTo(last, 60), facts)
  return { last, key, d1 }
}

// ───────────── rendering ─────────────

const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`

/** One metric as one panel on the detail board: name and day, the figure with its MA7, both deltas, the
 *  chart, then the definition and the 14-day table. Heads line up across a row, so the note goes last. */
/** The figure with its MA7, then both deltas (a cohort has no week-ago one). */
function figure(s: Series, unit: MetricDef['unit'], id: string, cohort: boolean) {
  const h = headline(s)
  if (!h) return '<p class="empty">Chưa có số.</p>'
  const deltas = [delta(h.vsMa7, id, 'so với MA7'), cohort ? '' : delta(h.vsWeek, id, 'so với tuần trước')].filter(Boolean).map(x => `<span>${x}</span>`).join('')
  return `<div class="report-fig"><span class="fig">${esc(fmtUnit(unit, h.v))}</span>${h.ma7 != null ? `<span class="muted">MA7 ${esc(fmtUnit(unit, h.ma7))}</span>` : ''}</div>
    ${deltas ? `<div class="report-deltas">${deltas}</div>` : ''}`
}

const chartSeries = (s: Series, cohort: boolean) => [{ label: cohort ? 'theo ngày cài' : 'theo ngày', cls: 'raw' as const, values: s.values }, { label: 'MA7', cls: 's1' as const, values: s.ma7 }, { label: 'MA28', cls: 's2' as const, values: s.ma28 }]

/** The day-by-day table, newest first. */
function dayTable(s: Series, unit: MetricDef['unit'], cohort: boolean, max: number) {
  const rows = s.days.map((d, i) => ({ d, i })).filter(x => s.values[x.i] != null).slice(-max).reverse()
    .map(({ d, i }) => `<tr><td>${esc(ddmm(d))}</td><td class="num">${esc(fmtUnit(unit, s.values[i]))}</td><td class="num">${esc(fmtUnit(unit, s.ma7[i]))}</td><td class="num">${esc(fmtUnit(unit, s.ma28[i]))}</td></tr>`)
  return rows.length ? `<details><summary>Bảng ${rows.length} ngày</summary><div class="scroll"><table><thead><tr><th>${cohort ? 'Ngày cài' : 'Ngày'}</th><th class="num">Giá trị</th><th class="num">MA7</th><th class="num">MA28</th></tr></thead><tbody>${rows.join('')}</tbody></table></div></details>` : ''
}

const zoomHref = (app: string, id: string) => `/report/app/${encodeURIComponent(app)}/chart/${encodeURIComponent(id)}`

function chartCard(app: string, title: string, unit: MetricDef['unit'], s: Series, id: string, note = '', markers: Marker[] = [], cohort = false) {
  const h = headline(s)
  const chart = lineChart({ title, days: s.days, fmt: x => fmtUnit(unit, x), axisFmt: x => axisUnit(unit, x), markers, series: chartSeries(s, cohort) })
  // the chart itself opens the zoom too (a tap on a phone); the "Phóng to" link is the one keyboards and readers get
  const zoom = `<a class="report-zoom-link" href="${esc(zoomHref(app, id))}" tabindex="-1" aria-hidden="true">${chart}</a>`
  return section(title, `${figure(s, unit, id, cohort)}${zoom}${note ? `<p class="report-note">${esc(note)}</p>` : ''}${dayTable(s, unit, cohort, 14)}`, '', `report-${id}`,
    { cls: 'report-chart', act: `${h ? `<span class="muted">${cohort ? 'cài ' : ''}${esc(ddmm(h.day))}</span> ` : ''}<a href="${esc(zoomHref(app, id))}" aria-label="Phóng to ${esc(title)}">Phóng to</a>` })
}

const RANGES = [14, 30, 90, 180]

/** One chart on a page of its own, filling the screen (owner 2026-11-09): back to the app, any range from 14 days to
 *  everything stored. MA7 and MA28 run over 27 days more than are shown, so both lines reach the left edge. */
function zoomPage(v: View, app: string, id: string, range: string | null) {
  const a = APPS.find(x => x.key === app), last = lastDay(v.db, app)
  const m = metricsFor(app).find(x => x.id === id), c = m ? undefined : COHORT.find(x => x.id === id)
  if (!a || !last || !(m || c)) return null
  const all = storedDays(v.db, app, last)
  const n = range === 'all' ? all : RANGES.includes(Number(range)) ? Math.min(Number(range), all) : Math.min(WINDOW, all)
  const ext = daysUpTo(last, n + 27), facts = loadFacts(v.db, app, ext[0])
  const full = m ? series(m, facts, ext) : (({ cells, last: cl }) => cohortSeries(c!, cells, cl, ext, facts))(loadCohort(v.db, app, ext[0]))
  const s: Series = { days: full.days.slice(-n), pts: full.pts.slice(-n), values: full.values.slice(-n), ma7: full.ma7.slice(-n), ma28: full.ma28.slice(-n) }
  const def = (m ?? c)!, cohort = !m, unit = def.unit
  const markers = cohort ? [] : markersFor(v, app, s.days[0])
  const chip = (d: string, label: string, on: boolean) => `<a href="${esc(zoomHref(app, id))}?d=${d}"${on ? ' aria-current="page"' : ''}>${label}</a>`
  const chips = [...RANGES.filter(r => r < all).map(r => chip(String(r), `${r} ngày`, n === r)), chip('all', 'Tất cả', n === all)].join('')
  const h = headline(s)
  const head = `<div class="report-zoom-head"><a class="report-zoom-back" href="/report/app/${esc(app)}#report-${esc(id)}">← ${esc(a.name)}</a>
    <h1>${esc(def.label)}</h1>${h ? `<span class="muted">${cohort ? 'cài ' : 'đến '}${esc(ddmm(h.day))}</span>` : ''}
    <nav class="report-apps report-range" aria-label="Khoảng ngày">${chips}</nav></div>`
  const chart = bigChart({ title: `${def.label} ${a.name}, ${n} ngày`, days: s.days, fmt: x => fmtUnit(unit, x), axisFmt: x => axisUnit(unit, x), markers, series: chartSeries(s, cohort) })
  const legend = `<div class="legend">${chartSeries(s, cohort).map(x => `<span><i class="${x.cls}"></i>${esc(x.label)}</span>`).join('')}</div>`
  const marks = markers.length ? `<h2>Mốc trong khoảng này</h2><ul class="list">${[...markers].reverse().map(x => `<li><span class="muted">${esc(ddmm(x.day))}</span> ${esc(x.label)}</li>`).join('')}</ul>` : ''
  const note = 'note' in def && def.note ? `<p class="report-note">${esc(def.note)}</p>` : ''
  return `<div class="report-zoom"><div class="report-zoom-screen">${head}<div class="report-zoom-fig">${figure(s, unit, id, cohort)}</div><div class="report-zoom-chart">${chart}</div></div>
    <div class="report-zoom-more">${legend}<p class="report-note">Ngày UTC. <span class="report-hover">Rê chuột lên biểu đồ để xem số từng ngày; </span>số từng ngày có ở bảng dưới.</p>${note}${marks}${dayTable(s, unit, cohort, n)}</div></div>`
}

function markersFor(v: View, app: string, from: string): Marker[] {
  const byDay = new Map<string, string[]>()
  for (const e of loadEvents(v.db, app, from)) byDay.set(e.day, [...(byDay.get(e.day) ?? []), e.label])
  // soft dependency: release markers published by the Theo dõi module, if it is installed
  for (const r of v.slot<{ releases?: { app: string; day: string; version: string }[] }>('track')?.data?.releases ?? [])
    if (r.app === app && r.day >= from) byDay.set(r.day, [...(byDay.get(r.day) ?? []), `bản ${r.version} vượt 1% user mới`])
  return [...byDay].map(([day, labels]) => ({ day, label: labels.length > 4 ? `${labels.slice(0, 4).join(', ')} +${labels.length - 4}` : labels.join(', ') }))
}

/** Detail page: app tabs, one line on how to read the charts, then one board of chart panels with a heading
 *  row per metric group (4 a row on a PC, 3 on a laptop, 2 on a tablet, 1 on a phone). */
function detailPage(v: View, app: string) {
  const a = APPS.find(x => x.key === app)!
  const last = lastDay(v.db, app)
  const nav = `<nav class="report-apps" aria-label="App">${APPS.map(x => `<a href="/report/app/${esc(x.key)}"${x.key === app ? ' aria-current="page"' : ''}>${esc(x.name)}</a>`).join('')}</nav>`
  if (!last) return `<div class="report-page">${nav}${board(section(a.name, '<p class="empty">Chưa có số. Report chạy mỗi ngày lúc 07:05, hoặc chạy <code>npm run report:backfill</code> để nạp 35 ngày.</p>', '', '', { span: 'all' }))}</div>`
  const days = windowDays(v.db, app, last), facts = loadFacts(v.db, app, days[0]), markers = markersFor(v, app, days[0])
  const group = (g: MetricDef['group']) => {
    const cards = metricsFor(app).filter(m => m.group === g).map(m => ({ m, s: series(m, facts, days) })).filter(x => x.s.values.some(y => y != null))
    const card = (x: (typeof cards)[number]) => chartCard(app, x.m.label, x.m.unit, x.s, x.m.id, x.m.note, markers)
    if (g !== 'ads') return cards.length ? boardHead(GROUP_LABEL[g]) + cards.map(card).join('') : ''
    // Ads: the three overall charts, then the 15 per-format ones under their own heading (one format a row at 3 columns)
    const all = cards.filter(x => x.m.base !== 'fmt._ran'), fmt = cards.filter(x => x.m.base === 'fmt._ran')
    return (all.length ? boardHead(GROUP_LABEL.ads) + all.map(card).join('') : '')
      + (fmt.length ? boardHead('Ads theo format', 'Số lượt, eCPM và tỉ trọng doanh thu của từng format.') + fmt.map(card).join('') : '')
  }
  const { cells, last: cl } = loadCohort(v.db, app, days[0])
  const coh = COHORT.map(d => ({ d, s: cohortSeries(d, cells, cl, days, facts) })).filter(x => x.s.values.some(y => y != null))
  const cohort = coh.length ? boardHead('Giữ chân và LTV theo ngày cài', 'Retention Dn: user mở app ngày thứ N ÷ user cài ngày đó (first_open); app Kotlin lệch ±1 ngày quanh nửa đêm UTC. LTV: doanh thu ads cộng dồn ÷ user cài ngày đó.')
    + coh.map(x => chartCard(app, x.d.label, x.d.unit, x.s, x.d.id, '', [], true)).join('') : ''
  const legend = '<div class="legend" aria-hidden="true"><span><i class="raw"></i>theo ngày</span><span><i class="s1"></i>MA7</span><span><i class="s2"></i>MA28</span></div>'
  const lede = `<div class="report-lede"><p>Ngày UTC, số đến hết ${esc(last)}. Vạch nhỏ dưới trục là ngày publish RC hoặc ra bản mới. <span class="report-hover">Rê chuột lên biểu đồ để xem số từng ngày.</span> Bấm vào biểu đồ để xem toàn màn hình và chọn khoảng ngày.</p>${legend}</div>`
  // what leads: users and money, then retention, then the ad detail, crashes and the app's own events
  return `<div class="report-page">${nav}${lede}${board(group('user') + group('biz') + cohort + group('ads') + group('tech') + group('app'))}</div>`
}

export const report: Module<ReportData> = {
  id: 'report', title: 'Report', group: 'report', daily: '07:05', timeout: 45 * 60,

  init: initStore,

  async collect({ now, signal, db }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    const runs: Run[] = []
    // a source never set up here is not a failure; one that has given numbers before and is now missing is
    const had = (key: string) => !!db.prepare('select 1 from report_facts where key = ? limit 1').get(key)
    const dbFresh = !had('session_start.users'), crashFresh = !had('crash.total')
    // 4 Databuckets calls, one at a time (each ~100 s); the last 3 complete days are refreshed every run
    await step(runs, 'Số chính', signal, async () => {
      const [r] = await runEql([{ eql: eql.core(4), cols: COLS.core }], signal)
      const f = toFacts('core', r.rows, now); saveFacts(db, f); return f.length
    }, dbFresh)
    const fq = formatQueries(4)
    await step(runs, fq.length > 1 ? 'Format ads và Idol video' : 'Format ads', signal, async () => {
      const [f, m] = await runEql(fq, signal)
      const facts = [...toFacts('formats', f.rows, now), ...(m ? toFacts('idolModes', m.rows, now, ['idol']) : [])]; saveFacts(db, facts); return facts.length
    }, dbFresh)
    await step(runs, 'Event riêng app', signal, async () => {
      const [r] = await runEql([{ eql: eql.appEvents(4), cols: COLS.appEvents }], signal)
      const f = toFacts('appEvents', r.rows, now); saveFacts(db, f); return f.length
    }, dbFresh)
    await step(runs, 'Cohort', signal, async () => {
      const qs = cohortQueries(3, RDS_DAILY), res = await runEql(qs, signal)
      const c = res.flatMap((r, i) => toCohort(r.rows, now, RDS_DAILY, qs[i].apps)); saveCohort(db, c); return c.length
    }, dbFresh)
    await step(runs, 'Crashlytics theo ngày', signal, () => crashDays(db, now, 3, signal), crashFresh)
    await step(runs, 'Mốc RC', signal, () => rcEvents(db, signal))
    const failed = runs.filter(r => !r.ok)
    if (failed.length) throw new Error(failed.map(f => `${f.name}: ${f.error}`).join(' · '))
    return { runs }
  },

  // The apps' summary: a table from 48rem (one row per app, each cell the figure, its delta and 30 days of
  // shape), restacked below that into one labelled block per app (2 metrics a row, 3 from 40rem).
  panel(s, v) {
    const cols = [['dau', 'DAU'], ['new', 'User mới'], ['iaa', 'Doanh thu ads'], ['arpdau', 'ARPDAU'], ['d1', 'Retention D1'], ['crash_free', 'Crash-free']] as const
    const tail = <T,>(xs: T[]) => xs.slice(-30)
    const rows = APPS.map(a => {
      const sm = appSummary(v, a.key)
      const name = `<th scope="row"><a href="/report/app/${esc(a.key)}">${esc(a.name)}</a>${sm ? `<span class="report-day">đến ${esc(ddmm(sm.last))}</span>` : ''}</th>`
      if (!sm) return `<tr class="report-none">${name}<td colspan="6" class="muted">Chưa có số.</td></tr>`
      return `<tr>${name}${cols.map(([id, label]) => {
        const k = id === 'd1' ? { unit: 'pct' as const, s: sm.d1 } : (x => x && { unit: x.m.unit, s: x.s })(sm.key.find(x => x.m.id === id))
        const h = k && headline(k.s)
        if (!k || !h) return `<td class="num" data-label="${esc(label)}">—</td>`
        const odd = id !== 'new' && id !== 'd1' && outlier(k.s.values) // same check as alerts()
        return `<td class="num" data-label="${esc(label)}"><span class="report-v">${esc(fmtUnit(k.unit, h.v))}</span>
          <span class="report-d">${delta(h.vsMa7, id, '') || '<span class="muted">—</span>'}${id === 'd1' ? ` <span class="muted">cài ${esc(ddmm(h.day))}</span>` : ''}</span>
          ${sparkline(tail(k.s.values), tail(k.s.ma7), `${label} ${a.name} 30 ngày; đường đậm là MA7`)}${odd ? pill('warn', 'Bất thường') : ''}</td>`
      }).join('')}</tr>`
    }).join('')
    const err = s && !s.ok && s.at ? `<p class="report-err">${pill('warn', 'Lỗi')}<span>Lần chạy ${esc(ago(s.at, v.now))} lỗi: ${esc(cut(brief(s.error), 160))}. Số bên dưới là số đã lưu, đến ngày ghi ở từng app.</span></p>` : ''
    const runs = s?.data?.runs ?? []
    const foot = `<div class="report-foot"><p>Đường nhỏ là 30 ngày, nét đậm là MA7. Bất thường: ngoài khoảng MA28 ± 2σ. Chạy mỗi ngày lúc 07:05.</p>${runs.length
      ? `<div class="report-runs"><span class="muted">Lần lấy số ${esc(ago(s?.dataAt, v.now))}:</span>${runs.map(r => r.ok && r.error ? pill('mute', `${r.name}: chưa cấu hình`) : pill(r.ok ? 'ok' : 'bad', `${r.ok ? '✓' : '✗'} ${r.name}, ${Math.round(r.ms / 1000)} s`)).join('')}</div>` : ''}</div>`
    return section(`Hôm qua của ${APPS.length} app`, `${err}<table class="report-sum"><thead><tr><th scope="col">App</th>${cols.map(([, l]) => `<th scope="col" class="num">${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>${foot}`,
      'Ngày UTC. Mũi tên: hôm qua so với MA7 của 7 ngày trước đó.', 'report', { span: 'all', cls: 'report-panel' })
  },

  // Hôm nay: one tile per app, the figure the owner opens the hub for (DAU) with 30 days of shape behind it
  today(_s, v) {
    const tiles = APPS.map(a => {
      const sm = appSummary(v, a.key)
      if (!sm) return ''
      const get = (id: string) => { const k = sm.key.find(x => x.m.id === id); return k ? { ...k, h: headline(k.s) } : null }
      const dau = get('dau'), tail = <T,>(xs: T[]) => xs.slice(-30)
      const fig = dau?.h ? `<div class="tile-fig"><span class="fig">${esc(fmtUnit(dau.m.unit, dau.h.v))}</span><span class="unit">DAU</span>${delta(dau.h.vsMa7, 'dau', '')}</div>` : ''
      const spark = dau ? sparkline(tail(dau.s.values), tail(dau.s.ma7), `DAU ${a.name} 30 ngày; đường đậm là MA7`) : ''
      const kv = ['iaa', 'arpdau'].map(id => {
        const k = get(id)
        return k?.h ? `<div><dt>${esc(k.m.label)}</dt><dd>${esc(fmtUnit(k.m.unit, k.h.v))} ${delta(k.h.vsMa7, id, '')}</dd></div>` : ''
      }).join('')
      return `<a class="tile" href="/report/app/${esc(a.key)}"><div class="tile-name">${esc(a.name)}<span>${esc(sm.last.slice(8, 10))}/${esc(sm.last.slice(5, 7))}</span></div>${fig}${spark}${kv ? `<dl class="kv">${kv}</dl>` : ''}</a>`
    }).filter(Boolean).join('')
    return tiles ? `<div class="board-head"><h2>Hôm qua của ${APPS.length} app</h2><p>Ngày UTC; mũi tên so với MA7 của 7 ngày trước đó.</p></div><div class="tiles">${tiles}</div>` : ''
  },

  alerts(_s, v) {
    const out: Alert[] = []
    for (const a of APPS) {
      const sm = appSummary(v, a.key)
      if (!sm) continue
      for (const { m, s } of sm.key) {
        if (m.id === 'new') continue
        const h = headline(s)
        if (m.id === 'iaa' && h?.vsMa7 != null && h.vsMa7 < -0.3) { out.push({ tone: 'bad', text: `${a.name}: doanh thu ads ${h.day} thấp hơn MA7 ${Math.round(-h.vsMa7 * 100)}%`, href: `/report/app/${a.key}` }); continue }
        const o = outlier(s.values)
        if (o) out.push({ tone: 'warn', text: `${a.name}: ${m.label} ${fmtUnit(m.unit, s.values.at(-1))} ngoài khoảng MA28 ± 2σ (${o.z > 0 ? 'cao' : 'thấp'} bất thường)`, href: `/report/app/${a.key}` })
      }
    }
    return out
  },

  routes: [{
    method: 'GET', path: '/report/app/:key/chart/:id',
    handle: (req, v) => {
      const body = zoomPage(v, req.params.key, req.params.id, req.query.get('d'))
      const a = APPS.find(x => x.key === req.params.key)
      return body ? { title: `${[...metricsFor(req.params.key), ...COHORT].find(x => x.id === req.params.id)!.label} · ${a!.name}`, body, bare: true }
        : { title: 'Không có biểu đồ này', body: board(section('Report', empty('Không có biểu đồ này, hoặc app chưa có số.'), '', '', { span: 'all' })), status: 404 }
    },
  }, {
    method: 'GET', path: '/report/app/:key',
    handle: (req, v) => APPS.some(a => a.key === req.params.key)
      ? { title: `Report · ${APPS.find(a => a.key === req.params.key)!.name}`, body: detailPage(v, req.params.key) }
      : { title: 'Không có app này', body: board(section('Report', empty('Không có app này.'), '', '', { span: 'all' })), status: 404 },
  }],

  css: String.raw`
/* summary (group page): a table from 48rem, one labelled block per app below */
.report-err { display: flex; align-items: baseline; gap: var(--space-xs); font-size: var(--text-sm) }
.report-err > span:last-child { min-width: 0; overflow-wrap: anywhere }
.report-sum { table-layout: fixed }
.report-sum th, .report-sum td { white-space: normal }
.report-sum thead th:first-child { width: 7rem }
.report-sum tbody th, .report-sum tbody td { padding-top: var(--space-sm); padding-bottom: var(--space-sm) }
.report-sum tbody th { font-weight: 600 }
.report-day { display: block; font-size: var(--text-xs); font-weight: 400; color: var(--muted) }
.report-v { display: block; font-size: var(--text-lg); font-weight: 600; line-height: 1.25; letter-spacing: -0.01em; font-variant-numeric: tabular-nums; white-space: nowrap }
.report-d { display: block; font-size: var(--text-xs); white-space: nowrap }
.report-d .delta { font-size: var(--text-xs) }
.report-sum .pill { margin-top: var(--space-xs) }
.report-sum svg.spark { height: 28px; margin-top: var(--space-xs) }
.report-foot { display: grid; gap: var(--space-xs); padding-top: var(--space-sm); border-top: 1px solid var(--rule); font-size: var(--text-xs); color: var(--muted) }
.report-runs { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs) }
.report-runs .pill { white-space: normal; line-height: 1.3 }
@media (max-width: 47.99rem) {
  .report-sum, .report-sum tbody { display: block }
  .report-sum thead { display: none }
  .report-sum tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-md) var(--space-lg); padding: var(--space-md) 0; border-top: 1px solid var(--rule) }
  .report-sum tbody tr:first-child { border-top: 0; padding-top: 0 }
  .report-sum tbody tr > * { display: block; padding: 0; border: 0; text-align: left; background: none }
  .report-sum tbody th { grid-column: 1 / -1; display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-sm); font-size: var(--text-lg) }
  .report-sum td::before { content: attr(data-label); display: block; font-size: var(--text-xs); color: var(--muted) }
  .report-sum .report-none td { grid-column: 1 / -1 }
}
@media (min-width: 40rem) and (max-width: 47.99rem) { .report-sum tr { grid-template-columns: repeat(3, minmax(0, 1fr)) } }
@media (min-width: 48rem) and (max-width: 79.99rem) {
  .report-sum th, .report-sum td { padding-left: var(--space-2xs); padding-right: var(--space-2xs) }
  .report-sum tr > :first-child { padding-left: 0 } .report-sum tr > :last-child { padding-right: 0 }
  .report-sum thead th:first-child { width: 6rem }
}
@media (min-width: 80rem) { .report-sum thead th:first-child { width: 10rem } .report-v { font-size: var(--text-xl) } .report-sum svg.spark { height: 36px } }

/* detail page: app tabs, the reading line, chart panels */
.report-page { display: grid; gap: var(--space-md); min-width: 0 }
.report-page > .board { grid-auto-flow: row; margin-top: var(--space-xs); align-items: stretch }
@media (hover: none) { .report-hover { display: none } }
.report-page .board-head:not(:first-child) { margin-top: var(--space-md) }
.report-apps { display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: var(--space-3xs); padding: var(--space-3xs); background: var(--paper-2); border-radius: var(--radius-pill) }
.report-apps a { display: flex; align-items: center; justify-content: center; min-height: 40px; padding: 0 var(--space-xs); border-radius: var(--radius-pill); color: var(--muted);
  font-size: var(--text-sm); font-weight: 500; text-decoration: none; white-space: nowrap; transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out) }
.report-apps a[aria-current="page"] { background: var(--accent-soft); color: var(--ink); font-weight: 600 }
@media (hover: hover) { .report-apps a:not([aria-current]):hover { background: var(--paper-3); color: var(--ink) } }
@media (min-width: 40rem) { .report-apps { justify-self: start; grid-auto-columns: auto } .report-apps a { padding: 0 var(--space-lg) } }
.report-lede { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs) var(--space-lg); font-size: var(--text-sm); color: var(--muted) }
.report-lede p { flex: 1 1 28rem; max-width: 75ch }
.report-chart { container-type: inline-size; gap: var(--space-xs) }
.report-chart .panel-head h2 { font-size: var(--text-md) }
.report-fig { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm); font-size: var(--text-sm) }
.report-deltas { display: grid; gap: var(--space-3xs); font-size: var(--text-sm) }
.report-chart svg.chart { margin-top: var(--space-xs) }
.report-chart .legend, .report-chart svg.chart text.val { display: none }
.report-note { font-size: var(--text-xs); color: var(--muted) }
/* the chart is a 600-unit viewBox drawn 300 to 600px wide: grow its labels as it shrinks so they stay about 10 to 11px */
@container (max-width: 34.99rem) { .report-chart svg.chart text { font-size: 13px } }
@container (max-width: 28.74rem) { .report-chart svg.chart text { font-size: 16px } }
@container (max-width: 23.74rem) { .report-chart svg.chart text { font-size: 19px } }
@container (max-width: 19.99rem) { .report-chart svg.chart text { font-size: 21px } }

/* zoom: one chart on a bare page, the first screen is the chart */
.report-zoom-link { display: block; color: inherit; text-decoration: none; cursor: zoom-in }
.report-zoom { display: grid; gap: var(--space-lg); min-width: 0 }
.report-zoom-screen { display: flex; flex-direction: column; gap: var(--space-xs); min-height: 20rem;
  height: calc(100dvh - max(var(--space-sm), env(safe-area-inset-top)) - var(--space-xs)) }
.report-zoom-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm) }
.report-zoom-head h1 { font-size: var(--text-xl) }
.report-zoom-back { display: inline-flex; align-items: center; min-height: 40px; padding: 0 var(--space-md); border-radius: var(--radius-pill); background: var(--paper-2);
  font-size: var(--text-sm); font-weight: 500; text-decoration: none; white-space: nowrap }
@media (hover: hover) { .report-zoom-back:hover { background: var(--paper-3) } }
.report-range { flex: 1 1 100% }
@media (min-width: 40rem) { .report-range { flex: 0 0 auto; margin-left: auto } }
.report-zoom-fig { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-md) }
.report-zoom-fig .fig { font-size: var(--text-2xl) }
.report-zoom-fig .report-deltas { display: flex; flex-wrap: wrap; gap: var(--space-2xs) var(--space-md) }
.report-zoom-chart { flex: 1 1 auto; min-height: 12rem }
.report-zoom-more { display: grid; gap: var(--space-sm); max-width: 60rem }
.report-zoom-more h2 { font-size: var(--text-md); margin-top: var(--space-xs) }
`,
}
