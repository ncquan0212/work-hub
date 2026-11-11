// What differs from one person's hub to the next: read once from a per-person JSON file that git never sees.
// The file is data/config.json (HUB_CONFIG overrides the path; the tests point it at test/fixtures/config.json).
// Every field is optional: with no file at all the hub is local only, follows no app, and Chrome mode is off.
// Fields and where to find their values: docs/config.md. Template: config.example.json.
// Module-only constants live in the module; this file holds only what more than one module reads.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { AccessConfig } from './core/access.ts'

export const HOME = homedir()
// HUB_DATA points a preview server at a copy of data/ (UI work with sample rows, never the real hub.db)
export const DATA = process.env.HUB_DATA || join(import.meta.dirname, '../data')
export const PORT = Number(process.env.PORT ?? 8787)
export const CONFIG_FILE = resolve(process.env.HUB_CONFIG || join(DATA, 'config.json'))

export type App = {
  key: string
  name: string
  pkg: string                       // Android applicationId = Databuckets app_id = Play package
  repo?: string                     // absolute after loading (the file may use ~/… or a path relative to codeDir)
  gradle?: string; pbxproj?: string // version files, relative to repo
  infoPlist?: string                // the app target's INFOPLIST_FILE as written in project.pbxproj
  rcKey?: string                    // Remote Config service-account file in rcKeyDir (read in place, never copied)
  appId?: string                    // Firebase Android app id, for Crashlytics
  playDev?: string                  // Play Console developer account id (the number in its console URLs)
  playAccount?: string              // that account's name, for the page
  storeTitle?: string               // the app's title in Play Console's app list (defaults to name)
  feedbackSubject?: string          // regex, case-insensitive: subjects of this app's feedback mails
}
export type Repo = { key: string; name: string; repo: string }
export type Browser = { id: string; name: string }
/** Chrome profiles the bridge extension runs in, by role: `falcon` = signed in to Chrome with the company account
 *  (Play Console, Jira), `publisher` = the publisher mailbox (Gmail feedback, AdMob). The value is the label shown. */
export type ProfileRole = 'falcon' | 'publisher'

type File = {
  modules?: string[]
  codeDir?: string
  rcKeyDir?: string
  apps?: App[]
  repos?: Repo[]
  access?: { tailnetHost?: string; devices?: Record<string, string[]> }
  chromeBrowsers?: Browser[]
  chromeNote?: string
  chromeProfiles?: Partial<Record<ProfileRole, string>>
  databucketsDataset?: string
  jiraHost?: string
  chromeDomains?: Record<string, ProfileRole>
  companyDomains?: string[]
  ai?: string
}

/** Modules on when the file names none: the ones that need no account, plus those that follow the apps in the file
 *  (owner 2026-11-11: teammates' hubs call Databuckets too). A module of this list with no app or no login says
 *  "chưa cấu hình" instead of failing. */
export const DEFAULT_MODULES = ['develop', 'agents', 'repos', 'notify', 'report', 'track', 'crash', 'rc', 'listing']

function load(): File {
  if (!existsSync(CONFIG_FILE)) return {}
  let raw: unknown
  try { raw = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) } catch (e) { throw new Error(`${CONFIG_FILE}: không đọc được JSON (${(e as Error).message})`) }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: phải là một object JSON`)
  const f = raw as File
  const keys = new Set<string>()
  for (const a of f.apps ?? []) {
    if (!a?.key || !a.name || !a.pkg) throw new Error(`${CONFIG_FILE}: mỗi app cần key, name và pkg`)
    if (keys.has(a.key)) throw new Error(`${CONFIG_FILE}: key app trùng: ${a.key}`)
    keys.add(a.key)
    // gmail compiles it when the registry imports the module: a typo would stop the hub with a raw SyntaxError
    if (a.feedbackSubject) try { new RegExp(a.feedbackSubject, 'i') } catch { throw new Error(`${CONFIG_FILE}: feedbackSubject của app ${a.key} không phải regex hợp lệ`) }
  }
  if (f.jiraHost && !/^https:\/\/[^/]+\/?$/.test(f.jiraHost)) throw new Error(`${CONFIG_FILE}: jiraHost phải có dạng https://jira.cong-ty.com`)
  for (const [d, role] of Object.entries(f.chromeDomains ?? {}))
    if (role !== 'falcon' && role !== 'publisher') throw new Error(`${CONFIG_FILE}: chromeDomains["${d}"] phải là "falcon" hoặc "publisher"`)
  for (const [n, ips] of Object.entries(f.access?.devices ?? {}))
    if (!Array.isArray(ips) || !ips.every(x => typeof x === 'string')) throw new Error(`${CONFIG_FILE}: access.devices["${n}"] phải là mảng IP`)
  for (const r of f.repos ?? []) {
    if (!r?.key || !r.name || !r.repo) throw new Error(`${CONFIG_FILE}: mỗi repo cần key, name và repo`)
    if (keys.has(r.key)) throw new Error(`${CONFIG_FILE}: key repo trùng: ${r.key}`)
    keys.add(r.key)
  }
  return f
}
const file = load()

