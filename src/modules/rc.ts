// E4 · Remote Config per app: current version, who changed it and when, and which parameters and
// conditions that change touched (diff of the last two versions). GET only, with the RC service
// accounts already in RC_DIR (config rcKeyDir). Templates are fetched only when the version number moves.
import { existsSync } from 'node:fs'
import { APPS, RC_DIR, rcKeyPath, type App } from '../config.ts'
import { ago, cut, empty, esc, pill, section, stale } from '../core/html.ts'
import { NotConfigured, type Module } from '../core/types.ts'
import { getJson, serviceAccountProject, serviceAccountToken } from '../lib/google.ts'

const API = 'https://firebaseremoteconfig.googleapis.com/v1/projects'

type Template = { conditions?: { name: string; expression?: string }[]; parameters?: Record<string, unknown>; parameterGroups?: Record<string, { parameters?: Record<string, unknown> }> }
export type Diff = { added: string[]; removed: string[]; changed: string[]; condAdded: string[]; condRemoved: string[]; condChanged: string[]; condOrder?: boolean }

/** JSON with sorted keys, so two equal values always compare equal. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canon((v as any)[k])}`).join(',')}}`
  return JSON.stringify(v)
}

function params(t: Template) {
  const out = new Map<string, string>()
  for (const [k, p] of Object.entries(t.parameters ?? {})) out.set(k, canon(p))
  for (const g of Object.values(t.parameterGroups ?? {})) for (const [k, p] of Object.entries(g.parameters ?? {})) out.set(k, canon(p))
  return out
}

/** What changed from template `a` (older) to `b` (newer): parameter keys and condition names. */
export function diffTemplates(a: Template, b: Template): Diff {
  const pa = params(a), pb = params(b)
  const ca = new Map((a.conditions ?? []).map(c => [c.name, canon(c)])), cb = new Map((b.conditions ?? []).map(c => [c.name, canon(c)]))
  const sorted = (x: string[]) => x.sort((p, q) => p.localeCompare(q))
  return {
    added: sorted([...pb.keys()].filter(k => !pa.has(k))),
    removed: sorted([...pa.keys()].filter(k => !pb.has(k))),
    changed: sorted([...pb.keys()].filter(k => pa.has(k) && pa.get(k) !== pb.get(k))),
    condAdded: sorted([...cb.keys()].filter(k => !ca.has(k))),
    condRemoved: sorted([...ca.keys()].filter(k => !cb.has(k))),
    condChanged: sorted([...cb.keys()].filter(k => ca.has(k) && ca.get(k) !== cb.get(k))),
    // conditions are evaluated top-down: reordering changes who gets which value
    condOrder: [...ca.keys()].filter(k => cb.has(k)).join('\n') !== [...cb.keys()].filter(k => ca.has(k)).join('\n'),
  }
}

export type RcRow = { key: string; name: string; error?: string; version?: number; at?: number; by?: string; origin?: string; prev?: number; diff?: Diff | null }

const diffCache = new Map<string, { version: number; prev?: number; diff: Diff | null }>()
const who = (email: string) => email.includes('gserviceaccount.com') ? 'rc.py' : email

async function one(a: App, signal: AbortSignal): Promise<RcRow> {
  try {
    const file = rcKeyPath(a)!
    const project = serviceAccountProject(file), tok = await serviceAccountToken(file)
    const j = await getJson(`${API}/${project}/remoteConfig:listVersions?pageSize=2`, tok, signal)
    const [v, p] = j.versions ?? []
    if (!v) return { key: a.key, name: a.name, error: 'không có version nào' }
    const version = Number(v.versionNumber), prev = p ? Number(p.versionNumber) : undefined
    let c = diffCache.get(project)
    if (!c || c.version !== version) {
      let diff: Diff | null = null
      if (prev != null) {
        const tb = await getJson(`${API}/${project}/remoteConfig?versionNumber=${version}`, tok, signal)
        const ta = await getJson(`${API}/${project}/remoteConfig?versionNumber=${prev}`, tok, signal)
        diff = diffTemplates(ta, tb)
      }
      diffCache.set(project, c = { version, prev, diff })
    }
    return { key: a.key, name: a.name, version, at: Date.parse(v.updateTime), by: who(v.updateUser?.email ?? '?'), origin: v.updateOrigin, prev, diff: c.diff }
  } catch (e) {
    if (signal.aborted) throw e
    return { key: a.key, name: a.name, error: (e as Error).message }
  }
}

