// Theo dõi's tables and collector parts. The collector runs every 30 minutes; each part keeps its own clock in
// track_state, so a restart never repeats a Databuckets call (never retry automatically: a call may already have run):
//  - RC history: every run (list of versions, one template per new version, cached by app and version number);
//  - D0 facts by version: once a day after 08:30 (1 call; by experiment_group only in the backfill CLI);
//  - comparison runs: every 6 hours per run (one call holds a run's EQLs, several runs share a call up to 7 EQLs);
//  - Play Console release history: once a day after 08:30, through the `falcon` Chrome profile (T3; off without one).
// Each part stamps its clock BEFORE its call: a restart or the module timeout mid-call never sends it again.
import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { APPS, PROFILE_LABELS, rcKeyPath } from '../../config.ts'
import { dailyMissed } from '../../core/scheduler.ts'
import { NotConfigured } from '../../core/types.ts'
import { eqlDiff, mcpSession, normEql, parseQueryResults, runEql, toRows, type Row } from '../../lib/databuckets.ts'
import { utcDay } from '../../lib/days.ts'
import { firebaseUserToken, getJson, serviceAccountProject, serviceAccountToken } from '../../lib/google.ts'
import { notify } from '../../lib/notify.ts'
import { chiSquare } from '../../lib/stats.ts'
import type { GroupFacts } from './compare.ts'
import { readPlay } from './play.ts'
import { coveredDays, queries, toTFacts, type Dim, type TFact } from './queries.ts'
import {
  DAY, DECISION, DEFAULT_HORIZON, DEFAULT_METRIC, HOUR, armSize, compareArms, dataSuggestion, decideDay, decisionOf, expSpans, primaryOf, rcEvents,
  rcSuggestions, rcSummary, runQueries, steadyStart, toFacts, toHours, topTwo, vnTime, type Fact, type NewRun, type RcSum, type Run, type RunQuery, type Status,
} from './runs.ts'

export const REFRESH_MS = 6 * HOUR
const MAX_EQL = 7          // probes 2026-11-09: 7 EQLs took 276 s, 6 took 248 s (each two-stage query 15–27 s on their side)
const CALL_MS = 900_000
const RC_API = 'https://firebaseremoteconfig.googleapis.com/v1/projects'

export function initStore(db: DatabaseSync) {
  db.exec(`
    create table if not exists track_facts (app text not null, cohort text not null, dim text not null, val text not null, rd integer not null,
      key text not null, value real not null, primary key (app, cohort, dim, val, rd, key)) without rowid;
    create table if not exists track_ran (app text not null, dim text not null, day text not null, primary key (app, dim, day)) without rowid;
    create table if not exists track_tests (id integer primary key, app text not null, name text not null, cond text, arms text not null,
      weights text not null, start_day text not null, end_day text, note text, created_at integer not null);
    create table if not exists track_runs (id integer primary key, app text not null, kind text not null, name text not null, arms text not null,
      weights text not null, start_at integer not null, end_at integer, source text not null, status text not null, cond text, exp_id text,
      metric text, note text, skey text unique, alt_at integer, refreshed_at integer, pulled_to text, error text, srm integer not null default 0,
      horizon integer not null default ${DEFAULT_HORIZON}, decided_at integer, decision text, created_at integer not null);
    create table if not exists track_run_facts (run integer not null, arm text not null, cohort text not null, rd integer not null, key text not null,
      value real not null, primary key (run, arm, cohort, rd, key)) without rowid;
    create table if not exists track_run_hours (run integer not null, arm text not null, hour integer not null, users real not null,
      primary key (run, arm, hour)) without rowid;
    create table if not exists track_rcv (app text not null, v integer not null, at integer not null, by text, label text, exps text not null,
      primary key (app, v)) without rowid;
    create table if not exists track_play (app text not null, version text not null, pct real not null, at integer, seen_at integer not null,
      primary key (app, version, pct)) without rowid;
    create table if not exists track_state (part text primary key, at integer not null, ok integer not null default 1, error text, info text) without rowid;
  `)
  // the fixed decision point (review 2026-11-09) on a table made earlier the same day
  for (const [c, def] of [['horizon', `integer not null default ${DEFAULT_HORIZON}`], ['decided_at', 'integer'], ['decision', 'text']]) {
    const have = (db.prepare('pragma table_info(track_runs)').all() as { name: string }[]).some(x => x.name === c)
    if (!have) try { db.exec(`alter table track_runs add column ${c} ${def}`) } catch { /* added by the other process */ }
  }
  // the A/B book of bản 1 becomes runs (once each: skey test:<id>); a day there was a UTC day
  for (const t of db.prepare('select * from track_tests').all() as any[])
    db.prepare(`insert or ignore into track_runs (app, kind, name, arms, weights, start_at, end_at, source, status, cond, note, skey, created_at)
      values (?, 'ab', ?, ?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`).run(t.app, t.name, t.arms, t.weights, Date.parse(`${t.start_day}T00:00:00Z`),
      t.end_day ? Date.parse(`${t.end_day}T00:00:00Z`) + DAY : null, t.end_day ? 'ended' : 'active', t.cond, t.note, `test:${t.id}`, t.created_at)
  // first start of bản 2: today's 08:30 D0 pull already ran under bản 1; Play pages open in the owner's Chrome only from
  // the next 08:30, not at whatever hour the hub restarts
  for (const part of ['d0', 'play']) db.prepare(`insert or ignore into track_state (part, at, ok) values (?, ?, 1)`).run(part, Date.now())
}

