// E3 · Crashlytics, last 24 h, per app: crash-free users (FATAL only, the console's number), users with
// an ANR, top issues. API notes in lib/crashlytics.ts.
import { APPS } from '../config.ts'
import { cut, empty, esc, link, num, pill, section, stale } from '../core/html.ts'
import { NotConfigured, type Module } from '../core/types.ts'
import { summary, topIssues, type Issue } from '../lib/crashlytics.ts'

export const CRASH_FREE_MIN = 99 // % crash-free users over 24h below which an app is flagged

export type CrashRow = { key: string; name: string; error?: string; crashFreeUsers?: number | null; crashUsers?: number; totalUsers?: number; anrUsers?: number; top?: Issue[] }

const isLow = (c: CrashRow) => c.crashFreeUsers != null && c.crashFreeUsers < CRASH_FREE_MIN
const freeText = (c: CrashRow) => c.crashFreeUsers == null ? '—' : `${num(c.crashFreeUsers, 2)}%`

// Four apps as a 2 × 2 of figures at every width (a 3 + 1 orphan never happens); top issues in one disclosure, by app.
const CSS = String.raw`
.crash-apps { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-lg) var(--space-md) }
@media (min-width: 40rem) { .crash-apps { column-gap: var(--space-lg) } }
.crash-app { display: grid; gap: var(--space-xs); align-content: start; min-width: 0 }
.crash-name { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-2xs) var(--space-xs); font-weight: 600; min-height: var(--space-lg) }
.crash-app .kv { margin: 0 }
.crash-top h3 { font-size: var(--text-sm); color: var(--ink-2); margin: var(--space-md) 0 var(--space-xs) }
.crash-top summary + h3 { margin-top: var(--space-xs) }
.crash-issues { grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--space-sm) }
.crash-issues > li { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: start; padding: var(--space-xs) 0 }
.crash-issue { display: grid; gap: var(--space-3xs); min-width: 0; font-size: var(--text-sm); overflow-wrap: anywhere }
.crash-sub { color: var(--muted) }
.crash-meta { display: flex; flex-wrap: wrap; gap: 0 var(--space-sm); color: var(--muted); font-size: var(--text-xs); font-variant-numeric: tabular-nums }
.crash-today .kv dd { display: inline-flex; align-items: center; gap: var(--space-xs) }
`

export const crash: Module<CrashRow[]> = {
  id: 'crash', title: 'Crash 24h', group: 'ops', every: 30 * 60, timeout: 120, css: CSS,

  async collect({ now, signal }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    if (!APPS.some(x => x.appId)) throw new NotConfigured('chưa có app nào có appId (Firebase app id) trong data/config.json')
    const out: CrashRow[] = []
    for (const a of APPS.filter(x => x.appId)) { // one app at a time: 3 calls each, ~1-2 s per call
      try {
        const s = await summary(a.appId!, now - 86_400_000, now, signal)
        const top = await topIssues(a.appId!, now - 86_400_000, now, 5, signal)
        out.push({ key: a.key, name: a.name, crashFreeUsers: s.crashFree, crashUsers: s.crashUsers, totalUsers: s.totalUsers, anrUsers: s.anrUsers, top })
      } catch (e) {
        if (signal.aborted || e instanceof NotConfigured) throw e // no Firebase login on this machine is not an app's error
        out.push({ key: a.key, name: a.name, error: (e as Error).message })
      }
    }
    if (out.length && out.every(r => r.error)) throw new Error(out[0].error!) // every app failed: keep the old numbers, raise the alert
    return out
  },

  panel(s, v) {
    const o = { cls: 'crash' }
    if (!s?.data) return section(this.title, empty('Đang lấy lần đầu…'), '', 'crash', o)
    const apps = s.data.map(c => {
      const low = isLow(c)
      const head = `<div class="crash-name"><span>${esc(c.name)}</span>${low ? pill('bad', `dưới ${CRASH_FREE_MIN}%`) : ''}</div>`
      if (c.error) return `<div class="crash-app">${head}<p class="sub bad-t">Lỗi: ${esc(cut(c.error, 140))}</p></div>`
      return `<div class="crash-app">${head}<div class="tile-fig"><span class="fig${low ? ' bad-t' : ''}">${freeText(c)}</span></div>
        <dl class="kv"><div><dt>User crash</dt><dd>${num(c.crashUsers)}</dd></div><div><dt>User ANR</dt><dd>${num(c.anrUsers)}</dd></div><div><dt>Tổng user</dt><dd>${num(c.totalUsers)}</dd></div></dl></div>`
    }).join('')
    const withIssues = s.data.filter(c => c.top?.length)
    const n = withIssues.reduce((t, c) => t + c.top!.length, 0)
    const issues = withIssues.map(c => `<h3>${esc(c.name)}</h3><ul class="list crash-issues">${c.top!.map(i => {
      const [lo, hi] = [i.versions[0], i.versions.at(-1)]
      return `<li>${pill(i.type === 'ANR' ? 'warn' : 'bad', i.type === 'ANR' ? 'ANR' : 'crash')}<div class="crash-issue">${link(i.uri, cut(i.title, 100))}
        ${i.subtitle ? `<span class="crash-sub">${esc(cut(i.subtitle, 120))}</span>` : ''}
        <span class="crash-meta"><span>${num(i.users)} user</span>${lo ? `<span>${esc(lo === hi ? lo : `${lo} → ${hi}`)}</span>` : ''}</span></div></li>`
    }).join('')}</ul>`).join('')
    return section(this.title, `${stale(s, v.now)}<div class="crash-apps">${apps}</div>${n ? `<details class="crash-top"><summary>Top issue của từng app (${n})</summary>${issues}</details>` : ''}`,
      `FATAL, cờ đỏ dưới ${CRASH_FREE_MIN}%`, 'crash', o)
  },

  alerts(s) {
    return (s?.data ?? []).filter(c => c.crashFreeUsers != null && c.crashFreeUsers < CRASH_FREE_MIN)
      .map(c => ({ tone: 'bad' as const, text: `${c.name}: crash-free ${c.crashFreeUsers!.toFixed(2)}% trong 24h`, href: '/ops' }))
  },

  // Hôm nay: the tiles' language, compact: the lowest app as the figure, every app on a .kv line
  today(s) {
    const d = s?.data
    if (!d?.length) return ''
    const known = d.filter(c => !c.error && c.crashFreeUsers != null)
    const lowest = known.reduce<CrashRow | undefined>((m, c) => !m || c.crashFreeUsers! < m.crashFreeUsers! ? c : m, undefined)
    const fig = lowest ? `<div class="tile-fig"><span class="fig${isLow(lowest) ? ' bad-t' : ''}">${freeText(lowest)}</span><span class="unit">crash-free thấp nhất, ${esc(lowest.name)}</span></div>` : ''
    const kv = d.map(c => `<div><dt>${esc(c.name)}</dt><dd>${c.error ? '<span class="warn-t">lỗi</span>' : `${isLow(c) ? `${pill('bad', `dưới ${CRASH_FREE_MIN}%`)} ` : ''}${freeText(c)}`}</dd></div>`).join('')
    return section('Crash 24h', `${fig}<dl class="kv">${kv}</dl>`, '', '', { cls: 'crash-today', act: '<a href="/ops#crash">Xem chi tiết</a>' })
  },
}