// One block per app: name, version, when, who, then the changed names as chips on a label column.
const CSS = String.raw`
.rc-list > li { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2xs); min-width: 0 }
.rc-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); min-width: 0 }
.rc-head b { font-weight: 600 }
.rc-ver { font: 500 var(--text-sm)/1.4 var(--mono); color: var(--ink-2) }
.rc-when { margin-left: auto; font-size: var(--text-sm); color: var(--muted); white-space: nowrap }
.rc-by { font-size: var(--text-sm); color: var(--muted); overflow-wrap: anywhere }
.rc-diff { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-2xs); margin: var(--space-2xs) 0 0; font-size: var(--text-sm) }
.rc-diff > div { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2xs) var(--space-2xs) }
.rc-diff dt { color: var(--muted); margin-right: var(--space-2xs) }
.rc-diff dd { display: contents }
.rc-diff .ok-t, .rc-diff .bad-t { font-weight: 600 }
.rc-same { font-size: var(--text-sm); color: var(--muted) }
.rc-order { font-size: var(--text-sm); color: var(--warn) }
`

/** One app's last change; the same block on /ops and on Hôm nay. */
function change(r: RcRow, v: { now: number }, flagRecent: boolean, max = 12) {
  const head = `<div class="rc-head"><b>${esc(r.name)}</b>`
  if (r.error) return `<li>${head}</div><p class="sub bad-t">Lỗi: ${esc(cut(r.error, 160))}</p></li>`
  const recent = flagRecent && r.at && v.now - r.at < 86_400_000
  return `<li>${head}<span class="rc-ver">v${esc(r.version)}</span>${recent ? pill('info', 'đổi trong 24h') : ''}<span class="rc-when">${esc(ago(r.at, v.now))}</span></div>
    <div class="rc-by">${esc(r.by)}</div>${diffList(r, max)}</li>`
}

export const rc: Module<RcRow[]> = {
  id: 'rc', title: 'Remote Config', group: 'ops', every: 15 * 60, timeout: 120, css: CSS,

  async collect({ signal }) {
    if (!APPS.length) throw new NotConfigured('chưa có app trong data/config.json')
    // not one key on this machine: RC is not set up here. Only some missing: those apps show their own error
    if (!APPS.some(a => { const f = rcKeyPath(a); return f && existsSync(f) })) throw new NotConfigured(`chưa có file key Remote Config nào trong ${RC_DIR} (trường rcKey của app trong data/config.json)`)
    const out: RcRow[] = []
    for (const a of APPS.filter(x => x.rcKey)) out.push(await one(a, signal)) // one app at a time: parallel template GETs drew 503s
    if (out.length && out.every(r => r.error)) throw new Error(out[0].error!) // every app failed: keep the old numbers, raise the alert
    return out
  },

  panel(s, v) {
    const o = { cls: 'rc' }
    if (!s?.data) return section(this.title, empty('Đang lấy lần đầu…'), '', 'rc', o)
    return section(this.title, `${stale(s, v.now)}<ul class="list rc-list">${s.data.map(r => change(r, v, true)).join('')}</ul>`,
      'chỉ tên tham số, không hiện giá trị', 'rc', o)
  },

  today(s, v) {
    const recent = (s?.data ?? []).filter(r => r.at && v.now - r.at < 86_400_000)
    if (!recent.length) return ''
    return section('Remote Config 24h', `<ul class="list rc-list">${recent.map(r => change(r, v, false, 6)).join('')}</ul>`, '', '',
      { cls: 'rc-today', act: '<a href="/ops#rc">Xem chi tiết</a>' })
  },
}

function diffList(r: RcRow, max: number) {
  const d = r.diff
  if (!d) return '<p class="rc-same">Không có version trước để so.</p>'
  const keys = (label: string, xs: string[], tone = '') => xs.length
    ? `<div><dt${tone ? ` class="${tone}"` : ''}>${esc(label)}</dt><dd>${xs.slice(0, max).map(k => `<span class="tag">${esc(k)}</span>`).join('')}${xs.length > max ? `<span class="muted">+${xs.length - max}</span>` : ''}</dd></div>` : ''
  const body = keys('Sửa', d.changed) + keys('Thêm', d.added, 'ok-t') + keys('Xoá', d.removed, 'bad-t')
    + keys('Điều kiện sửa', d.condChanged) + keys('Điều kiện thêm', d.condAdded) + keys('Điều kiện xoá', d.condRemoved)
  const order = d.condOrder ? '<p class="rc-order">Thứ tự điều kiện đổi, tức là thứ tự ưu tiên đổi.</p>' : ''
  return body || order ? `${body ? `<dl class="rc-diff">${body}</dl>` : ''}${order}` : `<p class="rc-same">Không đổi tham số nào so với v${esc(r.prev)}.</p>`
}
