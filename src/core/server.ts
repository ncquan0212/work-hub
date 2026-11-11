// HTTP: access control, routing, the shared layout. Listens on 127.0.0.1 only; other devices come in
// through `tailscale serve` (see access.ts).
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { DATA } from '../config.ts'
import { bell, unread } from '../lib/notify.ts'
import { checkAccess, sameOrigin, type AccessConfig } from './access.ts'
import { layout, type NavItem } from './layout.ts'
import { log } from './log.ts'
import { collectAlerts, groupPage, todayPage } from './pages.ts'
import { match } from './router.ts'
import type { Scheduler } from './scheduler.ts'
import { GROUPS, type Module, type Req, type Res, type Route, type Slot, type Upload, type View } from './types.ts'

// the hub's icon (tab, bookmark, home screen; layout.ts links it). favicon.ico is the PNG: browsers that ask for it read it
const ICON_SVG = readFileSync(join(import.meta.dirname, 'icon.svg')), ICON_PNG = readFileSync(join(import.meta.dirname, 'icon.png'))
const ICONS: Record<string, [string, Buffer]> = { '/icon.svg': ['image/svg+xml', ICON_SVG], '/icon.png': ['image/png', ICON_PNG], '/favicon.ico': ['image/png', ICON_PNG] }
// the service worker that shows Web Push notifications (architecture.md "Thông báo"). At /sw.js because a worker's scope is
// at most its own folder, and it must cover every page a notification opens. no-store (SECURITY_HEADERS): updates reach
// the browsers on their next visit
const SW = readFileSync(join(import.meta.dirname, 'sw.js'))

const MAX_BODY = 256 * 1024, MAX_UPLOAD = 64 * 1024 * 1024 // a form; a form with images (develop: 6 × 10 MB)

/** CSRF token for the hub's own forms. Kept in data/ so a restart does not invalidate open pages. */
function csrfSecret() {
  const f = join(DATA, 'csrf.secret')
  if (existsSync(f)) return readFileSync(f, 'utf8').trim()
  const s = randomBytes(32).toString('hex')
  writeFileSync(f, s, { mode: 0o600 }); chmodSync(f, 0o600)
  return s
}

/** The request body, or null past `max` bytes. Past it the rest is read and dropped rather than the socket destroyed,
 *  so the 413 page still reaches the browser (destroying the request kills the socket under the reply). */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { chunks.length = 0; resolve(null) } else chunks.push(c) })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** A multipart body through Node's own parser (fetch's Request.formData, no dependency). Throws on a broken body. */
export async function parseMultipart(body: Buffer, contentType: string) {
  const fd = await new Request('http://hub/', { method: 'POST', headers: { 'content-type': contentType }, body: new Uint8Array(body) }).formData()
  const form = new URLSearchParams(), files: Upload[] = []
  for (const [field, v] of fd) {
    if (typeof v === 'string') form.append(field, v)
    else if (v.size) files.push({ field, name: v.name, data: Buffer.from(await v.arrayBuffer()) })
  }
  return { form, files }
}

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  // LOAD-BEARING: not 'no-referrer'. Under it browsers send `Origin: null` on form POSTs and sameOrigin()
  // refuses every form ("Bad origin", 2026-11-09). 'same-origin' still sends nothing to other sites.
  'referrer-policy': 'same-origin',
  // access goes by device (tailnet IP), not a cookie: keep other sites open on an allowed device from embedding hub responses
  'cross-origin-resource-policy': 'same-origin',
  // script-src 'self': develop's paste.js and chat.js (owner 2026-11-09). Nothing inline. LOAD-BEARING: nosniff
  // above, so no other same-origin response (JSON, a stored image, a text/plain error) can be run as a script.
  // blob: shows images pasted into a form before they are sent; connect-src 'self': develop's chat.js sends and polls
  // the task page with fetch (owner 2026-11-09)
  'content-security-policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: blob:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
}

