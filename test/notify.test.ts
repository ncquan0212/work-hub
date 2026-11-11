// Notifications and Web Push (architecture.md "Thông báo"): RFC 8291's own test vector, VAPID checked the way a push service
// checks it, delivery to a fake push endpoint on 127.0.0.1 that decrypts what it gets (nothing goes to a real push
// service), quiet hours, the page and its routes, and what the scheduler records.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify, type ECDH } from 'node:crypto'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, mock, test } from 'node:test'

// before anything reads config.ts: the page makes data/vapid.json on first use, and this must never be the real data/
const DIR = mkdtempSync(join(tmpdir(), 'hub-notify-'))
process.env.HUB_DATA = DIR
after(() => rmSync(DIR, { recursive: true, force: true }))
const { openDb } = await import('../src/core/db.ts')
const { layout } = await import('../src/core/layout.ts')
const { Scheduler } = await import('../src/core/scheduler.ts')
const { bell, hubPath, listNotes, notify, noteDay, quietHours, takeUnsent, unread } = await import('../src/lib/notify.ts')
const { encrypt, vapidAuth, vapidKeys, vapidSubject } = await import('../src/lib/webpush.ts')
const { ACCESS } = await import('../src/config.ts')
const { checkSub, deliver, devices, notifyModule, pass, recover, saveDevice } = await import('../src/modules/notify/index.ts')
type Module = import('../src/core/types.ts').Module
type Req = import('../src/core/types.ts').Req
type View = import('../src/core/types.ts').View

const u = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'base64url')
const hk = (ikm: Buffer, salt: Buffer, info: string | Buffer, n: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, n))

/** The browser's side of RFC 8291, written separately from lib/webpush.ts: what a subscriber does with a push body. */
function decrypt(body: Buffer, ua: ECDH, auth: Buffer) {
  assert.equal(body.readUInt32BE(16), 4096, 'record size')
  const salt = body.subarray(0, 16), as = body.subarray(21, 21 + body[20]), ct = body.subarray(21 + body[20])
  const ikm = hk(ua.computeSecret(as), auth, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), as]), 32)
  const d = createDecipheriv('aes-128-gcm', hk(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hk(ikm, salt, 'Content-Encoding: nonce\0', 12))
  d.setAuthTag(ct.subarray(-16))
  const pt = Buffer.concat([d.update(ct.subarray(0, -16)), d.final()])
  let i = pt.length - 1
  while (i >= 0 && pt[i] === 0) i--
  assert.equal(pt[i], 2, 'one record, ended by the 0x02 delimiter')
  return pt.subarray(0, i)
}

/** What a push service checks (RFC 8292): the JWT signed by the key in k=, for its own origin, not expired. Returns k. */
function checkVapid(header: string, origin: string) {
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(header)
  assert.ok(m, header.slice(0, 40))
  const pub = u(m[4])
  const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' })
  assert.ok(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, u(m[3])), 'ES256 signature')
  assert.deepEqual(JSON.parse(u(m[1]).toString()), { typ: 'JWT', alg: 'ES256' })
  const c = JSON.parse(u(m[2]).toString()), now = Date.now() / 1000
  assert.equal(c.aud, origin); assert.equal(c.sub, `https://${ACCESS.tailnetHost}`) // the fixture's host (test/test.env)
  assert.ok(c.exp > now && c.exp <= now + 24 * 3600, 'expires within 24 h')
  return m[4]
}

const subscriber = (endpoint: string) => {
  const ua = createECDH('prime256v1'); ua.generateKeys()
  const auth = randomBytes(16)
  return { ua, auth, sub: { endpoint, p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } }
}
const req = (o: Partial<Req> = {}) => ({ method: 'GET', path: '', params: {}, query: new URLSearchParams(), form: new URLSearchParams(), files: [], ...o }) as Req
const view = (db: import('node:sqlite').DatabaseSync) => ({ now: Date.now(), db, csrf: 'tok', slot: () => undefined }) as unknown as View
const route = (method: string, path: string) => notifyModule.routes!.find(r => r.method === method && r.path === path)!
// 12:00 and 23:30 in Vietnam (UTC+7)
const NOON = Date.UTC(2026, 10, 9, 5), NIGHT = Date.UTC(2026, 10, 9, 16, 30)