// ───────────── reads ─────────────

const parse = (r: any): Run => ({ ...r, arms: JSON.parse(r.arms), weights: JSON.parse(r.weights) })
export const listRuns = (db: DatabaseSync, statuses: Status[] = ['suggested', 'active', 'ended']): Run[] =>
  (db.prepare(`select * from track_runs where status in (${statuses.map(() => '?').join(',')}) order by start_at desc`).all(...statuses) as any[]).map(parse)
export const getRun = (db: DatabaseSync, id: number): Run | null => { const r = db.prepare('select * from track_runs where id = ?').get(id); return r ? parse(r) : null }

export type State = { at: number; ok: number; error: string | null; info: any }
export function getState(db: DatabaseSync, part: string): State | null {
  const r = db.prepare('select at, ok, error, info from track_state where part = ?').get(part) as any
  return r ? { ...r, info: r.info ? JSON.parse(r.info) : null } : null
}
function setState(db: DatabaseSync, part: string, at: number, error?: string | null, info?: unknown) {
  db.prepare(`insert into track_state (part, at, ok, error, info) values (?, ?, ?, ?, ?) on conflict (part) do update set at = excluded.at, ok = excluded.ok,
    error = excluded.error, info = coalesce(excluded.info, info)`).run(part, at, error ? 0 : 1, error ?? null, info === undefined ? null : JSON.stringify(info))
}

/** arm → install day ('*' = the whole window) → days since install → key → value. */
export function runFacts(db: DatabaseSync, id: number) {
  const out = new Map<string, GroupFacts>()
  for (const r of db.prepare('select arm, cohort, rd, key, value from track_run_facts where run = ?').all(id) as { arm: string; cohort: string; rd: number; key: string; value: number }[]) {
    let g = out.get(r.arm); if (!g) out.set(r.arm, g = new Map())
    let c = g.get(r.cohort); if (!c) g.set(r.cohort, c = new Map())
    let k = c.get(r.rd); if (!k) c.set(r.rd, k = new Map())
    k.set(r.key, r.value)
  }
  return out
}
export function runHours(db: DatabaseSync, id: number) {
  const out = new Map<number, Map<string, number>>()
  for (const r of db.prepare('select arm, hour, users from track_run_hours where run = ? order by hour').all(id) as { arm: string; hour: number; users: number }[]) {
    let m = out.get(r.hour); if (!m) out.set(r.hour, m = new Map())
    m.set(r.arm, r.users)
  }
  return out
}
export function rcSums(db: DatabaseSync, app: string): RcSum[] {
  return (db.prepare('select v, at, by, label, exps from track_rcv where app = ? order by v').all(app) as any[]).map(r => ({ ...r, exps: JSON.parse(r.exps) }))
}
export const playSteps = (db: DatabaseSync, app: string) =>
  db.prepare('select version, pct, at from track_play where app = ? order by coalesce(at, seen_at)').all(app) as { version: string; pct: number; at: number | null }[]

/** New installs per version per install day (bản 1's daily facts), oldest first. */
export function versionDays(db: DatabaseSync, app: string, from: string): [string, Map<string, number>][] {
  const out = new Map<string, Map<string, number>>()
  for (const r of db.prepare(`select cohort, val, value from track_facts where app = ? and dim = 'ver' and rd = 0 and key = 'first_open.users' and cohort >= ? order by cohort`).all(app, from) as { cohort: string; val: string; value: number }[]) {
    let m = out.get(r.cohort); if (!m) out.set(r.cohort, m = new Map())
    m.set(r.val, r.value)
  }
  return [...out]
}

