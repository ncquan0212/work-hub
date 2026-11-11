// Theo dõi bản 2 (architecture.md "Theo dõi", "so song song theo thời điểm"): a comparison run ("đợt so sánh") is an app, its arms
// (app_version values for a version run, experiment_group values for an A/B run, A first), the expected split and a
// window in UTC ms. Its users are fixed at install: the cohort is who installed in the window, split by arm at install,
// so every metric (D0, retention, ad LTV) follows the same people. Pure functions here; tested in test/track.test.ts.
//
// Probed 2026-11-09 (requestIds in the Theo dõi docs):
//  - first_open carries the A/B arm only for ~9% of the arm's users: Firebase assigns the arm after the app fetches RC,
//    so first_open mostly carries the default label (IL…). An A/B arm is therefore "users whose events on their
//    install day (retention_day 0) carry the arm label"; a version arm is "users whose first_open has that version".
//    A user labelled with one arm almost never shows the other (11 of 48,932).
//  - the engine moves every absolute `to` one day forward, hour precision too: we send `to` a day early.
//  - grouping by a field drops the events that lack it (mode): Idol call modes need their own query.
//  - a step returns at most 1,000 rows; its true count is in `steps`.
import { APPS } from '../../config.ts'

/** App a Theo dõi page opens on: Idol when this hub follows it (its A/B tests are what the page was built for), else the first. */
export const DEFAULT_APP = (APPS.find(a => a.key === 'idol') ?? APPS[0])?.key ?? ''
import { DATASET, type Row } from '../../lib/databuckets.ts'
import { addDays, utcDay } from '../../lib/days.ts'
import { normCdf } from '../../lib/stats.ts'
import type { GroupFacts } from './compare.ts'

export const HOUR = 3_600_000, DAY = 86_400_000
export type Kind = 'version' | 'ab'
export type Status = 'suggested' | 'active' | 'ended' | 'dismissed'
export type Source = 'rc' | 'data' | 'play' | 'manual'
export type Run = {
  id: number; app: string; kind: Kind; name: string; arms: string[]; weights: number[]; start_at: number; end_at: number | null
  source: Source; status: Status; cond: string | null; exp_id: string | null; metric: string | null; note: string | null
  skey: string | null; alt_at: number | null; refreshed_at: number | null; pulled_to: string | null; error: string | null
  srm: number; horizon: number; decided_at: number | null; decision: string | null; created_at: number
}
export type NewRun = Pick<Run, 'app' | 'kind' | 'name' | 'arms' | 'weights' | 'start_at' | 'end_at' | 'source' | 'cond' | 'exp_id' | 'note' | 'skey'> & { horizon?: number }

/** Arm values go into EQL string literals: versions, labels like Set1, IL2611090, _null_. Nothing else. */
export const ARM_RE = /^[\w.-]{1,40}$/
export const field = (k: Kind) => k === 'version' ? 'app_version' : 'experiment_group'
/** Vietnam time (UTC+7, no DST) for the pages and the forms. */
export const vnTime = (t: number) => { const s = new Date(t + 7 * HOUR).toISOString(); return `${s.slice(11, 16)} ${s.slice(8, 10)}/${s.slice(5, 7)}` }
export const vnInput = (t: number) => new Date(t + 7 * HOUR).toISOString().slice(0, 16)
export const fromVnInput = (s: string) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s) ? Date.parse(`${s}:00+07:00`) : NaN

// ───────────── Remote Config history ─────────────

export type RcExp = { id: string; cond: string; arms: string[]; exposure: number | null }
export type RcSum = { v: number; at: number; by: string; label: string | null; exps: RcExp[] }

/** What a template says about experiments: experiment_group's default (the date label, IL2611090) and each Firebase
 *  A/B experiment on it (abt_N, its RC condition, the arm labels). Other parameters of an experiment carry no label. */
export function rcSummary(t: any): Pick<RcSum, 'label' | 'exps'> {
  const all: Record<string, any> = { ...(t?.parameters ?? {}) }
  for (const g of Object.values<any>(t?.parameterGroups ?? {})) Object.assign(all, g?.parameters ?? {})
  const eg = all.experiment_group
  const label = typeof eg?.defaultValue?.value === 'string' && eg.defaultValue.value ? eg.defaultValue.value : null
  const exps = Object.entries<any>(eg?.conditionalValues ?? {}).flatMap(([cond, cv]) => {
    const x = cv?.experimentValue
    if (!x?.experimentId) return []
    const arms = (x.variantValue ?? []).map((v: any) => v?.value).filter((v: unknown): v is string => typeof v === 'string' && ARM_RE.test(v))
    return [{ id: String(x.experimentId), cond, arms, exposure: x.exposurePercent == null ? null : Number(x.exposurePercent) }]
  })
  return { label, exps }
}

