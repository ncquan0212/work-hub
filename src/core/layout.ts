// The page shell: brand row with the clock, the group tabs (a bottom dock on phones), the page heading,
// the stylesheet; or, `bare`, the body alone (a chart's full-screen view, which brings its own heading). No script anywhere; dashboards reload themselves every 60 s, pages with forms don't
// (a reload would wipe what the owner is typing).
import { esc, TZ } from './html.ts'
import { CSS } from './style.ts'

export type NavItem = { path: string; label: string; badge?: number }
/** The bell beside the clock: where the notifications page is (the module that has it says, through lib/notify.ts) and how many are unread. */
export type Bell = { href: string; count: number }

// 24px line icons, drawn for this hub (stroke = currentColor)
const ICON: Record<string, string> = {
  '/': '<rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 10h17M8 3v4M16 3v4"/><path d="M8 14.5h3"/>',
  '/develop': '<path d="M8.5 8 4.5 12l4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13"/>',
  '/report': '<path d="M4 19.5h16"/><path d="M6.5 15.5l4-5 3 3 4.5-6"/>',
  '/track': '<path d="M12 4v16M4.5 8.5h15"/><path d="M4.5 8.5 2.5 14a2.2 2.2 0 0 0 4 0zM19.5 8.5l-2 5.5a2.2 2.2 0 0 0 4 0z"/>',
  '/ops': '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h3M8 16.5h3"/>',
  '/feedback': '<path d="M5 5.5h14a1.5 1.5 0 0 1 1.5 1.5v8.5A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5V7A1.5 1.5 0 0 1 5 5.5z"/><path d="M8 10h8M8 13h5"/>',
}
const icon = (path: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[path] ?? ''}</svg>`
// the hub in the middle, the four apps around it: the same picture as the tab and home-screen icon (core/icon.svg)
const MARK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="currentColor"/><circle cx="5" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="19" cy="19" r="2"/><path d="M6.6 6.6 9.8 9.8M17.4 6.6l-3.2 3.2M6.6 17.4l3.2-3.2M17.4 17.4l-3.2-3.2"/></svg>'

const BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/></svg>'
const bellLink = (b: Bell) => `<a class="bell" href="${esc(b.href)}" aria-label="Thông báo${b.count ? `, ${b.count} chưa đọc` : ''}">${BELL}${b.count ? `<span class="count" aria-hidden="true">${b.count > 99 ? '99+' : b.count}</span>` : ''}</a>`

// Phone labels where the full one does not fit a sixth of 360px
const SHORT: Record<string, string> = { '/feedback': 'Phản hồi', '/ops': 'Vận hành' }

export function layout(o: { title: string; body: string; nav: NavItem[]; active: string; now: number; refresh: boolean; noscriptRefresh?: boolean; bare?: boolean; css?: string; bell?: Bell }) {
  const link = (n: NavItem, short: boolean) => `<a href="${esc(n.path)}"${n.path === o.active ? ' aria-current="page"' : ''}>${icon(n.path)}<span>${esc(short ? SHORT[n.path] ?? n.label : n.label)}</span>${n.badge ? `<span class="count" aria-label="${n.badge} việc cần để ý">${n.badge}</span>` : ''}</a>`
  const group = o.nav.find(n => n.path === o.active)
  // "Report · XRemote" on /report: the group is the crumb, the rest is the heading
  const prefix = group && o.active !== '/' ? `${group.label} · ` : ''
  const heading = prefix && o.title.startsWith(prefix) ? o.title.slice(prefix.length) : o.title
  const crumb = group && o.active !== '/' && heading !== group.label ? `<div class="crumb"><a href="${esc(group.path)}">${esc(group.label)}</a></div>` : ''
  const d = new Date(o.now)
  const time = d.toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
  const date = d.toLocaleDateString('vi-VN', { timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit' })
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="description" content="Hub làm việc: số của 4 app, task với Claude, A/B, vận hành và phản hồi user.">
<meta name="theme-color" content="#efeaf7" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0e0b16" media="(prefers-color-scheme: dark)">
${o.refresh ? '<meta http-equiv="refresh" content="60">' : o.noscriptRefresh ? '<noscript><meta http-equiv="refresh" content="60"></noscript>' : ''}<title>${esc(o.title)} · Work Hub</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/icon.png">
<style>${CSS}${o.css ?? ''}</style></head>${o.bare ? `<body class="bare"><main class="page">${o.body}</main></body></html>` : `<body>
<header class="top"><div class="top-in">
<a class="wordmark" href="/" aria-label="Work Hub, về trang Hôm nay">${MARK}Work Hub</a>
<nav class="tabs" aria-label="Nhóm">${o.nav.map(n => link(n, false)).join('')}</nav>
<div class="top-end">${o.bell ? bellLink(o.bell) : ''}<div class="clock"><b>${esc(time)}</b> ${esc(date)}<br>${o.refresh ? 'tự tải lại mỗi phút' : 'không tự tải lại'}</div></div>
</div></header>
<main class="page"><div class="page-head">${crumb}<h1>${esc(heading)}</h1></div>${o.body}</main>
<nav class="dock" aria-label="Nhóm" style="--n:${o.nav.length}">${o.nav.map(n => link(n, true)).join('')}</nav>
</body></html>`}`
}
