// D · Theo dõi bản 2 (architecture.md "Theo dõi", owner approved T1, T2, T3 on 2026-11-09): comparison runs ("đợt so sánh") on cohorts
// fixed at install, suggested from Remote Config history, the data and Play Console, confirmed by the owner. Bản 1's
// daily D0 facts by version and experiment_group still feed /track/version and the Report's release markers.
// Files: runs.ts (pure logic, tested), store.ts (tables, collector parts), view.ts (pages), play.ts (T3), version.ts (bản 1 page).
import { APPS } from '../../config.ts'
import { board, empty, section } from '../../core/html.ts'
import { NotConfigured, type Alert, type Module, type Res } from '../../core/types.ts'
import { fromVnInput } from './runs.ts'
import { collectAll, confirmRun, getRun, getState, initStore, insertRun, listRuns, releases, setStatus, updateRun, useRcTimes } from './store.ts'
import { versionPage } from './version.ts'
import { boardPanel, readForm, runForm, runPage, runStats } from './view.ts'

export { initStore, saveRan, saveTFacts } from './store.ts'
export { signP } from './version.ts'

export type TrackData = {
  crashByVersion: Record<string, { version: string; build: string; crashFree: number | null; users: number }[]>
  releases: { app: string; day: string; version: string }[]
}

const notFound = (): Res => ({ title: 'Không có đợt', body: board(section('Đợt so sánh', empty('Không có đợt này.'), '', '', { span: 'all' })), status: 404 })
const runOf = (v: { db: any }, id: string) => getRun(v.db, Number(id))