test('RFC 8291 Appendix A: same bytes as the RFC, and the receiver gets the plaintext back', () => {
  const plain = u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24')
  const out = encrypt(plain, 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', 'BTBZMqHH6r4Tts7J_aSIgg',
    { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), serverKey: u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') })
  assert.equal(out.toString('base64url'), `DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
    mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
    pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`.replace(/\s/g, ''))
  const ua = createECDH('prime256v1'); ua.setPrivateKey(u('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'))
  assert.equal(decrypt(out, ua, u('BTBZMqHH6r4Tts7J_aSIgg')).toString(), 'When I grow up, I want to be a watermelon')
  // random salt and key otherwise: two pushes of the same text never look alike
  const { ua: ua2, auth, sub } = subscriber('https://x')
  const a = encrypt(Buffer.from('xin chào'), sub.p256dh, sub.auth), b = encrypt(Buffer.from('xin chào'), sub.p256dh, sub.auth)
  assert.notDeepEqual(a, b); assert.equal(decrypt(a, ua2, auth).toString(), 'xin chào')
  assert.throws(() => encrypt(Buffer.alloc(4000), sub.p256dh, sub.auth), /too large/)
})

test('VAPID: one key pair made once, mode 600; the JWT verifies with the public key, for the endpoint origin', () => {
  const file = join(DIR, 'vapid-test.json'), v = vapidKeys(file)
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(vapidKeys(file).publicKey, v.publicKey, 'read back, not made again')
  assert.equal(u(v.publicKey).length, 65); assert.equal(u(v.publicKey)[0], 4)
  assert.equal(checkVapid(vapidAuth('https://fcm.googleapis.com/fcm/send/abc', v), 'https://fcm.googleapis.com'), v.publicKey)
  // a copy with no tailnet host (local only) still sends a well-formed contact, never "https://"
  assert.match(vapidSubject(''), /^mailto:[^@\s]+@[^@\s]+\.[a-z]+$/)
})

test('a damaged vapid.json: a fixed message that never quotes the file, logged once however often delivery tries', async () => {
  const file = join(DIR, 'vapid-damaged.json'), damaged = 'data/vapid.json hỏng: sửa tay hoặc xoá, rồi mọi máy bật lại thông báo'
  for (const text of ['{"d":"SECRETKEYMATERIAL"x', '"SECRETKEYMATERIAL"' /* JSON, but not a key: createPrivateKey would quote it */]) {
    writeFileSync(file, text)
    assert.throws(() => vapidKeys(file), (e: Error) => e.message === damaged && !e.cause)
  }
  const logs = mock.method(console, 'log', () => {})
  try {
    const db = openDb(':memory:'); notifyModule.init!(db)
    const broken = () => vapidKeys(file)
    await pass(db, broken); await pass(db, broken)
    await pass(db, () => { throw new Error('khác') })
    assert.deepEqual(logs.mock.calls.map(c => JSON.parse(c.arguments[0]).err), [damaged, 'khác'])
  } finally { logs.mock.restore() }
})

test('quiet hours, the day of a key, hub paths, once per key per day', () => {
  const vn = (h: number, m = 0) => Date.UTC(2026, 10, 9, h - 7, m)
  assert.deepEqual([vn(22, 59), vn(23), vn(30, 59) /* 06:59 next day */, vn(31) /* 07:00 */].map(quietHours), [false, true, true, false])
  assert.equal(noteDay(Date.UTC(2026, 10, 9, 16, 59)), '2026-11-09'); assert.equal(noteDay(Date.UTC(2026, 10, 9, 17)), '2026-11-10')
  assert.deepEqual(['/develop/task/9#latest', '//evil.example', '/\\evil.example', 'https://evil.example', '/\t/evil.example', '/\n/evil.example', '/a\x00'].map(hubPath),
    ['/develop/task/9#latest', '/', '/', '/', '/', '/', '/'], 'a browser drops tabs and newlines: "/\t/x" is "//x"')
  const db = openDb(':memory:')
  const n = { key: 'k', title: 't', body: 'b', url: '//evil.example' }
  assert.equal(typeof notify(db, n, NOON), 'number')
  assert.equal(notify(db, n, NOON + 3_600_000), null, 'same Vietnam day')
  assert.equal(typeof notify(db, n, NOON + 86_400_000), 'number', 'next day')
  assert.equal(listNotes(db)[0].url, '/')
})

test('a table made by the first version gets the delivery columns', () => {
  const db = openDb(':memory:')
  db.exec(`create table notify_items (id integer primary key, key text not null, day text not null, title text not null, body text not null,
    url text not null, tone text not null default 'info', created_at integer not null, sent_at integer, read_at integer, unique (key, day))`)
  notify(db, { key: 'k', title: 't', body: '', url: '/' }, NOON)
  assert.deepEqual(takeUnsent(db, NOON).map(n => [n.key, n.push, n.pushed, n.tries, n.next_at]), [['k', null, 0, 0, null]])
})

test('subscriptions: only real push services and well-formed keys; one row per device', () => {
  const { sub } = subscriber('https://fcm.googleapis.com/fcm/send/abc:def')
  assert.equal(checkSub(sub.endpoint, sub.p256dh, sub.auth), '')
  assert.equal(checkSub('https://updates.push.services.mozilla.com/wpush/v2/x', sub.p256dh, sub.auth), '')
  assert.match(checkSub('http://fcm.googleapis.com/x', sub.p256dh, sub.auth), /không hợp lệ/)
  assert.match(checkSub('https://127.0.0.1/x', sub.p256dh, sub.auth), /chưa nhận dịch vụ đẩy 127\.0\.0\.1/)
  assert.match(checkSub('https://evilfcm.googleapis.com.evil.example/x', sub.p256dh, sub.auth), /chưa nhận/)
  assert.match(checkSub('https://fcm.googleapis.com:8443/x', sub.p256dh, sub.auth), /không hợp lệ/)
  assert.match(checkSub(sub.endpoint, sub.p256dh, 'AAAA'), /khoá/)
  assert.match(checkSub(sub.endpoint, Buffer.alloc(65, 4).toString('base64url'), sub.auth), /khoá/, 'not a point on the curve')
  const db = openDb(':memory:'); notifyModule.init!(db)
  saveDevice(db, { name: 'Z Fold6', ...sub }, 1)
  db.prepare('update notify_subs set ok_at = 5, fails = 2').run()
  saveDevice(db, { name: 'Z Fold6', ...sub }, 2)
  assert.deepEqual(devices(db).map(d => [d.name, d.created_at, d.ok_at, d.fails]), [['Z Fold6', 1, 5, 2]], 'the same subscription again keeps its counts')
  saveDevice(db, { name: 'Z Fold6', ...sub, endpoint: sub.endpoint + 'x' }, 3)
  saveDevice(db, { name: 'Tab S9', ...subscriber('https://fcm.googleapis.com/y').sub }, 4)
  assert.deepEqual(devices(db).map(d => [d.name, d.created_at]), [['Z Fold6', 3], ['Tab S9', 4]], 'a new subscription replaces the device\'s old one')
})

/** A push service on 127.0.0.1: 410 for /gone, 500 for /bad, 403 for /deny, else 201. */
async function fakePush() {
  const got: { path: string; headers: Record<string, any>; body: Buffer }[] = []
  const server = createServer((r, res) => {
    const chunks: Buffer[] = []
    r.on('data', c => chunks.push(c)).on('end', () => {
      got.push({ path: r.url!, headers: r.headers, body: Buffer.concat(chunks) })
      res.writeHead(r.url!.startsWith('/gone') ? 410 : r.url!.startsWith('/bad') ? 500 : r.url!.startsWith('/deny') ? 403 : 201).end()
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  return { got, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() }
}

test('delivery to a fake push endpoint: decrypted payload, VAPID, gone devices dropped, quiet hours, no device, never twice', async () => {
  const got: { path: string; headers: Record<string, any>; body: Buffer }[] = []
  const server = createServer((r, res) => {
    const chunks: Buffer[] = []
    r.on('data', c => chunks.push(c)).on('end', () => {
      got.push({ path: r.url!, headers: r.headers, body: Buffer.concat(chunks) })
      res.writeHead(r.url!.startsWith('/gone') ? 410 : r.url!.startsWith('/bad') ? 500 : 201).end()
    })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const db = openDb(':memory:'); notifyModule.init!(db)
    const v = vapidKeys(join(DIR, 'vapid-deliver.json'))
    const ok = subscriber(`${origin}/ok/1`), gone = subscriber(`${origin}/gone/2`)
    saveDevice(db, { name: 'Z Fold6', ...ok.sub }); saveDevice(db, { name: 'Tab S9', ...gone.sub })

    notify(db, { key: 'a', title: 'Claude trả lời: #9 Thêm <nút>', body: 'Đã xong phân tích.', url: '/develop/task/9#latest' }, NOON)
    await deliver(db, () => v, NOON + 1000)
    assert.deepEqual(got.map(g => g.path), ['/ok/1', '/gone/2'])
    const first = got[0]
    assert.equal(checkVapid(first.headers.authorization, origin), v.publicKey)
    assert.equal(first.headers['content-encoding'], 'aes128gcm'); assert.equal(first.headers.ttl, '21600'); assert.equal(first.headers.urgency, 'high')
    const id = listNotes(db)[0].id
    assert.deepEqual(JSON.parse(decrypt(first.body, ok.ua, ok.auth).toString()),
      { title: 'Claude trả lời: #9 Thêm <nút>', body: 'Đã xong phân tích.', url: `/ops/notify/go/${id}`, tag: '/develop/task/9#latest' })
    assert.deepEqual(devices(db).map(d => d.name), ['Z Fold6'], '410: the browser dropped it, so does the hub')
    assert.ok(devices(db)[0].ok_at)
    assert.deepEqual([listNotes(db)[0].push, listNotes(db)[0].pushed], ['sent', 1])

    // nothing new: nothing sent, however often the loop runs
    await deliver(db, () => v, NOON + 2000); assert.equal(got.length, 2)

    // 23:30: only "Gấp" rings; the rest stays in the list
    notify(db, { key: 'b', title: 'Claude trả lời', body: '', url: '/develop' }, NIGHT)
    notify(db, { key: 'c', title: 'Gấp: XRemote', body: 'doanh thu ads thấp hơn MA7 35%', url: '/report/app/xremote', tone: 'bad' }, NIGHT)
    await deliver(db, () => v, NIGHT + 1000)
    assert.equal(got.length, 3); assert.equal(JSON.parse(decrypt(got[2].body, ok.ua, ok.auth).toString()).title, 'Gấp: XRemote')
    assert.deepEqual(listNotes(db).slice(0, 2).map(n => [n.key, n.push, n.pushed]), [['c', 'sent', 1], ['b', 'quiet', 0]])

    // the hub was down for hours: listed, not pushed late. A failing push service is counted on the device
    notify(db, { key: 'd', title: 'cũ', body: '', url: '/' }, NOON)
    await deliver(db, () => v, NOON + 7 * 3_600_000)
    assert.equal(listNotes(db)[0].push, 'old'); assert.equal(got.length, 3)
    db.prepare('update notify_subs set endpoint = ?').run(`${origin}/bad/1`)
    notify(db, { key: 'e', title: 'e', body: '', url: '/' }, NOON)
    await deliver(db, () => v, NOON + 1000)
    assert.deepEqual([devices(db)[0].fails, devices(db)[0].error, listNotes(db)[0].pushed], [1, 'HTTP 500', 0])
    db.prepare('delete from notify_subs').run()
    notify(db, { key: 'f', title: 'f', body: '', url: '/' }, NOON)
    await deliver(db, () => v, NOON + 1000)
    assert.equal(listNotes(db)[0].push, 'none')

    // "Gửi thử tới máy này": straight to that device, now
    saveDevice(db, { name: 'MacBook Pro', ...ok.sub })
    const tested = await route('POST', '/ops/notify/test').handle(req({ method: 'POST', form: new URLSearchParams({ endpoint: ok.sub.endpoint }) }), view(db))
    assert.deepEqual(tested, { json: { ok: true, why: '' } })
    assert.deepEqual(JSON.parse(decrypt(got.at(-1)!.body, ok.ua, ok.auth).toString()), { title: 'Thử thông báo', body: 'MacBook Pro nhận được thông báo của hub.', url: '/ops/notify', tag: 'test' })
    assert.deepEqual(await route('POST', '/ops/notify/test').handle(req({ method: 'POST', form: new URLSearchParams({ endpoint: 'x' }) }), view(db)),
      { json: { ok: false, why: 'hub không có máy này, bấm Bật thông báo lại.' } })
  } finally { server.close() }
})

test('quiet hours: "Gấp" rings the night it is new, not again each night it is still there', async () => {
  const p = await fakePush()
  try {
    const db = openDb(':memory:'); notifyModule.init!(db)
    const v = vapidKeys(join(DIR, 'vapid-deliver.json')), ok = subscriber(`${p.origin}/ok/1`)
    saveDevice(db, { name: 'Z Fold6', ...ok.sub })
    const AFTER_MIDNIGHT = Date.UTC(2026, 10, 9, 17, 30) // 00:30 on 10/11 in Vietnam
    const gap = (key: string, t: number) => notify(db, { key, title: 'Gấp: XRemote', body: key, url: `/report/${key}`, tone: 'bad' }, t)
    gap('still', NOON); await deliver(db, () => v, NOON + 1000)
    gap('still', AFTER_MIDNIGHT); gap('new', AFTER_MIDNIGHT)
    await deliver(db, () => v, AFTER_MIDNIGHT + 1000)
    assert.deepEqual(listNotes(db).map(n => [n.key, n.day, n.push]), [['new', '2026-11-10', 'sent'], ['still', '2026-11-10', 'quiet'], ['still', '2026-11-09', 'sent']])
    assert.deepEqual(p.got.map(g => JSON.parse(decrypt(g.body, ok.ua, ok.auth).toString()).body), ['still', 'new'])
  } finally { p.close() }
})

test('delivery retries what failed only transiently, at most 3 times, and takes back what a dead pass left', async () => {
  const p = await fakePush()
  try {
    const db = openDb(':memory:'); notifyModule.init!(db)
    const v = vapidKeys(join(DIR, 'vapid-deliver.json')), ok = subscriber(`${p.origin}/ok/1`)
    saveDevice(db, { name: 'Z Fold6', ...ok.sub, endpoint: `${p.origin}/bad/1` })
    const row = () => { const n = listNotes(db)[0]; return [n.sent_at === null, n.tries, n.next_at, n.push, n.pushed] }
    const at = NOON + 1000
    notify(db, { key: 'r', title: 'r', body: '', url: '/r' }, NOON)
    await deliver(db, () => v, at)
    assert.deepEqual(row(), [true, 1, at + 60_000, null, 0], '500: back for another try in a minute')
    await deliver(db, () => v, at + 59_000); assert.equal(p.got.length, 1, 'not due yet')
    await deliver(db, () => v, at + 60_000)
    assert.deepEqual(row(), [true, 2, at + 180_000, null, 0], 'then two minutes later')
    db.prepare('update notify_subs set endpoint = ?').run(ok.sub.endpoint)
    await deliver(db, () => v, at + 180_000)
    assert.deepEqual(row().slice(3), ['sent', 1]); assert.equal(p.got.length, 3)

    // a network error is transient too; after 3 tries it is finished as before
    db.prepare('update notify_subs set endpoint = ?').run('http://127.0.0.1:1/x')
    notify(db, { key: 's', title: 's', body: '', url: '/s' }, NOON)
    for (const t of [0, 60_000, 180_000, 420_000]) await deliver(db, () => v, at + t)
    assert.deepEqual(row(), [false, 3, at + 420_000, 'sent', 0])
    // not transient (403), or the next try would be past 6 h: finished at once
    db.prepare('update notify_subs set endpoint = ?').run(`${p.origin}/deny/1`)
    notify(db, { key: 't', title: 't', body: '', url: '/t' }, NOON)
    await deliver(db, () => v, at); assert.deepEqual(row(), [false, 0, null, 'sent', 0])
    db.prepare('update notify_subs set endpoint = ?').run(`${p.origin}/bad/1`)
    notify(db, { key: 'w', title: 'w', body: '', url: '/w' }, NOON)
    await deliver(db, () => v, NOON + 6 * 3_600_000 - 30_000); assert.deepEqual(row(), [false, 0, null, 'sent', 0])

    // at hub start: taken over 2 min ago and never finished goes back (or is old); a pass still running keeps its own
    const id = (key: string) => notify(db, { key, title: key, body: '', url: '/' }, NOON)!
    const dead = id('dead'), running = id('running'), late = id('late')
    db.prepare('update notify_items set sent_at = ? where id in (?, ?)').run(NOON + 1000, dead, late)
    db.prepare('update notify_items set created_at = ? where id = ?').run(NOON - 6 * 3_600_000, late)
    db.prepare('update notify_items set sent_at = ? where id = ?').run(NOON + 100_000, running)
    recover(db, NOON + 180_000)
    const st = (i: number) => { const n = listNotes(db).find(x => x.id === i)!; return [n.sent_at, n.tries, n.next_at, n.push] }
    assert.deepEqual([st(dead), st(running), st(late)], [[null, 1, NOON + 240_000, null], [NOON + 100_000, 0, null, null], [NOON + 1000, 0, null, 'old']])
  } finally { p.close() }
})

test('one pass, one ring per page: the older notification for the same url is merged into the newer', async () => {
  const p = await fakePush()
  try {
    const db = openDb(':memory:'); notifyModule.init!(db)
    const v = vapidKeys(join(DIR, 'vapid-deliver.json')), ok = subscriber(`${p.origin}/ok/1`)
    saveDevice(db, { name: 'Z Fold6', ...ok.sub })
    notify(db, { key: 'develop:turn:9:end', title: '“Duyệt và làm” xong', body: '', url: '/develop/task/9#latest' }, NOON)
    notify(db, { key: 'develop:turn:9:job:1', title: 'Việc chạy nền xong', body: '', url: '/develop/task/9#latest' }, NOON)
    notify(db, { key: 'other', title: 'Khác', body: '', url: '/report' }, NOON)
    await deliver(db, () => v, NOON + 1000)
    assert.deepEqual(p.got.map(g => JSON.parse(decrypt(g.body, ok.ua, ok.auth).toString()).title), ['Việc chạy nền xong', 'Khác'])
    assert.deepEqual(listNotes(db).map(n => n.push), ['sent', 'sent', 'merged'])
    const page = (await route('GET', '/ops/notify').handle(req(), view(db)) as { body: string }).body
    assert.match(page, /“Duyệt và làm” xong<\/b><\/a><\/div>[^]*?gộp vào thông báo sau/)
  } finally { p.close() }
})

test('page and routes: escaped list, read once seen, bell count, subscribe by device, a tap marks one read', async () => {
  const db = openDb(':memory:'); notifyModule.init!(db)
  assert.equal(bell.href, '/ops/notify', 'the module turns the bell on')
  const a = notify(db, { key: 'x', title: '<script>alert(1)</script>', body: 'b & c', url: '/develop/task/1#latest', tone: 'bad' })!
  notify(db, { key: 'y', title: 'Hai', body: '', url: '/ops#health', tone: 'warn' })
  assert.equal(unread(db), 2)
  const html = layout({ title: 't', body: '', nav: [], active: '/', now: Date.now(), refresh: true, bell: { href: bell.href, count: unread(db) } })
  assert.match(html, /<a class="bell" href="\/ops\/notify" aria-label="Thông báo, 2 chưa đọc">.*<span class="count" aria-hidden="true">2<\/span><\/a><div class="clock">/s)
  assert.doesNotMatch(layout({ title: 't', body: '', nav: [], active: '/', now: 0, refresh: true }), /class="bell"/)

  const page = await route('GET', '/ops/notify').handle(req(), view(db)) as { body: string; noRefresh?: boolean }
  assert.equal(page.noRefresh, true)
  assert.ok(!page.body.includes('<script>alert'), 'escaped'); assert.match(page.body, /&#60;script&#62;alert\(1\)&#60;\/script&#62;/)
  assert.equal((page.body.match(/class="notify-new"/g) ?? []).length, 2, 'shown as new this once')
  assert.match(page.body, /Gấp<\/span>/); assert.match(page.body, /Cần xem<\/span>/); assert.match(page.body, /2 chưa đọc/)
  assert.ok(page.body.indexOf('Thông báo đẩy') < page.body.indexOf('Đã báo'), 'the button before the list')
  assert.match(page.body, /data-key="[A-Za-z0-9_-]{87}" data-csrf="tok"/, 'the VAPID public key, never the private one')
  assert.ok(!/"d"\s*:/.test(page.body))
  assert.match(page.body, /<script src="\/ops\/notify\/push\.js\?v=[0-9a-f]{12}" defer><\/script>/)
  assert.equal(unread(db), 0, 'seen')
  assert.doesNotMatch((await route('GET', '/ops/notify').handle(req(), view(db)) as { body: string }).body, /notify-new/)

  // a tap on a push: that one read, then its page
  const b = notify(db, { key: 'z', title: 'Ba', body: '', url: '/report' })!
  notify(db, { key: 'w', title: 'Bốn', body: '', url: '/report' })
  assert.deepEqual(await route('GET', '/ops/notify/go/:id').handle(req({ params: { id: String(b) } }), view(db)), { redirect: '/report' })
  assert.equal(unread(db), 1)
  assert.deepEqual(await route('GET', '/ops/notify/go/:id').handle(req({ params: { id: '999' } }), view(db)), { redirect: '/ops/notify' })
  assert.ok(a)

  // subscribe: refused with a reason, or saved under the device the request came from
  const { sub } = subscriber('https://fcm.googleapis.com/fcm/send/q')
  const subscribe = (form: Record<string, string>, who?: string) => route('POST', '/ops/notify/subscribe').handle(req({ method: 'POST', form: new URLSearchParams(form), who }), view(db))
  assert.deepEqual(await subscribe({ ...sub, endpoint: 'https://evil.example/x' }, 'Z Fold6'), { json: { ok: false, why: 'hub chưa nhận dịch vụ đẩy evil.example.' } })
  assert.deepEqual(await subscribe(sub, 'Z Fold6'), { json: { ok: true, why: '' } })
  await subscribe({ ...sub, endpoint: sub.endpoint + '2' })
  assert.deepEqual(devices(db).map(d => d.name), ['Z Fold6', `${hostname()} (127.0.0.1)`])
  const page2 = (await route('GET', '/ops/notify').handle(req(), view(db)) as { body: string }).body
  assert.match(page2, /<h3>Máy đã bật<\/h3><ul class="list"><li><b>Z Fold6<\/b>[^]*chưa đẩy lần nào/); assert.match(page2, /2 máy/)
})

test('scheduler: a collector failing twice in a row, and "Gấp" alerts once a day however the figure moves', async () => {
  const db = openDb(':memory:')
  let fail = true, pct = 98.12
  const m: Module = { id: 'x', title: 'Nguồn X', group: 'ops', every: 60, collect: async () => { if (fail) throw new Error('boom'); return 1 },
    alerts: () => [{ tone: 'bad', text: `XRemote: crash-free ${pct}% trong 24h`, href: '/ops' }, { tone: 'warn', text: 'chỉ cần xem' }, { tone: 'bad', text: 'không nguồn' },
      { tone: 'bad', text: 'paywall 2: B thua A', href: '/track/2' }, { tone: 'bad', text: 'paywall 3: B thua A', href: '/track/3' }] }
  const s = new Scheduler([m], {}, db)
  const rows = () => listNotes(db).reverse().map(n => [n.key, n.title, n.body, n.url, n.tone])
  await s.run(m)
  assert.deepEqual(rows(), [['alert:x:/ops:XRemote: crash-free #% trong #h', 'Gấp: XRemote', 'crash-free 98.12% trong 24h', '/ops', 'bad'], ['alert:x::không nguồn', 'Gấp: Nguồn X', 'không nguồn', '/', 'bad'],
    ['alert:x:/track/2:paywall #: B thua A', 'Gấp: paywall 2', 'B thua A', '/track/2', 'bad'], ['alert:x:/track/3:paywall #: B thua A', 'Gấp: paywall 3', 'B thua A', '/track/3', 'bad']],
    'one failure: no word about the collector yet; two alerts told apart only by a number each ring')
  await s.run(m)
  assert.deepEqual(rows().at(-1), ['collector:x', 'Nguồn X lỗi hai lần liền', 'boom', '/ops#health', 'warn'])
  fail = false; pct = 97.4
  await s.run(m); fail = true; await s.run(m); await s.run(m)
  assert.equal(rows().length, 5, 'once a day each')
  // a module whose alerts throw: the run still counts, and nothing breaks
  const bad: Module = { id: 'y', title: 'Y', group: 'ops', every: 60, collect: async () => 1, alerts: () => { throw new Error('render') } }
  const state: Record<string, any> = {}
  await new Scheduler([bad], state, db).run(bad)
  assert.equal(state.y.ok, true)
})

test('push.js and the service worker are valid scripts', () => {
  for (const f of ['../src/modules/notify/push.js', '../src/core/sw.js']) execFileSync(process.execPath, ['--check', join(import.meta.dirname, f)])
})