// ───────────── writes from the pages ─────────────

export function insertRun(db: DatabaseSync, n: NewRun, status: Status, now: number, metric: string | null = null): number | null {
  const r = db.prepare(`insert or ignore into track_runs (app, kind, name, arms, weights, start_at, end_at, source, status, cond, exp_id, metric, note, skey, horizon, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(n.app, n.kind, n.name, JSON.stringify(n.arms), JSON.stringify(n.weights), n.start_at, n.end_at, n.source,
    status, n.cond, n.exp_id, metric, n.note, n.skey, n.horizon ?? DEFAULT_HORIZON, now)
  return r.changes ? Number(r.lastInsertRowid) : null
}

/** Saved from the form: changing what defines the cohort (arms, window, kind, app) drops the old numbers. */
export function updateRun(db: DatabaseSync, id: number, n: Omit<NewRun, 'source' | 'skey' | 'exp_id'> & { metric: string | null; status: Status }) {
  const old = getRun(db, id)
  if (!old) return
  const moved = old.app !== n.app || old.kind !== n.kind || old.start_at !== n.start_at || old.end_at !== n.end_at || JSON.stringify(old.arms) !== JSON.stringify(n.arms)
  db.prepare(`update track_runs set app = ?, kind = ?, name = ?, arms = ?, weights = ?, start_at = ?, end_at = ?, cond = ?, metric = ?, note = ?, status = ?, horizon = ?
    ${moved ? ', refreshed_at = null, pulled_to = null, error = null, srm = 0, decided_at = null, decision = null' : ''} where id = ?`)
    .run(n.app, n.kind, n.name, JSON.stringify(n.arms), JSON.stringify(n.weights), n.start_at, n.end_at, n.cond, n.metric, n.note, n.status, n.horizon ?? old.horizon, id)
  if (moved) { db.prepare('delete from track_run_facts where run = ?').run(id); db.prepare('delete from track_run_hours where run = ?').run(id) }
}

/** One click on a suggestion: active from the RC (or chosen) moment; an experiment that already ended is "ended". */
export function confirmRun(db: DatabaseSync, id: number, at?: number) {
  const r = getRun(db, id)
  if (!r || r.status !== 'suggested' || r.arms.length < 2) return
  const start = at ?? r.start_at
  // refreshed_at cleared: the cohort queries run at the next collector tick (≤ 30 min), not 6 h after the last hourly one;
  // pulled_to cleared: a suggestion had only hourly numbers (a row from before 2026-11-09's fix may say otherwise)
  db.prepare(`update track_runs set status = ?, start_at = ?, metric = coalesce(metric, ?), refreshed_at = null, pulled_to = null where id = ?`).run(r.end_at ? 'ended' : 'active', start, DEFAULT_METRIC, id)
}
/** The RC experiment behind an A/B run (same abt_N, or the run's condition and arms), with the start and end of its
 *  stretch with the run's arms (an experiment that changed arms has one stretch per set). */
export function rcMatch(db: DatabaseSync, r: Run) {
  if (r.kind !== 'ab') return null
  const mine = expSpans(rcEvents(rcSums(db, r.app))).filter(s => s.exp.id === r.exp_id || (!r.exp_id && s.exp.cond === r.cond && s.exp.arms.join() === r.arms.join()))
  const st = mine.find(s => s.exp.arms.join() === r.arms.join()) ?? mine.at(-1)
  return st ? { id: st.exp.id, cond: st.exp.cond, start: st.start, end: st.end } : null
}

/** Take the RC experiment's own start and end (to the second) for a run written by hand with day precision. */
export function useRcTimes(db: DatabaseSync, id: number) {
  const r = getRun(db, id), m = r && rcMatch(db, r)
  if (!r || !m) return
  updateRun(db, id, { ...r, start_at: m.start, end_at: m.end, status: r.status === 'suggested' || r.status === 'dismissed' ? r.status : m.end ? 'ended' : 'active' })
  db.prepare('update track_runs set exp_id = ? where id = ?').run(m.id, id)
}

export const setStatus = (db: DatabaseSync, id: number, status: Status, endAt?: number) =>
  db.prepare(`update track_runs set status = ?, end_at = coalesce(?, end_at) where id = ?`).run(status, endAt ?? null, id)

// ───────────── collector parts ─────────────

/** Every page of a listVersions answer (pageSize caps one page). Throws when the last page was not reached. */
export async function allVersions(get: (url: string) => Promise<any>, url: string) {
  const out: any[] = []
  for (let i = 0, token = ''; i < 20; i++) {
    const j = await get(token ? `${url}&pageToken=${encodeURIComponent(token)}` : url)
    out.push(...(j?.versions ?? []))
    token = j?.nextPageToken ?? ''
    if (!token) return out
  }
  throw new Error('listVersions: hơn 20 trang')
}

/** RC history of every app: the versions of the last 45 days, the template of each one not cached yet (one at a
 *  time: parallel template GETs drew 503s, rc.ts). Returns the apps whose history has no gap. */
export async function rcHistory(db: DatabaseSync, now: number, signal: AbortSignal, errors: string[]) {
  const complete = new Set<string>()
  for (const a of APPS) {
    const file = rcKeyPath(a)
    if (!file || !existsSync(file)) continue // no RC key on this machine: no RC history (nor RC suggestions) for that app
    try {
      const project = serviceAccountProject(file), tok = await serviceAccountToken(file)
      const versions = await allVersions(u => getJson(u, tok, signal), `${RC_API}/${project}/remoteConfig:listVersions?pageSize=300&startTime=${new Date(now - 45 * DAY).toISOString()}`)
      const have = new Set((db.prepare('select v from track_rcv where app = ?').all(a.key) as { v: number }[]).map(r => r.v))
      for (const v of versions) {
        const n = Number(v.versionNumber)
        if (have.has(n)) continue
        const s = rcSummary(await getJson(`${RC_API}/${project}/remoteConfig?versionNumber=${n}`, tok, signal))
        db.prepare('insert or replace into track_rcv (app, v, at, by, label, exps) values (?, ?, ?, ?, ?, ?)')
          .run(a.key, n, Date.parse(v.updateTime), String(v.updateUser?.email ?? '').includes('gserviceaccount.com') ? 'rc.py' : String(v.updateUser?.email ?? ''), s.label, JSON.stringify(s.exps))
      }
      complete.add(a.key)
    } catch (e) { if (signal.aborted) throw e; errors.push(`RC ${a.name}: ${(e as Error).message}`) }
  }
  return complete
}

/** A suggestion already covered by a run (any status, dismissed too): same experiment with the same arms, or same RC
 *  condition and arms, or (version) the same two versions. */
function covered(db: DatabaseSync, n: NewRun) {
  const same = (a: string[]) => a.length === n.arms.length && a.every(x => n.arms.includes(x))
  return listRuns(db, ['suggested', 'active', 'ended', 'dismissed']).some(r => r.app === n.app && r.skey !== n.skey && r.kind === n.kind &&
    (n.kind === 'ab' ? (n.exp_id && r.exp_id === n.exp_id && same(r.arms)) || (!r.exp_id && n.cond && r.cond === n.cond && same(r.arms)) : n.arms.length > 0 && same(r.arms)))
}

function suggestNote(db: DatabaseSync, id: number, now: number) {
  const r = getRun(db, id)
  if (!r || r.status !== 'suggested' || r.arms.length < 2) return
  notify(db, { key: `track:suggest:${id}`, title: `Đợt so sánh mới: ${r.name}`, body: `${r.kind === 'ab' ? 'A/B' : 'Version'} ${r.arms.join(' với ')}, từ ${vnTime(r.start_at)} giờ VN (${SOURCE[r.source]}). Bấm để xác nhận hoặc sửa.`, url: `/track/run/${id}` }, now)
}
export const SOURCE: Record<string, string> = { rc: 'lịch sử RC', data: 'số liệu', play: 'Play Console', manual: 'ghi tay' }

/** New suggestions from RC history (apps whose history has no gap), the daily version split and Play rollouts. */
export function suggest(db: DatabaseSync, now: number, rcComplete: Set<string>) {
  const fresh: NewRun[] = []
  for (const a of APPS) {
    if (rcComplete.has(a.key)) fresh.push(...rcSuggestions(a.key, rcEvents(rcSums(db, a.key)), now))
    const d = dataSuggestion(a.key, versionDays(db, a.key, utcDay(now - 4 * DAY)))
    if (d) fresh.push(d)
    for (const s of playSteps(db, a.key).filter(s => s.at && s.at > now - 7 * DAY && s.pct > 0 && s.pct < 100))
      fresh.push({ app: a.key, kind: 'version', name: `${a.name} ${s.version} rollout ${s.pct}%`, arms: [], weights: [100 - s.pct, s.pct], start_at: s.at!, end_at: null,
        source: 'play', cond: null, exp_id: null, skey: `play:${a.key}:${s.version}:${s.pct}`, note: `Play Console: ${s.version} lên ${s.pct}% lúc ${vnTime(s.at!)} giờ VN.` })
  }
  for (const n of fresh) {
    // a suggestion not confirmed yet follows RC: its experiment ended or changed arms since it was made
    if (n.source === 'rc') db.prepare(`update track_runs set end_at = ?, note = ? where skey = ? and status = 'suggested'`).run(n.end_at, n.note, n.skey)
    if (covered(db, n)) continue
    const id = insertRun(db, n, 'suggested', now)
    if (id) suggestNote(db, id, now)
  }
}

/** runEql, except that each query carries `ran`: the EQL the engine reports back, whose absolute `to` is one day after
 *  the one sent (probed 2026-11-09). ponytail: a copy of runEql's prompt and checks; give runEql a `ran` option and drop this. */
export async function askAll(qs: Pick<RunQuery, 'eql' | 'ran' | 'cols'>[], signal: AbortSignal) {
  const s = await mcpSession(AbortSignal.any([signal, AbortSignal.timeout(CALL_MS)]))
  const question = [
    'READ-ONLY: do not create, save, schedule, send or modify any report, dashboard, insight, alert or email.',
    `Execute each of the ${qs.length} EQL queries below exactly as written, once each, in order. No exploration, no follow-up queries, no chart, no rewriting.`,
    'Translate it faithfully into your query model: keep every clause (bucket 1 day, since N days ago, retention_day, every filter value); do not drop or add anything.',
    // 2026-11-09: the agent once moved a stage-1 `time from '… 02:02:05'` to the day before at 00:00 (the hub refused it)
    'Keep every absolute time range exactly as written, to the second, in every stage: do not round it to whole days or widen it.',
    'Reply with the Query results block only.',
    ...qs.flatMap((q, i) => [`Query ${i + 1}:`, '```', q.eql, '```']),
  ].join('\n')
  const res = await s.call('chat_with_agent', { user_question: question })
  const text = res?.content?.find((c: any) => c?.type === 'text')?.text
  if (!text) throw new Error('Databuckets: trả lời rỗng')
  const out = JSON.parse(text)
  if (out.agent_run_failed) throw new Error(`Databuckets: agent lỗi: ${String(out.reply ?? '').slice(0, 160)}`)
  const results = parseQueryResults(String(out.reply ?? ''))
  return qs.map((q, i) => {
    const want = normEql(q.ran), r = results.find(x => x.eql && normEql(x.eql) === want)
    if (!r) { const ran = results[i]?.eql ?? results[0]?.eql; throw new Error(ran ? `Databuckets: agent đã đổi EQL (truy vấn ${i + 1}): ${eqlDiff(want, normEql(ran))}` : `Databuckets: thiếu kết quả truy vấn ${i + 1}`) }
    const last = r.steps?.at(-1), total = Array.isArray(last) ? Number(last[1]) : NaN
    if (total > r.data.length - 1 || r.data.length - 1 >= 1000) throw new Error(`Databuckets: kết quả bị cắt (${Number.isNaN(total) ? '≥1000' : total} dòng, nhận ${r.data.length - 1})`)
    const missing = q.cols.filter(c => !(r.data[0] as string[]).includes(c))
    if (missing.length) throw new Error(`Databuckets: thiếu cột ${missing.join(', ')} (truy vấn ${i + 1})`)
    return toRows(r.data)
  })
}

/** Runs to refresh now: active ones, ended ones whose D7 is still coming (9 days), suggestions of the last 3 days
 *  (their hourly split gives the data-driven start), each at most every 6 hours, failures included. */
export function dueRuns(runs: Run[], now: number) {
  return runs.filter(r => (r.refreshed_at == null || now - r.refreshed_at >= REFRESH_MS) && r.start_at < now - HOUR && (
    r.status === 'active' || (r.status === 'ended' && (r.end_at ?? 0) > now - 9 * DAY) || (r.status === 'suggested' && Math.max(r.created_at, r.start_at) > now - 3 * DAY)))
}

/** Store one run's rows, fill a suggestion's arms from the hourly split, then check SRM and the primary verdict. */
export function saveRun(db: DatabaseSync, r: Run, qs: RunQuery[], rows: Row[][], now: number) {
  const facts: Fact[] = []
  let hours: Map<number, Map<string, number>> | null = null
  for (let i = 0; i < qs.length; i++) if (qs[i].kind === 'hour') hours = toHours(r.kind, rows[i]); else facts.push(...toFacts(qs[i], rows[i]))
  let arms = r.arms
  db.exec('begin')
  try {
    if (qs.some(q => q.kind !== 'hour')) {
      db.prepare('delete from track_run_facts where run = ?').run(r.id)
      const st = db.prepare('insert or replace into track_run_facts (run, arm, cohort, rd, key, value) values (?, ?, ?, ?, ?, ?)')
      for (const f of facts) st.run(r.id, f.arm, f.cohort, f.rd, f.key, f.value)
    }
    if (hours) {
      const h = hours
      db.prepare('delete from track_run_hours where run = ?').run(r.id)
      const st = db.prepare('insert into track_run_hours (run, arm, hour, users) values (?, ?, ?, ?)')
      for (const [t, m] of h) for (const [arm, u] of m) st.run(r.id, arm, t, u)
      if (r.status === 'suggested' && r.kind === 'version' && !arms.length) {
        const after = new Map<string, number>()
        for (const [t, m] of h) if (t >= r.start_at) for (const [v, u] of m) after.set(v, (after.get(v) ?? 0) + u)
        arms = topTwo(after)
        // a day after the label change still one version: nothing ran in parallel (100% rollout, or no new build)
        if (!arms.length && now - r.start_at > DAY) db.prepare(`update track_runs set status = 'dismissed', note = coalesce(note, '') || ' Một ngày sau lúc đổi nhãn vẫn không có hai version cùng có từ 5% user mới.' where id = ?`).run(r.id)
      }
      db.prepare('update track_runs set arms = ?, alt_at = ? where id = ?').run(JSON.stringify(arms), arms.length >= 2 ? steadyStart(h, arms) : null, r.id)
    }
    // pulled_to: the last complete day of cohort numbers, so only when cohort queries ran (not an hourly-only refresh)
    if (qs.some(q => q.kind !== 'hour')) db.prepare('update track_runs set pulled_to = ? where id = ?').run(utcDay(now - DAY), r.id)
    db.prepare('update track_runs set refreshed_at = ?, error = null where id = ?').run(now, r.id)
    db.exec('commit')
  } catch (e) { db.exec('rollback'); throw e }
  if (r.status === 'suggested' && !r.arms.length && arms.length >= 2) {
    if (covered(db, { ...r, arms })) db.prepare(`update track_runs set status = 'dismissed', note = coalesce(note, '') || ' Trùng một đợt đã có.' where id = ?`).run(r.id)
    else suggestNote(db, r.id, now)
  }
  if (r.status === 'active' || r.status === 'ended') evaluate(db, getRun(db, r.id)!, now)
}

/** SRM (χ² against the expected split, p < 0.001, from 100 users per arm), notified once per run (again only after it
 *  cleared), and the decision on the primary metric: made once, at the decision point (decideDay), notified once
 *  whatever it is, "no clear difference" too. Before it, the verdicts on the pages are provisional. */
export function evaluate(db: DatabaseSync, r: Run, now: number) {
  const g = runFacts(db, r.id), sizes = r.arms.map(a => armSize(g.get(a)))
  const srm = sizes.every(s => s >= 100) && chiSquare(sizes, r.weights).p < 0.001
  if (srm && !r.srm) notify(db, { key: `track:srm:${r.id}`, tone: 'warn', title: `${r.name} bị SRM`, url: `/track/run/${r.id}`,
    body: `User mới mỗi nhánh ${sizes.map(s => s.toLocaleString('vi-VN')).join(' : ')}, lệch so với tỉ lệ ${r.weights.join(':')}. Kết quả chưa đáng tin cho tới khi rõ nguyên nhân.` }, now)
  db.prepare('update track_runs set srm = ? where id = ?').run(srm ? 1 : 0, r.id)
  const m = primaryOf(r)
  if (r.decided_at || !r.pulled_to || r.arms.length < 2 || r.pulled_to < decideDay(r, m)) return
  const res = r.arms.slice(1).map(arm => ({ arm, ...compareArms(g.get(r.arms[0]), g.get(arm), m, r.pulled_to!) }))
  if (res.some(x => !x.a.den || !x.b.den)) return // no numbers is no decision: it waits for them
  const dec = res.map(x => decisionOf(x.c))
  db.prepare('update track_runs set decided_at = ?, decision = ? where id = ?').run(now, dec.join(','), r.id)
  const pc = (x: number) => `${x > 0 ? '+' : ''}${(x * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}%`
  notify(db, { key: `track:verdict:${r.id}`, title: `${r.name}: ${DECISION[dec[0]].word} ở ${m.label}`, url: `/track/run/${r.id}`,
    body: `Kết luận sau ${r.horizon} ngày cài. ${res.map(x => `${x.arm} so với ${r.arms[0]}: ${x.l ? pc(x.l.lift) : '—'}${x.l?.lo != null && x.l.hi != null ? ` (khoảng 95% ${pc(x.l.lo)} đến ${pc(x.l.hi)})` : ''}${x.c.tone === 'warn' ? `, ${x.c.word.toLowerCase()}` : ''}.`).join(' ')}${srm ? ' Đợt đang bị SRM.' : ''}` }, now)
}

/** Refresh the due runs: one Databuckets call per group of runs (up to 7 EQLs), never retried. */
export async function refreshRuns(db: DatabaseSync, now: number, signal: AbortSignal, errors: string[], ask = askAll) {
  const due = dueRuns(listRuns(db), now)
  const groups: { r: Run; qs: RunQuery[] }[][] = []
  for (const r of due) {
    let qs: RunQuery[]
    try { qs = runQueries(r, now, r.status !== 'suggested') } catch (e) { db.prepare('update track_runs set refreshed_at = ?, error = ? where id = ?').run(now, (e as Error).message, r.id); continue }
    if (!qs.length) continue
    const g = groups.at(-1)
    if (g && g.reduce((s, x) => s + x.qs.length, 0) + qs.length <= MAX_EQL) g.push({ r, qs }); else groups.push([{ r, qs }])
  }
  for (const g of groups) {
    const all = g.flatMap(x => x.qs)
    for (const x of g) db.prepare('update track_runs set refreshed_at = ? where id = ?').run(now, x.r.id) // the attempt, before the call
    try {
      const rows = await ask(all, signal)
      let i = 0
      for (const x of g) { saveRun(db, x.r, x.qs, rows.slice(i, i + x.qs.length), now); i += x.qs.length }
    } catch (e) {
      if (signal.aborted) throw e
      const msg = (e as Error).message
      for (const x of g) db.prepare('update track_runs set refreshed_at = ?, error = ? where id = ?').run(now, msg.slice(0, 500), x.r.id)
      if (!unsetOk(db, e)) errors.push(`đợt ${g.map(x => `#${x.r.id}`).join(', ')}: ${msg}`)
    }
  }
}

export function saveTFacts(db: DatabaseSync, facts: TFact[]) {
  const st = db.prepare(`insert into track_facts (app, cohort, dim, val, rd, key, value) values (?, ?, ?, ?, ?, ?, ?)
    on conflict (app, cohort, dim, val, rd, key) do update set value = excluded.value`)
  db.exec('begin')
  try { for (const f of facts) st.run(f.app, f.cohort, f.dim, f.val, f.rd, f.key, f.value); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
}
export function saveRan(db: DatabaseSync, dim: Dim, days: string[]) {
  const st = db.prepare('insert or ignore into track_ran (app, dim, day) values (?, ?, ?)')
  for (const a of APPS) for (const d of days) st.run(a.key, dim, d)
}

/** Databuckets not set up on this copy (NotConfigured) and no number pulled yet: noted on the part, not a failed run.
 *  Once numbers came, a missing source is an error again: it worked and was lost (review 11/11). */
const unsetOk = (db: DatabaseSync, e: unknown) => e instanceof NotConfigured && !db.prepare('select 1 from track_facts limit 1').get()

/** Bản 1's daily pull: D0 by version (release markers, /track/version, data suggestions), 1 call. The split by
 *  experiment_group is left to the backfill CLI: comparison runs replaced its only reader. */
export async function daily(db: DatabaseSync, now: number, signal: AbortSignal, errors: string[], run = runEql) {
  setState(db, 'd0', now) // the attempt, before the call
  const dim: Dim = 'ver'
  try {
    const qs = queries(dim, 3), res = await run(qs.map(q => ({ eql: q.eql, cols: q.cols })), signal)
    saveTFacts(db, res.flatMap((r, i) => toTFacts(dim, qs[i].kind, r.rows, now)))
    saveRan(db, dim, coveredDays(res[1].rows, now)) // the retention query decides which days count as pulled
  } catch (e) { if (signal.aborted) throw e; const msg = `version: ${(e as Error).message}`; if (!unsetOk(db, e)) errors.push(msg); setState(db, 'd0', now, msg) }
}

/** Crash-free users by version, 14 days (Crashlytics), once a day: shown on /track/version. */
async function crashes(db: DatabaseSync, now: number, signal: AbortSignal, errors: string[]) {
  setState(db, 'crash', now) // the attempt, before the calls
  const before = errors.length
  const crash: Record<string, { version: string; build: string; crashFree: number | null; users: number }[]> = {}
  for (const a of APPS.filter(x => x.appId)) {
    try {
      const q = new URLSearchParams([['filter.interval.start_time', new Date(now - 14 * DAY).toISOString()], ['filter.interval.end_time', new Date(now).toISOString()], ['filter.issue.error_types', 'FATAL'], ['page_size', '10']])
      const r = await getJson(`https://firebasecrashlytics.googleapis.com/v1alpha/projects/${a.appId!.split(':')[1]}/apps/${a.appId}/reports/topVersions?${q}`, await firebaseUserToken(), signal)
      crash[a.key] = (r.groups ?? []).map((g: any) => ({ version: String(g.version?.displayVersion ?? ''), build: String(g.version?.buildVersion ?? ''),
        crashFree: g.metrics?.[0]?.crashFreeUsersPercentage != null ? Number(g.metrics[0].crashFreeUsersPercentage) : null, users: Number(g.metrics?.[0]?.totalUsersCount ?? 0) }))
    } catch (e) {
      if (signal.aborted) throw e
      if (e instanceof NotConfigured) break // no Firebase login on this machine: no crash-free by version, not an error
      errors.push(`Crashlytics ${a.name}: ${(e as Error).message}`)
    }
  }
  setState(db, 'crash', now, errors.length > before ? errors.slice(before).join(' · ') : null, Object.keys(crash).length ? { crash } : undefined)
}

