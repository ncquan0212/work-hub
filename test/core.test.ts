import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CODE, HOME } from '../src/config.ts'
import { checkAccess, sameOrigin } from '../src/core/access.ts'
import { openDb } from '../src/core/db.ts'
import { md } from '../src/core/md.ts'
import { collectAlerts, groupPage, healthSection, todayPage } from '../src/core/pages.ts'
import { parseMultipart } from '../src/core/server.ts'
import { createTask, imageType, saveImages, taskFiles, initStore as initDevelop } from '../src/modules/develop/store.ts'
import { match } from '../src/core/router.ts'
import { dailyMissed, nextDaily, Scheduler } from '../src/core/scheduler.ts'
import { NotConfigured, type Module, type Route, type View } from '../src/core/types.ts'
import { projectDir } from '../src/lib/claude.ts'
import { findServer } from '../src/lib/databuckets.ts'
import { firebaseApiFiles } from '../src/lib/google.ts'
import { listNotes } from '../src/lib/notify.ts'
import { projectLabel } from '../src/modules/agents.ts'

const cfg = { port: 8787, tailnetHost: 'mini.ts.net', devices: { phone: ['100.1.1.1', 'fd7a::1'] } }

test('access: local hosts, allowed device via tailscale serve, everything else refused', () => {
  assert.equal(checkAccess('127.0.0.1:8787', undefined, cfg).ok, true)
  assert.equal(checkAccess('localhost:8787', undefined, cfg).ok, true)
  assert.deepEqual(checkAccess('mini.ts.net', '100.1.1.1', cfg), { ok: true, who: 'phone' })
  assert.equal(checkAccess('mini.ts.net', 'fd7a::1', cfg).ok, true)
  assert.equal(checkAccess('mini.ts.net', '100.9.9.9', cfg).ok, false)           // another tailnet device
  assert.equal(checkAccess('mini.ts.net', undefined, cfg).ok, false)             // no proxy header: fail closed
  assert.equal(checkAccess('mini.ts.net', '100.1.1.1, 100.9.9.9', cfg).ok, false) // only the last hop counts
  assert.equal(checkAccess('evil.example:8787', '100.1.1.1', cfg).ok, false)     // DNS rebinding
  assert.equal(checkAccess('127.0.0.1:9999', undefined, cfg).ok, false)
  assert.equal(checkAccess('127.0.0.1:8787', '100.9.9.9', cfg).ok, false)          // via serve with a forged Host
  assert.equal(checkAccess('localhost:8787', '100.1.1.1', cfg).ok, false)
  assert.equal(checkAccess(undefined, undefined, cfg).ok, false)
})

test('same-origin check for form posts', () => {
  assert.equal(sameOrigin('https://mini.ts.net', cfg), true)
  assert.equal(sameOrigin('http://127.0.0.1:8787', cfg), true)
  assert.equal(sameOrigin('https://evil.example', cfg), false)
  assert.equal(sameOrigin(undefined, cfg), false)
  assert.equal(sameOrigin('null', cfg), false)
})

test('router: exact segments and params', () => {
  const r = (path: string): Route => ({ method: 'GET', path, handle: () => ({ redirect: '/' }) })
  const routes = [r('/develop/task/:id'), r('/develop/new')]
  assert.deepEqual(match(routes, 'GET', '/develop/task/42')?.params, { id: '42' })
  assert.equal(match(routes, 'GET', '/develop/new')?.route.path, '/develop/new')
  assert.equal(match(routes, 'POST', '/develop/new'), null)
  assert.equal(match(routes, 'GET', '/develop/task/42/x'), null)
  assert.equal(match(routes, 'GET', '/develop/task/%E0%A4%A'), null) // bad escape: no match, no throw
})

test('daily schedule: next slot and catch-up after a missed one', () => {
  const at = (s: string) => new Date(s).getTime() // local time
  assert.equal(nextDaily('07:30', at('2026-11-08T06:00:00')), at('2026-11-08T07:30:00'))
  assert.equal(nextDaily('07:30', at('2026-11-08T07:30:00')), at('2026-11-09T07:30:00'))
  assert.equal(dailyMissed('07:30', at('2026-11-08T07:31:00'), at('2026-11-08T12:00:00')), false)
  assert.equal(dailyMissed('07:30', at('2026-11-07T07:31:00'), at('2026-11-08T12:00:00')), true)
  assert.equal(dailyMissed('07:30', at('2026-11-07T07:31:00'), at('2026-11-08T07:00:00')), false)
  assert.equal(dailyMissed('07:30', undefined, at('2026-11-08T07:00:00')), true)
})