export type RcEv = { at: number; v: number; type: 'label' | 'ab_start' | 'ab_end' | 'ab_exposure' | 'ab_arms'; label?: string; from?: string | null; exp?: RcExp }

/** Changes between consecutive versions (sorted by number): default label, experiments started, ended, re-exposed,
 *  given other arms (`from` = the old arms, Set1/Set2). */
export function rcEvents(sums: RcSum[]): RcEv[] {
  const out: RcEv[] = [], s = [...sums].sort((a, b) => a.v - b.v)
  for (let i = 1; i < s.length; i++) {
    const a = s[i - 1], b = s[i]
    if (b.label && b.label !== a.label) out.push({ at: b.at, v: b.v, type: 'label', label: b.label, from: a.label })
    for (const e of b.exps) {
      const p = a.exps.find(x => x.id === e.id)
      if (!p) { out.push({ at: b.at, v: b.v, type: 'ab_start', exp: e }); continue }
      if (p.arms.join('/') !== e.arms.join('/')) out.push({ at: b.at, v: b.v, type: 'ab_arms', exp: e, from: p.arms.join('/') })
      if (p.exposure !== e.exposure) out.push({ at: b.at, v: b.v, type: 'ab_exposure', exp: e, from: String(p.exposure) })
    }
    for (const p of a.exps) if (!b.exps.some(x => x.id === p.id)) out.push({ at: b.at, v: b.v, type: 'ab_end', exp: p })
  }
  return out
}

/** Each stretch of an experiment with one set of arms: from its start or an arm change (Brain abt_35 ran Set1/Set2 for
 *  2.5 h, then Set3/Set4) to the next arm change or its end. */
export function expSpans(evs: RcEv[]) {
  return evs.filter(e => (e.type === 'ab_start' || e.type === 'ab_arms') && e.exp).map(e => {
    const next = evs.find(x => (x.type === 'ab_arms' || x.type === 'ab_end') && x.exp?.id === e.exp!.id && x.at > e.at)
    return { ev: e, exp: e.exp!, start: e.at, end: next?.at ?? null, next }
  })
}

/** Suggestions from RC history: each stretch of a Firebase experiment with one set of arms still running (or ended in
 *  the last 3 days) that started in the last 30 days, and each default-label change of the last 7 days. A label change
 *  starts a version run whose arms come from the data (top two versions by new installs after it); arms stay empty until then. */
export function rcSuggestions(app: string, evs: RcEv[], now: number): NewRun[] {
  const out: NewRun[] = [], name = APPS.find(a => a.key === app)?.name ?? app
  for (const { ev: e, exp, start, end, next } of expSpans(evs)) {
    if (exp.arms.length < 2 || start <= now - 30 * DAY || (end && end < now - 3 * DAY)) continue
    const expo = evs.filter(x => x.type === 'ab_exposure' && x.exp?.id === exp.id && x.at >= start && (!end || x.at < end)).map(x => `${x.from}% → ${x.exp!.exposure}% lúc ${vnTime(x.at)}`)
    const arms = exp.arms.join('/'), changed = e.type === 'ab_arms'
    out.push({ app, kind: 'ab', name: `${name} ${exp.id} ${arms}`, arms: exp.arms, weights: exp.arms.map(() => 1),
      start_at: start, end_at: end, source: 'rc', cond: exp.cond, exp_id: exp.id, skey: changed ? `rc:${app}:${exp.id}:${arms}` : `rc:${app}:${exp.id}`,
      note: `RC v${e.v}: ${changed ? `${exp.id} đổi nhánh ${e.from} → ${arms}` : `thêm ${exp.id}`} trên condition ${exp.cond}, exposure ${exp.exposure ?? '?'}%.${expo.length ? ` Exposure đổi: ${expo.join(', ')}.` : ''}${next?.type === 'ab_arms' ? ` Nhánh đổi sang ${next.exp!.arms.join('/')} lúc ${vnTime(next.at)}: đợt này dừng ở đó.` : ''}` })
  }
  for (const e of evs) {
    if (e.type === 'label' && e.label && e.at > now - 7 * DAY)
      out.push({ app, kind: 'version', name: `${name} nhãn ${e.label}`, arms: [], weights: [1, 1], start_at: e.at, end_at: null, source: 'rc', cond: null, exp_id: null,
        skey: `rc:${app}:label:${e.label}`, note: `RC v${e.v}: nhãn mặc định experiment_group đổi ${e.from ?? '(trống)'} → ${e.label}.` })
  }
  return out
}

