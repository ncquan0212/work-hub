// Notifications (architecture.md "Thông báo", owner 2026-11-09: Web Push). Any process records one here: the hub's modules,
// the core (alerts) and the Develop runner. The hub delivers what is recorded (push to the devices that turned
// notifications on, and the bell in the hub). This file is the contract between them: keep `notify`'s signature.
import type { DatabaseSync } from 'node:sqlite'

export type NoteTone = 'info' | 'warn' | 'bad' // bad: "Gấp", the only tone that rings in quiet hours
export type Note = { key: string; title: string; body: string; url: string; tone?: NoteTone }
/** What delivery did with it: null not yet; sent: pushed to `pushed` devices; quiet: in quiet hours, not pushed;
 *  none: no device had push on; old: recorded too long before the hub could deliver it (the hub was down);
 *  merged: a newer one for the same page went in the same pass, and only that one was pushed. */
export type PushState = 'sent' | 'quiet' | 'none' | 'old' | 'merged'
// tries, next_at: a push that failed only transiently is taken again at next_at (modules/notify decides)
export type NoteRow = Note & { id: number; day: string; tone: NoteTone; created_at: number; sent_at: number | null; read_at: number | null
  push: PushState | null; pushed: number; tries: number; next_at: number | null }

const ready = new WeakSet<DatabaseSync>()
export function initNotify(db: DatabaseSync) {
  if (ready.has(db)) return
  db.exec(`create table if not exists notify_items (id integer primary key, key text not null, day text not null, title text not null,
    body text not null, url text not null, tone text not null default 'info', created_at integer not null, sent_at integer, read_at integer,
    push text, pushed integer not null default 0, tries integer not null default 0, next_at integer, unique (key, day))`)
  // a table made by an earlier version of this file (2026-11-09) lacks the delivery columns. The hub and the runner both run this
  for (const [c, def] of [['push', 'text'], ['pushed', 'integer not null default 0'], ['tries', 'integer not null default 0'], ['next_at', 'integer']]) {
    const have = (db.prepare('pragma table_info(notify_items)').all() as { name: string }[]).some(x => x.name === c)
    if (!have) try { db.exec(`alter table notify_items add column ${c} ${def}`) } catch { /* added by the other process */ }
  }
  ready.add(db)
}

/** The Vietnam calendar day of `t`: one notification per key per day. */
export const noteDay = (t: number) => new Date(t + 7 * 3_600_000).toISOString().slice(0, 10)
/** 23:00 to 07:00 Vietnam time: only "Gấp" (tone bad) is pushed then; the rest waits in the bell's list. */
export const quietHours = (t: number) => { const h = new Date(t + 7 * 3_600_000).getUTCHours(); return h >= 23 || h < 7 }
/** A hub path, never one a browser reads as another site ("//x", "/\x", or "/\t/x": browsers drop tabs and newlines). */
export const hubPath = (u: string) => /^\/(?![/\\])[^\x00-\x1f]*$/.test(u) ? u : '/'

/** Records a notification once per key per Vietnam day. Returns its id, or null when this key was already recorded
 *  today. `url` is a hub path ("/develop/task/9#latest"). Never throws for a duplicate. */
export function notify(db: DatabaseSync, n: Note, now = Date.now()): number | null {
  initNotify(db)
  const r = db.prepare(`insert or ignore into notify_items (key, day, title, body, url, tone, created_at) values (?, ?, ?, ?, ?, ?, ?)`)
    .run(n.key, noteDay(now), n.title.slice(0, 120), n.body.slice(0, 400), hubPath(n.url), n.tone ?? 'info', now)
  return r.changes ? Number(r.lastInsertRowid) : null
}

/** The page that lists notifications, set by the module that has it (modules/notify): the top bar shows a bell when set. */
export const bell = { href: '' }

export function unread(db: DatabaseSync) {
  initNotify(db)
  return (db.prepare('select count(*) as n from notify_items where read_at is null').get() as { n: number }).n
}
export function listNotes(db: DatabaseSync, limit = 100) {
  initNotify(db)
  return db.prepare('select * from notify_items order by id desc limit ?').all(limit) as NoteRow[]
}
export const getNote = (db: DatabaseSync, id: number) => { initNotify(db); return db.prepare('select * from notify_items where id = ?').get(id) as NoteRow | undefined }
/** Marks read every notification up to `id` (the newest one a page showed), or only `id` itself. */
export function markRead(db: DatabaseSync, id: number, o: { only?: boolean; now?: number } = {}) {
  initNotify(db)
  db.prepare(`update notify_items set read_at = ? where read_at is null and ${o.only ? 'id = ?' : 'id <= ?'}`).run(o.now ?? Date.now(), id)
}
/** Takes what no delivery has handled yet (and is due, when put back for another try), marking it taken in the same statement. */
export function takeUnsent(db: DatabaseSync, now = Date.now()) {
  initNotify(db)
  return (db.prepare('update notify_items set sent_at = ? where sent_at is null and (next_at is null or next_at <= ?) returning *').all(now, now) as NoteRow[])
    .sort((a, b) => a.id - b.id)
}
export function setPush(db: DatabaseSync, id: number, push: PushState, pushed = 0) {
  db.prepare('update notify_items set push = ?, pushed = ? where id = ?').run(push, pushed, id)
}
/** Gives a taken notification back, for another try at `at`. */
export function putBack(db: DatabaseSync, id: number, at: number) {
  db.prepare('update notify_items set sent_at = null, tries = tries + 1, next_at = ? where id = ?').run(at, id)
}
/** Rows a delivery took and never finished (it died halfway), taken before `before`. */
export function stuck(db: DatabaseSync, before: number) {
  initNotify(db)
  return db.prepare('select * from notify_items where sent_at < ? and push is null order by id').all(before) as NoteRow[]
}
/** Whether `key` was recorded on the Vietnam day before `day`. */
export const dayBefore = (db: DatabaseSync, key: string, day: string) =>
  !!db.prepare('select 1 from notify_items where key = ? and day = ?').get(key, noteDay(Date.parse(day) - 86_400_000))