test('scheduler: keeps last data on failure, times out, never overlaps', async () => {
  const db = openDb(':memory:')
  let n = 0, fail = false, calls = 0
  const ok: Module = { id: 'ok', title: 'OK', group: 'ops', every: 60, collect: async () => { if (fail) throw new Error('boom'); return ++n } }
  const hang: Module = { id: 'hang', title: 'Hang', group: 'ops', every: 60, timeout: 0.05,
    collect: ({ signal }) => { calls++; return new Promise((_, reject) => setTimeout(() => reject(new Error('late')), signal.aborted ? 0 : 200)) } }
  const state: Record<string, any> = {}
  const s = new Scheduler([ok, hang], state, db)

  await s.run(ok)
  assert.deepEqual([state.ok.ok, state.ok.data], [true, 1])
  const firstAt = state.ok.dataAt
  fail = true
  await s.run(ok)
  assert.deepEqual([state.ok.ok, state.ok.data, state.ok.error, state.ok.dataAt], [false, 1, 'boom', firstAt])

  await s.run(hang)
  assert.equal(state.hang.ok, false)
  assert.match(state.hang.error, /timeout/)
  await s.run(hang) // the first call has not really ended yet: no second call
  assert.equal(calls, 1)
  await new Promise(r => setTimeout(r, 250))
  await s.run(hang)
  assert.equal(calls, 2)
  db.close()
})

test('scheduler and pages: NotConfigured is recorded, never a failure, never notified; its panel says so', async () => {
  const db = openDb(':memory:')
  let unset = true, panels = 0
  const m: Module = { id: 'u', title: 'Nguồn U', group: 'ops', every: 60,
    collect: async () => { throw unset ? new NotConfigured('chưa có app trong data/config.json') : new Error('boom') },
    alerts: () => [{ tone: 'bad', text: 'Nguồn U: số cũ' }], panel: () => { panels++; return 'PANEL' }, today: () => 'TODAY' }
  const state: Record<string, any> = {}
  const s = new Scheduler([m], state, db)
  await s.run(m); await s.run(m)
  assert.deepEqual([state.u.ok, state.u.unset], [false, 'chưa có app trong data/config.json'])
  assert.deepEqual(listNotes(db), [], 'no "lỗi hai lần liền", no "Gấp" from its old data')
  const v: View = { now: Date.now(), db, csrf: '', slot: () => undefined }
  assert.deepEqual(collectAlerts([m], state, v), [])
  assert.doesNotMatch(todayPage([m], state, v), /TODAY|Lỗi/)
  assert.match(groupPage('ops', [m], state, v), /<p class="sub muted">Chưa cấu hình: chưa có app trong data\/config\.json<\/p>/)
  assert.equal(panels, 0, 'its own panel is not rendered')
  const health = healthSection([m], state, Date.now())
  assert.match(health, /Chưa cấu hình/); assert.doesNotMatch(health, /warn-t|nguồn lỗi/)
  // set up, then failing: a real failure starts its own count
  unset = false
  await s.run(m)
  assert.equal(state.u.unset, undefined)
  assert.equal(listNotes(db).filter(n => n.key === 'collector:u').length, 0, 'not twice in a row yet')
  await s.run(m)
  assert.equal(listNotes(db).filter(n => n.key === 'collector:u').length, 1)
  db.close()
})

test('databuckets token: the .env pair first, then Claude Code user scope, then a project scope', () => {
  const mcp = (url: string, auth: string) => ({ mcpServers: { databuckets: { type: 'http', url, headers: { Authorization: auth } } } })
  const j = { ...mcp('https://u', 'Bearer user'), projects: { '/p': {}, '/q': mcp('https://p', 'Bearer proj') } }
  assert.deepEqual(findServer({ DATABUCKETS_URL: 'https://e', DATABUCKETS_TOKEN: ' tok\n' }, j), { url: 'https://e', auth: 'Bearer tok' })
  assert.equal(findServer({ DATABUCKETS_URL: 'https://e', DATABUCKETS_TOKEN: 'Bearer tok' }, j)?.auth, 'Bearer tok')
  assert.deepEqual(findServer({ DATABUCKETS_TOKEN: 'tok' }, j), { url: 'https://u', auth: 'Bearer user' }, 'half a pair is ignored')
  assert.deepEqual(findServer({}, { projects: j.projects }), { url: 'https://p', auth: 'Bearer proj' })
  assert.equal(findServer({}, { mcpServers: { databuckets: { url: 'https://u' } } }), null, 'no token')
  assert.equal(findServer({}, null), null)
})

test('firebase-tools: found in npx\'s cache wherever npm keeps it, without running npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-npm-'))
  try {
    const api = (root: string) => { const d = join(root, '_npx', 'abc', 'node_modules/firebase-tools/lib'); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'api.js'), ''); return join(d, 'api.js') }
    const posix = api(join(dir, 'cache')), win = api(join(dir, 'local', 'npm-cache'))
    assert.ok(firebaseApiFiles({ npm_config_cache: join(dir, 'cache') }, 'linux').includes(posix))
    assert.ok(firebaseApiFiles({ LOCALAPPDATA: join(dir, 'local') }, 'win32').includes(win))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('agents: a transcript folder is labelled by its path under codeDir, else under home', () => {
  assert.equal(projectLabel(projectDir(HOME)), 'home')
  assert.equal(projectLabel(projectDir(join(CODE, 'work-hub'))), 'work-hub')
  assert.equal(projectLabel(projectDir(join(HOME, 'notes'))), 'notes')
})