/** ~/x → under HOME; a relative path → under `base`; an absolute one stays. */
export function expand(p: string, base: string) {
  if (p === '~') return HOME
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(HOME, p.slice(2))
  return isAbsolute(p) ? p : join(base, p)
}

export const CODE = expand(file.codeDir ?? '~/Code', HOME)
/** Where the Remote Config service-account keys (and the owner's rc.py) live, read in place. */
export const RC_DIR = expand(file.rcKeyDir ?? join(CODE, 'tv-rc'), CODE)
export const rcKeyPath = (a: App) => a.rcKey ? expand(a.rcKey, RC_DIR) : null

export const APPS: App[] = (file.apps ?? []).map(a => ({ ...a, repo: a.repo ? expand(a.repo, CODE) : undefined }))

/** Repos whose git state is shown and that Develop tasks run in: each app's repo, then the extra ones. */
export const REPOS: Repo[] = [
  ...APPS.filter(a => a.repo).map(a => ({ key: a.key, name: a.name, repo: a.repo! })),
  ...(file.repos ?? []).map(r => ({ ...r, repo: expand(r.repo, CODE) })),
]

// Which devices may open the hub through `tailscale serve` (tailnet IPs from `tailscale status`). No tailnetHost =
// local only: http://127.0.0.1:PORT on this machine. A device that re-joins the tailnet gets a new IP: update the file.
export const ACCESS: AccessConfig = {
  port: PORT,
  tailnetHost: file.access?.tailnetHost ?? '',
  devices: file.access?.devices ?? {},
}

// The Chrome browsers a Develop task with "Chrome" on may drive, in order of preference, by the deviceId
// mcp__claude-in-chrome__list_connected_browsers shows. Empty = Chrome mode off: on a shared Claude seat the list
// shows everyone's browsers, so a task may only ever pick one named here. Reconnecting may give a new id.
export const CHROME_BROWSERS: Browser[] = file.chromeBrowsers ?? []
/** One line for Develop tasks: which of those browsers is signed in to what (e.g. "Play Console ở Profile 1"). */
export const CHROME_NOTE = file.chromeNote ?? ''

/** Bridge roles this copy has a Chrome profile for, with the label shown on pages and in errors. */
export const PROFILE_LABELS: Partial<Record<ProfileRole, string>> = file.chromeProfiles ?? {}

/** Databuckets dataset every Report and Track query reads. Empty = Databuckets not set up (no call is made). */
export const DATASET = file.databucketsDataset ?? ''

// Company values live here, not in the code (the repo is public, owner 2026-11-11):
/** Jira Server/DC address: the Jira panel, and the one Jira API path the hub and the extension may read. '' = no Jira. */
export const JIRA_HOST = (file.jiraHost ?? '').replace(/\/+$/, '')
/** Which bridge role a Chrome profile plays, by the domain of the account signed in to Chrome (built into the extension). */
export const CHROME_DOMAINS: Record<string, ProfileRole> = file.chromeDomains ?? {}
/** Mail from these domains is the company's own, not user feedback (Gmail panel). Default: the chromeDomains. */
export const COMPANY_DOMAINS = file.companyDomains ?? Object.keys(CHROME_DOMAINS)

/** The AI that runs Develop tasks (src/lib/claude.ts is the only one so far; architecture.md "Đổi AI"). */
export const AI = file.ai ?? 'claude'

/** Module ids switched on in this copy. */
export const ENABLED = new Set(file.modules ?? DEFAULT_MODULES)