// ───────────── versions and hours ─────────────

/** Semver-ish compare: 1.0.9 < 1.0.16. */
export const verCmp = (a: string, b: string) => {
  const x = a.split(/[.-]/).map(Number), y = b.split(/[.-]/).map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d }
  return a.localeCompare(b)
}

/** The two versions with the most new installs (each ≥ 5% of them), older first: the arms of a version run. */
export function topTwo(users: Map<string, number>): string[] {
  const total = [...users.values()].reduce((a, b) => a + b, 0)
  const top = [...users].filter(([v, n]) => ARM_RE.test(v) && n >= 0.05 * total).sort((a, b) => b[1] - a[1]).slice(0, 2).map(x => x[0])
  return top.length === 2 ? top.sort(verCmp) : []
}

/** A new version taking ≥ 5% of a day's new installs while an older one keeps ≥ 5%: a version run to suggest
 *  (apps without a date label in RC). `days` = install day → version → new users, oldest day first. */
export function dataSuggestion(app: string, days: [string, Map<string, number>][]): NewRun | null {
  const last = days.at(-1)
  if (!last) return null
  const arms = topTwo(last[1])
  if (!arms.length) return null
  const share = (m: Map<string, number>, v: string) => (m.get(v) ?? 0) / Math.max(1, [...m.values()].reduce((a, b) => a + b, 0))
  const [first, fm] = days.find(([, m]) => share(m, arms[1]) >= 0.05)!
  // expected split: the two versions' shares on that first day (a staged rollout), in whole percent
  const pb = fm.get(arms[1]) ?? 0, pct = Math.min(99, Math.max(1, Math.round(100 * pb / Math.max(1, (fm.get(arms[0]) ?? 0) + pb))))
  const name = APPS.find(a => a.key === app)?.name ?? app
  return { app, kind: 'version', name: `${name} ${arms[0]} → ${arms[1]}`, arms, weights: [100 - pct, pct], start_at: Date.parse(`${first}T00:00:00Z`), end_at: null,
    source: 'data', cond: null, exp_id: null, skey: `data:${app}:${arms[1]}`,
    note: `Từ số ngày cài: ${arms[1]} có từ 5% user mới từ ngày ${first} (UTC). Tỉ lệ kỳ vọng ${100 - pct}:${pct} theo user mới hai version ngày đó. Giờ bắt đầu chính xác lấy từ số theo giờ.` }
}

/** The first hour from which every arm keeps a steady share of new installs: 6 hours in a row, each with users in
 *  every arm and at least a quarter of the usual hourly volume (the median hour of the last 24 h: a few stray labelled
 *  users before a start are not a split), whose pooled share of the first arm sits within 3 standard errors (plus 5
 *  points) of its share over those last 24 hours. `hours`: hour → arm → users. Null when no such run of hours exists yet. */
export function steadyStart(hours: Map<number, Map<string, number>>, arms: string[], run = 6): number | null {
  const hs = [...hours.keys()].sort((a, b) => a - b)
  if (arms.length < 2 || hs.length < run) return null
  const a = (h: number) => hours.get(h)?.get(arms[0]) ?? 0
  const all = (h: number) => arms.reduce((s, x) => s + (hours.get(h)?.get(x) ?? 0), 0)
  const tail = hs.slice(-24), tn = tail.reduce((s, h) => s + all(h), 0)
  if (!tn) return null
  const m = tail.reduce((s, h) => s + a(h), 0) / tn
  const usual = tail.map(all).sort((x, y) => x - y)[Math.floor(tail.length / 2)]
  for (let i = 0; i + run <= hs.length; i++) {
    const w = hs.slice(i, i + run)
    if (w.at(-1)! - w[0] !== (run - 1) * HOUR || !w.every(h => all(h) >= usual / 4 && arms.every(x => (hours.get(h)?.get(x) ?? 0) > 0))) continue
    const n = w.reduce((s, h) => s + all(h), 0), p = w.reduce((s, h) => s + a(h), 0) / n
    if (Math.abs(p - m) <= 3 * Math.sqrt(m * (1 - m) / n) + 0.05) return w[0]
  }
  return null
}