test('md: Claude replies render as safe HTML', () => {
  const h = md([
    '# Họ dùng gì', '- **Lib ad riêng `com.leansoft.ads`** (log `<b>`).', '  - con *nghiêng*', '- [x] xong', '- [ ] chưa',
    '', '3. ba', '', '| Bước | Event | Số |', '|---|---|---:|', '| C1 | `enter_screen_tv_check` | 18% |',
    '', '```', '<script>x</script>', '```', '> trích', '---', 'xem https://a.com/x?a=1&b=2. và [link](https://b.com) [xấu](javascript:alert(1))',
    '<img src=x onerror=alert(1)> ad_revenue_x 2 * 3',
  ].join('\n'))
  assert.match(h, /^<div class="md"><h3>Họ dùng gì<\/h3><ul><li><strong>Lib ad riêng <code>com\.leansoft\.ads<\/code><\/strong> \(log <code>&#60;b&#62;<\/code>\)\.<ul><li>con <em>nghiêng<\/em><\/li><\/ul><\/li><li><input type="checkbox" disabled checked aria-label="xong">xong<\/li><li><input type="checkbox" disabled aria-label="chưa xong">chưa<\/li><\/ul><ol start="3"><li>ba<\/li><\/ol>/)
  assert.match(h, /<th>Bước<\/th><th>Event<\/th><th class="num">Số<\/th>.*<td><code>enter_screen_tv_check<\/code><\/td><td class="num">18%<\/td>/)
  assert.match(h, /<pre><code>&#60;script&#62;x&#60;\/script&#62;<\/code><\/pre><blockquote>trích<\/blockquote><hr>/)
  assert.match(h, /<a href="https:\/\/a\.com\/x\?a=1&#38;b=2" [^>]*>https:\/\/a\.com\/x\?a=1&#38;b=2<\/a>\. và <a href="https:\/\/b\.com"[^>]*>link<\/a> \[xấu\]\(javascript:alert\(1\)\)/)
  assert.match(h, /&#60;img src=x onerror=alert\(1\)&#62; ad_revenue_x 2 \* 3<\/p><\/div>$/)
  assert.ok(!/<(script|img)/.test(h))
})

test('multipart: fields and non-empty files through Node\'s own parser', async () => {
  const b = 'XyZ', part = (h: string, v: string) => `--${b}\r\nContent-Disposition: form-data; ${h}\r\n\r\n${v}\r\n`
  const body = Buffer.from(part('name="_csrf"', 'tok') + part('name="images"; filename="a.png"\r\nContent-Type: image/png', 'PNGDATA')
    + part('name="images"; filename=""\r\nContent-Type: application/octet-stream', '') + `--${b}--\r\n`)
  const { form, files } = await parseMultipart(body, `multipart/form-data; boundary=${b}`)
  assert.equal(form.get('_csrf'), 'tok')
  assert.deepEqual(files.map(f => [f.field, f.name, f.data.toString()]), [['images', 'a.png', 'PNGDATA']])
  await assert.rejects(parseMultipart(Buffer.from('junk'), `multipart/form-data; boundary=${b}`))
})

test('images: type from the first bytes; saveImages re-encodes real ones with sips and skips the rest', { skip: process.platform !== 'darwin' && 'sips is macOS only' }, async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  assert.equal(imageType(png), 'image/png')
  assert.equal(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg')
  assert.equal(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp')
  assert.equal(imageType(Buffer.from('\0\0\0\x18ftypheic')), 'image/heic')
  assert.equal(imageType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), null)
  const db = openDb(':memory:'); initDevelop(db)
  const task = createTask(db, { title: 't', body: '', repo: 'x' })
  const dir = mkdtempSync(join(tmpdir(), 'hub-img-'))
  try {
    const fake = Buffer.concat([png.subarray(0, 8), Buffer.from('not really a png')])
    const { ids, skipped } = await saveImages(db, task, 7, [{ data: png }, { data: fake }, { data: Buffer.from('hello') }], dir)
    assert.equal(ids.length, 1); assert.equal(skipped, 2)
    const [f] = taskFiles(db, task)
    assert.equal(f.message_id, 7); assert.equal(f.mime, 'image/png'); assert.ok(existsSync(f.path) && f.path.startsWith(dir))
    assert.match(execFileSync('/usr/bin/sips', ['-g', 'pixelWidth', f.path], { encoding: 'utf8' }), /pixelWidth: 1\b/, 'a small image is not enlarged')
    assert.deepEqual(readdirSync(dir), [f.path.slice(dir.length + 1)], 'no temp file left behind')
  } finally { rmSync(dir, { recursive: true, force: true }); db.close() }
})

