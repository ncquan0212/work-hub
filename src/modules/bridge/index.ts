// Browser bridge: a small HTTP endpoint on 127.0.0.1:8788 for the work-hub Chrome extension (owner rules
// R1/R6: read Gmail, Play Console, AdMob, Jira with the person's existing logins, no new accounts or apps).
// Modules queue jobs through lib/bridge.ts; the extension in each Chrome profile polls here every minute,
// does the job in that profile and posts the result. Port 8788 is never exposed through tailscale serve.
// Auth: a shared key in data/bridge.key, baked into the extension build (npm run bridge:extension).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DATA } from '../../config.ts'
import { ago, cut, esc, pill, section, unsetNote } from '../../core/html.ts'
import { log } from '../../core/log.ts'
import type { Module } from '../../core/types.ts'
import { hasProfile, initBridge, markSeen, PROFILES, type Profile } from '../../lib/bridge.ts'

export const BRIDGE_PORT = 8788
export const EXTENSION_DIR = join(DATA, 'extension')
const MAX_BODY = 4 * 1024 * 1024

export function bridgeKey() {
  const f = join(DATA, 'bridge.key')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const k = randomBytes(32).toString('hex')
  writeFileSync(f, k, { mode: 0o600 }); chmodSync(f, 0o600)
  return k
}

/** The bridge endpoint. Port and key are parameters for the test; the module uses 8788 and data/bridge.key. */
export function serveBridge(db: DatabaseSync, port = BRIDGE_PORT, keyValue = bridgeKey()) {
  const key = Buffer.from(keyValue)
  const okKey = (h: unknown) => { const b = Buffer.from(String(h ?? '')); return b.length === key.length && timingSafeEqual(b, key) }
  const server = createServer((req, res) => {
    const send = (code: number, body = '') => res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(body)
    // only the extension: right Host (no DNS rebinding), the key, and no web-page origin
    if (req.headers.host !== `127.0.0.1:${(server.address() as { port: number }).port}` || !okKey(req.headers['x-hub-key'])) return send(403)
    const origin = req.headers.origin
    if (origin && !origin.startsWith('chrome-extension://')) return send(403)
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      if (req.method === 'GET' && url.pathname === '/bridge/poll') {
        const profile = url.searchParams.get('profile') as Profile
        if (!Object.hasOwn(PROFILES, profile)) return send(400) // a known role; queue() refuses jobs for one this copy has not set up
        markSeen(db, profile, String(url.searchParams.get('v') ?? '').slice(0, 20))
        db.prepare(`update bridge_jobs set status = 'failed', error = 'quá hạn' where status = 'queued' and created_at < ?`).run(Date.now() - 10 * 60_000)
        const job = db.prepare(`select id, kind, url, wait_for from bridge_jobs where profile = ? and status = 'queued' order by id limit 1`).get(profile) as
          { id: number; kind: string; url: string; wait_for: string | null } | undefined
        if (!job) return send(204)
        db.prepare(`update bridge_jobs set status = 'taken', taken_at = ? where id = ?`).run(Date.now(), job.id)
        return send(200, JSON.stringify({ id: job.id, kind: job.kind, url: job.url, waitFor: job.wait_for }))
      }
      if (req.method === 'POST' && url.pathname === '/bridge/result') {
        let size = 0; const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => { size += c.length; if (size > MAX_BODY) req.destroy(); else chunks.push(c) })
        req.on('end', () => {
          try {
            const b = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            db.prepare(`update bridge_jobs set status = ?, result = ?, error = ?, done_at = ? where id = ? and status = 'taken'`)
              .run(b.ok ? 'done' : 'failed', b.ok ? JSON.stringify(b.result) : null, b.ok ? null : String(b.error ?? '').slice(0, 300), Date.now(), Number(b.id))
            send(204)
          } catch { send(400) }
        })
        return
      }
      send(404)
    } catch (e) { log('warn', 'bridge request failed', { err: (e as Error).message }); send(500) }
  })
  server.on('error', e => log('warn', 'bridge server error', { err: e.message }))
  server.listen(port, '127.0.0.1', () => log('info', 'bridge listening', { port: (server.address() as { port: number }).port }))
  return server
}

function startServer(db: DatabaseSync) {
  serveBridge(db)
  // keep the job table small
  setInterval(() => { try { db.prepare('delete from bridge_jobs where created_at < ?').run(Date.now() - 2 * 86_400_000) } catch { /* next time */ } }, 3_600_000)
}