// ───────────── EQL for one run ─────────────

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }
/** The engine's bucket label "Sat Nov  7 13:00:00 2026" (UTC) → ms. */
export function bucketTime(t: unknown) {
  const m = String(t ?? '').match(/^\w{3} (\w{3}) +(\d{1,2}) (\d\d:\d\d:\d\d) (\d{4})$/)
  if (!m || !MONTHS[m[1]]) throw new Error(`Databuckets: không đọc được cột time "${String(t).slice(0, 40)}"`)
  return Date.parse(`${m[4]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}T${m[3]}Z`)
}
export const eqlTime = (t: number) => new Date(t).toISOString().slice(0, 19).replace('T', ' ')
/** An absolute window: sent with `to` one day early (the engine moves it forward); `ran` is what should come back. */
const win = (from: number, to: number) => ({ sent: `time from '${eqlTime(from)}' to '${eqlTime(to - DAY)}'`, ran: `time from '${eqlTime(from)}' to '${eqlTime(to)}'` })
const lit = (xs: string[]) => xs.map(x => { if (!ARM_RE.test(x)) throw new Error(`nhãn nhánh không hợp lệ: ${x.slice(0, 40)}`); return `'${x}'` }).join(', ')

export const D0_RUN: Record<string, string[]> = {
  '*': ['session_start', 'complete_onboard', 'ad_revenue', 'iap_purchase_show', 'iap_purchase_success'],
  idol: ['prank_call_start', 'chat_open'], brain: ['enter_game_play'], xremote: ['remote_tv_connected', 'cast_started'], xcast: ['remote_tv_connected', 'cast_started'],
}

export type RunQuery = { run: number; arm: string; kind: 'hour' | 'd0' | 'mode' | 'ret'; eql: string; ran: string; cols: string[] }

/** The cohort's window: [start, end), never past the start of today (UTC), so every D0 counted is complete, and at
 *  most 28 days of installs (a longer run keeps its first 28 days). */
export function cohortWindow(r: Pick<Run, 'start_at' | 'end_at'>, now: number) {
  const today = Date.parse(utcDay(now) + 'T00:00:00Z')
  return { from: r.start_at, to: Math.min(r.end_at ?? Infinity, today, r.start_at + 28 * DAY) }
}

/** The EQLs of one refresh. Always new installs per arm by hour, from 24 h before the start to 7 days after (version:
 *  first_open by version; A/B: users with the label on their install day, a user active in several hours counts in
 *  each). While a version run's arms are unknown there is no version filter, so only 12 h before to 36 h after the start
 *  (every version that had an install in an hour is a row: Idol has about ten). Rows stay under the 1,000 cap: hours ×
 *  arms ≤ 192 × 4. With `cohort`, per arm: stage 1 picks the arm's users, stage 2 counts their install-day events (d0),
 *  Idol call modes (mode), and session_start/ad_revenue by days since install (ret). */
