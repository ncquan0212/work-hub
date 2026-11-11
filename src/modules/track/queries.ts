// Theo dõi's EQL: new-install cohorts split by app_version or by experiment_group (the owner's method,
// insight 75521 "Idol Vesion Insight": D0 rates of new users by version). Three small queries per split
// share one Databuckets call: D0 events, retention (session_start on days 0/1/3/7), Idol call mode (when there is an Idol).
import { APPS, type App } from '../../config.ts'
import { DATASET, type Row } from '../../lib/databuckets.ts'
import { addDays, bucketDay, completeDays } from '../../lib/days.ts'

export type Dim = 'ver' | 'exp'
const FIELD: Record<Dim, string> = { ver: 'app_version', exp: 'experiment_group' }

export const D0_EVENTS = ['first_open', 'complete_onboard', 'ad_revenue', 'iap_purchase_show', 'iap_purchase_success',
  'prank_call_start', 'chat_open', 'enter_game_play', 'remote_tv_connected', 'cast_started', 'cast_played']
export const RET_DAYS = [0, 1, 3, 7]

const list = (xs: string[]) => xs.map(x => `'${x}'`).join(', ')

/** The split's EQLs. 'mode' only when an app is keyed idol (`app_id in ()` would fail the whole call); it comes last, so
 *  d0 and ret keep their indices. */
export function queries(dim: Dim, days: number, apps: App[] = APPS) {
  const f = FIELD[dim], all = list(apps.map(a => a.pkg)), idol = apps.filter(a => a.key === 'idol').map(a => a.pkg)
  return [
    { kind: 'd0' as const, cols: ['time', 'app_id', f, 'event_name', 'events', 'users', 'rev'],
      eql: `select app_id, ${f}, event_name, count() as events, count_distinct(user_pseudo_id) as users, sum(revenue) as rev from ${DATASET} where app_id in (${all}) regex_off and event_name in (${list(D0_EVENTS)}) regex_off and retention_day in (0) bucket 1 day since ${days} days ago` },
    { kind: 'ret' as const, cols: ['time', 'app_id', f, 'retention_day', 'users'],
      eql: `select app_id, ${f}, retention_day, count_distinct(user_pseudo_id) as users from ${DATASET} where app_id in (${all}) regex_off and event_name in ('session_start') regex_off and retention_day in (${RET_DAYS.join(', ')}) bucket 1 day since ${days} days ago` },
    ...(idol.length ? [{ kind: 'mode' as const, cols: ['time', 'app_id', f, 'mode', 'events', 'users'],
      eql: `select app_id, ${f}, mode, count() as events, count_distinct(user_pseudo_id) as users from ${DATASET} where app_id in (${list(idol)}) regex_off and event_name in ('prank_call_start') regex_off and retention_day in (0) bucket 1 day since ${days} days ago` }] : []),
  ]
}

/** A stored fact. `cohort` = install day (bucket day − retention day); `rd` = days since install. */
export type TFact = { app: string; cohort: string; dim: Dim; val: string; rd: number; key: string; value: number }
const appKey = new Map(APPS.map(a => [a.pkg, a.key]))
const n = (v: unknown) => Number(v ?? 0) || 0

/** Bucket days a result covered (complete days only): stored so a missing row is not read as 0. */
export const coveredDays = (rows: Row[], now: number) => [...completeDays(rows, now)]

export function toTFacts(dim: Dim, kind: 'd0' | 'ret' | 'mode', rows: Row[], now: number): TFact[] {
  const keep = completeDays(rows, now), f = FIELD[dim], out: TFact[] = []
  for (const r of rows) {
    const day = bucketDay(r.time), app = appKey.get(String(r.app_id)), val = String(r[f] ?? '')
    if (!app || !keep.has(day) || !val) continue
    const rd = kind === 'ret' ? Number(r.retention_day) : 0
    if (!Number.isInteger(rd)) continue
    const push = (key: string, value: number) => out.push({ app, cohort: addDays(day, -rd), dim, val, rd, key, value })
    if (kind === 'd0') {
      const e = String(r.event_name)
      push(`${e}.users`, n(r.users)); push(`${e}.n`, n(r.events))
      if (e === 'ad_revenue') push('ad_revenue.rev', n(r.rev))
    } else if (kind === 'ret') push('session_start.users', n(r.users))
    else { const m = String(r.mode || 'unknown'); push(`prank_call_start.${m}.users`, n(r.users)); push(`prank_call_start.${m}.n`, n(r.events)) }
  }
  return out
}
