// The generic pages: Hôm nay (collects alerts, waiting items and summaries from every module), one page
// per group (each module's panel, in registry order), and the data-source health table.
import { ago, board, brief, cut, empty, esc, pill, section, until, unsetNote } from './html.ts'
import type { State } from './scheduler.ts'
import { GROUPS, type Alert, type GroupId, type Module, type View, type Waiting } from './types.ts'

/** Calls a module renderer; a bug in one module renders as a note instead of breaking the page. */
export function safe<T>(m: Module, what: string, f: () => T, fallback: T): T {
  try { return f() } catch (e) {
    console.log(JSON.stringify({ t: new Date().toISOString(), level: 'warn', msg: 'render failed', module: m.id, what,
      err: (e as Error).stack?.split('\n').slice(0, 3).join(' | ') }))
    return fallback
  }
}

export function collectAlerts(modules: Module[], state: State, v: View): Alert[] {
  const out: Alert[] = []
  for (const m of modules) {
    const s = state[m.id]
    if (s?.unset) continue // not set up in this copy: not a failure, and its old data raises nothing
    if (m.collect && s?.at && !s.ok) out.push({ tone: 'warn', label: 'Lỗi', text: `${m.title}: ${cut(brief(s.error), 90)}`, href: '/ops#health' })
    if (m.alerts) out.push(...safe(m, 'alerts', () => m.alerts!(s, v), [{ tone: 'warn', text: `${m.title}: lỗi hiển thị cảnh báo (xem log)` }]))
  }
  return out.sort((a, b) => (a.tone === 'bad' ? 0 : 1) - (b.tone === 'bad' ? 0 : 1))
}

/** "Source: what happened" → the source in bold, so a long list scans by app. */
function alertLine(a: Alert, v: View) {
  const i = a.text.indexOf(': ')
  const src = i > 0 && i < 40 ? a.text.slice(0, i) : '', rest = src ? a.text.slice(i + 2) : a.text
  const text = `${src ? `<span class="src">${esc(src)}</span> ` : ''}${esc(rest)}`
  const chip = a.tone === 'bad' ? pill('bad', 'Gấp') : a.label ? pill('warn', a.label) : ''
  const seen = a.seen ? `<form method="post" action="${esc(a.seen)}" class="alert-seen"><input type="hidden" name="_csrf" value="${esc(v.csrf)}"><button type="submit" class="ghost">Đã xem</button></form>` : ''
  return `<li${seen ? ' class="has-seen"' : ''}><span>${chip}${a.href ? `<a href="${esc(a.href)}">${text}</a>` : text}</span>${seen}</li>`
}

export function todayPage(modules: Module[], state: State, v: View) {
  const al = collectAlerts(modules, state, v)
  const waiting: (Waiting & { from: string })[] = []
  for (const m of modules) if (m.waiting && !state[m.id]?.unset) waiting.push(...safe(m, 'waiting', () => m.waiting!(state[m.id], v), []).map(w => ({ ...w, from: m.title })))
  waiting.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
  const alerts = al.length ? `<ul class="alerts">${al.map(a => alertLine(a, v)).join('')}</ul>` : '<p class="calm">Không có gì cần chú ý.</p>'
  const oneSource = new Set(waiting.map(w => w.from)).size === 1 // then the source goes in the heading note, not on every row
  const wl = waiting.length ? `<ul class="list">${waiting.map(w => `<li><div class="row">${oneSource ? '' : pill('info', w.from)}${w.href ? `<a href="${esc(w.href)}"><b>${esc(w.text)}</b></a>` : `<b>${esc(w.text)}</b>`}</div>
    <div class="sub muted">${w.sub ? esc(w.sub) : ''}${w.sub && w.at ? ', ' : ''}${w.at ? esc(ago(w.at, v.now)) : ''}</div></li>`).join('')}</ul>`
    : empty('Không có gì đang chờ bạn.')
  const summaries = modules.filter(m => m.today && !state[m.id]?.unset).map(m => safe(m, 'today', () => m.today!(state[m.id], v), '')).filter(Boolean).join('')
  return board(section('Cần để ý', alerts, al.length ? `${al.length} việc` : '', 'alerts', { span: 2 })
    + section('Đang chờ bạn', wl, waiting.length ? `${waiting.length} việc${oneSource ? `, từ ${waiting[0].from}` : ''}` : '', 'waiting') + summaries)
}

export function groupPage(group: GroupId, modules: Module[], state: State, v: View, next: Record<string, number> = {}) {
  const body = modules.filter(m => m.group === group && m.panel)
    // a source this copy has not set up: one muted line in place of its panel (old data would only mislead)
    .map(m => state[m.id]?.unset ? section(m.title, unsetNote(state[m.id]!.unset!), '', m.id) : safe(m, 'panel', () => m.panel!(state[m.id], v), section(m.title, '<p class="bad-t">Lỗi hiển thị phần này (xem log).</p>'))).join('')
  return board((body || empty('Chưa có phần nào trong nhóm này.')) + (group === 'ops' ? healthSection(modules, state, v.now, next) : ''))
}

const every = (m: Module) => m.daily ? `mỗi ngày ${m.daily}` : !m.every ? '' : m.every < 120 ? `mỗi ${m.every} s` : m.every < 7200 ? `mỗi ${m.every / 60} phút` : `mỗi ${m.every / 3600} giờ`

export function healthSection(modules: Module[], state: State, now: number, next: Record<string, number> = {}) {
  const dur = (ms: number) => ms < 1000 ? `${ms} ms` : ms < 60_000 ? `${(ms / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} s` : `${(ms / 60_000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })} phút`
  const ms = modules.filter(m => m.collect)
  const rows = ms.map(m => {
    const s = state[m.id], failed = !!s?.at && !s.ok && !s.unset
    const status = !s ? pill('mute', 'chưa chạy') : !s.at ? pill('info', 'đang chạy lần đầu') : s.ok ? pill('ok', 'ok') : s.unset ? pill('mute', 'chưa cấu hình') : pill('warn', 'lỗi')
    const group = GROUPS.find(g => g.id === m.group)?.label ?? m.group
    return `<tr><td><b>${esc(m.title)}</b>${group !== m.title ? `<div class="sub muted">${esc(group)}</div>` : ''}</td><td>${status}</td>
      <td data-label="Số liệu">${esc(ago(s?.dataAt, now))}${s?.ms != null ? `<div class="sub muted">chạy ${esc(dur(s.ms))}</div>` : ''}</td>
      <td data-label="Lịch">${esc(every(m))}${next[m.id] ? `<div class="sub muted">lần tới ${esc(until(next[m.id], now))}</div>` : ''}</td>
      <td class="wrap${failed ? ' warn-t' : s?.unset ? ' muted' : ''}">${failed ? esc(cut(s.error, 200)) : s?.unset ? esc(cut(s.unset, 200)) : ''}</td></tr>`
  }).join('')
  const bad = ms.filter(m => state[m.id]?.at && !state[m.id]!.ok && !state[m.id]!.unset).length
  // class "restack": labelled blocks on a phone once the shared stylesheet has that rule; until then the first column is pinned
  return section('Nguồn dữ liệu', `<div class="scroll"><table class="restack"><thead><tr><th>Phần</th><th>Trạng thái</th><th>Số liệu</th><th>Lịch</th><th>Lỗi lần chạy cuối</th></tr></thead><tbody>${rows}</tbody></table></div>`,
    bad ? `${bad} trong ${ms.length} nguồn lỗi ở lần chạy cuối` : `${ms.length} nguồn`, 'health', { span: 'all' })
}