export const track: Module<TrackData> = {
  id: 'track', title: 'Theo dõi', group: 'track', every: 30 * 60, timeout: 50 * 60,

  init: initStore,

  async collect({ now, signal, db }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    const errors = await collectAll(db, now, signal)
    if (errors.length) throw new Error(errors.join(' · '))
    return { crashByVersion: getState(db, 'crash')?.info?.crash ?? {}, releases: releases(db, now) }
  },

  panel: boardPanel,

  // warn, not bad: evaluate() already notified the SRM once; a "Gấp" line would push it again at night, every day
  alerts(_s, v): Alert[] {
    return listRuns(v.db, ['active']).filter(r => r.srm).map(r => {
      const st = runStats(v.db, r)
      return { tone: 'warn', text: `Đợt ${r.name} bị SRM: user mới ${st.sizes.map(s => s.toLocaleString('vi-VN')).join(' : ')}, kỳ vọng ${r.weights.join(':')}`, href: `/track/run/${r.id}` }
    })
  },

  routes: [
    { method: 'GET', path: '/track/version', handle: (req, v): Res => ({ title: 'So sánh version', body: versionPage(v, req.query), noRefresh: true }) },
    { method: 'GET', path: '/track/run/new', handle: (req, v): Res => ({ title: 'Ghi đợt so sánh', body: runForm(v, req.query, null), noRefresh: true }) },
    { method: 'GET', path: '/track/run/:id', handle: (req, v): Res => { const r = runOf(v, req.params.id); return r ? { title: r.name, body: runPage(v, r) } : notFound() } },
    { method: 'GET', path: '/track/run/:id/edit', handle: (req, v): Res => { const r = runOf(v, req.params.id); return r ? { title: `Sửa ${r.name}`, body: runForm(v, new URLSearchParams(), r), noRefresh: true } : notFound() } },
    { method: 'POST', path: '/track/run/save', handle: (req, v): Res => {
      const id = Number(req.form.get('id') ?? 0), old = id ? getRun(v.db, id) : null
      if (id && !old) return notFound()
      const { why, run } = readForm(req.form, fromVnInput, old)
      if (why) return { title: 'Chưa lưu', body: runForm(v, req.form, old, why), status: 400, noRefresh: true }
      const status = run.end_at != null && run.end_at <= v.now ? 'ended' : 'active'
      if (old) { updateRun(v.db, old.id, { ...run, status }); return { redirect: `/track/run/${old.id}` } }
      const nid = insertRun(v.db, { ...run, source: 'manual', exp_id: null, skey: null }, status, v.now, run.metric)
      return { redirect: nid ? `/track/run/${nid}` : '/track' }
    } },
    { method: 'POST', path: '/track/run/:id/confirm', handle: (req, v): Res => {
      const r = runOf(v, req.params.id)
      if (!r) return notFound()
      confirmRun(v.db, r.id, req.form.get('at') === 'alt' && r.alt_at ? r.alt_at : undefined)
      return { redirect: `/track/run/${r.id}` }
    } },
    { method: 'POST', path: '/track/run/:id/rc-times', handle: (req, v): Res => { useRcTimes(v.db, Number(req.params.id)); return { redirect: `/track/run/${Number(req.params.id)}` } } },
    { method: 'POST', path: '/track/run/:id/dismiss', handle: (req, v): Res => { const r = runOf(v, req.params.id); if (r?.status === 'suggested') setStatus(v.db, r.id, 'dismissed'); return { redirect: '/track#goi-y' } } },
    { method: 'POST', path: '/track/run/:id/end', handle: (req, v): Res => {
      const r = runOf(v, req.params.id)
      if (r?.status === 'active') setStatus(v.db, r.id, 'ended', v.now)
      return { redirect: `/track/run/${req.params.id}` }
    } },
    // bản 1 links: the A/B book became runs (skey test:<id>), its form became the run form
    { method: 'GET', path: '/track/test/:id', handle: (req, v): Res => {
      const r = v.db.prepare('select id from track_runs where skey = ?').get(`test:${Number(req.params.id)}`) as { id: number } | undefined
      return r ? { redirect: `/track/run/${r.id}` } : notFound()
    } },
    { method: 'GET', path: '/track/new', handle: (req): Res => {
      const q = new URLSearchParams()
      const app = req.query.get('app'), arms = req.query.get('arms')
      if (app && APPS.some(a => a.key === app)) q.set('app', app)
      if (arms) q.set('arms', arms)
      return { redirect: `/track/run/new${q.size ? `?${q}` : ''}` }
    } },
  ],

  css: String.raw`
/* run cards */
.track-card { display: grid; gap: var(--space-xs); align-content: start }
.track-sub { font-size: var(--text-sm) }
.track-split { position: relative; display: flex; height: 12px; border-radius: var(--radius-pill); overflow: hidden; background: var(--rule); margin-top: var(--space-2xs) }
.track-split > span { display: block; height: 100% }
.track-split > span + span { border-left: 2px solid var(--paper-2) }
.track-split .ta, .track-legend i.ta { background: var(--ink-2) }
.track-split .tb, .track-legend i.tb { background: var(--accent) }
.track-split .track-exp { position: absolute; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: var(--paper-2) }
.track-legend { align-items: baseline }
.track-legend i { height: 8px; width: 8px; border-radius: 2px }
.track-metrics { list-style: none; margin: 0; padding: 0; display: grid }
.track-metrics li { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 var(--space-sm); align-items: baseline; padding: var(--space-xs) 0; border-top: 1px solid var(--rule) }
.track-ml { font-size: var(--text-sm); grid-column: 1 }
.track-mc { grid-column: 2; grid-row: 1 / 3; align-self: center; justify-self: end; font-size: var(--text-sm) }
.track-mv { grid-column: 1; display: flex; flex-wrap: wrap; gap: 0 var(--space-xs); align-items: baseline; font-variant-numeric: tabular-nums }
.track-mv .delta { font-weight: 600 }
.track-ci { font-size: var(--text-xs); color: var(--muted) }
.track-acts { flex-wrap: wrap; gap: var(--space-xs) }
.track-acts form { display: contents }
.track-btn { display: inline-flex; align-items: center; min-height: 44px; padding: 0 var(--space-md); border: 1px solid var(--rule-2); border-radius: var(--radius-pill); color: var(--ink); text-decoration: none; font-weight: 500 }
.track-btn:hover { border-color: var(--accent) }
.track-sugg > li { display: grid; gap: var(--space-2xs) }

/* timeline */
.track-timeline { --track-lane: 22px }
.track-tl { display: grid; gap: var(--space-xs); min-width: 0 }
.track-tl-axis { position: relative; height: 1.25rem; margin-left: 5.5rem; font-size: var(--text-xs); color: var(--muted) }
.track-tl-axis span { position: absolute; transform: translateX(-50%); white-space: nowrap; font-variant-numeric: tabular-nums }
.track-tl-axis span.end { transform: translateX(-100%) }
@media (max-width: 39.99rem) { .track-tl-axis span.odd { display: none } .track-tl-row { grid-template-columns: 4.5rem minmax(0, 1fr) } .track-tl-axis { margin-left: 4.5rem } }
.track-tl-row { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); align-items: start; border-top: 1px solid var(--rule); padding-top: var(--space-xs) }
.track-tl-name { font-size: var(--text-sm); font-weight: 600; padding-top: 2px; overflow-wrap: anywhere }
.track-tl-lane { position: relative; min-width: 0; display: grid; gap: var(--space-2xs) }
.track-tl-marks { position: relative; height: 14px; background: linear-gradient(var(--rule), var(--rule)) center / 100% 1px no-repeat }
.track-mk { position: absolute; top: 50%; width: 10px; height: 10px; margin: -5px 0 0 -5px; display: inline-block }
.track-timeline .legend .track-mk { position: static; display: inline-block; width: 10px; height: 10px; margin: 0 var(--space-2xs) 0 0; vertical-align: middle; border-radius: 0 }
.track-timeline .legend .track-mk.ver { width: 8px; height: 8px; margin-right: 6px }
.track-timeline .legend .track-mk.roll { border-radius: 50% }
.track-timeline .legend .track-mk.lbl { width: 2px; height: 12px }
.track-timeline .legend .track-mk.ab, .track-timeline .legend .track-mk.abend { width: 0; height: 0 }
.track-timeline .legend .track-bar-key { height: 8px; width: 16px }
.track-mk.ver { background: var(--accent); transform: rotate(45deg); width: 8px; height: 8px; margin: -4px 0 0 -4px }
.track-mk.roll { background: var(--accent); border-radius: 50% }
.track-mk.lbl { width: 2px; height: 14px; margin: -7px 0 0 -1px; background: var(--ink-2) }
.track-mk.ab { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-bottom: 9px solid var(--ink-2) }
.track-mk.abend { width: 0; height: 0; background: none; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 9px solid var(--ink-2) }
.track-tl-bars { position: relative }
.track-bar { position: absolute; height: calc(var(--track-lane) - 4px); border-radius: 6px; background: var(--accent-soft); color: var(--ink); font-size: var(--text-xs); line-height: calc(var(--track-lane) - 4px); text-decoration: none; overflow: hidden; min-width: 6px }
.track-bar span { display: block; padding: 0 var(--space-2xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
.track-bar.s-active { background: var(--accent); color: var(--accent-ink) }
.track-bar.s-suggested { background: transparent; border: 1px dashed var(--rule-2) }
.track-bar:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px }
.track-bar-key { display: inline-block; width: 16px; height: 8px; border-radius: 3px; margin-right: var(--space-2xs); vertical-align: middle }
.track-bar-key.s-active { background: var(--accent) }
.track-bar-key.s-suggested { border: 1px dashed var(--rule-2) }
.track-tl-legend { margin-top: var(--space-xs) }
.track-recent ul { margin: var(--space-xs) 0 0; padding-left: var(--space-md); display: grid; gap: var(--space-2xs); font-size: var(--text-sm) }

/* run page: lift with interval, curves */
.track-forest-axis { display: flex; justify-content: space-between; margin-left: min(40%, 12rem); font-size: var(--text-xs); color: var(--muted) }
.track-forest { list-style: none; margin: 0; padding: 0; display: grid }
.track-forest li { display: grid; grid-template-columns: min(40%, 12rem) minmax(0, 1fr); gap: var(--space-2xs) 0; align-items: center; padding: var(--space-xs) 0; border-top: 1px solid var(--rule) }
.track-fl { font-size: var(--text-sm); padding-right: var(--space-xs) }
.track-fx { position: relative; height: 16px }
.track-f0 { position: absolute; left: 50%; top: -4px; bottom: -4px; width: 1px; background: var(--ink-2) }
.track-fci { position: absolute; top: 6px; height: 4px; border-radius: 2px; background: var(--muted) }
.track-fpt { position: absolute; top: 2px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; background: var(--muted); box-shadow: 0 0 0 2px var(--paper-2) }
.track-fci.ok, .track-fpt.ok { background: var(--good) }
.track-fci.bad, .track-fpt.bad { background: var(--bad) }
.track-fpt.out { background: var(--paper-2); border: 2px solid var(--muted) } /* past the axis: the number beside it is the value */
.track-fpt.out.ok { border-color: var(--good) } .track-fpt.out.bad { border-color: var(--bad) }
.track-fv { grid-column: 2; display: flex; flex-wrap: wrap; gap: 0 var(--space-xs); align-items: baseline; font-variant-numeric: tabular-nums }
.track-xy { height: 13rem }
.track-xy .bigchart { grid-template-columns: 3.25rem minmax(0, 1fr) 4.5rem }
.track-xy path.ta { stroke: var(--ink-2); stroke-width: 2; fill: none; stroke-dasharray: 5 3; stroke-linejoin: round }
.track-xy path.tb, .track-xy path.t0 { stroke: var(--accent); stroke-width: 2.5; fill: none; stroke-linejoin: round }
.track-xy path.t1 { stroke: var(--ink-2); stroke-width: 2; fill: none; stroke-dasharray: 5 3 }
.track-xy path.t2 { stroke: var(--c-ma28); stroke-width: 2; fill: none; stroke-dasharray: 2 3 }
.track-xy path.t3, .track-xy path.t4, .track-xy path.t5 { stroke: var(--c-raw); stroke-width: 1.5; fill: none }
.track-xy .bc-dot.ta, .track-xy .bc-dot.t1 { background: var(--ink-2) }
.track-xy .bc-dot.t2, .track-xy .bc-dot.t3, .track-xy .bc-dot.t4, .track-xy .bc-dot.t5 { background: var(--c-raw) }
.track-xy .mark { stroke: var(--ink-2); stroke-width: 1; stroke-dasharray: 3 3 }
.track-xy .xy-mark { position: absolute; top: 2px; margin-left: 4px; color: var(--ink-2); white-space: nowrap }
.track-xy .xy-mark.right { transform: translateX(-100%); margin-left: -4px }
.track-result .legend i.ta, .track-curve .legend i.ta { background: repeating-linear-gradient(90deg, var(--ink-2) 0 5px, transparent 5px 8px) }
.track-result .legend i.tb, .track-curve .legend i.tb, .track-result .legend i.t0 { background: var(--accent) }
.track-result .legend i.t1 { background: var(--ink-2) } .track-result .legend i.t2 { background: var(--c-ma28) }
.track-result .legend i.t3, .track-result .legend i.t4, .track-result .legend i.t5 { background: var(--c-raw) }
.track-how { margin: 0; padding-left: var(--space-md); display: grid; gap: var(--space-xs); font-size: var(--text-sm) }
.track-how code, .track-method code { font-size: var(--text-xs) }
.track-days table { margin-top: var(--space-xs) }
.track-ev .track-how { display: block }

/* B against A: a table in a wide box, two lines a metric in a narrow one */
.track-cmp { container-type: inline-size; min-width: 0 }
.track-cmp tbody th { font-weight: 500; white-space: normal; min-width: 9rem }
.track-n { display: block; font-size: var(--text-xs); color: var(--muted) }
.track-ev { font-size: var(--text-xs); color: var(--muted) }
@container (max-width: 39.99rem) {
  .track-cmp table, .track-cmp tbody { display: block }
  .track-cmp thead { display: none }
  .track-cmp tr { display: grid; grid-template-columns: auto auto auto minmax(0, 1fr) auto; align-items: baseline; gap: var(--space-2xs) var(--space-xs); padding: var(--space-sm) 0; border-top: 1px solid var(--rule) }
  .track-cmp tr:first-child { border-top: 0; padding-top: var(--space-2xs) }
  .track-cmp tr > * { display: block; padding: 0; border: 0; background: none; text-align: left }
  .track-cmp tbody th { grid-column: 1 / 5; grid-row: 1; min-width: 0 }
  .track-cmp .track-call { grid-column: 5; grid-row: 1; justify-self: end }
  .track-cmp .track-a { grid-column: 1; grid-row: 2 }
  .track-cmp .track-b { grid-column: 2; grid-row: 2 }
  .track-cmp .track-b::before { content: "→ "; color: var(--muted) }
  .track-cmp .track-lift { grid-column: 3; grid-row: 2 }
  .track-cmp .track-ev { grid-column: 1 / 6; grid-row: 3; white-space: normal }
  .track-cmp .track-n { display: none }
}

/* forms, version page, notes */
.track-pair { display: flex; flex-wrap: wrap; gap: var(--space-2xs) var(--space-lg); font-size: var(--text-sm) }
.track-srm { display: flex; align-items: baseline; gap: var(--space-xs); font-size: var(--text-sm) }
.track-srm > span:last-child { min-width: 0; overflow-wrap: anywhere }
.track-note { white-space: pre-wrap; overflow-wrap: anywhere }
.track-method { font-size: var(--text-sm); padding-top: var(--space-xs); border-top: 1px solid var(--rule) }
.track-method p + p { margin-top: var(--space-xs) }
.track-method .track-how { margin-top: var(--space-xs) }
.track-fields { grid-template-columns: repeat(auto-fit, minmax(min(100%, 14rem), 1fr)); align-items: end; gap: var(--space-sm) var(--space-md) }
.track-fields label { display: grid; gap: var(--space-2xs) }
/* the shared stylesheet styles type=date but not datetime-local: the same pill */
.track-fields input[type=datetime-local] { font: inherit; font-size: max(16px, var(--text-md)); color: var(--ink); background: var(--raised); border: 0; border-radius: var(--radius-pill);
  box-shadow: inset 0 0 0 1px var(--muted); padding: 0 var(--space-md); min-height: 44px; width: 100%; outline: 2px solid transparent; outline-offset: -3px }
.track-fields input[type=datetime-local]:focus-visible { outline-color: var(--focus); box-shadow: inset 0 0 0 1px var(--ink-2) }
.track-fields .track-full, .track-new .track-fields button { grid-column: 1 / -1 }
.track-result .kv { max-width: 32rem }
/* a long RC condition (AB_NativeCollap_Close_1103) wraps instead of widening the overview at 360 px */
.track-aside .kv dd { white-space: normal; min-width: 0; overflow-wrap: anywhere }
.track-aside .tag { white-space: normal; max-width: 100%; overflow-wrap: anywhere }

/* board: no hole at any column count (panels that would sit alone take the row) */
@media (min-width: 48rem) and (max-width: 79.99rem) { .track-aside, .track-other, .track-method-panel { grid-column: 1 / -1 } }
@media (min-width: 120rem) { .track-result { grid-column: span 3 } }
`,
}
