// Thông báo (architecture.md "Thông báo", owner 2026-11-09: N1, N2, Web Push). Anything records a notification with lib/notify.ts:
// the Develop runner, the scheduler ("Gấp" alerts, a collector failing twice in a row), modules. This module lists them
// (the bell in the top bar opens /ops/notify), keeps the devices that turned push on (notify_subs, one row per device)
// and delivers: every few seconds what is new goes to every device; 23:00 to 07:00 only "Gấp" is pushed, the rest
// stays in the list. Push needs push.js on the page and the hub's service worker (/sw.js, served by the core).
import { createECDH, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { ago, board, clock, cut, empty, esc, pill, section } from '../../core/html.ts'
import { log } from '../../core/log.ts'
import type { Module, Req, Res, View } from '../../core/types.ts'
import { bell, dayBefore, getNote, hubPath, initNotify, listNotes, markRead, putBack, quietHours, setPush, stuck, takeUnsent, unread, type NoteRow } from '../../lib/notify.ts'
import { sendPush, vapidKeys, type Vapid } from '../../lib/webpush.ts'

const PAGE = '/ops/notify', EVERY_MS = 5_000
const MAX_AGE = 6 * 3_600_000 // recorded longer ago than this when the hub gets to it (it was down): listed, not pushed
const RETRIES = 3 // a push no device took, all failures transient: tried again 1, 2 then 4 min later
// the push services of Chrome (also on Samsung phones), Firefox, Edge and Safari. The hub POSTs to whatever endpoint a
// browser gives it, so only these: a new browser whose host is refused says so on the page, add the host here
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com']

export type Device = { id: number; name: string; endpoint: string; p256dh: string; auth: string; created_at: number; ok_at: number | null; fails: number; error: string | null }

export function initDevices(db: DatabaseSync) {
  db.exec(`create table if not exists notify_subs (id integer primary key, name text not null unique, endpoint text not null unique,
    p256dh text not null, auth text not null, created_at integer not null, ok_at integer, fails integer not null default 0, error text)`)
}
export const devices = (db: DatabaseSync) => db.prepare('select * from notify_subs order by created_at').all() as Device[]

/** Why a subscription a browser posted is refused, or '' when it is fine. It is a trust boundary: the hub will POST to it. */
export function checkSub(endpoint: string, p256dh: string, auth: string) {
  let u: URL
  try { u = new URL(endpoint) } catch { return 'địa chỉ đẩy không hợp lệ.' }
  if (u.protocol !== 'https:' || endpoint.length > 1000 || u.username || u.port) return 'địa chỉ đẩy không hợp lệ.'
  if (!PUSH_HOSTS.some(h => u.hostname === h || u.hostname.endsWith(`.${h}`))) return `hub chưa nhận dịch vụ đẩy ${cut(u.hostname, 60)}.`
  const b64 = /^[A-Za-z0-9_-]+$/
  if (!b64.test(auth) || Buffer.from(auth, 'base64url').length !== 16) return 'khoá của trình duyệt không hợp lệ.'
  if (!b64.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65) return 'khoá của trình duyệt không hợp lệ.'
  try { const e = createECDH('prime256v1'); e.generateKeys(); e.computeSecret(Buffer.from(p256dh, 'base64url')) } catch { return 'khoá của trình duyệt không hợp lệ.' }
  return ''
}

/** One row per device: the same device subscribing again (a new browser profile, permission reset) replaces its row. */
export function saveDevice(db: DatabaseSync, d: Pick<Device, 'name' | 'endpoint' | 'p256dh' | 'auth'>, now = Date.now()) {
  // the page posts the browser's subscription on every visit: the same one only refreshes its keys, the counts stay
  if (db.prepare('update notify_subs set p256dh = ?, auth = ? where name = ? and endpoint = ?').run(d.p256dh, d.auth, d.name, d.endpoint).changes) return
  db.prepare('delete from notify_subs where name = ? or endpoint = ?').run(d.name, d.endpoint)
  db.prepare('insert into notify_subs (name, endpoint, p256dh, auth, created_at) values (?, ?, ?, ?, ?)').run(d.name, d.endpoint, d.p256dh, d.auth, now)
}

/** Pushes to one device and records how it went: 'ok', 'retry' (network error, 429, 5xx: may work later) or 'fail'.
 *  404/410: the browser dropped the subscription, so the hub does too. */
export async function pushTo(db: DatabaseSync, d: Device, payload: unknown, v: Vapid, now = Date.now()): Promise<'ok' | 'retry' | 'fail'> {
  let status = 0, err = ''
  try { status = await sendPush(d, payload, v) } catch (e) { err = cut(String((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message), 120) }
  if (status >= 200 && status < 300) {
    db.prepare('update notify_subs set ok_at = ?, fails = 0, error = null where id = ?').run(now, d.id)
    return 'ok'
  }
  if (status === 404 || status === 410) {
    db.prepare('delete from notify_subs where id = ?').run(d.id)
    log('info', 'push device gone', { device: d.name, status })
    return 'fail'
  }
  db.prepare('update notify_subs set fails = fails + 1, error = ? where id = ?').run(err || `HTTP ${status}`, d.id)
  log('warn', 'push failed', { device: d.name, host: new URL(d.endpoint).host, status, err }) // the host only: an endpoint is a capability
  return !status || status === 429 || status >= 500 ? 'retry' : 'fail'
}

// a tap opens /ops/notify/go/<id>: marked read, then on to the page it is about. tag: one per page on the device
const payload = (n: NoteRow) => ({ title: n.title, body: n.body, url: `${PAGE}/go/${n.id}`, tag: n.url })

/** Gives a taken notification back for another try 60 s × 2^tries later: at most RETRIES times, never past MAX_AGE. */
function retry(db: DatabaseSync, n: NoteRow, now: number) {
  const at = now + 60_000 * 2 ** n.tries
  if (n.tries >= RETRIES || at - n.created_at > MAX_AGE) return false
  putBack(db, n.id, at)
  return true
}

/** One delivery pass: every notification not handled yet goes to every device, or is listed only (quiet hours, too old,
 *  no device, a newer one for the same page in this pass). */
export async function deliver(db: DatabaseSync, v: () => Vapid, now = Date.now()) {
  const vk = v() // before anything is taken: a key file that cannot be read leaves every notification waiting, not lost
  const go: NoteRow[] = []
  for (const n of takeUnsent(db, now)) {
    if (now - n.created_at > MAX_AGE) setPush(db, n.id, 'old')
    // "Gấp" rings in quiet hours only the night it is new: one still active is a new row after 00:00 (a new day)
    else if (quietHours(now) && (n.tone !== 'bad' || dayBefore(db, n.key, n.day))) setPush(db, n.id, 'quiet')
    else go.push(n)
  }
  // one ring per page: an approved turn ending right on its job's report pushes only the newer
  const newest = new Map(go.map(n => [n.url, n.id]))
  for (const n of go) {
    if (newest.get(n.url) !== n.id) { setPush(db, n.id, 'merged'); continue }
    const ds = devices(db) // fresh each time: a push may have dropped a device
    let ok = 0, transient = ds.length > 0
    for (const d of ds) { const r = await pushTo(db, d, payload(n), vk, now); if (r === 'ok') ok++; else if (r === 'fail') transient = false }
    if (!ok && transient && retry(db, n, now)) continue
    setPush(db, n.id, ds.length ? 'sent' : 'none', ok)
  }
}

/** At hub start: what a delivery took over 2 min ago and never finished (the hub died halfway) goes back like a
 *  transient failure, or is 'old' past MAX_AGE ('sent' to no device when its tries are used up). */
export function recover(db: DatabaseSync, now = Date.now()) {
  for (const n of stuck(db, now - 120_000)) if (!retry(db, n, now)) setPush(db, n.id, n.tries >= RETRIES ? 'sent' : 'old')
}

let lastErr = ''
/** One turn of the delivery loop. A failure is logged when its message changes, not every 5 s. */
export const pass = (db: DatabaseSync, v: () => Vapid) => deliver(db, v).then(() => { lastErr = '' }, e => {
  const err = (e as Error).message
  if (err !== lastErr) log('warn', 'push delivery failed', { err })
  lastErr = err
})

let keys: Vapid | undefined
const vapid = () => keys ??= vapidKeys() // made on first use, into data/vapid.json

const PUSH_NOTE: Record<string, string> = { quiet: 'giờ yên lặng, không đẩy', none: 'chưa có máy nào bật thông báo', old: 'hub nhận muộn, không đẩy',
  merged: 'gộp vào thông báo sau' }
const pushText = (n: NoteRow) => n.push === 'sent' ? (n.pushed ? `đã đẩy tới ${n.pushed} máy` : 'không đẩy tới được máy nào') : n.push ? PUSH_NOTE[n.push] : 'đang gửi'
// the chip carries "Gấp", so the list drops it from the title (the push needs it there, on a lock screen)
const TONE_CHIP = { bad: pill('bad', 'Gấp'), warn: pill('warn', 'Cần xem'), info: '' }

function itemList(rows: NoteRow[]) {
  if (!rows.length) return empty('Chưa có thông báo nào.')
  return `<ul class="list">${rows.map(n => `<li${n.read_at ? '' : ' class="notify-new"'}>
    <div class="row">${n.read_at ? '' : pill('info', 'Mới')}${TONE_CHIP[n.tone] ?? ''}<a href="${esc(hubPath(n.url))}"><b>${esc(n.tone === 'bad' ? n.title.replace(/^Gấp: /, '') : n.title)}</b></a></div>
    ${n.body ? `<div class="sub">${esc(n.body)}</div>` : ''}<div class="sub muted"><span>${esc(clock(n.created_at))}</span>, <span>${esc(pushText(n))}</span></div></li>`).join('')}</ul>`
}

function deviceList(ds: Device[], now: number) {
  if (!ds.length) return empty('Chưa có máy nào bật thông báo.')
  return `<ul class="list">${ds.map(d => `<li><b>${esc(d.name)}</b>
    <div class="sub muted"><span>bật ${esc(clock(d.created_at))}</span>, <span>${d.ok_at ? `đẩy được lần cuối ${esc(ago(d.ok_at, now))}` : 'chưa đẩy lần nào'}</span></div>
    ${d.fails ? `<div class="sub warn-t">Đẩy lỗi ${d.fails} lần liền: ${esc(d.error ?? '')}</div>` : ''}</li>`).join('')}</ul>`
}

const SCRIPT = readFileSync(join(import.meta.dirname, 'push.js'))
const scriptTag = `<script src="${PAGE}/push.js?v=${createHash('sha256').update(SCRIPT).digest('hex').slice(0, 12)}" defer></script>`

function page(v: View) {
  const rows = listNotes(v.db), ds = devices(v.db), n = unread(v.db)
  const push = `<div class="notify-push" data-key="${esc(vapid().publicKey)}" data-csrf="${esc(v.csrf)}">
    <p data-say role="status">Cần JavaScript để bật thông báo trên máy này.</p>
    <div class="inline" data-acts hidden><button type="button" data-act="on">Bật thông báo trên máy này</button><button type="button" class="ghost" data-act="test" hidden>Gửi thử tới máy này</button></div>
    </div>
    <p class="sub muted">Mỗi máy bấm bật một lần. 23:00 đến 07:00 chỉ đẩy việc Gấp; mọi thông báo vẫn nằm trong danh sách.</p>
    <p class="sub muted">Báo khi: Claude trả lời hoặc hỏi lại, “Duyệt và làm” xong, việc chạy nền xong, lượt lỗi; cảnh báo Gấp; nguồn lỗi hai lần liền. Mỗi việc một lần một ngày.</p>
    <h3>Máy đã bật</h3>${deviceList(ds, v.now)}`
  // the button first: on a phone it would sit under up to 100 notifications
  const body = board(section('Thông báo đẩy', push, ds.length ? `${ds.length} máy` : '', 'push')
    + section('Đã báo', itemList(rows), n ? `${n} chưa đọc` : '', 'list', { cls: 'notify-items' })) + scriptTag
  if (rows.length) markRead(v.db, rows[0].id, { now: v.now }) // seen now; this page still showed them as new
  return body
}

const intParam = (req: Req) => { const n = Number(req.params.id); return Number.isInteger(n) && n > 0 ? n : 0 }
// the device the request came from (core/access.ts, by tailnet IP); 'local' is a browser on the hub's own machine at 127.0.0.1
const deviceName = (req: Req) => !req.who || req.who === 'local' ? `${hostname()} (127.0.0.1)` : req.who

const CSS = `
.notify-items .list > li.notify-new { box-shadow: inset 3px 0 0 var(--accent); padding-left: var(--space-sm); border-radius: 0 }
.notify-push { display: grid; gap: var(--space-sm) }
.notify-push [hidden] { display: none }
/* beside the push panel: one column of two on a tablet, two of three from 80rem */
@media (min-width: 80rem) { .board > .notify-items { grid-column: span 2 } }
`

export const notifyModule: Module = {
  id: 'notify', title: 'Thông báo', group: 'ops',
  css: CSS,
  init(db) { initNotify(db); initDevices(db); bell.href = PAGE },
  // serve mode, not paused: a preview (HUB_PAUSE=*) lists notifications but never pushes
  start(db) {
    recover(db)
    let busy = false
    setInterval(() => {
      if (busy) return
      busy = true
      void pass(db, vapid).finally(() => { busy = false })
    }, EVERY_MS).unref()
  },
  routes: [
    { method: 'GET', path: PAGE, handle: (_req, v): Res => ({ title: 'Thông báo', body: page(v), noRefresh: true }) },
    { method: 'GET', path: `${PAGE}/push.js`, handle: (): Res => ({ file: SCRIPT, type: 'text/javascript; charset=utf-8' }) },
    { method: 'POST', path: `${PAGE}/subscribe`, handle: (req, v): Res => {
      const [endpoint, p256dh, auth] = ['endpoint', 'p256dh', 'auth'].map(k => (req.form.get(k) ?? '').trim())
      const why = checkSub(endpoint, p256dh, auth)
      if (why) return { json: { ok: false, why } }
      saveDevice(v.db, { name: deviceName(req), endpoint, p256dh, auth })
      return { json: { ok: true, why: '' } }
    } },
    { method: 'POST', path: `${PAGE}/test`, handle: async (req, v): Promise<Res> => {
      const d = devices(v.db).find(x => x.endpoint === req.form.get('endpoint'))
      if (!d) return { json: { ok: false, why: 'hub không có máy này, bấm Bật thông báo lại.' } }
      const ok = await pushTo(v.db, d, { title: 'Thử thông báo', body: `${d.name} nhận được thông báo của hub.`, url: PAGE, tag: 'test' }, vapid()) === 'ok'
      const after = devices(v.db).find(x => x.id === d.id)
      return { json: { ok, why: ok ? '' : after ? `dịch vụ đẩy trả ${after.error}.` : 'trình duyệt đã bỏ đăng ký này, bấm Bật thông báo lại.' } }
    } },
    { method: 'GET', path: `${PAGE}/go/:id`, handle: (req, v): Res => {
      const n = getNote(v.db, intParam(req))
      if (!n) return { redirect: PAGE }
      markRead(v.db, n.id, { only: true })
      return { redirect: hubPath(n.url) }
    } },
  ],
}