export function runQueries(r: Pick<Run, 'id' | 'app' | 'kind' | 'arms' | 'start_at' | 'end_at'> & { refreshed_at?: number | null }, now: number, cohort: boolean): RunQuery[] {
  const pkg = APPS.find(a => a.key === r.app)?.pkg
  if (!pkg) throw new Error(`không có app ${r.app}`)
  const f = field(r.kind), app = `app_id in ('${pkg}') regex_off`, out: RunQuery[] = []
  const pending = r.kind === 'version' && !r.arms.length, hours = pending ? 48 : Math.min(192, Math.floor(800 / Math.max(2, r.arms.length)))
  const hf = Math.floor((r.start_at - (pending ? 12 : 24) * HOUR) / HOUR) * HOUR
  const ht = Math.min(Math.ceil(now / HOUR) * HOUR, hf + hours * HOUR, r.end_at ?? Infinity)
  // the hourly window was complete at the last refresh (an hour to spare for late events): its rows are stored already
  if (ht > hf && !(cohort && r.refreshed_at && ht + HOUR <= r.refreshed_at)) {
    const w = win(hf, ht - 1000)
    const filter = r.kind === 'version'
      ? `event_name in ('first_open') regex_off${r.arms.length ? ` and app_version in (${lit(r.arms)}) regex_off` : ''}`
      : `experiment_group in (${lit(r.arms)}) regex_off and retention_day in (0)`
    const head = `select ${f}, count_distinct(user_pseudo_id) as users from ${DATASET} where ${app} and ${filter} bucket 1 hour `
    out.push({ run: r.id, arm: '*', kind: 'hour', eql: head + w.sent, ran: head + w.ran, cols: ['time', f, 'users'] })
  }
  const c = cohortWindow(r, now)
  if (!cohort || r.arms.length < 2 || c.to <= c.from) return out
  const day0 = Date.parse(utcDay(c.from) + 'T00:00:00Z') - DAY // users whose install day is local, not UTC, start a little earlier
  for (const arm of r.arms) {
    const pick = r.kind === 'version' ? `event_name in ('first_open') regex_off and app_version in (${lit([arm])}) regex_off` : `experiment_group in (${lit([arm])}) regex_off and retention_day in (0)`
    const w1 = win(c.from, c.to - 1000)
    const s1 = (w: 'sent' | 'ran') => `select user_pseudo_id from ${DATASET} where ${app} and ${pick} ${w1[w]} boost time 10 | `
    const stage2 = (kind: RunQuery['kind'], sel: string, where: string, to: number, bucket: boolean, cols: string[]) => {
      const w2 = win(day0, to - 1000), body = `select ${sel} from ${DATASET} where ${app} and ${where} and include $0.user_pseudo_id ${bucket ? 'bucket 1 day ' : ''}`
      out.push({ run: r.id, arm, kind, eql: `${s1('sent')}${body}${w2.sent} boost user_pseudo_id str 10`, ran: `${s1('ran')}${body}${w2.ran} boost user_pseudo_id str 10`, cols })
    }
    const evs = [...D0_RUN['*'], ...(D0_RUN[r.app] ?? [])]
    stage2('d0', 'event_name, count() as events, count_distinct(user_pseudo_id) as users, sum(revenue) as rev', `event_name in (${lit(evs)}) regex_off and retention_day in (0)`, c.to + DAY, false, ['event_name', 'events', 'users', 'rev'])
    if (r.app === 'idol') stage2('mode', 'mode, count() as events, count_distinct(user_pseudo_id) as users', `event_name in ('prank_call_start') regex_off and retention_day in (0)`, c.to + DAY, false, ['mode', 'events', 'users'])
    stage2('ret', 'event_name, retention_day, count() as events, count_distinct(user_pseudo_id) as users, sum(revenue) as rev',
      `event_name in ('session_start', 'ad_revenue') regex_off and retention_day between (0, 7)`, c.to + 9 * DAY, true, ['time', 'event_name', 'retention_day', 'events', 'users', 'rev'])
  }
  return out
}

export type Fact = { arm: string; cohort: string; rd: number; key: string; value: number }
const n = (v: unknown) => Number(v ?? 0) || 0

/** Rows of one cohort query → facts: d0 and mode are totals over the window (cohort '*'), ret is per install day
 *  (bucket day − days since install). */
export function toFacts(q: Pick<RunQuery, 'arm' | 'kind'>, rows: Row[]): Fact[] {
  const out: Fact[] = [], push = (cohort: string, rd: number, key: string, value: number) => out.push({ arm: q.arm, cohort, rd, key, value })
  for (const r of rows) {
    if (q.kind === 'd0') { const e = String(r.event_name); push('*', 0, `${e}.users`, n(r.users)); push('*', 0, `${e}.n`, n(r.events)); if (e === 'ad_revenue') push('*', 0, 'ad_revenue.rev', n(r.rev)) }
    else if (q.kind === 'mode') { const m = String(r.mode || 'unknown'); push('*', 0, `prank_call_start.${m}.users`, n(r.users)); push('*', 0, `prank_call_start.${m}.n`, n(r.events)) }
    else if (q.kind === 'ret') {
      const rd = Number(r.retention_day), e = String(r.event_name)
      if (!Number.isInteger(rd) || rd < 0 || rd > 7) continue
      const cohort = addDays(utcDay(bucketTime(r.time)), -rd)
      push(cohort, rd, `${e}.users`, n(r.users)); push(cohort, rd, `${e}.n`, n(r.events)); if (e === 'ad_revenue') push(cohort, rd, 'ad_revenue.rev', n(r.rev))
    }
  }
  return out
}

