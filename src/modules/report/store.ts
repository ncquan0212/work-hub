// Report storage: raw daily facts and cohort cells, in the shared SQLite file (tables report_*).
import type { DatabaseSync } from 'node:sqlite'
import type { CohortCell, Fact } from './queries.ts'

export function initStore(db: DatabaseSync) {
  db.exec(`
    create table if not exists report_facts (app text not null, day text not null, key text not null, value real not null, primary key (app, day, key)) without rowid;
    create table if not exists report_cohort (app text not null, cohort text not null, rd integer not null, users real, rev real, primary key (app, cohort, rd)) without rowid;
    create table if not exists report_events (app text not null, day text not null, kind text not null, label text not null, primary key (app, day, kind, label)) without rowid;
  `)
}

export function saveFacts(db: DatabaseSync, facts: Fact[]) {
  const st = db.prepare('insert into report_facts (app, day, key, value) values (?, ?, ?, ?) on conflict (app, day, key) do update set value = excluded.value')
  db.exec('begin')
  try { for (const f of facts) st.run(f.app, f.day, f.key, f.value); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
}

export function saveCohort(db: DatabaseSync, cells: CohortCell[]) {
  const st = db.prepare(`insert into report_cohort (app, cohort, rd, users, rev) values (?, ?, ?, ?, ?)
    on conflict (app, cohort, rd) do update set users = coalesce(excluded.users, users), rev = coalesce(excluded.rev, rev)`)
  db.exec('begin')
  try { for (const c of cells) st.run(c.app, c.cohort, c.rd, c.users ?? null, c.rev ?? null); db.exec('commit') } catch (e) { db.exec('rollback'); throw e }
}

export function saveEvents(db: DatabaseSync, events: { app: string; day: string; kind: string; label: string }[]) {
  const st = db.prepare('insert or ignore into report_events (app, day, kind, label) values (?, ?, ?, ?)')
  for (const e of events) st.run(e.app, e.day, e.kind, e.label)
}

/** Facts of one app from `from` on: day → key → value. */
export function loadFacts(db: DatabaseSync, app: string, from: string) {
  const out = new Map<string, Map<string, number>>()
  for (const r of db.prepare('select day, key, value from report_facts where app = ? and day >= ?').all(app, from) as { day: string; key: string; value: number }[]) {
    let m = out.get(r.day); if (!m) out.set(r.day, m = new Map())
    m.set(r.key, r.value)
  }
  return out
}

/** Last day with DAU data for an app (the Report's "hôm qua"). */
export function lastDay(db: DatabaseSync, app: string): string | null {
  return (db.prepare(`select max(day) d from report_facts where app = ? and key = 'session_start.users'`).get(app) as { d: string | null })?.d ?? null
}

/** Cohort cells of one app: install day → rd → {users, rev}; and the last day any cell covers. */
export function loadCohort(db: DatabaseSync, app: string, from: string) {
  const out = new Map<string, Map<number, { users: number; rev: number }>>()
  let last = ''
  for (const r of db.prepare('select cohort, rd, users, rev from report_cohort where app = ? and cohort >= ?').all(app, from) as { cohort: string; rd: number; users: number | null; rev: number | null }[]) {
    let m = out.get(r.cohort); if (!m) out.set(r.cohort, m = new Map())
    m.set(r.rd, { users: r.users ?? 0, rev: r.rev ?? 0 })
    const d = new Date(Date.parse(r.cohort + 'T00:00:00Z') + r.rd * 86_400_000).toISOString().slice(0, 10)
    if (d > last) last = d
  }
  return { cells: out, last }
}

export function loadEvents(db: DatabaseSync, app: string, from: string) {
  return db.prepare('select day, kind, label from report_events where app = ? and day >= ? order by day').all(app, from) as { day: string; kind: string; label: string }[]
}
