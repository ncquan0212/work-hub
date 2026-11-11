// Reading sites that have no API we may use, through the person's own logged-in Chrome (owner rules R1,
// R6, R7). A module queues a job here; the work-hub extension in that Chrome profile picks it up from
// the bridge endpoint (modules/bridge), does a GET in the profile (a fetch with its cookies, or a page
// opened in a background tab and read), and posts the result back. Read-only: no clicks, no forms.
import type { DatabaseSync } from 'node:sqlite'
import { JIRA_HOST, PROFILE_LABELS, type ProfileRole } from '../config.ts'
import { NotConfigured } from '../core/types.ts'

/** A role, not a profile name: `falcon` = the Chrome profile signed in with the company account, `publisher` = the
 *  publisher mailbox's. Which profile plays which role, and its label, come from data/config.json chromeProfiles. */
export type Profile = ProfileRole
export const PROFILES: Record<Profile, string> = {
  falcon: PROFILE_LABELS.falcon ?? 'Chrome (tài khoản công ty)',
  publisher: PROFILE_LABELS.publisher ?? 'Chrome (hộp thư publisher)',
}
/** Whether this copy has a Chrome profile for the role: none = the modules that need it say "chưa cấu hình". */
export const hasProfile = (p: Profile) => !!PROFILE_LABELS[p]

export type FetchResult = { status: number; finalUrl: string; headers: Record<string, string>; body: string }
export type PageResult = { finalUrl: string; title: string; text: string; jsonld: unknown[]; tables: string[][][]; links: [href: string, text: string][] }

export function initBridge(db: DatabaseSync) {
  db.exec(`create table if not exists bridge_jobs (
    id integer primary key, profile text not null, kind text not null, url text not null, wait_for text,
    status text not null default 'queued', result text, error text,
    created_at integer not null, taken_at integer, done_at integer);
    create table if not exists bridge_seen (profile text primary key, at integer not null, version text)`)
}

/** The extension calls in every minute; a profile not seen for 5 minutes is treated as absent. */
export function markSeen(db: DatabaseSync, profile: Profile, version: string) {
  db.prepare('insert into bridge_seen (profile, at, version) values (?, ?, ?) on conflict (profile) do update set at = excluded.at, version = excluded.version').run(profile, Date.now(), version)
}
export function lastSeen(db: DatabaseSync, profile: Profile) {
  return (db.prepare('select at from bridge_seen where profile = ?').get(profile) as { at: number } | undefined)?.at ?? null
}

/** Allow-list: the extension refuses anything else too (its manifest host_permissions). */
export const ALLOWED = [/^https:\/\/mail\.google\.com\/mail\/u\/\d+\/feed\/atom(\/[\w-]+)?$/, /^https:\/\/play\.google\.com\/console\//, /^https:\/\/admob\.google\.com\//, ...(JIRA_HOST ? [new RegExp(`^${RegExp.escape(JIRA_HOST)}/rest/api/2/`)] : [])]

async function waitJob(db: DatabaseSync, id: number, signal: AbortSignal, timeoutMs: number) {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    const j = db.prepare('select status, result, error from bridge_jobs where id = ?').get(id) as { status: string; result: string | null; error: string | null }
    if (j.status === 'done') return JSON.parse(j.result ?? 'null')
    if (j.status === 'failed') throw new Error(`Chrome: ${j.error ?? 'lỗi'}`)
    await new Promise(r => setTimeout(r, 1000))
  }
  db.prepare(`update bridge_jobs set status = 'failed', error = 'hết giờ chờ' where id = ? and status in ('queued', 'taken')`).run(id)
  throw new Error('Chrome không trả kết quả kịp')
}

function queue(db: DatabaseSync, profile: Profile, kind: 'fetch' | 'page', url: string, waitFor?: string) {
  if (!ALLOWED.some(r => r.test(url))) throw new Error(`URL ngoài danh sách cho phép: ${url.slice(0, 80)}`)
  if (!hasProfile(profile)) throw new NotConfigured(`thêm chromeProfiles.${profile} vào data/config.json, rồi cài extension trong Chrome đó (docs/config.md)`)
  const seen = lastSeen(db, profile)
  // fail fast instead of queueing work nobody will pick up
  if (!seen) throw new Error(`extension work-hub chưa kết nối từ ${PROFILES[profile]} (chưa cài)`)
  if (Date.now() - seen > 5 * 60_000) throw new Error(`extension ở ${PROFILES[profile]} im lặng từ ${new Date(seen).toLocaleString('vi-VN')} (Chrome tắt hoặc profile chưa mở)`)
  return Number(db.prepare('insert into bridge_jobs (profile, kind, url, wait_for, created_at) values (?, ?, ?, ?, ?)').run(profile, kind, url, waitFor ?? null, Date.now()).lastInsertRowid)
}

/** GET `url` with the profile's cookies (credentials: include) from the extension. */
export async function bridgeFetch(db: DatabaseSync, profile: Profile, url: string, signal: AbortSignal, timeoutMs = 120_000): Promise<FetchResult> {
  return waitJob(db, queue(db, profile, 'fetch', url), signal, timeoutMs)
}

/** Open `url` in a background tab of the profile, wait for `waitFor` (CSS selector) or load, return its text. */
export async function bridgePage(db: DatabaseSync, profile: Profile, url: string, signal: AbortSignal, waitFor?: string, timeoutMs = 180_000): Promise<PageResult> {
  return waitJob(db, queue(db, profile, 'page', url, waitFor), signal, timeoutMs)
}

/** Did the page land on a Google sign-in / marketing page instead of the console? (probed 2026-11-08) */
export function loggedOut(finalUrl: string) {
  return /accounts\.google\.com\/(ServiceLogin|signin|v3\/signin|.*challenge)/.test(finalUrl) || /^https:\/\/google\.play\/business/.test(finalUrl)
}
