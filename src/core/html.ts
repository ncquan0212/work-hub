// Rendering helpers shared by every module. Everything that comes from a source (transcript prompts,
// crash titles, mail subjects, RC keys) is untrusted text: pass it through esc() before it reaches HTML.
import type { Tone } from './types.ts'

export const TZ = 'Asia/Ho_Chi_Minh'

export const esc = (v: unknown) => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)

export function ago(t: number | null | undefined, now: number) {
  if (!t) return '—'
  const m = Math.round((now - t) / 60_000)
  if (m < 1) return 'vừa xong'
  if (m < 60) return `${m} phút trước`
  if (m < 48 * 60) return `${Math.round(m / 60)} giờ trước`
  return `${Math.round(m / 1440)} ngày trước`
}
export function until(t: number, now: number) {
  const m = Math.round((t - now) / 60_000)
  if (m < 1) return 'sắp chạy'
  if (m < 60) return `${m} phút nữa`
  if (m < 48 * 60) return `${Math.round(m / 60)} giờ nữa`
  return `${Math.round(m / 1440)} ngày nữa`
}
export const clock = (t: number) =>
  new Date(t).toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' })
/** Grouped integer; null/undefined render as "—" (older snapshots may lack a field). */
export const num = (x: unknown, digits = 0) =>
  x == null || Number.isNaN(Number(x)) ? '—' : Number(x).toLocaleString('vi-VN', { maximumFractionDigits: digits, minimumFractionDigits: digits })
export const pct = (x: number | null | undefined, digits = 1) => x == null ? '—' : `${(x * 100).toFixed(digits)}%`
export const cut = (s: unknown, n: number) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t }
/** A status chip: tone colour plus a word, in sentence case on every page. */
export const pill = (tone: Tone, text: string) =>
  `<span class="pill ${tone}">${esc(text === 'ok' ? 'OK' : text.charAt(0).toLocaleUpperCase('vi') + text.slice(1))}</span>`
/** A link only for http(s) URLs from a source; anything else renders as plain text. */
export const link = (href: unknown, text: string) =>
  /^https:\/\//.test(String(href ?? '')) ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>` : esc(text)

export type PanelOpts = {
  span?: 2 | 3 | 'all' // columns on the board: 2 or 3 where the board has them, 'all' = the full row
  act?: string        // trusted HTML at the right of the heading (a link to the detail page)
  cls?: string        // extra class names, for the module's own CSS
}
/** A panel on the board: heading, optional note beside it, body. */
export const section = (title: string, body: string, note = '', id = '', o: PanelOpts = {}) => {
  const cls = ['panel', o.span ? `span-${o.span}` : '', o.cls ?? ''].filter(Boolean).join(' ')
  return `<section class="${esc(cls)}"${id ? ` id="${esc(id)}"` : ''}><header class="panel-head"><h2>${esc(title)}</h2>${note ? `<p class="note">${esc(note)}</p>` : ''}${o.act ? `<span class="act">${o.act}</span>` : ''}</header>${body}</section>`
}

/** The board: panels flow into 1 / 2 / 3 / 4 columns by width. */
export const board = (inner: string) => `<div class="board">${inner}</div>`
/** A heading row across the whole board, between groups of panels. */
export const boardHead = (title: string, note = '', act = '') => `<div class="board-head"><h2>${esc(title)}</h2>${note ? `<p>${esc(note)}</p>` : ''}${act ? `<span class="act">${act}</span>` : ''}</div>`

/** ▲/▼ and the percentage; tone by whether up is good. Empty for a missing or non-finite value. */
export function delta(x: number | null | undefined, upIsGood = true, label = '') {
  if (x == null || !Number.isFinite(x)) return ''
  const tone = Math.abs(x) < 0.02 ? 'muted' : (x > 0) === upIsGood ? 'ok-t' : 'bad-t'
  return `<span class="delta ${tone}">${x > 0 ? '▲' : x < 0 ? '▼' : ''}${esc(Math.abs(x * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1, minimumFractionDigits: 1 }))}%</span>${label ? ` <span class="muted">${esc(label)}</span>` : ''}`
}

/** A muted line for a source this copy has not set up (NotConfigured). */
export const unsetNote = (msg: string) => `<p class="sub muted">Chưa cấu hình: ${esc(cut(msg, 200))}</p>`

/** Error line for a failed source; keeps the old numbers visible below it. */
export const stale = (s: { ok: boolean; error?: string; unset?: string; dataAt?: number } | undefined, now: number) =>
  s?.unset ? unsetNote(s.unset) : s && !s.ok ?`<div class="sub warn-t">Lỗi lần chạy cuối: ${esc(cut(brief(s.error), 160))}${s.dataAt ? `, số từ ${esc(ago(s.dataAt, now))}` : ''}</div>` : ''

/** A collector error for the page: without the raw agent reply some errors carry (the Ops health table keeps it all). */
export const brief = (e: unknown) => String(e ?? '').split('. Agent trả lời')[0]

export const empty = (text: string) => `<p class="empty">${esc(text)}</p>`
