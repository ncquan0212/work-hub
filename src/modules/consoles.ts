// Play Console vitals and AdMob earnings, read from the consoles' own pages through the browser bridge
// (no API we may use: owner rules R1/R2). These pages are single-page apps nobody has inspected yet, so
// every reading is validated and the page text is saved as a sample (data/bridge-samples, chmod 600):
// when a rule finds nothing, the panel says "cần hiệu chỉnh" instead of showing a wrong number, and the
// next agent calibrates the rules below from the sample. Once a day; read-only (no clicks).
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { APPS, DATA, PROFILE_LABELS } from '../config.ts'
import { ago, cut, empty, esc, pill, section, stale } from '../core/html.ts'
import { NotConfigured, type Alert, type Module } from '../core/types.ts'
import { bridgePage, initBridge, lastSeen, loggedOut, type PageResult } from '../lib/bridge.ts'

const SAMPLES = join(DATA, 'bridge-samples')

/** Play developer accounts with their apps and store titles, from the config (playDev, playAccount, storeTitle), in app
 *  order. Exported for tests. */
export function playAccounts(apps = APPS) {
  const out = new Map<string, { dev: string; account: string; apps: { key: string; title: string }[] }>()
  for (const a of apps) {
    if (!a.playDev) continue
    let acc = out.get(a.playDev)
    if (!acc) out.set(a.playDev, acc = { dev: a.playDev, account: a.playAccount ?? a.playDev, apps: [] })
    acc.apps.push({ key: a.key, title: a.storeTitle ?? a.name })
  }
  return [...out.values()]
}
const PLAY = playAccounts()
// each half reads through its own Chrome profile: Play Console in `falcon`, AdMob in `publisher`
const PLAY_ON = PLAY.length > 0 && !!PROFILE_LABELS.falcon, ADMOB_ON = !!PROFILE_LABELS.publisher
const OFF = !APPS.length ? 'chưa có app trong data/config.json' : !PLAY_ON && !ADMOB_ON
  ? 'Play Console cần playDev của app và chromeProfiles.falcon, AdMob cần chromeProfiles.publisher trong data/config.json' : ''
// Play's "bad behavior" thresholds (Android vitals, overall)
const BAD = { crash: 1.09, anr: 0.47 }

function sample(name: string, p: PageResult) {
  mkdirSync(SAMPLES, { recursive: true, mode: 0o700 })
  const f = join(SAMPLES, `${name}.txt`)
  writeFileSync(f, `${p.finalUrl}\n${p.title}\n\n${p.text}\n\n--- links ---\n${p.links.map(l => l.join(' | ')).join('\n')}`, { mode: 0o600 })
  chmodSync(f, 0o600)
  return f
}

/** First percentage after a label in page text, e.g. "User-perceived crash rate\n0.21%". Exported for tests.
 *  Review 2026-11-09: the label is grouped (an English|Vietnamese alternation bound the number to its last branch, and
 *  the English page threw); only blanks and one icon word ("info") may sit between label and value (a wider gap ran
 *  past "Không đủ dữ liệu" to the threshold or the next metric and showed it as the app's rate); Play ships some
 *  Vietnamese decomposed, so the text is normalized to NFC like the labels in this file. */
export const pctAfter = (text: string, label: RegExp) =>
  pct(text, new RegExp(`(?:${label.source})\\s*(?:[a-z_]+\\s*)?(\\d{1,2}(?:[.,]\\d{1,3})?)\\s?%`, 'i'))
/** The rate on a metric's detail page (seen 2026-11-11, eight pages): the metric picker names it, then the filters and
 *  "Lần cập nhật dữ liệu gần nhất là Thứ Ba, 15:00", then the app's value as the first plain percentage line. What sits
 *  around it differs: two help icons, or the metric name and "so với ứng dụng ngang hàng: …" (XRemote crash); then
 *  "Phiên bản chính thức", or "error" and "so với ngưỡng" when over the threshold (Idol ANR). A "-" or "Không đủ dữ
 *  liệu" before any percentage is the app having no value: the peer average further down ("0,13%\nĐiểm trung bình…")
 *  must not be taken for it. Exported for tests. */
