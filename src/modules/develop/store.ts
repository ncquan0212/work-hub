// Develop board storage, shared by the hub (web, writes what the owner does) and the runner (a separate
// process that runs Claude turns). The two only talk through these tables, plus the image files under
// data/develop-files/ that develop_files rows point to (the hub writes them, the runner reads them).
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { DATA } from '../../config.ts'

export type TaskStatus = 'new' | 'discussing' | 'awaiting' | 'working' | 'review' | 'done' | 'cancelled'
export type TurnKind = 'discuss' | 'execute'
// merged: a reply the owner sent while Claude waited on its background job, written into that running session
export type TurnStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancel' | 'cancelled' | 'merged'

export type Task = {
  id: number; title: string; body: string; repo: string; status: TaskStatus; session_id: string; session_started: number
  worktree: string | null; branch: string | null; jira_key: string | null; cost_usd: number; created_at: number; updated_at: number
} & RunMode
/** How a task's turns run (architecture.md "Develop"). null / 0 = today's default; prompts.ts turns it into CLI flags. */
export type RunMode = { model: string | null; effort: string | null; ultracode: number; chrome: number; isolated: number }
export type Message = { id: number; task_id: number; at: number; who: 'owner' | 'claude' | 'system'; text: string }
export type Turn = { id: number; task_id: number; kind: TurnKind; prompt: string; files: string | null /* JSON ids of images sent with it */; status: TurnStatus; pid: number | null
  started_at: number | null; ended_at: number | null; cost_usd: number | null /* session total after this turn */; error: string | null; created_at: number
  waiting: number /* 1: running, Claude's turn is over and it waits on its background job; a reply goes straight in */
  said: string | null /* a reply: the owner's own text, worded by the runner for the session it joins */
  model_used: string | null /* the model claude ran, from its init event ("claude-fable-5-1") */ }
export type Activity = { task_id: number; turn_id: number; at: number; text: string }
/** An image the owner attached to a message. `path` is absolute; `mime` is what the file was checked and stored as. */
export type DevFile = { id: number; task_id: number; message_id: number; mime: string; path: string; bytes: number; at: number }

export const STATUS_LABEL: Record<TaskStatus, string> = {
  new: 'Mới', discussing: 'Đang trao đổi', awaiting: 'Chờ bạn', working: 'Đang làm', review: 'Chờ bạn xem', done: 'Xong', cancelled: 'Huỷ',
}

export function initStore(db: DatabaseSync) {
  db.exec(`
    create table if not exists develop_tasks (
      id integer primary key, title text not null, body text not null default '', repo text not null,
      status text not null default 'new', session_id text not null, session_started integer not null default 0,
      worktree text, branch text, jira_key text, cost_usd real not null default 0,
      created_at integer not null, updated_at integer not null, model text, effort text, ultracode integer not null default 0,
      chrome integer not null default 0, isolated integer not null default 0);
    create table if not exists develop_messages (id integer primary key, task_id integer not null references develop_tasks(id),
      at integer not null, who text not null, text text not null);
    create table if not exists develop_turns (id integer primary key, task_id integer not null references develop_tasks(id),
      kind text not null, prompt text not null, status text not null default 'queued', pid integer,
      started_at integer, ended_at integer, cost_usd real, error text, created_at integer not null, files text, waiting integer not null default 0, said text);
    create table if not exists develop_activity (task_id integer not null, turn_id integer not null, at integer not null, text text not null);
    create index if not exists develop_activity_turn on develop_activity (turn_id, at);
    create table if not exists develop_models (alias text primary key, model text not null, at integer not null);
    create table if not exists develop_files (id integer primary key, task_id integer not null references develop_tasks(id),
      message_id integer not null, mime text not null, path text not null, bytes integer not null, at integer not null);
    create table if not exists develop_runner (id integer primary key check (id = 1), pid integer not null, beat integer not null);
  `)
  // columns added after the first release (2026-11-09: run mode, images). Hub and runner both run this: a lost race is harmless
  for (const [table, c, def] of [['develop_tasks', 'model', 'text'], ['develop_tasks', 'effort', 'text'], ['develop_tasks', 'ultracode', 'integer not null default 0'],
    ['develop_tasks', 'chrome', 'integer not null default 0'], ['develop_turns', 'files', 'text'], ['develop_tasks', 'isolated', 'integer not null default 0'],
    ['develop_turns', 'waiting', 'integer not null default 0'], ['develop_turns', 'said', 'text'], ['develop_turns', 'model_used', 'text']]) {
    const have = (db.prepare(`pragma table_info(${table})`).all() as { name: string }[]).some(x => x.name === c)
    if (!have) try { db.exec(`alter table ${table} add column ${c} ${def}`) } catch { /* added by the other process */ }
  }
  // a task's cost is its session's latest total. Until 2026-11-09 the runner added the turns' running totals up
  // (task #3 showed $25.91 for $7.66); recomputing is idempotent, turn rows have always held the totals
  db.exec('update develop_tasks set cost_usd = coalesce((select max(cost_usd) from develop_turns t where t.task_id = develop_tasks.id), cost_usd)')
}

