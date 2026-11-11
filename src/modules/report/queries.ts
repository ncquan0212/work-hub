// The fixed EQL the Report runs, and how each result row becomes stored facts (app, day, key, value).
// Facts are raw aggregates; every displayed metric is computed from them (metrics.ts), so a new metric
// rarely needs a new query. Syntax and gotchas: memory note `databucket-query-tool`, research
// docs/sources.md (Databuckets).
//  - DAU = distinct users on session_start (notification events fire without the app opening);
//  - ad revenue = sum(revenue) on ad_revenue, USD, impression-level; impressions = count(ad_revenue);
//  - IAP money = revenue_usd on the server events (their user is mostly Unknown: totals only);
//  - days are UTC buckets from `bucket 1 day`; the first and the current bucket are partial;
//  - grouped queries drop rows whose group field is missing, so one query per grouping.
import { APPS, type App } from '../../config.ts'
import { DATASET, type Row } from '../../lib/databuckets.ts'
import { addDays, bucketDay, completeDays } from '../../lib/days.ts'
export { addDays, bucketDay, completeDays, utcDay } from '../../lib/days.ts'

export const CORE_EVENTS = ['session_start', 'first_open', 'ad_revenue', 'complete_onboard', 'iap_purchase_show', 'iap_purchase_success',
  'iap_sub_new_success', 'iap_renew_success', 'iap_product_new_success', 'iap_sub_refund_success', 'iap_product_refund_success']

// App-specific events (plan 3b). An event an app never sends simply returns no rows for it.
export const APP_EVENTS = [
  // Brainova
  'enter_game_play', 'game_level_stats', 'enter_test_play', 'complete_game_3_daily_task',
  // Idol (prank_call_* / chat_open are Tier1-only outside the whitelist; enter_screen_* pass everywhere)
  'idol_select', 'prank_call_start', 'prank_call_answer', 'prank_call_end', 'chat_open', 'surprise_show', 'surprise_accept', 'enter_screen_call', 'enter_screen_chat',
  // XRemote / XCast
  'remote_tv_connected', 'remote_key_pressed', 'cast_started', 'cast_played', 'mirror_start_result',
]

const list = (xs: string[]) => xs.map(x => `'${x.replace(/'/g, '')}'`).join(', ')
const pkgs = (keys?: string[]) => APPS.filter(a => !keys || keys.includes(a.key)).map(a => a.pkg)

export const eql = {
  core: (days: number, apps?: string[]) =>
    `select app_id, event_name, count() as events, count_distinct(user_pseudo_id) as users, sum(revenue) as rev, sum(revenue_usd) as rev_usd from ${DATASET} where app_id in (${list(pkgs(apps))}) regex_off and event_name in (${list(CORE_EVENTS)}) regex_off bucket 1 day since ${days} days ago`,
  formats: (days: number, apps?: string[]) =>
    `select app_id, ads_format, count() as events, count_distinct(user_pseudo_id) as users, sum(revenue) as rev from ${DATASET} where app_id in (${list(pkgs(apps))}) regex_off and event_name in ('ad_revenue') regex_off bucket 1 day since ${days} days ago`,
  appEvents: (days: number, apps?: string[]) =>
    `select app_id, event_name, count() as events, count_distinct(user_pseudo_id) as users, sum(duration_s) as dur, sum(game_level_stats_play_time_seconds) as play from ${DATASET} where app_id in (${list(pkgs(apps))}) regex_off and event_name in (${list(APP_EVENTS)}) regex_off bucket 1 day since ${days} days ago`,
  idolModes: (days: number) =>
    `select app_id, mode, count() as events, count_distinct(user_pseudo_id) as users from ${DATASET} where app_id in (${list(pkgs(['idol']))}) regex_off and event_name in ('prank_call_start') regex_off bucket 1 day since ${days} days ago`,
  // users on session_start and ad revenue, by days since install (retention_day is stored on 100% of rows;
  // install_day is not, so cohorts are rebuilt here as day − retention_day)
  cohort: (days: number, rds: number[], apps?: string[]) =>
    `select app_id, retention_day, event_name, count_distinct(user_pseudo_id) as users, sum(revenue) as rev from ${DATASET} where app_id in (${list(pkgs(apps))}) regex_off and event_name in ('session_start', 'ad_revenue') regex_off and retention_day in (${rds.join(', ')}) bucket 1 day since ${days} days ago`,
}

export const COLS = {
  core: ['time', 'app_id', 'event_name', 'events', 'users', 'rev', 'rev_usd'],
  formats: ['time', 'app_id', 'ads_format', 'events', 'users', 'rev'],
  appEvents: ['time', 'app_id', 'event_name', 'events', 'users'], // dur/play only come back when some row has those fields
  idolModes: ['time', 'app_id', 'mode', 'events', 'users'],
  cohort: ['time', 'app_id', 'retention_day', 'event_name', 'users', 'rev'],
}