export const bridge: Module = {
  id: 'bridge', title: 'Trình duyệt (extension)', group: 'ops',

  init: initBridge,
  start: startServer,

  css: String.raw`
@media (min-width: 48rem) and (max-width: 79.99rem) { .bridge-panel { grid-column: 1 / -1 } }
.bridge-body { container: bridge / inline-size; display: grid; gap: var(--space-sm); min-width: 0 }
.bridge-profiles { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-md) }
.bridge-profiles > li { display: grid; gap: var(--space-xs); align-content: start; min-width: 0 }
.bridge-profiles > li + li { border-top: 1px solid var(--rule); padding-top: var(--space-md) }
.bridge-who { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs) }
.bridge-who .sub { flex-basis: 100%; margin: 0 }
.bridge-profiles .kv { margin: 0 }
.bridge-fail { font-size: var(--text-sm); display: grid; gap: var(--space-3xs); min-width: 0; overflow-wrap: anywhere }
.bridge-install ol { margin: 0; padding-left: var(--space-lg); display: grid; gap: var(--space-2xs); font-size: var(--text-sm) }
.bridge-install code { overflow-wrap: anywhere }
.bridge-install p { margin-top: var(--space-xs) }
@container bridge (min-width: 30rem) {
  .bridge-profiles { grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: var(--space-xl) }
  .bridge-profiles > li + li { border-top: 0; padding-top: 0 }
}
`,

  panel(_s, v) {
    const JOB: Record<string, string> = { done: 'xong', failed: 'lỗi', queued: 'đang chờ', taken: 'đang làm' }
    const roles = (Object.keys(PROFILES) as Profile[]).filter(hasProfile)
    const items = roles.map(p => {
      const seen = v.db.prepare('select at, version from bridge_seen where profile = ?').get(p) as { at: number; version: string } | undefined
      const stats = v.db.prepare(`select status, count(*) n from bridge_jobs where profile = ? and created_at > ? group by status`).all(p, v.now - 86_400_000) as { status: string; n: number }[]
      const fail = v.db.prepare(`select url, error, created_at from bridge_jobs where profile = ? and status = 'failed' order by id desc limit 1`).get(p) as { url: string; error: string; created_at: number } | undefined
      const st = !seen ? pill('mute', 'chưa cài') : v.now - seen.at < 5 * 60_000 ? pill('ok', 'đang kết nối') : pill('warn', 'im lặng')
      const [, name, account] = /^(.*?) \((.*)\)$/.exec(PROFILES[p]) ?? ['', PROFILES[p], '']
      const jobs = stats.map(x => `${x.n} ${JOB[x.status] ?? x.status}`).join(', ')
      return `<li><div class="bridge-who"><b>${esc(name)}</b>${st}${account ? `<div class="sub muted">${esc(account)}</div>` : ''}</div>
        <dl class="kv"><div><dt>Lần cuối</dt><dd>${seen ? esc(ago(seen.at, v.now)) : '—'}</dd></div><div><dt>Phiên bản</dt><dd>${seen ? `v${esc(seen.version)}` : '—'}</dd></div>
        <div><dt>Việc 24 giờ</dt><dd>${esc(jobs || 'không có')}</dd></div></dl>
        ${fail ? `<div class="bridge-fail"><span class="label">Lỗi gần nhất, ${esc(ago(fail.created_at, v.now))}</span><span class="warn-t">${esc(cut(fail.error, 100))}</span><span class="muted">${esc(cut(fail.url, 60))}</span></div>` : ''}</li>`
    }).join('')
    return section(this.title, `<div class="bridge-body">${roles.length ? `<ul class="bridge-profiles">${items}</ul>` : unsetNote('thêm chromeProfiles vào data/config.json, rồi cài extension (docs/config.md)')}
      <details class="bridge-install"><summary>Cách cài extension</summary><ol>
        <li>Chạy <code>npm run bridge:extension</code> trên máy này.</li>
        <li>Trong Chrome của từng profile, mở <code>chrome://extensions</code> và bật Developer mode.</li>
        <li>Bấm Load unpacked, chọn <code>${esc(EXTENSION_DIR)}</code>.</li></ol>
        <p class="sub muted">Extension chỉ đọc (GET và chữ trên trang), và chỉ các trang trong danh sách cho phép.</p></details></div>`,
      'cổng 8788, chỉ trên máy này', 'bridge', { cls: 'bridge-panel' })
  },

  alerts(_s, v) {
    return (Object.keys(PROFILES) as Profile[]).filter(hasProfile).flatMap(p => {
      const seen = v.db.prepare('select at from bridge_seen where profile = ?').get(p) as { at: number } | undefined
      return seen && v.now - seen.at > 30 * 60_000 ? [{ tone: 'warn' as const, text: `Extension ở ${PROFILES[p]} im lặng ${ago(seen.at, v.now)}`, href: '/ops' }] : []
    })
  },
}