export function startServer(o: { modules: Module[]; scheduler: Scheduler; db: DatabaseSync; access: AccessConfig }) {
  const { modules, scheduler, db, access } = o
  const state = scheduler.state
  const csrf = csrfSecret()
  const routes: Route[] = modules.flatMap(m => m.routes ?? [])
  for (const r of routes) {
    // a module's routes live under its group, so two modules can never shadow the core pages
    if (!GROUPS.some(g => r.path.startsWith(`/${g.id}/`))) throw new Error(`route ${r.path} must start with /<group>/`)
  }
  const groups = GROUPS.filter(g => modules.some(m => m.group === g.id))
  const css = modules.map(m => m.css ?? '').join('') // each module's own rules, after the shared sheet
  // main.ts keeps the slots of modules switched off in data/config.json (switching one back on must not rerun a daily
  // collector at once): a soft dependency on one of them sees it as absent, never its old data
  const on = new Set(modules.map(m => m.id))
  const view = (): View => ({ now: Date.now(), db, csrf, slot: <D,>(id: string) => on.has(id) ? state[id] as Slot<D> | undefined : undefined })

  function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) {
    res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': type, ...extra }).end(body)
  }

  function page(res: ServerResponse, active: string, r: { title: string; body: string; status?: number; noRefresh?: boolean; bare?: boolean; noscriptRefresh?: boolean }, v: View) {
    const alerts = collectAlerts(modules, state, v).length
    const nav: NavItem[] = [{ path: '/', label: 'Hôm nay', badge: alerts }, ...groups.map(g => ({ path: `/${g.id}`, label: g.label }))]
    // the bell: a module that lists notifications sets bell.href (lib/notify.ts); the count of unread ones beside it
    const b = bell.href ? { href: bell.href, count: unread(db) } : undefined
    send(res, r.status ?? 200, 'text/html; charset=utf-8', layout({ title: r.title, body: r.body, nav, active, now: v.now, refresh: !r.noRefresh, noscriptRefresh: r.noscriptRefresh, bare: r.bare, css, bell: b }))
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const verdict = checkAccess(req.headers.host, req.headers['x-forwarded-for'] as string | undefined, access)
    if (!verdict.ok) { log('warn', 'refused', { why: verdict.why }); return send(res, 403, 'text/plain; charset=utf-8', 'Forbidden') }
    if (req.method !== 'GET' && req.method !== 'POST') return send(res, 405, 'text/plain; charset=utf-8', 'Method not allowed')

    const url = new URL(req.url ?? '/', 'http://hub')
    const path = url.pathname.replace(/\/+$/, '') || '/'
    let form = new URLSearchParams(), files: Upload[] = []
    if (req.method === 'POST') {
      // CSRF: the browser must say the form came from one of the hub's own pages, and carry the token
      if (!sameOrigin(req.headers.origin, access)) return send(res, 403, 'text/plain; charset=utf-8', 'Bad origin')
      const ct = String(req.headers['content-type'] ?? ''), multi = ct.startsWith('multipart/form-data')
      if (!multi && !ct.startsWith('application/x-www-form-urlencoded')) return send(res, 415, 'text/plain; charset=utf-8', 'Form posts only')
      const body = await readBody(req, multi ? MAX_UPLOAD : MAX_BODY)
      if (!body) return send(res, 413, 'text/plain; charset=utf-8', `Gửi quá lớn (tối đa ${multi ? '64 MB' : '256 KB'}).`, { connection: 'close' })
      if (multi) {
        const parsed = await parseMultipart(body, ct).catch(() => null)
        if (!parsed) return send(res, 400, 'text/plain; charset=utf-8', 'Form hỏng, gửi lại.')
        ;({ form, files } = parsed)
      } else form = new URLSearchParams(body.toString('utf8'))
      const t = Buffer.from(form.get('_csrf') ?? ''), want = Buffer.from(csrf)
      if (t.length !== want.length || !timingSafeEqual(t, want)) return send(res, 403, 'text/plain; charset=utf-8', 'Trang đã cũ: tải lại rồi gửi lại.')
    }
    const v = view()

    if (req.method === 'GET' && path === '/sw.js') return send(res, 200, 'text/javascript; charset=utf-8', SW)
    if (req.method === 'GET' && Object.hasOwn(ICONS, path)) return send(res, 200, ICONS[path][0], ICONS[path][1], { 'cache-control': 'private, max-age=86400' })
    if (req.method === 'GET' && path === '/') return page(res, '/', { title: 'Hôm nay', body: todayPage(modules, state, v) }, v)
    const g = groups.find(x => `/${x.id}` === path)
    if (req.method === 'GET' && g) return page(res, path, { title: g.label, body: groupPage(g.id, modules, state, v, scheduler.next) }, v)
    if (req.method === 'GET' && path === '/api') return send(res, 200, 'application/json', JSON.stringify(state))
    if (req.method === 'GET' && path.startsWith('/api/')) {
      const s = state[path.slice(5)]
      return s ? send(res, 200, 'application/json', JSON.stringify(s)) : send(res, 404, 'text/plain; charset=utf-8', 'Not found')
    }

    const hit = match(routes, req.method, path)
    if (!hit) return send(res, 404, 'text/plain; charset=utf-8', 'Not found')
    // who: the device by name (access.ts), for the notifications module's device list
    const r: Res = await hit.route.handle({ method: req.method, path, params: hit.params, query: url.searchParams, form, files, who: verdict.who } as Req, v)
    // a stored file never changes under its id, so the browser may keep it
    if ('file' in r) return send(res, 200, r.type, r.file, { 'cache-control': 'private, max-age=31536000, immutable' })
    if ('redirect' in r) return send(res, 303, 'text/plain; charset=utf-8', '', { location: r.redirect.startsWith('/') ? r.redirect : '/' })
    if ('json' in r) return send(res, r.status ?? 200, 'application/json', JSON.stringify(r.json))
    return page(res, '/' + path.split('/')[1], r, v)
  }

  const server = createServer((req, res) => {
    handle(req, res).catch(e => {
      // a bug in one route must not take the server (and the collectors) down with it
      log('warn', 'request failed', { path: req.url?.slice(0, 120), err: (e as Error).stack?.split('\n').slice(0, 3).join(' | ') })
      if (!res.headersSent) send(res, 500, 'text/plain; charset=utf-8', 'Lỗi máy chủ, xem log.')
    })
  })
  server.listen(access.port, '127.0.0.1', () => log('info', 'listening', { url: `http://127.0.0.1:${access.port}` }))
  return server
}