/** App keys two by two: one result per pair stays under Databuckets' 1,000-row cap where all apps together would not. */
export const pairs = (keys: string[]) => keys.flatMap((_, i) => i % 2 ? [] : [keys.slice(i, i + 2)])

/** The daily "Format ads" call: Idol's call modes ride along only when the hub follows an app keyed idol
 *  (`app_id in ()` would fail the whole call). */
export const formatQueries = (days: number, apps: App[] = APPS) => [{ eql: eql.formats(days), cols: COLS.formats },
  ...(apps.some(a => a.key === 'idol') ? [{ eql: eql.idolModes(days), cols: COLS.idolModes }] : [])]

/** The daily cohort pull, 4 buckets × apps × 31 rd × 2 events rows: up to 4 apps fit one EQL (992 rows), more go one
 *  EQL per pair of apps, all in the same Databuckets call. `apps` = the keys each EQL covers, for toCohort. */
export const cohortQueries = (days: number, rds: number[], keys = APPS.map(a => a.key)) =>
  (keys.length <= 4 ? [keys] : pairs(keys)).map(apps => ({ eql: eql.cohort(days, rds, apps), cols: COLS.cohort, apps }))

export type Fact = { app: string; day: string; key: string; value: number }
const appKey = new Map(APPS.map(a => [a.pkg, a.key]))
const n = (v: unknown) => Number(v ?? 0) || 0

// A marker fact per (app, day) a query covered, so "no rows" reads as 0 only where the query ran
// (a day it did not cover stays "no data" instead of a false 0%).
const RAN: Record<string, string> = { formats: 'fmt._ran', appEvents: 'ev._ran', idolModes: 'mode._ran' }

/** Rows of one query → facts, complete days only. `kind` picks the key naming; `apps` = app keys the query covered. */
export function toFacts(kind: 'core' | 'formats' | 'appEvents' | 'idolModes', rows: Row[], now: number, apps: string[] = APPS.map(a => a.key)): Fact[] {
  const keep = completeDays(rows, now), out: Fact[] = []
  if (RAN[kind]) for (const day of keep) for (const app of apps) out.push({ app, day, key: RAN[kind], value: 1 })
  for (const r of rows) {
    const day = bucketDay(r.time), app = appKey.get(String(r.app_id))
    if (!app || !keep.has(day)) continue
    const push = (key: string, value: number) => out.push({ app, day, key, value })
    if (kind === 'core') {
      const e = String(r.event_name)
      push(`${e}.users`, n(r.users)); push(`${e}.n`, n(r.events))
      if (e === 'ad_revenue') push('ad_revenue.rev', n(r.rev))
      if (/^iap_.*_success$/.test(e) && e !== 'iap_purchase_success') push(`${e}.usd`, n(r.rev_usd))
    } else if (kind === 'formats') {
      const f = String(r.ads_format || 'unknown')
      push(`fmt.${f}.n`, n(r.events)); push(`fmt.${f}.users`, n(r.users)); push(`fmt.${f}.rev`, n(r.rev))
    } else if (kind === 'appEvents') {
      const e = String(r.event_name)
      push(`${e}.users`, n(r.users)); push(`${e}.n`, n(r.events))
      if (e === 'prank_call_end') push('prank_call_end.dur', n(r.dur))
      if (e === 'game_level_stats') push('game_level_stats.play', n(r.play))
    } else {
      const m = String(r.mode || 'unknown')
      push(`prank_call_start.${m}.users`, n(r.users)); push(`prank_call_start.${m}.n`, n(r.events))
    }
  }
  return out
}

export type CohortCell = { app: string; cohort: string; rd: number; users?: number; rev?: number }

/** Cohort rows → cells keyed by install day (= bucket day − retention_day). Every (app, covered day, rd)
 *  the query asked for gets a zero cell first, so a missing cell later means "not pulled", never 0. */
export function toCohort(rows: Row[], now: number, rds: number[], apps: string[] = APPS.map(a => a.key)): CohortCell[] {
  const keep = completeDays(rows, now), out: CohortCell[] = []
  for (const day of keep) for (const app of apps) for (const rd of rds) out.push({ app, cohort: addDays(day, -rd), rd, users: 0, rev: 0 })
  for (const r of rows) {
    const day = bucketDay(r.time), app = appKey.get(String(r.app_id)), rd = Number(r.retention_day)
    if (!app || !keep.has(day) || !Number.isInteger(rd) || rd < 0) continue
    const cell: CohortCell = { app, cohort: addDays(day, -rd), rd }
    if (r.event_name === 'session_start') cell.users = n(r.users)
    else if (r.event_name === 'ad_revenue') cell.rev = n(r.rev)
    else continue
    out.push(cell)
  }
  return out
}