export function detailPct(text: string, label: RegExp) {
  const t = text.normalize('NFC')
  const m = new RegExp(`(?:${label.source})\\s*arrow_drop_down[\\s\\S]{0,600}?(?:lần cập nhật dữ liệu gần nhất|last updated)[^\\n]*`, 'i').exec(t)
  if (!m) return null
  for (const l of t.slice(m.index + m[0].length).split('\n').map(x => x.trim()).filter(Boolean).slice(0, 12)) {
    if (l === '-' || /không đủ dữ liệu|not enough data/i.test(l)) return null
    if (/^\d{1,2}(?:[.,]\d{1,3})?\s?%$/.test(l)) return pct(l, /^([\d.,]+)/)
  }
  return null
}
function pct(text: string, re: RegExp) {
  const m = text.normalize('NFC').match(re)
  const v = m ? Number(m[1].replace(',', '.')) : null
  return v != null && v >= 0 && v <= 100 ? v : null
}
/** First money amount after a label, e.g. "Yesterday\nUS$123.45" or AdMob's rounded "Yesterday\n$24.6K" (seen 2026-11-09).
 *  No letters in the gap: an amount shown as "—" must not take the next label's amount (review 2026-11-09). */
export function moneyAfter(text: string, label: RegExp) {
  const m = text.match(new RegExp(`(?:${label.source})[^\\da-z$€₫]{0,40}?(?:US\\$|\\$|€|₫)\\s?([\\d.,]+)(?:([KMB])(?![A-Za-z]))?`, 'i'))
  if (!m) return null
  const v = Number(m[1].replace(/,(?=\d{3}\b)/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) * ({ K: 1e3, M: 1e6, B: 1e9 }[m[2]?.toUpperCase() ?? ''] ?? 1)
  return Number.isFinite(v) ? v : null
}

/** Console id path of each app on a developer's app list, by package name. The row's title is in no link's
 *  text: each row shows its package on a line of its own and ends with an "arrow_forward" link to the app
 *  dashboard, also an "arrow_forward" line in the text. So the text splits into one block per row, and the n-th
 *  block pairs with the n-th such link (DOM order, whatever the sort). A block without exactly one package (a new
 *  app before its first bundle has none) loses only its own row (review 2026-11-09: it used to blank the account).
 *  When the block and link counts differ the page changed: return nothing rather than pair wrongly. Exported for tests. */
export function appPaths(p: Pick<PageResult, 'text' | 'links'>, dev: string): Record<string, string> {
  const blocks: string[][] = [[]]
  for (const l of p.text.split('\n').map(x => x.trim())) l === 'arrow_forward' ? blocks.push([]) : blocks.at(-1)!.push(l)
  blocks.pop() // what follows the last row (the page footer)
  const rows = p.links.filter(([href, text]) => text.includes('arrow_forward') && href.endsWith('/app-dashboard'))
    .map(([href]) => href.match(new RegExp(`/developers/${dev}/app/\\d+`))?.[0])
  if (!rows.length || blocks.length !== rows.length || rows.some(r => !r)) return {}
  return Object.fromEntries(blocks.flatMap((b, i) => {
    const pkgs = b.filter(l => /^[a-zA-Z]\w*(\.\w+){2,}$/.test(l))
    return pkgs.length === 1 ? [[pkgs[0], rows[i]!]] : []
  }))
}

type Vital = { key: string; account: string; crash: number | null; anr: number | null; url?: string; error?: string; sample?: string
  bad?: string[] /* Play's own "Hành vi xấu" cards on the overview, e.g. "Mức sử dụng bộ nhớ, bản 165 (2.0.63), hạn khắc phục thg 2 2027" */ }
type Earnings = { today: number | null; yesterday: number | null; month: number | null; lastMonth: number | null; sample?: string; error?: string }
export type ConsolesData = { vitals: Vital[]; admob?: Earnings /* absent when AdMob is off in this copy */ }

/** Play's "Hành vi xấu" (bad behavior) cards on a vitals overview, in words: the metric, its value, the release, the fix
 *  deadline. Seen 2026-11-11: Idol's ANR card names the metric after the flag, Brain's memory card names it before.
 *  Exported for tests. */
export function badBehavior(text: string): string[] {
  const lines = text.normalize('NFC').split('\n').map(l => l.trim()).filter(Boolean)
  const ICON = /^[a-z_]+$/ // Material icon names on their own line (error, thumb_up, expand_less)
  const out: string[] = []
  lines.forEach((l, i) => {
    if (!/^hành vi xấu$/i.test(l)) return
    // the card ends at its fold toggle: past it come other sections and their release names (Idol 2026-11-11)
    const rest = lines.slice(i + 1, i + 14), end = rest.findIndex(x => /^expand_less$|^mở rộng tất cả$/i.test(x))
    const after = end >= 0 ? rest.slice(0, end) : rest, before = lines.slice(Math.max(0, i - 3), i).filter(x => !ICON.test(x))
    const metric = after.find(x => /^tỷ lệ |^mức sử dụng|^thời gian|^hiển thị|^khung hình|^wake ?lock|^bộ hẹn giờ/i.test(x)) ?? before.at(-1) ?? ''
    const v = after[after.indexOf(metric) + 1]
    const value = metric && v && /^\d{1,3}(?:[.,]\d+)?\s?%$/.test(v) ? v : ''
    const release = after.find(x => /^tên bản phát hành:/i.test(x))?.replace(/^tên bản phát hành:\s*/i, '')
    const di = after.findIndex(x => /^hạn chót khắc phục$/i.test(x)), deadline = di >= 0 ? after[di + 1] : ''
    if (metric) out.push([`${metric}${value ? ` ${value}` : ''}`, release ? `bản ${release}` : '', deadline ? `hạn khắc phục ${deadline}` : ''].filter(Boolean).join(', '))
  })
  return [...new Set(out)]
}

// The overview folds its metric sections on an app Play has flagged (2026-11-11: XRemote, Brain, Idol showed no rate, XCast
// did), and the extension never clicks; each rate's own detail page always shows it (the overview links it as "Xem chỉ số")
const DETAIL = { crash: 'USER_PERCEIVED_CRASHES', anr: 'USER_PERCEIVED_ANRS' } as const
const detailUrl = (appPath: string, metric: keyof typeof DETAIL) =>
  `https://play.google.com/console/u/0${appPath}/vitals/metrics/details?userCohort=OS_RELEASED_VIEW&days=28&metric=${DETAIL[metric]}`
// a selector that never matches: the extension then waits its full 60 s before reading, enough for a console page that
// renders its cards long after "complete" (AdMob 2026-11-11 was read with only its menu; the text had stopped growing)
const FULL_WAIT = '[data-work-hub-wait-full]'
const CRASH = /user[- ]perceived crash rate|tỷ lệ sự cố mà người dùng nhận thấy/, ANR = /user[- ]perceived ANR rate|tỷ lệ (?:lỗi )?ANR mà người dùng nhận thấy/

async function playVitals(db: DatabaseSync, signal: AbortSignal): Promise<Vital[]> {
  // every page of a step is queued at once and the extension takes them back to back; one at a time, each waited for
  // the extension's next minute poll (a run took 18 of its 20 minutes on 2026-11-11). So a job's wait counts the queue
  // ahead of it. A page that fails costs only its own app or rate (review 2026-11-09)
  const page = async (url: string, waitFor?: string) => {
    try { return await bridgePage(db, 'falcon', url, signal, waitFor, 15 * 60_000) } catch (e) { if (signal.aborted) throw e; return e instanceof Error ? e : new Error(String(e)) }
  }
  // the app list gives each app's console id, found by package name
  const lists = await Promise.all(PLAY.map(acc => page(`https://play.google.com/console/u/0/developers/${acc.dev}/app-list`)))
  if (lists.some(l => !(l instanceof Error) && loggedOut(l.finalUrl))) throw new Error(`${PROFILE_LABELS.falcon} chưa đăng nhập Play Console`)
  type App = { acc: (typeof PLAY)[number]; app: (typeof PLAY)[number]['apps'][number] } & ({ appPath: string } | { error: string; sample?: string })
  const apps = PLAY.flatMap((acc, i): App[] => {
    const list = lists[i]
    if (list instanceof Error) return acc.apps.map(app => ({ acc, app, error: list.message }))
    const listSample = sample(`play-app-list-${acc.dev}`, list), paths = appPaths(list, acc.dev)
    return acc.apps.map(app => {
      const appPath = paths[APPS.find(a => a.key === app.key)?.pkg ?? '']
      return appPath ? { acc, app, appPath } : { acc, app, error: 'không tìm thấy app trong danh sách (cần hiệu chỉnh)', sample: listSample }
    })
  })
  const overview = (appPath: string) => `https://play.google.com/console/u/0${appPath}/vitals/metrics/overview`
  const pages = await Promise.all(apps.map(a => 'appPath' in a ? page(overview(a.appPath)) : null))
  // the console follows the profile's language (Vietnamese; labels confirmed on XCast's page 2026-11-11). The overview
  // folds its sections now and then (XRemote and Brain at 07:05, XCast at 09:29 the same day): a rate it does not show
  // comes from that metric's detail page, read in full
  const rates = pages.map(p => p && !(p instanceof Error) ? { crash: pctAfter(p.text, CRASH), anr: pctAfter(p.text, ANR) } : null)
  const want = rates.flatMap((r, i) => r ? (['crash', 'anr'] as const).filter(m => r[m] == null).map(m => ({ i, m })) : [])
  const details = await Promise.all(want.map(w => { const a = apps[w.i]; return 'appPath' in a ? page(detailUrl(a.appPath, w.m), FULL_WAIT) : null }))
  want.forEach((w, k) => {
    const d = details[k]
    if (!d || d instanceof Error) return
    sample(`play-vitals-${apps[w.i].app.key}-${w.m}`, d)
    rates[w.i]![w.m] = detailPct(d.text, w.m === 'crash' ? CRASH : ANR)
  })
  return apps.map((a, i): Vital => {
    const base = { key: a.app.key, account: a.acc.account, crash: null, anr: null }
    if (!('appPath' in a)) return { ...base, error: a.error, sample: a.sample }
    const url = overview(a.appPath), p = pages[i]!
    if (p instanceof Error) return { ...base, url, error: p.message }
    const { crash, anr } = rates[i]!, bad = badBehavior(p.text)
    return { ...base, crash, anr, url, sample: sample(`play-vitals-${a.app.key}`, p), bad: bad.length ? bad : undefined,
      error: crash == null && anr == null ? 'đọc được trang nhưng chưa nhận ra số (cần hiệu chỉnh)' : undefined }
  })
}

async function admob(db: DatabaseSync, signal: AbortSignal): Promise<Earnings> {
  const p = await bridgePage(db, 'publisher', 'https://admob.google.com/v2/home', signal, FULL_WAIT)
  if (loggedOut(p.finalUrl)) throw new Error(`${PROFILE_LABELS.publisher} chưa đăng nhập AdMob`)
  const f = sample('admob-home', p)
  const e = { today: moneyAfter(p.text, /today so far/), yesterday: moneyAfter(p.text, /yesterday/), month: moneyAfter(p.text, /this month so far/), lastMonth: moneyAfter(p.text, /last month/), sample: f }
  return Object.values(e).slice(0, 4).every(x => x == null) ? { ...e, error: 'đọc được trang nhưng chưa nhận ra số (cần hiệu chỉnh)' } : e
}

const fmt = (v: number | null, digits = 2) => v == null ? '—' : v.toLocaleString('vi-VN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
const TITLE: Record<string, string> = Object.fromEntries(PLAY.flatMap(a => a.apps.map(x => [x.key, x.title])))
const tone = (v: number | null, bad: number) => v == null ? '' : v >= bad ? 'bad' : v >= bad * 0.8 ? 'warn' : 'ok'

/** A bar against Play's threshold: the scale runs to twice the threshold, the tick marks the threshold. */
function meter(v: number | null, bad: number, label: string) {
  const x = (n: number) => (Math.min(n / (bad * 2), 1) * 100).toFixed(1)
  return `<svg class="consoles-meter" viewBox="0 0 100 10" preserveAspectRatio="none" role="img" aria-label="${esc(label)}"><rect class="track" x="0" y="3" width="100" height="4"/>${v == null ? '' : `<rect class="val ${tone(v, bad)}" x="0" y="3" width="${x(v)}" height="4"/>`}<rect class="limit" x="49.5" y="0" width="1" height="10"/></svg>`
}
function rate(name: string, v: number | null, bad: number) {
  const t = tone(v, bad)
  return `<span class="big${t === 'bad' ? ' bad-t' : ''}">${v == null ? '<span class="muted">—</span>' : `${esc(fmt(v))}%`}</span>${meter(v, bad, `${name} ${v == null ? 'chưa có số' : `${fmt(v)}%`}, ngưỡng ${fmt(bad)}%`)}${t === 'bad' ? '<div class="sub bad-t">vượt ngưỡng</div>' : t === 'warn' ? '<div class="sub warn-t">gần ngưỡng</div>' : ''}`
}
/** The run's error says "Play: … · AdMob: …" when both sides failed: one line per source. */
function errorLines(err: string | undefined) {
  const m = /^Play: ([\s\S]*) · AdMob: ([\s\S]*)$/.exec(err ?? '')
  const xs: [string, string][] = m ? [['Play Console', m[1]], ['AdMob', m[2]]] : [['Lỗi', err ?? '']]
  return `<ul class="alerts">${xs.map(([src, e]) => `<li>${pill('warn', 'lỗi')}<span><span class="src">${esc(src)}</span> ${esc(cut(e, 200))}</span></li>`).join('')}</ul>`
}

export const consoles: Module<ConsolesData> = {
  id: 'consoles', title: 'Play Console và AdMob', group: 'ops', daily: '07:05', timeout: 30 * 60,

  init: initBridge,

  async collect({ db, signal }) {
    if (OFF) throw new NotConfigured(OFF)
    // two Chrome profiles, two extensions: Play and AdMob are read at the same time
    const [vitals, earn] = await Promise.all([
      !PLAY_ON ? [] : playVitals(db, signal).catch(e => { if (signal.aborted) throw e; return [{ key: '*', account: '', crash: null, anr: null, error: (e as Error).message }] as Vital[] }),
      !ADMOB_ON ? undefined : admob(db, signal).catch(e => { if (signal.aborted) throw e; return { today: null, yesterday: null, month: null, lastMonth: null, error: (e as Error).message } as Earnings }),
    ])
    // fails only when every half this copy reads failed
    if ((!PLAY_ON || vitals.every(x => x.error)) && (!earn || earn.error))
      throw new Error([PLAY_ON && `Play: ${vitals[0]?.error}`, earn && `AdMob: ${earn.error}`].filter(Boolean).join(' · '))
    return { vitals, admob: earn }
  },

  css: String.raw`
.consoles-panel { container: consoles / inline-size }
.consoles-body { display: grid; gap: var(--space-lg); min-width: 0 }
.consoles-part { display: grid; gap: var(--space-xs); align-content: start; min-width: 0 }
.consoles-part > header { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-sm) }
.consoles-part > header p { color: var(--muted); font-size: var(--text-sm) }
.consoles-vitals th, .consoles-vitals td { white-space: normal; vertical-align: top }
.consoles-vitals th:first-child { width: 34% }
.consoles-vitals td:not(:first-child) { padding-right: var(--space-md) }
.consoles-vitals .big { display: block; margin-bottom: var(--space-2xs) }
.consoles-vitals td.consoles-note { padding-top: 0; font-size: var(--text-sm) }
.consoles-meter { display: block; width: 100%; max-width: 12rem; height: 10px }
.consoles-meter .track { fill: var(--rule) }
.consoles-meter .val { fill: var(--accent) }
.consoles-meter .val.warn { fill: var(--warn) }
.consoles-meter .val.bad { fill: var(--bad) }
.consoles-meter .limit { fill: var(--ink-2) }
.consoles-earn { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-sm) var(--space-lg); margin: 0 }
.consoles-earn > div { border-top: 1px solid var(--rule); padding-top: var(--space-xs); min-width: 0 }
.consoles-earn dt { color: var(--muted); font-size: var(--text-sm); font-weight: 500 }
.consoles-earn dd { margin: 0 }
.consoles-samples code { font-size: var(--text-xs); overflow-wrap: anywhere }
.consoles-samples ul { margin: 0; padding-left: var(--space-md); display: grid; gap: var(--space-2xs); color: var(--muted) }
@container consoles (min-width: 30rem) {
  .consoles-earn { grid-template-columns: repeat(4, minmax(0, 1fr)) }
}
@container consoles (min-width: 52rem) {
  .consoles-body { grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); column-gap: var(--space-xl) }
  .consoles-part:only-child { grid-column: 1 / -1 }
  .consoles-earn { grid-template-columns: repeat(2, minmax(0, 1fr)) }
}
`,

  panel(s, v) {
    if (OFF) return section(this.title, empty(`Chưa cấu hình: ${OFF}.`), '', 'consoles', { cls: 'consoles-panel', span: 3 })
    const d = s?.data
    const roles = ([['falcon', PLAY_ON, 'Play'], ['publisher', ADMOB_ON, 'AdMob']] as const).filter(r => r[1])
    // never read yet, or every source failed: the same layout with dashes, under what broke and what to do
    const vitals: Vital[] = d?.vitals.some(x => x.key !== '*') ? d.vitals
      : PLAY.flatMap(acc => acc.apps.map(app => ({ key: app.key, account: acc.account, crash: null, anr: null })))
    const playError = d?.vitals.find(x => x.key === '*')?.error
    const a: Earnings = d?.admob ?? { today: null, yesterday: null, month: null, lastMonth: null }
    const state = !s?.at ? `<p class="muted">Chưa đọc lần nào. Hub đọc lúc ${esc(this.daily)} mỗi ngày, qua extension: ${esc(roles.map(([p, , src]) => `${src} trong ${PROFILE_LABELS[p]}`).join(', '))}.</p>`
      : !d ? `${errorLines(s.error)}<p class="sub muted">Lần đọc ${esc(ago(s.at, v.now))} chưa được, chưa có số nào. ${
          // the extension came up after that failure: nothing to fix, the next daily run will read
          roles.every(([p]) => (lastSeen(v.db, p) ?? 0) > s.at)
            ? `Extension đã kết nối sau lần đó; hub đọc lại lúc ${esc(this.daily)}.`
            : `Cách sửa: cài extension trong ${esc(roles.map(([p]) => PROFILE_LABELS[p]).join(' và '))}, xem <a href="#bridge">Trình duyệt (extension)</a>.`}</p>`
      : stale(s, v.now)
    const note = `đọc qua Chrome lúc ${this.daily}`
    // nothing read yet: say so in a line or two, no table of dashes
    if (!d) return section(this.title, state, note, 'consoles', { cls: 'consoles-panel', span: 3 })
    const rows = vitals.map(x => `<tr><td><b>${esc(TITLE[x.key] ?? x.key)}</b><div class="sub muted">${esc(x.account)}</div></td>
      <td>${rate('Crash', x.crash, BAD.crash)}</td><td>${rate('ANR', x.anr, BAD.anr)}</td></tr>
      ${x.bad?.length ? `<tr><td colspan="3" class="consoles-note bad-t">${esc(TITLE[x.key] ?? x.key)}: Play báo hành vi xấu: ${esc(x.bad.join('; '))}</td></tr>` : ''}
      ${x.error ? `<tr><td colspan="3" class="consoles-note warn-t">${esc(TITLE[x.key] ?? x.key)}: ${esc(x.error)}</td></tr>` : ''}`).join('')
    const samples = [...vitals.map(x => x.sample), a.sample].filter(Boolean) as string[]
    const earn = ([['Hôm nay', a.today], ['Hôm qua', a.yesterday], ['Tháng này', a.month], ['Tháng trước', a.lastMonth]] as const)
      .map(([k, x]) => `<div><dt>${k}</dt><dd class="big">${x == null ? '<span class="muted">—</span>' : `$${esc(fmt(x, x >= 1000 ? 0 : 2))}`}</dd></div>`).join('')
    return section(this.title, `${state}<div class="consoles-body">
      ${PLAY_ON ? `<div class="consoles-part"><header><h3>Play vitals</h3><p>tỷ lệ user gặp crash và ANR; vạch là ngưỡng xấu của Play (crash ${esc(fmt(BAD.crash))}%, ANR ${esc(fmt(BAD.anr))}%)</p></header>
        ${playError && d ? `<p class="warn-t">${esc(cut(playError, 200))}</p>` : ''}<table class="consoles-vitals"><thead><tr><th>App</th><th>Crash</th><th>ANR</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}
      ${ADMOB_ON ? `<div class="consoles-part"><header><h3>AdMob</h3><p>số ước tính trên trang chủ AdMob, USD, làm tròn như trên trang</p></header>
        ${a.error && d ? `<p class="warn-t">${esc(cut(a.error, 200))}</p>` : ''}<dl class="consoles-earn">${earn}</dl></div>` : ''}
      </div>${samples.length ? `<details class="consoles-samples"><summary>Mẫu trang đã lưu (${samples.length}), để hiệu chỉnh bộ đọc</summary><ul>${samples.map(f => `<li><code>${esc(f)}</code></li>`).join('')}</ul></details>` : ''}`,
      note, 'consoles', { cls: 'consoles-panel', span: 3 })
  },

  alerts(s): Alert[] {
    const vitals = s?.data?.vitals ?? []
    return [
      ...vitals.filter(x => (x.crash ?? 0) >= BAD.crash * 0.8 || (x.anr ?? 0) >= BAD.anr * 0.8)
        .map(x => ({ tone: (x.crash ?? 0) >= BAD.crash || (x.anr ?? 0) >= BAD.anr ? 'bad' : 'warn', text: `Play vitals ${TITLE[x.key] ?? x.key}: crash ${x.crash ?? '—'}%, ANR ${x.anr ?? '—'}% (ngưỡng ${BAD.crash}% và ${BAD.anr}%)`, href: '/ops' }) as Alert),
      // Play's own flags for what the rates above do not cover (memory, start-up …); crash and ANR are the line above
      ...vitals.flatMap(x => (x.bad ?? []).filter(b => !/^tỷ lệ (sự cố|lỗi ANR|ANR)/i.test(b))
        .map(b => ({ tone: 'warn' as const, text: `Play vitals ${TITLE[x.key] ?? x.key}: Play báo hành vi xấu, ${b}`, href: '/ops' }))),
    ]
  },
}