export function createTask(db: DatabaseSync, t: { title: string; body: string; repo: string; jira_key?: string | null } & Partial<RunMode>, now = Date.now()) {
  const r = db.prepare(`insert into develop_tasks (title, body, repo, session_id, jira_key, created_at, updated_at, model, effort, ultracode, chrome, isolated)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(t.title, t.body, t.repo, randomUUID(), t.jira_key ?? null, now, now, t.model ?? null, t.effort ?? null, t.ultracode ?? 0, t.chrome ?? 0, t.isolated ?? 0)
  return Number(r.lastInsertRowid)
}

export function setMode(db: DatabaseSync, id: number, m: RunMode) {
  db.prepare('update develop_tasks set model = ?, effort = ?, ultracode = ?, chrome = ?, isolated = ? where id = ?').run(m.model, m.effort, m.ultracode, m.chrome, m.isolated, id)
}

export const getTask = (db: DatabaseSync, id: number) => db.prepare('select * from develop_tasks where id = ?').get(id) as Task | undefined
export const listTasks = (db: DatabaseSync) => db.prepare('select * from develop_tasks order by updated_at desc').all() as Task[]
export const messages = (db: DatabaseSync, id: number) => db.prepare('select * from develop_messages where task_id = ? order by at, id').all(id) as Message[]
export const turns = (db: DatabaseSync, id: number) => db.prepare('select * from develop_turns where task_id = ? order by id').all(id) as Turn[]
export const activity = (db: DatabaseSync, turnId: number, limit = 12) =>
  (db.prepare('select * from develop_activity where turn_id = ? order by at desc limit ?').all(turnId, limit) as Activity[]).reverse()

export function setStatus(db: DatabaseSync, id: number, status: TaskStatus, now = Date.now()) {
  db.prepare('update develop_tasks set status = ?, updated_at = ? where id = ?').run(status, now, id)
}

export function addMessage(db: DatabaseSync, taskId: number, who: Message['who'], text: string, now = Date.now()) {
  const r = db.prepare('insert into develop_messages (task_id, at, who, text) values (?, ?, ?, ?)').run(taskId, now, who, text)
  db.prepare('update develop_tasks set updated_at = ? where id = ?').run(now, taskId)
  return Number(r.lastInsertRowid)
}

/** Queue a Claude turn. A task never has two open turns: the caller checks `openTurn` first. */
export function queueTurn(db: DatabaseSync, taskId: number, kind: TurnKind, prompt: string, files: number[] = [], now = Date.now(), said: string | null = null) {
  db.prepare('insert into develop_turns (task_id, kind, prompt, files, created_at, said) values (?, ?, ?, ?, ?, ?)').run(taskId, kind, prompt, files.length ? JSON.stringify(files) : null, now, said)
  setStatus(db, taskId, kind === 'discuss' ? 'discussing' : 'working', now)
}

/** Claude's turn is over and it waits on its background job in a live session. */
export const takesReply = (t: Turn | undefined) => t?.status === 'running' && t.waiting === 1

/** What the reply box does (owner 2026-11-09: open for the whole turn, like a chat). reply: a new turn, with the run mode
 *  and "Duyệt và làm"; queued, live, waiting: the message joins the turn (the runner writes it into the session, claude
 *  reads it after the step it is on); cancel: the turn is stopping; closed: the task is done or cancelled. */
export type ComposeState = 'reply' | 'queued' | 'live' | 'waiting' | 'cancel' | 'closed'
export function composeState(t: Pick<Task, 'status'>, open: Turn | undefined): ComposeState {
  if (t.status === 'done' || t.status === 'cancelled') return 'closed'
  if (!open) return 'reply'
  return open.status === 'cancel' ? 'cancel' : open.status === 'queued' ? 'queued' : open.waiting ? 'waiting' : 'live'
}

// the running (or stopping) turn first: a reply queued during it must not make the page say "waiting for the runner"
// What each run-mode model choice ("fable", "" for the account default) last ran as, from claude's init event: an
// alias moves to a newer version when the CLI is updated, and the page shows the version it really is (owner 2026-11-10)
export function noteModel(db: DatabaseSync, alias: string, model: string, now = Date.now()) {
  db.prepare('insert into develop_models (alias, model, at) values (?, ?, ?) on conflict (alias) do update set model = excluded.model, at = excluded.at').run(alias, model, now)
}
export const resolvedModels = (db: DatabaseSync) =>
  new Map((db.prepare('select alias, model from develop_models').all() as { alias: string; model: string }[]).map(r => [r.alias, r.model]))

export const openTurn = (db: DatabaseSync, taskId: number) =>
  db.prepare(`select * from develop_turns where task_id = ? and status in ('queued', 'running', 'cancel') order by status = 'queued', id desc limit 1`).get(taskId) as Turn | undefined

export function requestCancel(db: DatabaseSync, taskId: number) {
  // "Dừng" stops the running turn; replies the owner sent during it stay queued and run after the stop (review
  // 2026-11-09: they were dropped without a word). With nothing running yet, the queued turns are what is stopped
  const running = db.prepare(`update develop_turns set status = 'cancel' where task_id = ? and status = 'running'`).run(taskId).changes
  if (!running) {
    const n = Number(db.prepare(`update develop_turns set status = 'cancelled' where task_id = ? and status = 'queued'`).run(taskId).changes)
    if (n > 1) addMessage(db, taskId, 'system', `Đã huỷ cả ${n - 1} tin đang chờ, Claude chưa đọc chúng.`)
  }
  // a turn cancelled before it started leaves no runner to move the task on: hand it back now
  db.prepare(`update develop_tasks set status = 'awaiting', updated_at = ? where id = ? and status in ('discussing', 'working')
    and not exists (select 1 from develop_turns where task_id = ? and status in ('running', 'cancel'))`).run(Date.now(), taskId, taskId)
}

// Images in the thread (architecture.md "Develop"). Checked by their first bytes, never by the name or type the browser sent.
export const MAX_IMAGES = 6, MAX_IMAGE_BYTES = 10 * 1024 * 1024
export function imageType(b: Buffer): string | null {
  const at = (i: number, s: string) => b.subarray(i, i + s.length).toString('latin1') === s
  if (at(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (at(0, 'GIF87a') || at(0, 'GIF89a')) return 'image/gif'
  if (at(0, 'RIFF') && at(8, 'WEBP')) return 'image/webp'
  if (at(4, 'ftyp') && ['heic', 'heix', 'hevc', 'mif1', 'msf1'].some(x => at(8, x))) return 'image/heic' // phone cameras set to HEIF
  return null
}

const run = promisify(execFile)
const SIPS = '/usr/bin/sips', LONG_SIDE = 1568, MAX_STORED = 3.5 * 1024 * 1024 // base64 of it stays under the API's 5 MB per image
/** macOS only. Without it (Ubuntu, Windows) an image is kept as it came, so only what Claude reads as it is, small enough. */
export const HAS_SIPS = process.platform === 'darwin' && existsSync(SIPS)
/** Whether saveImages keeps this upload: an image sips reads, ≤ 10 MB; without sips PNG, JPEG, WebP or GIF ≤ 3.5 MB (no HEIC). */
export function storable(b: Buffer, sips = HAS_SIPS) {
  const mime = imageType(b)
  return !!mime && (sips ? b.length <= MAX_IMAGE_BYTES : mime !== 'image/heic' && b.length <= MAX_STORED)
}
/** Stores the images of one message: each is re-encoded by macOS sips as PNG (screenshots, GIF) or JPEG (photos, WebP,
 *  HEIC), shrunk to 1568 px on its long side when larger (what Claude reads anyway; sips -Z alone would also enlarge
 *  small ones). A PNG still over 3.5 MB (a photo saved as PNG) becomes a JPEG. Without sips the bytes are kept as they are
 *  (storable). One copy serves both the thread and the turn. Anything else, or anything sips cannot read, is skipped and
 *  counted; nothing is left behind on disk. */
export async function saveImages(db: DatabaseSync, taskId: number, messageId: number, uploads: { data: Buffer }[], dir = join(DATA, 'develop-files', String(taskId)), sips = HAS_SIPS) {
  const ids: number[] = []
  let skipped = Math.max(0, uploads.length - MAX_IMAGES)
  const insert = (mime: string, path: string) => ids.push(Number(db.prepare('insert into develop_files (task_id, message_id, mime, path, bytes, at) values (?, ?, ?, ?, ?, ?)')
    .run(taskId, messageId, mime, path, statSync(path).size, Date.now()).lastInsertRowid))
  for (const u of uploads.slice(0, MAX_IMAGES)) {
    const mime = imageType(u.data)
    if (!mime || !storable(u.data, sips)) { skipped++; continue }
    mkdirSync(dir, { recursive: true })
    if (!sips) {
      const out = join(dir, `${randomUUID()}.${mime.slice(6).replace('jpeg', 'jpg')}`)
      try { writeFileSync(out, u.data); insert(mime, out) } catch { skipped++; rmSync(out, { force: true }) }
      continue
    }
    let png = mime === 'image/png' || mime === 'image/gif'
    const name = randomUUID(), tmp = join(dir, `${name}.in`)
    let out = join(dir, `${name}.${png ? 'png' : 'jpg'}`)
    try {
      writeFileSync(tmp, u.data)
      const dims = (await run(SIPS, ['-g', 'pixelWidth', '-g', 'pixelHeight', tmp])).stdout.match(/\d+/g)?.slice(-2).map(Number) ?? []
      const shrink = Math.max(...dims, 0) > LONG_SIDE ? ['-Z', String(LONG_SIDE)] : []
      await run(SIPS, [...shrink, '-s', 'format', png ? 'png' : 'jpeg', tmp, '--out', out])
      if (png && statSync(out).size > MAX_STORED) {
        const jpg = join(dir, `${name}.jpg`)
        await run(SIPS, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '80', out, '--out', jpg])
        rmSync(out, { force: true }); out = jpg; png = false
      }
      insert(png ? 'image/png' : 'image/jpeg', out)
    } catch { skipped++; rmSync(out, { force: true }) }
    finally { rmSync(tmp, { force: true }) }
  }
  return { ids, skipped }
}

export const getFile = (db: DatabaseSync, id: number) => db.prepare('select * from develop_files where id = ?').get(id) as DevFile | undefined
export const taskFiles = (db: DatabaseSync, taskId: number) => db.prepare('select * from develop_files where task_id = ? order by id').all(taskId) as DevFile[]

