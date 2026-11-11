// B6 · Jira Server (jiraHost in data/config.json; built against 8.16.1): issues assigned to the person running this copy, in three columns
// Đã giao / In Progress / Done (Done of the last 14 days). Read-only.
// Access, in order: a Personal Access Token in .env (JIRA_PAT), else the browser bridge (the person's
// logged-in Chrome session, Phase 5) if that module is installed. Probed 2026-11-08: a wrong PAT does
// NOT fail, Jira answers 200 with an empty list as user "anonymous", so every reply is checked.
import { cut, empty, esc, link, pill, section, stale } from '../core/html.ts'
import { JIRA_HOST } from '../config.ts'
import { NotConfigured, type Alert, type Module } from '../core/types.ts'
import { bridgeFetch, hasProfile, initBridge, PROFILES, type Profile } from '../lib/bridge.ts'

export const JIRA = JIRA_HOST
// The Chrome profile signed in with the company account; JIRA_PROFILE=publisher if Jira is open in the other one.
const JIRA_PROFILE: Profile = (process.env.JIRA_PROFILE as Profile) || 'falcon'
export const JQL = 'assignee = currentUser() AND (statusCategory != Done OR updated >= -14d) ORDER BY updated DESC'
export const SEARCH_PATH = `/rest/api/2/search?${new URLSearchParams({ jql: JQL, fields: 'summary,status,priority,duedate,updated,project,issuetype', maxResults: '100' })}`

export type Issue = { key: string; summary: string; status: string; cat: 'new' | 'indeterminate' | 'done'; priority: string; due: string | null; updated: number; project: string; type: string }
export type JiraData = { via: 'pat' | 'browser'; user: string; issues: Issue[] }

/** Jira search JSON → issues. */
export function parseIssues(j: any): Issue[] {
  return (j?.issues ?? []).map((i: any) => ({
    key: String(i.key), summary: String(i.fields?.summary ?? ''), status: String(i.fields?.status?.name ?? ''),
    cat: (['new', 'indeterminate', 'done'].includes(i.fields?.status?.statusCategory?.key) ? i.fields.status.statusCategory.key : 'new') as Issue['cat'],
    priority: String(i.fields?.priority?.name ?? ''), due: i.fields?.duedate ?? null, updated: Date.parse(i.fields?.updated ?? '') || 0,
    project: String(i.fields?.project?.key ?? ''), type: String(i.fields?.issuetype?.name ?? ''),
  }))
}

async function viaPat(pat: string, signal: AbortSignal): Promise<JiraData> {
  const r = await fetch(JIRA + SEARCH_PATH, { headers: { authorization: `Bearer ${pat}`, accept: 'application/json' }, signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) })
  const user = r.headers.get('x-ausername') ?? ''
  if (!r.ok) throw new Error(`Jira HTTP ${r.status}`)
  if (!user || user === 'anonymous') throw new Error('Jira coi PAT là khách (anonymous): PAT sai hoặc hết hạn')
  return { via: 'pat', user, issues: parseIssues(await r.json()) }
}

const COLS: { cat: Issue['cat']; title: string; none: string }[] = [
  { cat: 'new', title: 'Đã giao', none: 'Không có issue mới nào.' },
  { cat: 'indeterminate', title: 'In Progress', none: 'Không có issue nào đang làm.' },
  { cat: 'done', title: 'Done (14 ngày)', none: 'Chưa xong issue nào trong 14 ngày.' },
]
/** 2026-11-06 → 06/11 (the year only when it is not this year's). */
const dm = (d: string, today: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}${d.slice(0, 4) === today.slice(0, 4) ? '' : `/${d.slice(0, 4)}`}`

// Scoped styles (docs/ui.md): every selector starts with .jira-, tokens only, mobile first.
const CSS = String.raw`
@media (min-width: 48rem) { .jira-panel { grid-column: 1 / -1 } }
@media (min-width: 80rem) { .jira-panel { grid-column: span 2 } }
@media (min-width: 120rem) { .jira-panel { grid-column: span 3 } }
.jira-panel { container-type: inline-size }
.jira-cols { display: grid; grid-template-columns: minmax(0, 1fr) }
.jira-col { display: grid; gap: var(--space-sm); align-content: start; min-width: 0; padding: var(--space-md) 0 }
.jira-col:first-child { padding-top: 0 } .jira-col:last-child { padding-bottom: 0 }
.jira-col + .jira-col { border-top: 1px solid var(--rule) }
.jira-head { display: flex; align-items: center; gap: var(--space-xs) }
.jira-n { min-width: 24px; height: 22px; padding: 0 var(--space-xs); border-radius: var(--radius-pill); background: var(--paper-3); color: var(--ink-2);
  display: inline-grid; place-items: center; font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums }
.jira-item { display: grid; gap: var(--space-2xs) }
.jira-top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-sm) }
.jira-key { font-family: var(--mono); font-size: var(--text-sm); font-weight: 600 }
.jira-due { margin-left: auto; color: var(--muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums }
.jira-top .pill { margin-left: auto }
.jira-sum { overflow-wrap: anywhere }
.jira-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-sm); font-size: var(--text-sm); color: var(--muted) }
.jira-make { margin-left: auto; display: inline-flex; align-items: center; min-height: 32px; font-weight: 500; white-space: nowrap }
@media (pointer: coarse) { .jira-make { min-height: 44px } }
@container (min-width: 44rem) {
  .jira-cols { grid-template-columns: repeat(3, minmax(0, 1fr)) }
  .jira-col, .jira-col:first-child, .jira-col:last-child { padding: 0 var(--space-md) }
  .jira-col:first-child { padding-left: 0 } .jira-col:last-child { padding-right: 0 }
  .jira-col + .jira-col { border-top: 0; border-left: 1px solid var(--rule) }
}
`

export const jira: Module<JiraData> = {
  id: 'jira', title: 'Jira', group: 'develop', every: 5 * 60, timeout: 150,
  css: CSS,

  init: initBridge,

  async collect({ signal, db }) {
    if (!JIRA) throw new NotConfigured('đặt jiraHost trong data/config.json')
    const pat = process.env.JIRA_PAT
    if (pat) return viaPat(pat, signal)
    // no PAT: the same JSON endpoint through the person's logged-in Chrome (bridge, Phase 5)
    if (!hasProfile(JIRA_PROFILE)) throw new NotConfigured(`đặt JIRA_PAT trong .env, hoặc thêm chromeProfiles.${JIRA_PROFILE} vào data/config.json`)
    const r = await bridgeFetch(db, JIRA_PROFILE, JIRA + SEARCH_PATH, signal)
    const user = r.headers['x-ausername'] ?? ''
    if (r.status !== 200) throw new Error(`Jira HTTP ${r.status} (qua Chrome)`)
    if (!user || user === 'anonymous') throw new Error(`${PROFILES[JIRA_PROFILE]} chưa đăng nhập Jira: Jira trả về khách`)
    return { via: 'browser', user, issues: parseIssues(JSON.parse(r.body)) }
  },

  panel(s, v) {
    const d = s?.data
    if (!d) return section(this.title, `${stale(s, v.now)}${empty('Chưa đọc được Jira.')}`, '', '', { cls: 'jira-panel' })
    const today = new Date(v.now).toISOString().slice(0, 10)
    const item = (i: Issue) => {
      const late = i.due && i.due < today && i.cat !== 'done'
      return `<li class="jira-item"><div class="jira-top"><span class="jira-key">${link(`${JIRA}/browse/${i.key}`, i.key)}</span>
        ${late ? pill('bad', `quá hạn ${dm(i.due!, today)}`) : i.due ? `<span class="jira-due">hạn ${esc(dm(i.due, today))}</span>` : ''}</div>
        <p class="jira-sum">${esc(cut(i.summary, 140))}</p>
        <div class="jira-meta"><span>${esc(i.status)}</span>${i.priority ? `<span>${esc(i.priority)}</span>` : ''}
        <a class="jira-make" href="${esc(`/develop/new?${new URLSearchParams({ title: `${i.key}: ${i.summary}`.slice(0, 200), body: `Jira ${JIRA}/browse/${i.key}\n${i.summary}`, jira: i.key })}`)}">Tạo task</a></div></li>`
    }
    const col = (c: typeof COLS[number]) => {
      const xs = d.issues.filter(i => i.cat === c.cat)
      return `<div class="jira-col"><div class="jira-head"><h3>${esc(c.title)}</h3><span class="jira-n">${xs.length}</span></div>
        ${xs.length ? `<ul class="list">${xs.map(item).join('')}</ul>` : empty(c.none)}</div>`
    }
    return section(this.title, `${stale(s, v.now)}<div class="jira-cols">${COLS.map(col).join('')}</div>`,
      `issue giao cho ${d.user}, đọc qua ${d.via === 'pat' ? 'PAT' : 'Chrome'}`, '', { cls: 'jira-panel' })
  },

  alerts(s, v): Alert[] {
    const today = new Date(v.now).toISOString().slice(0, 10)
    return (s?.data?.issues ?? []).filter(i => i.cat !== 'done' && i.due && i.due < today)
      .map(i => ({ tone: 'warn', text: `Jira ${i.key} quá hạn ${i.due}: ${cut(i.summary, 60)}`, href: '/develop' }))
  },
}