export async function play(db: DatabaseSync, now: number, signal: AbortSignal, read = readPlay) {
  setState(db, 'play', now) // the attempt, before the pages open
  const paths = new Map<string, string>(Object.entries(getState(db, 'play-paths')?.info ?? {}))
  let apps: Awaited<ReturnType<typeof read>>
  try { apps = await read(db, signal, paths) } catch (e) { if (signal.aborted) throw e; setState(db, 'play', now, (e as Error).message); return }
  setState(db, 'play-paths', now, null, Object.fromEntries(paths))
  const st = db.prepare(`insert into track_play (app, version, pct, at, seen_at) values (?, ?, ?, ?, ?) on conflict (app, version, pct) do update set at = coalesce(excluded.at, at), seen_at = excluded.seen_at`)
  for (const a of apps) for (const s of a.steps) st.run(a.app, s.version, s.pct, s.at, now)
  setState(db, 'play', now, apps.every(a => a.error) ? apps[0]?.error ?? 'không đọc được' : null, apps.map(a => ({ app: a.app, steps: a.steps.length, sample: a.sample, error: a.error })))
}

/** One collector run. Throws (after saving everything) when a Databuckets or RC part failed in this run. */
export async function collectAll(db: DatabaseSync, now: number, signal: AbortSignal) {
  const errors: string[] = []
  const rcOk = await rcHistory(db, now, signal, errors)
  if (dailyMissed('08:30', getState(db, 'd0')?.at, now)) await daily(db, now, signal, errors)
  if (dailyMissed('08:30', getState(db, 'crash')?.at, now)) await crashes(db, now, signal, errors)
  suggest(db, now, rcOk)
  await refreshRuns(db, now, signal, errors)
  if (PROFILE_LABELS.falcon && dailyMissed('08:30', getState(db, 'play')?.at, now)) await play(db, now, signal)
  return errors
}

/** First install day on which a version took ≥ 1% of that day's new users: release markers for the Report. */
export function releases(db: DatabaseSync, now: number) {
  const out: { app: string; day: string; version: string }[] = []
  for (const a of APPS) {
    const rows = db.prepare(`select cohort, val, value from track_facts where app = ? and dim = 'ver' and rd = 0 and key = 'first_open.users' and cohort >= ? order by cohort`)
      .all(a.key, utcDay(now - 120 * DAY)) as { cohort: string; val: string; value: number }[]
    const total = new Map<string, number>()
    for (const r of rows) total.set(r.cohort, (total.get(r.cohort) ?? 0) + r.value)
    // versions already there on the first stored day were released earlier: no marker for them
    const first = rows[0]?.cohort
    const seen = new Set(rows.filter(r => r.cohort === first && r.value >= 0.01 * (total.get(first) ?? 0)).map(r => r.val))
    for (const r of rows) if (!seen.has(r.val) && r.value >= 0.01 * (total.get(r.cohort) ?? 0)) { seen.add(r.val); out.push({ app: a.key, day: r.cohort, version: r.val }) }
  }
  return out
}
