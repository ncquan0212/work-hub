// Google auth with credentials that already exist on this machine (owner rule R1: nothing new is created).
//  - serviceAccountToken: the RC service accounts in rcKeyDir (data/config.json), read in place, never copied.
//  - firebaseUserToken: the person's own Firebase CLI login (~/.config/configstore/firebase-tools.json).
// Tokens live in memory only and are never logged.
import { createSign } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { HOME } from '../config.ts'
import { NotConfigured } from '../core/types.ts'

type TokenReply = { access_token?: string; expires_in?: number; error?: string; error_description?: string }
const tokens = new Map<string, { tok: string; exp: number }>()

async function cached(key: string, get: () => Promise<TokenReply>) {
  const c = tokens.get(key)
  if (c && c.exp > Date.now() + 60_000) return c.tok
  const j = await get()
  if (!j.access_token) throw new Error(`token ${key}: ${j.error ?? '?'} ${j.error_description ?? ''}`.trim())
  tokens.set(key, { tok: j.access_token, exp: Date.now() + (j.expires_in ?? 3600) * 1000 })
  return j.access_token
}

export function serviceAccountProject(file: string): string {
  return JSON.parse(readFileSync(file, 'utf8')).project_id
}

export function serviceAccountToken(file: string) {
  return cached(file, async () => {
    const sa = JSON.parse(readFileSync(file, 'utf8')), now = Math.floor(Date.now() / 1000)
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const unsigned = b64({ alg: 'RS256', typ: 'JWT' }) + '.' + b64({ iss: sa.client_email, aud: sa.token_uri, iat: now, exp: now + 3600,
      scope: 'https://www.googleapis.com/auth/cloud-platform' })
    const assertion = unsigned + '.' + createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url')
    return (await fetch(sa.token_uri, { method: 'POST', signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })).json()
  })
}

/** Every firebase-tools lib/api.js on this machine, newest first: npx's cache (npm's cache folder: npm_config_cache,
 *  else ~/.npm, %LocalAppData%\npm-cache on Windows), then the usual global installs. Looked up, never by running npm. */
export function firebaseApiFiles(env = process.env, platform = process.platform) {
  const win = platform === 'win32'
  const caches = [env.npm_config_cache, win ? env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'npm-cache') : join(HOME, '.npm')]
  const globals = win ? [env.APPDATA && join(env.APPDATA, 'npm/node_modules')]
    // the prefix of the node running the hub (nvm, Homebrew, /usr), then Homebrew's and /usr/local's
    : [join(dirname(dirname(process.execPath)), 'lib/node_modules'), '/opt/homebrew/lib/node_modules', '/usr/local/lib/node_modules']
  const ls = (d: string) => { try { return readdirSync(d) } catch { return [] } }
  const files = [
    ...caches.filter(Boolean).flatMap(c => ls(join(c!, '_npx')).map(d => join(c!, '_npx', d, 'node_modules/firebase-tools/lib/api.js'))),
    ...globals.filter(Boolean).map(g => join(g!, 'firebase-tools/lib/api.js')),
  ]
  return [...new Set(files)].filter(existsSync).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

function firebaseCliClient() {
  // The Firebase CLI's own OAuth client (public in its source). Read from the installed copy so a CLI
  // update never strands the hub; FT_CLIENT_ID / FT_CLIENT_SECRET override.
  if (process.env.FT_CLIENT_ID && process.env.FT_CLIENT_SECRET) return { id: process.env.FT_CLIENT_ID, secret: process.env.FT_CLIENT_SECRET }
  const api = firebaseApiFiles()[0]
  if (!api) throw new NotConfigured('chưa có firebase-tools: chạy npx firebase-tools login một lần')
  const src = readFileSync(api, 'utf8')
  const id = src.match(/FIREBASE_CLIENT_ID", "([^"]+)"/)?.[1], secret = src.match(/FIREBASE_CLIENT_SECRET", "([^"]+)"/)?.[1]
  if (!id || !secret) throw new Error('không đọc được OAuth client của firebase-tools')
  return { id, secret }
}

export function firebaseUserToken() {
  return cached('firebase-cli', async () => {
    // Re-read the CLI's login every time: a `firebase login` elsewhere (the MCP) then just works here too.
    // configstore keeps it under XDG_CONFIG_HOME, else ~/.config, on every OS (Windows too)
    let store: string
    try { store = readFileSync(join(process.env.XDG_CONFIG_HOME || join(HOME, '.config'), 'configstore/firebase-tools.json'), 'utf8') } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotConfigured('chưa đăng nhập firebase: npx firebase-tools login')
      throw e
    }
    // a fixed message: JSON.parse's own quotes the file, which holds the refresh token
    let rt: string | undefined
    try { rt = JSON.parse(store).tokens?.refresh_token } catch { throw new Error('configstore/firebase-tools.json hỏng: chạy lại npx firebase-tools login') }
    if (!rt) throw new NotConfigured('chưa đăng nhập firebase: npx firebase-tools login')
    const c = firebaseCliClient()
    const j = await (await fetch('https://www.googleapis.com/oauth2/v3/token', { method: 'POST', signal: AbortSignal.timeout(20_000),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: c.id, client_secret: c.secret }) })).json()
    if (j.error === 'invalid_grant') throw new Error('Firebase login hết hạn: chạy `npx firebase-tools login --reauth`')
    return j
  })
}

/** GET a Google JSON API; a non-2xx reply throws with the API's short error. A 503 is retried once
 *  after 2 s (seen on Remote Config 2026-11-08), a 429 once after a minute; GET is idempotent, so a retry is safe. */
export async function getJson(url: string, tok: string, signal?: AbortSignal) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    const j: any = await r.json().catch(() => ({}))
    if (r.status === 503 && attempt === 0) { await new Promise(res => setTimeout(res, 2000)); continue }
    // per-minute read quota (Crashlytics 2026-11-08 during the 35-day backfill): wait out the minute once
    if (r.status === 429 && attempt === 0) { await new Promise(res => setTimeout(res, 61_000)); continue }
    if (!r.ok) throw new Error(`${r.status} ${j.error?.status ?? ''} ${String(j.error?.message ?? '').slice(0, 120)}`.trim())
    return j
  }
}