/** Hourly rows → hour → arm → users. */
export function toHours(kind: Kind, rows: Row[]) {
  const out = new Map<number, Map<string, number>>(), f = field(kind)
  for (const r of rows) {
    const h = bucketTime(r.time), arm = String(r[f] ?? '')
    if (!arm) continue
    let m = out.get(h); if (!m) out.set(h, m = new Map())
    m.set(arm, (m.get(arm) ?? 0) + n(r.users))
  }
  return out
}

// ───────────── metrics and statistics ─────────────

export type RunMetric = { id: string; label: string; kind: 'prop' | 'mean'; unit: 'pct' | 'num' | 'usd'; src: 'total' | 'day'; num: string; den: string; rd: number; cum?: boolean; apps?: string[] }
const BASE = 'session_start.users' // the cohort: users with a session on their install day
export const METRICS: RunMetric[] = [
  { id: 'd1', label: 'Retention D1', kind: 'prop', unit: 'pct', src: 'day', num: BASE, den: BASE, rd: 1 },
  { id: 'd3', label: 'Retention D3', kind: 'prop', unit: 'pct', src: 'day', num: BASE, den: BASE, rd: 3 },
  { id: 'd7', label: 'Retention D7', kind: 'prop', unit: 'pct', src: 'day', num: BASE, den: BASE, rd: 7 },
  { id: 'ltv0', label: 'LTV ads D0', kind: 'mean', unit: 'usd', src: 'day', num: 'ad_revenue.rev', den: BASE, rd: 0, cum: true },
  { id: 'ltv3', label: 'LTV ads D3', kind: 'mean', unit: 'usd', src: 'day', num: 'ad_revenue.rev', den: BASE, rd: 3, cum: true },
  { id: 'ltv7', label: 'LTV ads D7', kind: 'mean', unit: 'usd', src: 'day', num: 'ad_revenue.rev', den: BASE, rd: 7, cum: true },
  { id: 'ads', label: 'Ads / user (D0)', kind: 'mean', unit: 'num', src: 'day', num: 'ad_revenue.n', den: BASE, rd: 0 },
  { id: 'onboard', label: 'Hoàn thành onboarding (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'complete_onboard.users', den: BASE, rd: 0 },
  { id: 'video', label: 'VideoUserRate (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'prank_call_start.video.users', den: 'complete_onboard.users', rd: 0, apps: ['idol'] },
  { id: 'video_n', label: 'VideoRate: lượt video / user onboarding', kind: 'mean', unit: 'num', src: 'total', num: 'prank_call_start.video.n', den: 'complete_onboard.users', rd: 0, apps: ['idol'] },
  { id: 'audio', label: 'AudioUserRate (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'prank_call_start.audio.users', den: 'complete_onboard.users', rd: 0, apps: ['idol'] },
  { id: 'chat', label: 'ChatUserRate (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'chat_open.users', den: 'complete_onboard.users', rd: 0, apps: ['idol'] },
  { id: 'play', label: 'Chơi game (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'enter_game_play.users', den: BASE, rd: 0, apps: ['brain'] },
  { id: 'connect', label: 'Kết nối TV (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'remote_tv_connected.users', den: BASE, rd: 0, apps: ['xremote', 'xcast'] },
  { id: 'cast', label: 'Cast (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'cast_started.users', den: BASE, rd: 0, apps: ['xremote', 'xcast'] },
  { id: 'paywall', label: 'Thấy paywall (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'iap_purchase_show.users', den: BASE, rd: 0 },
  { id: 'buy', label: 'Mua IAP (D0)', kind: 'prop', unit: 'pct', src: 'total', num: 'iap_purchase_success.users', den: BASE, rd: 0 },
]
export const metricsFor = (app: string) => METRICS.filter(m => !m.apps || m.apps.includes(app))
/** The headline metrics on a run's card, the primary first. */
export const HEADLINE: Record<string, string[]> = { idol: ['d1', 'ltv3', 'video', 'ads'], brain: ['d1', 'ltv3', 'play', 'ads'], xremote: ['d1', 'ltv3', 'connect', 'ads'], xcast: ['d1', 'ltv3', 'connect', 'ads'] }
export const DEFAULT_METRIC = 'd1'
export const primaryOf = (r: Pick<Run, 'metric'>) => METRICS.find(x => x.id === (r.metric ?? DEFAULT_METRIC)) ?? METRICS[0]

/** One arm's value of a metric. Per-day metrics count only install days whose day N is over with a day to spare
 *  (retention_day follows the phone's local day, not UTC): `lastDay` = the last complete UTC day pulled. */
export function armValue(g: GroupFacts | undefined, m: RunMetric, lastDay: string) {
  const get = (c: string, rd: number, k: string) => g?.get(c)?.get(rd)?.get(k) ?? 0
  if (m.src === 'total') { const num = get('*', 0, m.num), den = get('*', 0, m.den); return { num, den, value: den ? num / den : null, days: [] as { day: string; num: number; den: number }[] } }
  const days: { day: string; num: number; den: number }[] = []
  for (const c of [...(g?.keys() ?? [])].filter(c => c !== '*').sort()) {
    if (addDays(c, m.rd + 1) > lastDay) continue
    const den = get(c, 0, m.den)
    if (!den) continue
    let num = 0
    for (let k = m.cum ? 0 : m.rd; k <= m.rd; k++) num += get(c, k, m.num)
    days.push({ day: c, num, den })
  }
  const num = days.reduce((s, d) => s + d.num, 0), den = days.reduce((s, d) => s + d.den, 0)
  return { num, den, value: den ? num / den : null, days }
}

/** Two-sided 95% t quantile; 1.96 + 2.5/df beyond the table (within 0.002 of the true value). */
export function t975(df: number) {
  const T = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042]
  return df >= 1 && df <= 30 ? T[df - 1] : 1.96 + 2.5 / df
}

export type Lift = { lift: number; lo: number | null; hi: number | null; p: number | null; how: string }

/** B over A for a proportion: the ratio of the two rates with a 95% interval on its log (Katz), and the p of the same
 *  z. Null when a rate is 0 or not a rate. */
export function propLift(x1: number, n1: number, x2: number, n2: number): Lift | null {
  if (!(n1 > 0 && n2 > 0 && x1 > 0 && x2 > 0 && x1 <= n1 && x2 <= n2)) return null
  const r = (x2 / n2) / (x1 / n1), se = Math.sqrt(1 / x1 - 1 / n1 + 1 / x2 - 1 / n2), z = Math.log(r) / se
  return { lift: r - 1, lo: Math.exp(Math.log(r) - 1.96 * se) - 1, hi: Math.exp(Math.log(r) + 1.96 * se) - 1, p: se > 0 ? 2 * (1 - normCdf(Math.abs(z))) : null, how: 'tỉ số hai tỉ lệ, khoảng log (Katz)' }
}

/** B over A for a mean (ad LTV, ads per user) that has no per-user spread in aggregates. Each install day is one
 *  measurement made on both arms at once (parallel arms): the interval is a t interval on the daily log-ratios,
 *  centred on the pooled ratio (batch means). Needs 4 days where both arms have a value and a real share of the arm
 *  (5% of it or 100 users: the few users of the day before the start are no measurement; they stay in the pooled
 *  ratio); otherwise no interval. */
export function meanLift(a: { num: number; den: number; days: { day: string; num: number; den: number }[] }, b: typeof a): Lift | null {
  if (!(a.den > 0 && b.den > 0 && a.num > 0 && b.num > 0)) return null
  const r = (b.num / b.den) / (a.num / a.den)
  const bd = new Map(b.days.map(d => [d.day, d])), real = (d: { den: number }, total: number) => d.den >= Math.min(100, 0.05 * total)
  const logs = a.days.flatMap(d => { const e = bd.get(d.day); return e && d.num > 0 && e.num > 0 && real(d, a.den) && real(e, b.den) ? [Math.log((e.num / e.den) / (d.num / d.den))] : [] })
  if (logs.length < 4) return { lift: r - 1, lo: null, hi: null, p: null, how: `chưa đủ ngày (${logs.length}/4)` }
  const mean = logs.reduce((s, x) => s + x, 0) / logs.length, sd = Math.sqrt(logs.reduce((s, x) => s + (x - mean) ** 2, 0) / (logs.length - 1))
  const h = t975(logs.length - 1) * sd / Math.sqrt(logs.length)
  return { lift: r - 1, lo: Math.exp(Math.log(r) - h) - 1, hi: Math.exp(Math.log(r) + h) - 1, p: null, how: `t trên tỉ số từng ngày, ${logs.length} ngày` }
}

export type Call = { tone: 'ok' | 'bad' | 'mute' | 'warn'; word: string }
/** The verdict: an interval wholly above or below 0. Small samples (under 100 users an arm; a rate also needs 10 users
 *  with and without the event) get no verdict. Every metric here is better when higher. */
export function verdict(m: RunMetric, a: { num: number; den: number }, b: { num: number; den: number }, l: Lift | null): Call {
  if (!a.den || !b.den) return { tone: 'mute', word: 'Chưa có số' }
  if (Math.min(a.den, b.den) < 100 || (m.kind === 'prop' && Math.min(a.num, b.num, a.den - a.num, b.den - b.num) < 10)) return { tone: 'warn', word: 'Mẫu nhỏ' }
  if (!l || l.lo == null || l.hi == null) return { tone: 'mute', word: m.kind === 'mean' && l ? 'Chưa đủ ngày' : 'Chưa chắc' }
  return l.lo > 0 ? { tone: 'ok', word: 'B tốt hơn' } : l.hi < 0 ? { tone: 'bad', word: 'B kém hơn' } : { tone: 'mute', word: 'Chưa chắc' }
}

/** Cohort size per arm: users with a session on their install day, over the whole window. */
export const armSize = (g: GroupFacts | undefined) => g?.get('*')?.get(0)?.get(BASE) ?? 0

/** Arm B against arm A on one metric. A per-day metric waits until the install days old enough cover a tenth of each
 *  arm (before that only the few users who installed just before the start count: "Chờ đủ ngày", not "Mẫu nhỏ"). */
export function compareArms(ga: GroupFacts | undefined, gb: GroupFacts | undefined, m: RunMetric, lastDay: string) {
  const a = armValue(ga, m, lastDay), b = armValue(gb, m, lastDay)
  if (m.src === 'day' && (a.den < 0.1 * armSize(ga) || b.den < 0.1 * armSize(gb))) return { a, b, l: null, c: { tone: 'mute', word: 'Chờ đủ ngày' } as Call }
  const l = m.kind === 'prop' ? propLift(a.num, a.den, b.num, b.den) : m.src === 'day' ? meanLift(a, b)
    : a.num > 0 && a.den && b.den ? { lift: (b.num / b.den) / (a.num / a.den) - 1, lo: null, hi: null, p: null, how: 'không có khoảng: chỉ có số gộp' } : null
  return { a, b, l, c: verdict(m, a, b, l) }
}

// ───────────── the decision ─────────────

/** Days of installs before a run concludes, unless the run says otherwise. */
export const DEFAULT_HORIZON = 7

/** The fixed decision point (looking every 6 hours and concluding the first time an interval clears 0 calls an A/A run
 *  "different" about a quarter of the time): the run's first `horizon` days of installs (its whole window if it ends
 *  sooner), once the primary metric is mature on all of them (Dn: the last install day n + 1 days old). The run decides
 *  at the first refresh whose last complete day (pulled_to) is this day or later. */
export function decideDay(r: Pick<Run, 'start_at' | 'end_at' | 'horizon'>, m: Pick<RunMetric, 'rd'>) {
  return addDays(utcDay(Math.min(r.start_at + r.horizon * DAY, r.end_at ?? Infinity) - 1), m.rd + 1)
}

/** A stored decision (one word per arm after A, comma separated) → what it shows. */
export const DECISION: Record<string, Call> = { better: { tone: 'ok', word: 'B tốt hơn' }, worse: { tone: 'bad', word: 'B kém hơn' }, none: { tone: 'mute', word: 'Chưa thấy khác biệt' } }
export const decisionOf = (c: Call) => c.tone === 'ok' ? 'better' : c.tone === 'bad' ? 'worse' : 'none'

/** What a metric's row shows. Only the primary metric concludes, once (`decided`: its stored decision for this arm);
 *  before that its verdict is provisional. Other metrics are for reference (with many metrics some look different by
 *  chance): never a coloured verdict. */
export function shownCall(c: Call, primary: boolean, decided: string | undefined): Call {
  if (!primary) return ['B tốt hơn', 'B kém hơn', 'Chưa chắc'].includes(c.word) ? { tone: 'mute', word: 'Tham khảo' } : { ...c, tone: 'mute' }
  if (decided) return DECISION[decided] ?? c
  return c.tone === 'ok' || c.tone === 'bad' ? { tone: 'mute', word: `Tạm thời: ${c.word}` } : c
}
