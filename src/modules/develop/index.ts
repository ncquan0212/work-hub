// B · Develop board: tasks between the owner and Claude. The owner creates a task (or imports a Jira
// issue), talks it through with Claude (full tools, no edits to the main tree), approves, and Claude works in the repo's
// main working tree, or in the task's own git worktree when the task asks for one (decisions.md D15). The hub only writes rows; the runner service (src/runner/main.ts) runs the turns.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPOS } from '../../config.ts'
import { ago, board, boardHead, cut, empty, esc, num, pill, section, TZ } from '../../core/html.ts'
import { md } from '../../core/md.ts'
import type { Alert, Module, Req, Res, Upload, View, Waiting } from '../../core/types.ts'
import { ai, chromeOn, firstDiscussPrompt, modeLabel, modelChoice, modelName, parseMode, replyPrompt, taskMessage } from './prompts.ts'
import { activity, addMessage, commandsFor, compactedSince, CONTEXT_WARN, contextShare, createTask, getFile, getTask, HAS_SIPS, kTokens, initStore, listTasks, MAX_IMAGES, messages, openTurn, queueTurn, requestCancel, saveImages, setMode, setStatus, storable, takesReply, resolvedModels, composeState, type ComposeState,
  STATUS_LABEL, taskFiles, turns, type DevFile, type Message, type RunMode, type Task, type TaskStatus, type Turn } from './store.ts'

const TONE: Record<TaskStatus, 'ok' | 'warn' | 'bad' | 'info' | 'mute'> = {
  new: 'mute', discussing: 'info', awaiting: 'warn', working: 'info', review: 'warn', done: 'ok', cancelled: 'mute',
}
const COLUMNS: { title: string; note: string; tone: 'warn' | 'run' | 'ok'; statuses: TaskStatus[]; none: string }[] = [
  { title: 'Chờ bạn', note: 'trả lời, duyệt hoặc xem diff', tone: 'warn', statuses: ['awaiting', 'review', 'new'], none: 'Không có task nào chờ bạn.' },
  { title: 'Claude đang làm', note: 'runner chạy từng lượt', tone: 'run', statuses: ['discussing', 'working'], none: 'Claude đang rảnh.' },
  { title: 'Xong gần đây', note: '14 ngày qua', tone: 'ok', statuses: ['done', 'cancelled'], none: 'Chưa có task nào xong trong 14 ngày.' },
]
const repoName = (k: string) => REPOS.find(r => r.key === k)?.name ?? k
const csrfField = (v: View) => `<input type="hidden" name="_csrf" value="${esc(v.csrf)}">`
const usd = (x: number) => `$${num(x, 2)}` // vi-VN like every other page: $4,12 (a dot is a thousands mark)
const hhmm = (t: number) => new Date(t).toLocaleTimeString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit' })
/** "Đọc /Users/…/ads/AdManager.kt" → "Đọc …/ads/AdManager.kt": a card has room for the file, not the path. */
const shortPaths = (s: string) => s.replace(/\/(?:[^\s/]+\/)+([^\s/]+\/[^\s/]+)/g, '…/$1')
/** Activity paths relative to the task's worktree or repo: "Đọc app/src/…/AdManager.kt". */
const relPaths = (s: string, t: Task) => [t.worktree, REPOS.find(r => r.key === t.repo)?.repo].reduce<string>((x, root) => root ? x.replaceAll(`${root}/`, '') : x, s)

/** Checklist lines "- [ ] …" / "- [x] …" from Claude's latest message: the task's steps. */
export function steps(text: string) {
  return [...text.matchAll(/^\s*[-*] \[( |x|X)\] (.+)$/gm)].map(m => ({ done: m[1] !== ' ', text: m[2].trim() }))
}
function lastSteps(v: View, id: number) {
  const m = messages(v.db, id).findLast(m => m.who === 'claude')
  return m ? steps(m.text) : []
}
const progress = (st: { done: boolean }[]) => {
  const n = st.filter(s => s.done).length
  return `<progress class="develop-bar" value="${n}" max="${st.length}" aria-label="${n} trên ${st.length} bước xong"></progress>`
}

/** What the open turn is doing, one line: for a card in "Claude đang làm". */
function liveLine(v: View, open: Turn | undefined) {
  if (!open) return ''
  if (open.status === 'queued') return `<span class="develop-card-live is-queued"><span>Chờ runner nhận lượt</span></span>`
  if (takesReply(open)) return `<span class="develop-card-live"><span>Chờ việc chạy nền</span></span>`
  const last = activity(v.db, open.id, 1)[0]
  return `<span class="develop-card-live"><span>${esc(last ? shortPaths(last.text) : open.status === 'cancel' ? 'Đang dừng' : 'Đang bắt đầu')}</span></span>`
}

function card(v: View, t: Task) {
  const closed = t.status === 'done' || t.status === 'cancelled'
  const live = t.status === 'discussing' || t.status === 'working' ? liveLine(v, openTurn(v.db, t.id)) : ''
  const st = closed ? [] : lastSteps(v, t.id)
  // owner 2026-11-16: the board says which open task is near its context limit
  const share = closed || !ai.features.context ? null : contextShare(t)
  const ctx = share != null && share >= CONTEXT_WARN ? pill('warn', `Context ${Math.round(share * 100)}%`) : ''
  return `<li><a class="tile develop-card" href="/develop/task/${t.id}#latest">
    <span class="develop-card-top"><span class="develop-card-pills">${pill(TONE[t.status], STATUS_LABEL[t.status])}${ctx}</span><span class="develop-id">#${t.id}</span></span>
    <strong class="develop-card-title">${esc(t.title)}</strong>${live}
    ${st.length ? `<span class="develop-card-steps">${progress(st)}<span>${st.filter(s => s.done).length}/${st.length} bước</span></span>` : ''}
    <span class="develop-card-meta"><span class="develop-repo">${esc(repoName(t.repo))}</span>${t.jira_key ? `<span class="tag">${esc(t.jira_key)}</span>` : ''}${t.model || t.effort || t.ultracode || t.chrome || t.isolated ? `<span class="develop-mode-tag">${esc(modeLabel(t, resolvedModels(v.db)))}</span>` : ''}
      <span class="develop-age"><span>${esc(ago(t.updated_at, v.now))}</span>${t.cost_usd ? `<span class="develop-cost">${usd(t.cost_usd)}</span>` : ''}</span></span></a></li>`
}

function lanes(v: View) {
  const all = listTasks(v.db)
  return `<div class="develop-lanes">${COLUMNS.map(c => {
    const xs = all.filter(t => c.statuses.includes(t.status)).filter(t => !['done', 'cancelled'].includes(t.status) || v.now - t.updated_at < 14 * 86_400_000)
    return `<div class="develop-lane develop-lane-${c.tone}"><div class="develop-lane-head"><h3>${esc(c.title)}</h3><span class="develop-n">${xs.length}</span><p>${esc(c.note)}</p></div>
      ${xs.length ? `<ul class="develop-cards">${xs.map(t => card(v, t)).join('')}</ul>` : `<p class="develop-lane-empty">${esc(c.none)}</p>`}</div>`
  }).join('')}</div>`
}

const opt = (value: string, label: string, cur: string | null) => `<option value="${esc(value)}"${(cur ?? '') === value ? ' selected' : ''}>${esc(label)}</option>`

/** Model, thinking, ultracode, Chrome and worktree for a task's turns (architecture.md "Develop", decisions.md D15), folded under one line that says the current mode.
 *  Model, thinking and Chrome only where the AI has them (ai.features) and, for Chrome, the config names the browsers. */
// each model choice by the version it last ran as (owner 2026-11-10: "Fable" alone hides 5.1 from a later 5.2)
function modeFields(m: RunMode, v: View) {
  const seen = resolvedModels(v.db), { models, efforts } = ai.features, def = modelChoice(null, seen)
  return `<details class="develop-mode"><summary>${I_MODE}<span class="develop-mode-k">Chế độ chạy:</span> <b>${esc(modeLabel(m, seen))}</b></summary><div class="develop-mode-fields">
    ${Object.keys(models).length ? `<label><span class="label">Model</span><select name="model">${opt('', def === 'mặc định' ? 'Mặc định' : `Mặc định (${def})`, m.model)}${Object.keys(models).map(k => opt(k, modelChoice(k, seen), m.model)).join('')}</select></label>` : ''}
    ${ai.features.effort ? `<label><span class="label">Thinking</span><select name="effort">${opt('', 'Mặc định', m.effort)}${Object.entries(efforts).map(([k, l]) => opt(k, l, m.effort)).join('')}</select></label>` : '<input type="hidden" name="effort" value="">'}
    <label class="develop-check"><input type="checkbox" name="ultracode" value="1"${m.ultracode ? ' checked' : ''}><span>Ultracode<span class="develop-hint">Claude chạy workflow nhiều agent (tối đa 5) cho việc lớn. Tốn hơn nhiều.</span></span></label>
    ${chromeOn ? `<label class="develop-check"><input type="checkbox" name="chrome" value="1"${m.chrome ? ' checked' : ''}><span>Chrome<span class="develop-hint">Claude dùng Chrome đã đăng nhập của bạn (chromeBrowsers trong data/config.json), trong tab riêng. Chỉ đọc, trừ khi bạn yêu cầu.</span></span></label>` : ''}
    <input type="hidden" name="isolated" value="0"><label class="develop-check"><input type="checkbox" name="isolated" value="1"${m.isolated ? ' checked' : ''}><span>Worktree riêng<span class="develop-hint">Khi duyệt, Claude sửa trong worktree riêng của task (branch hub/task-số, tạo từ HEAD) thay vì working tree chính.</span></span></label></div></details>`
}

function newForm(v: View, preset: { title?: string; body?: string; repo?: string; jira?: string } = {}) {
  const repo = REPOS.some(r => r.key === preset.repo) ? preset.repo : REPOS[0]?.key
  return `<form class="develop-form" method="post" action="/develop/new" enctype="multipart/form-data">${csrfField(v)}
    <label class="develop-f-title"><span class="label">Tiêu đề</span><input type="text" name="title" required maxlength="200" autocomplete="off" placeholder="Việc cần làm, một dòng" value="${esc(preset.title ?? '')}"></label>
    <fieldset class="develop-f-repo"><legend class="label">Repo</legend><div class="develop-chips">${REPOS.map(r => `<label class="develop-chip"><input type="radio" name="repo" value="${esc(r.key)}"${r.key === repo ? ' checked' : ''}><span>${esc(r.name)}</span></label>`).join('')}</div></fieldset>
    <label class="develop-f-body"><span class="label">Mô tả</span><textarea name="body" maxlength="20000" placeholder="Cần gì, ở đâu, xong khi nào">${esc(preset.body ?? '')}</textarea></label>
    ${modeFields({ model: null, effort: null, ultracode: 0, chrome: 0, isolated: 0 }, v)}
    ${ai.features.images ? `<label class="develop-f-images"><span class="label">Ảnh</span><input type="file" name="images" accept="image/*" multiple data-max="${MAX_IMAGES}"></label>` : ''}
    ${preset.jira ? `<input type="hidden" name="jira" value="${esc(preset.jira)}">` : ''}
    <div class="develop-f-foot"><label class="develop-check"><input type="checkbox" name="start" value="1"${preset.jira || preset.body || preset.title ? '' : ' checked'}><span>Gửi cho Claude trao đổi ngay<span class="develop-hint">Bỏ chọn để lưu task và bắt đầu sau.</span></span></label>
    <button type="submit">Tạo task</button></div></form>${pasteScript}`
}

/** Side panel of /develop/new: what happens to a task once it exists. */
const howItRuns = () => section('Sau khi tạo', `<ol class="develop-how">
    <li><b>Claude trao đổi, phân tích, báo cáo.</b><span>Dùng mọi tool (Databuckets, Firebase, chạy lệnh…), không sửa file trong repo.</span></li>
    <li><b>Bạn bấm “Duyệt và làm”.</b><span>Claude sửa thẳng trong working tree chính của repo, không push, chỉ commit khi bạn bảo. Chọn “Worktree riêng” thì Claude làm trong worktree của task, không commit.</span></li>
    <li><b>Bạn xem thay đổi.</b><span>Hệ thống liệt kê file lượt đó sửa. Task chuyển sang “Chờ bạn xem”.</span></li></ol>`, '', '', { cls: 'develop-how-panel' })

function liveSection(v: View, t: Task, open: Turn) {
  const acts = activity(v.db, open.id)
  const queued = open.status === 'queued'
  const bg = takesReply(open)
  const title = queued ? 'Đang chờ runner' : open.status === 'cancel' ? 'Đang dừng lượt này' : bg ? 'Claude đang chờ việc chạy nền' : `Claude đang ${open.kind === 'execute' ? 'làm' : 'trao đổi'}`
  const since = queued ? `xếp hàng ${ago(open.created_at, v.now)}` : `bắt đầu ${ago(open.started_at ?? open.created_at, v.now)}`
  // while a job runs in the background, stopping the turn stops the job too (task #5 lost its analysis that way)
  const stop = `<form method="post" action="/develop/task/${t.id}/cancel">${csrfField(v)}<button type="submit" class="danger">${bg ? 'Dừng cả việc chạy nền' : 'Dừng lượt này'}</button></form>`
  const body = acts.length
    ? `<ol class="develop-acts">${acts.map(a => `<li><time>${esc(hhmm(a.at))}</time><span>${esc(relPaths(a.text, t))}</span></li>`).join('')}</ol>`
    : empty(queued ? 'Runner sẽ nhận lượt này trong vài giây (nếu service runner đang chạy).' : 'Chưa có thao tác nào.')
  const hint = bg ? 'Workflow hay lệnh nền của Claude vẫn đang chạy, xong thì Claude tự báo kết quả. Muốn nói thêm thì gửi ở ô dưới, không cần dừng.'
    : 'Muốn nói thêm thì gửi ở ô dưới, không cần dừng: Claude đọc ngay sau bước đang chạy.'
  return section(title, `${body}<p class="develop-hint">${hint}</p>`, since, 'live', { act: stop, cls: `develop-live${queued ? ' is-queued' : ''}` })
}

function message(m: Message, now: number, files: DevFile[] = [], last = false) {
  const id = last ? ' id="latest"' : '' // links to a task end in #latest: the page opens on the newest message
  if (m.who === 'system') return `<div class="develop-sys"${id} data-id="${m.id}"><span class="develop-sys-who">Hệ thống</span><time>${esc(ago(m.at, now))}</time><p${m.text.includes('\n') ? ' class="develop-sys-pre"' : ''}>${esc(m.text)}</p></div>`
  // .msg keeps white-space: pre-wrap, so nothing between its tags but the text. Claude writes Markdown; the owner's
  // text stays as typed
  const imgs = files.length ? `<div class="develop-imgs">${files.map((f, i) => `<a href="/develop/file/${f.id}" target="_blank" rel="noopener"><img src="/develop/file/${f.id}" alt="Ảnh ${i + 1}" loading="lazy"></a>`).join('')}</div>` : ''
  return `<div class="msg${m.who === 'owner' ? ' me' : ''}"${id} data-id="${m.id}"><div class="who"><span>${m.who === 'owner' ? 'Bạn' : 'Claude'}</span><time>${esc(ago(m.at, now))}</time></div>${m.who === 'owner' ? esc(m.text) : md(m.text)}${imgs}</div>`
}

// 20px line icons for the composer, drawn for this hub (stroke = currentColor)
const svg = (d: string) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`
const I_CLIP = svg('<path d="m20 11.5-8 8a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.6 1.6 0 0 1-2.3-2.3l7.9-7.9"/>')
const I_SEND = svg('<path d="M4 11.6 20 4l-7.6 16-2.1-6.3z"/><path d="M10.3 13.7 20 4"/>')
const I_OK = svg('<path d="m5 12.5 4.5 4.5L19 7.5"/>')
const I_MODE = `<span class="develop-mode-icon">${svg('<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>')}</span>`

/** What sits under the reply box for each state: the two buttons explained, or what happens to a message now. */
function composeNote(t: Task, state: ComposeState) {
  if (state === 'reply') return `<ul class="develop-rules"><li><b>Gửi trao đổi:</b> Claude dùng mọi tool để phân tích, trả lời, không sửa file trong repo.</li>
    <li><b>Duyệt và làm:</b> Claude sửa file ${t.isolated ? 'trong worktree riêng của task (tạo từ HEAD), chạy build hay test khi cần. Không commit, không push.' : 'thẳng trong working tree chính, chạy build hay test khi cần. Không push, chỉ commit khi bạn bảo.'}</li></ul>`
  const now = state === 'waiting' ? 'Claude đọc tin ngay, việc chạy nền vẫn chạy tiếp.' : state === 'queued' ? 'Tin này đi cùng lượt sắp chạy.' : 'Claude đọc tin ngay sau bước đang chạy, không cần dừng.'
  return state === 'cancel' ? '' : `<p class="develop-hint">${now} "Duyệt và làm" và đổi chế độ chạy mở lại khi lượt này xong.</p>`
}
const placeholder = (state: ComposeState) => `${state === 'reply' ? 'Trả lời Claude' : 'Nói thêm với Claude'}${ai.features.commands ? ', / để chạy lệnh hay skill' : ''}`

/** The reply box at the foot of the thread: it stays on screen while the thread scrolls (owner 2026-11-09). The text
 *  grows with what is typed; images, the run mode and the two buttons sit on one bar under it. One form for every
 *  state, so chat.js only flips `data-state` as the turn moves on (the run mode and "Duyệt và làm" show only in
 *  `reply`); hidden while a turn is stopping, absent once the task is closed. */
function composer(v: View, t: Task, state: ComposeState) {
  const off = `<p class="develop-hint develop-compose-off" id="compose-off"${state === 'cancel' || state === 'closed' ? '' : ' hidden'}>${state === 'closed'
    ? 'Task đã đóng. Bấm “Mở lại” ở phần Trạng thái để trao đổi tiếp.' : 'Đang dừng lượt này. Ô trả lời mở lại khi dừng xong.'}</p>`
  if (state === 'closed') return off
  return `${off}<form class="develop-compose" method="post" action="/develop/task/${t.id}/send" enctype="multipart/form-data" data-state="${state}"${state === 'cancel' ? ' hidden' : ''}>${csrfField(v)}
    <button type="button" class="develop-newmsg" id="newmsg" hidden>Tin mới bên dưới</button>
    <div class="develop-compose-box"><div class="develop-compose-preview" id="compose-preview"></div>
      ${ai.features.commands ? '<ul class="develop-cmds" id="compose-cmds" role="listbox" aria-label="Lệnh và skill" hidden></ul><p class="develop-sr" id="compose-cmds-n" aria-live="polite"></p>' : ''}
      <textarea id="compose-text" name="text" maxlength="20000" rows="2" aria-label="Trả lời Claude" placeholder="${placeholder(state)}" data-base="${placeholder(state)}"${ai.features.commands ? ' aria-autocomplete="list" aria-controls="compose-cmds" aria-expanded="false"' : ''}></textarea>
      <div class="develop-compose-bar">
        ${ai.features.images ? `<label class="develop-attach-btn" title="Đính kèm ảnh">${I_CLIP}<span>Ảnh</span><input type="file" name="images" accept="image/*" multiple data-max="${MAX_IMAGES}" data-preview="compose-preview" data-hint="compose-text"></label>` : ''}
        ${modeFields(t, v)}
        <div class="develop-compose-btns"><button type="submit" name="mode" value="execute" class="ghost">${I_OK}Duyệt và làm</button><button type="submit" name="mode" value="discuss">${I_SEND}Gửi trao đổi</button></div>
      </div></div><p class="develop-compose-err" id="compose-err" role="status"></p></form>
    <div class="develop-compose-note" id="compose-note">${composeNote(t, state)}</div>`
}

/** "Claude is typing" at the foot of the thread while a turn is open: what it is doing right now. */
function typing(v: View, open: Turn | undefined, state: ComposeState) {
  if (!open || state === 'closed') return ''
  const last = activity(v.db, open.id, 1)[0]
  const text = state === 'queued' ? 'Đang chờ runner nhận lượt' : state === 'cancel' ? 'Đang dừng'
    : state === 'waiting' ? 'Đang chờ việc chạy nền, xong sẽ báo ở đây' : last ? shortPaths(last.text) : 'Đang bắt đầu'
  const act = state === 'live' && !!last // a tool line ("$ git status") reads as code
  return `<div class="msg develop-typing" id="typing" role="status"><div class="who"><span>Claude</span></div><p><span class="develop-dots" aria-hidden="true"><i></i><i></i><i></i></span><span${act ? ' class="develop-typing-act"' : ''}>${esc(text)}</span></p></div>`
}

/** The session's context in the Trạng thái panel (plan §12): tokens in it of the model's size, a bar that warns from
 *  CONTEXT_WARN, and Compact (it sends "/compact" like the reply box would). */
function contextBlock(v: View, t: Task, open: Turn | undefined) {
  if (!ai.features.context) return ''
  const share = contextShare(t), closed = t.status === 'done' || t.status === 'cancelled'
  const compacted = compactedSince(t)
  const pct = share == null ? '' : `${Math.round(share * 100)}%`
  const figure = compacted ? `<span>Vừa compact${t.context_used ? `, trước đó ${esc(kTokens(t.context_used))}` : ''}</span>`
    : t.context_used == null ? '<span class="develop-hint">có số sau câu trả lời đầu tiên</span>'
    : `<span class="develop-ctx-n">${esc(kTokens(t.context_used))}${t.context_window ? ` / ${esc(kTokens(t.context_window))}, ${pct}` : ''}</span>`
  const warn = share != null && share >= CONTEXT_WARN
  const btn = ai.features.compact && t.session_started && !closed
    ? `<form method="post" action="/develop/task/${t.id}/send" class="develop-ctx-form">${csrfField(v)}<input type="hidden" name="mode" value="discuss"><input type="hidden" name="text" value="/compact"><button type="submit" class="ghost"${open ? ' disabled' : ''}>Compact</button></form>` : ''
  return `<div class="develop-ctx"><div class="develop-ctx-head"><span class="label">Context</span>${figure}${btn}</div>
    ${share != null ? `<progress class="develop-bar${warn ? ' develop-bar-warn' : ''}" value="${t.context_used}" max="${t.context_window}" aria-label="Context đã dùng ${pct}"></progress>` : ''}
    ${warn ? '<p class="develop-hint">Gần đầy: Claude tự compact ở khoảng 83%. Compact ngay, hoặc gõ <code>/compact</code> kèm điều cần giữ.</p>' : ''}
    ${btn && open ? '<p class="develop-hint">Compact được khi lượt đang chạy xong.</p>' : ''}</div>`
}

/** The task page's pieces, for the page and for /live (chat.js swaps them in as they change). */
function parts(v: View, t: Task) {
  const msgs = messages(v.db, t.id), ts = turns(v.db, t.id), open = openTurn(v.db, t.id), state = composeState(t, open)
  const lastModel = [...ts].reverse().find(x => x.model_used)?.model_used ?? null // what claude really ran last
  const lastClaude = [...msgs].reverse().find(m => m.who === 'claude')
  const st = lastClaude ? steps(lastClaude.text) : []
  const closed = t.status === 'done' || t.status === 'cancelled'

  const files = taskFiles(v.db, t.id)
  // a worktree left from before the task moved to the main tree (decisions.md D15) is not where its work is: not shown
  const wt = t.isolated && t.worktree ? `<div class="develop-wt"><h3>Worktree</h3>
      <div><span class="label">Branch</span><span class="tag">${esc(t.branch)}</span></div>
      <div><span class="label">Xem diff</span><code class="develop-cmd">git -C ${esc(t.worktree)} diff</code></div>
      <div><span class="label">Dọn khi xong, chạy từ repo chính</span><code class="develop-cmd">git worktree remove ${esc(t.worktree)}</code></div></div>` : ''
  const dis = open ? ' disabled' : ''
  const close = `<form method="post" action="/develop/task/${t.id}/status" class="develop-status-form">${csrfField(v)}<div class="inline">${closed
    ? `<button type="submit" name="to" value="awaiting" class="ghost"${dis}>Mở lại</button>`
    : `<button type="submit" name="to" value="done" class="ghost"${dis}>Đánh dấu xong</button><button type="submit" name="to" value="cancelled" class="ghost"${dis}>Huỷ task</button>`}</div>
    ${open ? '<p class="develop-hint">Dừng lượt đang chạy trước khi đổi trạng thái.</p>' : ''}</form>`
  const sum = section('Trạng thái', `<div class="develop-sum-top">${pill(TONE[t.status], STATUS_LABEL[t.status])}<span class="develop-hint">cập nhật ${esc(ago(t.updated_at, v.now))}</span></div>
    <div class="develop-figs"><div><span class="label">Chi phí</span><span class="big">${usd(t.cost_usd)}</span></div><div><span class="label">Lượt Claude</span><span class="big">${ts.length}</span></div></div>
    ${contextBlock(v, t, open)}
    <dl class="kv"><div><dt>Repo</dt><dd>${esc(repoName(t.repo))}</dd></div><div><dt>Chế độ</dt><dd>${esc(modeLabel(t, resolvedModels(v.db)))}</dd></div>${lastModel ? `<div><dt>Model lượt gần nhất</dt><dd title="${esc(lastModel)}">${esc(modelName(lastModel))}</dd></div>` : ''}${t.jira_key ? `<div><dt>Jira</dt><dd><span class="tag">${esc(t.jira_key)}</span></dd></div>` : ''}
    <div><dt>Tạo</dt><dd>${esc(ago(t.created_at, v.now))}</dd></div></dl>${wt}${close}`, '', 'status', { cls: 'develop-sum' })

  const done = st.filter(s => s.done).length
  const stepsPanel = st.length ? section('Các bước', `${progress(st)}<ul class="develop-checks">${st.map(s => `<li${s.done ? ' class="develop-check-done"' : ''}><span class="develop-box" role="img" aria-label="${s.done ? 'Xong' : 'Chưa xong'}"></span><span>${esc(s.text)}</span></li>`).join('')}</ul>`,
    `${done}/${st.length} xong, theo tin mới nhất của Claude`, 'steps', { cls: 'develop-steps' }) : ''

  const msg = (m: (typeof msgs)[number], i: number) => message(m, v.now, files.filter(f => f.message_id === m.id), i === msgs.length - 1)
  return { t, msgs, msg, open, state, sum, stepsPanel, live: open ? liveSection(v, t, open) : '', typing: typing(v, open, state) }
}

// /live's cursor: the highest id (messages are ordered by time, and a row can be written with an earlier time)
const lastId = (msgs: { id: number }[]) => msgs.reduce((m, x) => Math.max(m, x.id), 0)
const hash = (s: string) => createHash('sha1').update(s).digest('hex').slice(0, 10)
const versions = (p: ReturnType<typeof parts>) => ({ typing: hash(p.typing), live: hash(p.live), status: hash(p.sum), steps: hash(p.stepsPanel) })

function taskPage(v: View, t: Task) {
  const p = parts(v, t)
  // role=log: a screen reader reads new messages out as chat.js adds them; data-v-*: what the panels are, for /live
  const v0 = versions(p)
  const thread = section('Trao đổi', `<div class="develop-msgs" role="log" data-task="${t.id}" data-after="${lastId(p.msgs)}" data-v-typing="${v0.typing}" data-v-live="${v0.live}" data-v-status="${v0.status}" data-v-steps="${v0.steps}">${p.msgs.map(p.msg).join('') || empty('Chưa có tin nào.')}</div>${p.typing}${composer(v, t, p.state)}${pasteScript}${chatScript}`,
    p.msgs.length ? `${p.msgs.length} tin` : '', 'thread', { cls: 'develop-thread' })
  // two wrappers: main and side columns from 60rem; below that they dissolve (display: contents) and `order` sets the phone sequence
  return board(`<div class="develop-task"><div class="develop-task-main">${p.live}${thread}</div><div class="develop-task-side">${p.sum}${p.stepsPanel}</div></div>`)
}

function intParam(req: Req) { const id = Number(req.params.id); return Number.isInteger(id) && id > 0 ? id : null }

/** First turn of a task. Its session has seen nothing yet, so every image attached so far goes with it. */
function startDiscussion(v: View, id: number) {
  const t = getTask(v.db, id)!
  queueTurn(v.db, id, 'discuss', firstDiscussPrompt(t), allFiles(v, id))
}
const allFiles = (v: View, taskId: number) => taskFiles(v.db, taskId).map(f => f.id)

/** Stores a message's images (architecture.md "Develop"); what is not a usable image leaves a note in the thread. */
/** Images first (sips takes seconds), then the message and its images in one synchronous step, so a /live poll never
 *  sees the bubble without them (review 2026-11-09). Returns the image ids. */
async function postWithImages(v: View, taskId: number, uploads: Upload[], add: () => number) {
  const { ids, skipped } = await saveImages(v.db, taskId, 0, uploads)
  const mid = add()
  if (ids.length) v.db.prepare(`update develop_files set message_id = ? where id in (${ids.map(() => '?').join(', ')})`).run(mid, ...ids)
  if (skipped) addMessage(v.db, taskId, 'system', `Bỏ qua ${skipped} file: ${SKIP_NOTE}`)
  return ids
}
async function attach(v: View, taskId: number, messageId: number, uploads: Upload[]) {
  const { ids, skipped } = await saveImages(v.db, taskId, messageId, uploads)
  if (skipped) addMessage(v.db, taskId, 'system', `Bỏ qua ${skipped} file: ${SKIP_NOTE}`)
  return ids
}
// paste and drop for the image fields (paste.js). The hash in the URL lets the browser keep it until the file changes
const PASTE = readFileSync(join(import.meta.dirname, 'paste.js'))
const pasteScript = `<script src="/develop/paste.js?v=${createHash('sha256').update(PASTE).digest('hex').slice(0, 12)}" defer></script>`
// the task page as a chat (owner 2026-11-09): Enter sends, the thread updates itself. Loaded after paste.js
const CHAT = readFileSync(join(import.meta.dirname, 'chat.js'))
const chatScript = `<script src="/develop/chat.js?v=${createHash('sha256').update(CHAT).digest('hex').slice(0, 12)}" defer></script>`

// without sips (not macOS) an image is kept as it came: no HEIC, and small enough for the AI as it is (store.ts storable)
const SKIP_NOTE = HAS_SIPS ? `chỉ nhận ảnh PNG, JPEG, WebP, GIF, HEIC, tối đa 10 MB mỗi ảnh và ${MAX_IMAGES} ảnh mỗi tin.`
  : `chỉ nhận ảnh PNG, JPEG, WebP, GIF, tối đa 3,5 MB mỗi ảnh và ${MAX_IMAGES} ảnh mỗi tin (máy chạy hub không có sips để đổi định dạng hay thu nhỏ ảnh).`
const usable = (u: Upload) => storable(u.data)
/** The images of a form, or none when the AI cannot take images. */
const imagesOf = (req: Req) => ai.features.images ? req.files.filter(f => f.field === 'images') : []

const newPage = (form: string, note = '') =>
  board(section('Nội dung task', form, note, '', { cls: 'develop-new develop-new-page' }) + howItRuns())

// Scoped styles (docs/ui.md): every selector starts with .develop-, tokens only, mobile first.
const CSS = String.raw`
.develop-lanes { grid-column: 1 / -1; display: grid; gap: var(--space-lg); min-width: 0 }
.develop-lane { display: grid; gap: var(--space-sm); align-content: start; min-width: 0 }
.develop-lane-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); min-width: 0 }
.develop-lane-head h3 { font-size: var(--text-md) }
.develop-lane-head p { flex-basis: 100%; color: var(--muted); font-size: var(--text-sm) }
.develop-n { min-width: 24px; height: 22px; padding: 0 var(--space-xs); border-radius: var(--radius-pill); background: var(--paper-3); color: var(--ink-2);
  display: inline-grid; place-items: center; font-size: var(--text-xs); font-weight: 600; font-variant-numeric: tabular-nums }
.develop-cards { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-sm); grid-template-columns: repeat(auto-fill, minmax(min(100%, 17rem), 1fr)) }
.develop-cards > li { min-width: 0; display: grid }
.develop-lane-empty { margin: 0; padding: var(--space-md); border-radius: var(--radius-card); box-shadow: inset 0 0 0 1px var(--rule-2); color: var(--muted); font-size: var(--text-sm) }
@media (min-width: 48rem) {
  .develop-lanes { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--gap) }
  .develop-cards { grid-template-columns: minmax(0, 1fr) }
}

.develop-card { display: flex; flex-direction: column; gap: var(--space-xs); color: var(--ink) }
.develop-card:focus-visible { border-radius: var(--radius-card) }
.develop-card-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-xs) }
.develop-card-pills { display: flex; flex-wrap: wrap; gap: var(--space-2xs); min-width: 0 }
.develop-id { color: var(--muted); font-size: var(--text-sm); font-variant-numeric: tabular-nums }
.develop-card-title { font-weight: 600; line-height: 1.35; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden }
.develop-card-live { display: flex; align-items: baseline; gap: var(--space-xs); font-size: var(--text-sm); color: var(--ink-2); min-width: 0 }
.develop-card-live > span:last-child { min-width: 0; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden }
.develop-card-live.is-queued { color: var(--muted) }
.develop-card-steps { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--space-sm); font-size: var(--text-xs); color: var(--muted); font-variant-numeric: tabular-nums }
.develop-card-meta { margin-top: auto; display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); font-size: var(--text-sm); padding-top: var(--space-xs); border-top: 1px solid var(--rule) }
.develop-repo { font-weight: 500 }
.develop-age { margin-left: auto; display: inline-flex; gap: var(--space-xs); color: var(--muted); white-space: nowrap }
.develop-cost { font-variant-numeric: tabular-nums; color: var(--ink-2) }

.develop-bar { appearance: none; -webkit-appearance: none; display: block; width: 100%; height: 6px; border: 0; border-radius: var(--radius-pill); background: var(--paper-3); overflow: hidden; color: var(--accent) }
.develop-bar::-webkit-progress-bar { background: var(--paper-3); border-radius: var(--radius-pill) }
.develop-bar::-webkit-progress-value { background: var(--accent); border-radius: var(--radius-pill) }
.develop-bar::-moz-progress-bar { background: var(--accent); border-radius: var(--radius-pill) }
.develop-card .develop-bar, .develop-card .develop-bar::-webkit-progress-bar { background: var(--rule) }

/* the new-task form: stacked; two columns once its panel is wide enough */
.develop-new { container-type: inline-size }
@media (min-width: 48rem) { .develop-new-page, .develop-how-panel { grid-column: 1 / -1 } }
@media (min-width: 80rem) { .develop-how-panel { grid-column: auto } .develop-new-page { grid-column: span 2 } }
@media (min-width: 120rem) { .develop-new-page { grid-column: span 3 } }
.develop-form { gap: var(--space-md) }
.develop-form > label, .develop-f-repo { display: grid; gap: var(--space-xs); min-width: 0 }
.develop-f-repo { border: 0; margin: 0; padding: 0 }
.develop-f-repo legend { padding: 0; margin-bottom: var(--space-xs) }
.develop-chips { display: flex; flex-wrap: wrap; gap: var(--space-xs) }
.develop-chip { position: relative; display: inline-flex }
.develop-chip input { position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; opacity: 0; cursor: pointer }
.develop-chip span { display: inline-flex; align-items: center; min-height: 40px; padding: 0 var(--space-md); border-radius: var(--radius-pill); box-shadow: inset 0 0 0 1.5px var(--rule-2);
  font-size: var(--text-sm); font-weight: 500; color: var(--ink-2); white-space: nowrap; transition: background-color var(--dur-micro) var(--ease-out), box-shadow var(--dur-micro) var(--ease-out) }
@media (hover: hover) { .develop-chip:hover span { background: var(--paper-3) } }
.develop-chip input:checked + span { background: var(--accent-soft); color: var(--ink); box-shadow: inset 0 0 0 1.5px var(--accent); font-weight: 600 }
.develop-chip input:focus-visible + span { outline: 2px solid var(--focus); outline-offset: 2px }
@media (pointer: coarse) { .develop-chip span { min-height: 44px } }
.develop-f-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--space-md) }
.develop-check { display: flex; align-items: flex-start; gap: var(--space-sm); cursor: pointer; min-width: 0; flex: 1 1 16rem }
.develop-check input { margin-top: var(--space-3xs); flex-shrink: 0 }
.develop-check > span { display: grid; gap: var(--space-3xs) }
.develop-hint { color: var(--muted); font-size: var(--text-sm); font-weight: 400 }
/* run mode: one folded line; open, model and thinking side by side, the ultracode and Chrome boxes under them */
.develop-mode { min-width: 0 }
.develop-mode summary b { color: var(--ink); font-weight: 600 }
.develop-mode-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr)); gap: var(--space-sm) }
.develop-mode-fields > label:not(.develop-check) { display: grid; gap: var(--space-xs); min-width: 0 }
.develop-mode-fields > .develop-check { grid-column: 1 / -1 }
.develop-mode-tag { font-size: var(--text-xs); color: var(--muted) }
/* images: a file picker (camera or gallery on a phone), thumbnails under the message that open the stored copy */
.develop-attach, .develop-f-images { display: grid; gap: var(--space-xs); min-width: 0 }
.develop-attach input, .develop-f-images input { font: inherit; font-size: var(--text-sm); color: var(--ink-2); max-width: 100% }
.develop-imgs { display: flex; flex-wrap: wrap; gap: var(--space-2xs); margin-top: var(--space-xs) }
.develop-imgs img { display: block; width: 6.5rem; height: 6.5rem; object-fit: cover; border-radius: var(--radius-inner) }
/* images pasted, dropped or picked, before sending (paste.js): each thumbnail is a button that takes it out */
.develop-paste { display: grid; gap: var(--space-2xs) }
.develop-paste .develop-imgs[hidden] { display: none }
.develop-paste .develop-imgs { margin-top: 0 }
.develop-paste-img { min-height: 0; padding: 0; background: none; border-radius: var(--radius-inner) }
@media (hover: hover) { .develop-paste-img:hover { background: none; opacity: 0.8 } }
.develop-paste-img img { width: 4.5rem; height: 4.5rem }
@container (min-width: 40rem) {
  .develop-form { grid-template-columns: minmax(0, 1fr) minmax(0, 1.25fr); grid-template-areas: "title body" "repo body" "mode body" "imgs body" "foot foot"; column-gap: var(--space-lg) }
  .develop-f-images { grid-area: imgs }
  .develop-f-title { grid-area: title } .develop-f-repo { grid-area: repo } .develop-f-foot { grid-area: foot } .develop-form > .develop-mode { grid-area: mode }
  .develop-f-body { grid-area: body; grid-template-rows: auto minmax(7rem, 1fr) }
  .develop-f-body textarea { height: 100% }
}
.develop-how { list-style: none; margin: 0; padding: 0; display: grid; counter-reset: develop-how }
.develop-how > li { counter-increment: develop-how; display: grid; grid-template-columns: auto minmax(0, 1fr); column-gap: var(--space-sm); row-gap: var(--space-3xs);
  padding: var(--space-sm) 0; border-top: 1px solid var(--rule); font-size: var(--text-sm) }
.develop-how > li:first-child { border-top: 0; padding-top: 0 }
.develop-how > li::before { content: counter(develop-how); grid-row: span 2; width: 28px; height: 28px; border-radius: 50%; background: var(--paper-3); color: var(--ink);
  display: grid; place-items: center; font-weight: 600; font-variant-numeric: tabular-nums }
.develop-how b { font-size: var(--text-md) }
.develop-how > li > span { color: var(--ink-2) }

/* the task page: one column on a phone (live turn, status, steps, thread with the composer last), two from 60rem */
.develop-task { grid-column: 1 / -1; display: grid; gap: var(--gap); grid-template-columns: minmax(0, 1fr); align-items: start; min-width: 0 }
.develop-task-main, .develop-task-side { display: contents }
.develop-live { order: 1 } .develop-sum { order: 2 } .develop-steps { order: 3 } .develop-thread { order: 4 }
@media (min-width: 48rem) and (max-width: 59.99rem) {
  .develop-task { grid-template-columns: repeat(2, minmax(0, 1fr)) }
  .develop-live, .develop-thread, .develop-sum:only-child { grid-column: 1 / -1 }
}
@media (min-width: 60rem) {
  .develop-task { grid-template-columns: minmax(0, 1fr) minmax(20rem, 24rem) }
  .develop-task-main, .develop-task-side { display: grid; gap: var(--gap); align-content: start; min-width: 0 }
  /* the status and steps stay in view while the thread scrolls (owner 2026-11-10), under the top bar; taller than the
     screen, the column scrolls on its own */
  .develop-task-side { position: sticky; top: calc(var(--bar-h) + env(safe-area-inset-top) + var(--space-md)); max-height: calc(100dvh - var(--bar-h) - env(safe-area-inset-top) - 2 * var(--space-md));
    overflow-y: auto; overscroll-behavior: contain; scrollbar-width: thin }
}
@media (min-width: 120rem) { .develop-task { grid-template-columns: minmax(0, 1fr) 28rem } }

.develop-live { box-shadow: inset 0 0 0 1.5px var(--accent) }
.develop-live.is-queued { box-shadow: inset 0 0 0 1.5px var(--rule-2) }
.develop-live .panel-head { align-items: center }
.develop-live .panel-head h2 { display: inline-flex; align-items: center; gap: var(--space-xs) }
.develop-live .panel-head .act form { display: block }
.develop-acts { list-style: none; margin: 0; padding: 0; display: grid; font-size: var(--text-sm) }
.develop-acts > li { display: grid; grid-template-columns: 3.25rem minmax(0, 1fr); gap: var(--space-sm); padding: var(--space-xs) 0; border-top: 1px solid var(--rule); color: var(--ink-2) }
.develop-acts > li:first-child { border-top: 0; padding-top: 0 }
.develop-acts > li:last-child { color: var(--ink); font-weight: 600 }
.develop-acts time { color: var(--muted); font-variant-numeric: tabular-nums; font-weight: 400 }
.develop-acts span { font-family: var(--mono); font-size: var(--text-xs); line-height: 1.6; overflow-wrap: anywhere }

.develop-msgs { display: grid; gap: var(--space-sm); min-width: 0 }
.develop-msgs .msg { min-width: 0; max-width: min(75ch, 92%) }
.develop-msgs .msg:not(.me) { justify-self: start }
.develop-msgs .who { display: flex; gap: var(--space-xs); align-items: baseline }
.develop-msgs .who time { font-weight: 400 }
.develop-sys { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 var(--space-xs); font-size: var(--text-xs); color: var(--muted); padding: var(--space-2xs) 0 }
.develop-sys-who { font-weight: 600 }
.develop-sys p { flex-basis: 100%; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); font-size: var(--text-sm) }
.develop-sys .develop-sys-pre { font-family: var(--mono); font-size: var(--text-xs); line-height: 1.6 }
/* the composer (owner 2026-11-09): stays at the foot of the screen while the thread scrolls (above the dock on a phone),
   on the panel's own colour so the messages pass under it; one rounded box holds the text, the images and a button bar */
.develop-compose { position: sticky; bottom: calc(var(--dock-h) + env(safe-area-inset-bottom)); z-index: 5; display: block;
  margin: 0 calc(-1 * var(--space-md)); padding: var(--space-sm) var(--space-md); background: var(--paper-2); box-shadow: 0 -1px 0 var(--rule) }
@media (min-width: 40rem) { .develop-compose { bottom: 0; margin: 0 calc(-1 * var(--space-lg)); padding: var(--space-sm) var(--space-lg) max(var(--space-sm), env(safe-area-inset-bottom)) } }
/* on the box, not the form: the "new messages" button sits above the form and must not be clipped */
@media (max-width: 39.99rem) { .develop-compose-box { max-height: calc(100dvh - var(--bar-h) - var(--dock-h) - 2 * var(--space-sm) - env(safe-area-inset-top) - env(safe-area-inset-bottom)); overflow-y: auto } }
.develop-compose-box { display: grid; background: var(--raised); border-radius: var(--radius-card); box-shadow: inset 0 0 0 1px var(--rule-2), var(--shadow-card);
  transition: box-shadow var(--dur-short) var(--ease-out) }
.develop-compose-box:focus-within { box-shadow: inset 0 0 0 1.5px var(--accent), 0 0 0 4px color-mix(in oklab, var(--accent) 16%, transparent) }
.develop-compose-box textarea { field-sizing: content; min-height: calc(2lh + 2 * var(--space-sm)); max-height: 40vh; resize: none; overflow-y: auto;
  background: transparent; box-shadow: none; border-radius: var(--radius-card) var(--radius-card) 0 0; padding: var(--space-sm) var(--space-md) var(--space-2xs) }
/* the box's ring is the focus mark for the text */
.develop-compose-box textarea:focus-visible { outline-color: transparent; box-shadow: none }
/* "/" suggestions: above the text, inside the box, so the box grows upwards from its place at the foot */
.develop-cmds { list-style: none; margin: 0; padding: var(--space-2xs); display: grid; max-height: min(40vh, 24rem); overflow-y: auto; overscroll-behavior: contain; border-bottom: 1px solid var(--rule) }
.develop-cmds[hidden] { display: none }
.develop-sr { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
.develop-cmds > li { display: grid; gap: var(--space-3xs); min-height: 44px; align-content: center; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-inner); cursor: pointer; min-width: 0 }
.develop-cmds > li[aria-selected="true"] { background: var(--accent-soft) }
@media (hover: hover) { .develop-cmds > li:hover { background: var(--paper-3) } }
.develop-cmd-name { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-xs); min-width: 0 }
.develop-cmd-name b { font-family: var(--mono); font-weight: 600; overflow-wrap: anywhere }
.develop-cmd-hint { color: var(--muted); font-size: var(--text-xs); overflow-wrap: anywhere }
.develop-cmd-desc { color: var(--ink-2); font-size: var(--text-sm); display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden }
@media (hover: hover) { .develop-compose-box textarea:hover { background: transparent } }
.develop-compose-preview .develop-paste { padding: 0 var(--space-md) }
.develop-compose-preview .develop-paste:has(.develop-imgs:not([hidden]), .develop-hint:not(:empty)) { padding-top: var(--space-sm) }
.develop-compose-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2xs) var(--space-xs); padding: var(--space-2xs) var(--space-xs) var(--space-xs) }
.develop-attach-btn { position: relative; display: inline-flex; align-items: center; gap: var(--space-2xs); min-height: 36px; padding: 0 var(--space-sm) 0 var(--space-xs);
  border-radius: var(--radius-pill); color: var(--ink-2); cursor: pointer; transition: background-color var(--dur-micro) var(--ease-out), color var(--dur-micro) var(--ease-out) }
.develop-attach-btn svg { width: 20px; height: 20px; flex-shrink: 0 }
.develop-attach-btn input { position: absolute; width: 1px; height: 1px; padding: 0; opacity: 0; overflow: hidden; clip-path: inset(50%) }
.develop-attach-btn:focus-within { outline: 2px solid var(--focus); outline-offset: 1px }
@media (hover: hover) { .develop-attach-btn:hover { background: var(--paper-3); color: var(--ink) } }
.develop-compose .develop-mode > summary { min-height: 36px; margin: 0; padding: 0 var(--space-sm) 0 var(--space-2xs); border-radius: var(--radius-pill);
  transition: background-color var(--dur-micro) var(--ease-out) }
.develop-compose .develop-mode { flex: 1 1 0; min-width: 0 }
.develop-compose .develop-mode > summary { max-width: 100%; gap: var(--space-2xs) }
.develop-compose .develop-mode > summary::before { display: none }
.develop-compose .develop-mode > summary b { font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
/* in the bar the label is for screen readers; the icon says it */
.develop-mode-icon { display: none }
.develop-compose .develop-mode-icon { display: inline-flex; flex-shrink: 0 } .develop-compose .develop-mode-icon svg { width: 20px; height: 20px }
.develop-compose .develop-mode-k { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap }
@media (hover: hover) { .develop-compose .develop-mode > summary:hover { background: var(--paper-3) } }
/* open, the run mode takes a row of its own above the bar's buttons */
.develop-compose .develop-mode[open] { order: -1; flex-basis: 100%; padding: var(--space-2xs) var(--space-2xs) var(--space-sm); border-bottom: 1px solid var(--rule) }
.develop-compose .develop-mode[open] > summary { margin-bottom: var(--space-xs) }
/* the box never outgrows the screen: open, the run mode scrolls inside it (a 360x740 phone, review 2026-11-09) */
.develop-compose .develop-mode[open] .develop-mode-fields { max-height: 35dvh; overflow-y: auto; overscroll-behavior: contain }
.develop-compose-btns { display: flex; gap: var(--space-xs); margin-left: auto }
.develop-compose-btns button { min-height: 40px; padding: 0 var(--space-md) 0 var(--space-sm) }
.develop-compose-btns svg { width: 18px; height: 18px; flex-shrink: 0 }
/* a phone: images and the run mode on one row, the two buttons on the next, half and half */
@media (max-width: 39.99rem) {
  .develop-compose-bar { display: grid; grid-template-columns: auto minmax(0, 1fr) }
  .develop-compose .develop-mode[open], .develop-compose-btns { grid-column: 1 / -1 }
  .develop-compose-btns { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); margin-left: 0 }
  .develop-compose-btns button { justify-self: stretch; min-width: 0; padding: 0 var(--space-sm) }
}
.develop-compose-note { padding-top: var(--space-xs) }
.develop-compose[hidden], .develop-newmsg[hidden] { display: none }
/* the run mode and "Duyệt và làm" are for a new turn only; while one is open the box just adds to it */
.develop-compose:not([data-state="reply"]) :is(.develop-mode, button[value="execute"]) { display: none }
.develop-compose.is-sending .develop-compose-box { opacity: 0.7 }
.develop-compose-err { color: var(--bad); font-size: var(--text-sm); padding: var(--space-2xs) var(--space-xs) 0 }
.develop-compose-err:empty { padding: 0 }
/* "new messages below": rides on top of the sticky box while the owner reads further up */
.develop-newmsg { position: absolute; left: 50%; top: 0; transform: translate(-50%, calc(-100% - var(--space-xs))); min-height: 36px; padding: 0 var(--space-md);
  box-shadow: 0 2px 10px oklch(18% 0.02 300 / 0.18) }
/* Claude at work, at the foot of the thread */
.develop-typing { justify-self: start; max-width: min(75ch, 92%); min-width: 0 }
.develop-typing p { display: flex; align-items: center; gap: var(--space-sm); margin: 0; color: var(--ink-2); min-width: 0 }
.develop-typing p > span:last-child { font-size: var(--text-sm); overflow-wrap: anywhere; min-width: 0 }
.develop-typing .develop-typing-act { font-family: var(--mono); font-size: var(--text-xs) }
.develop-dots { display: inline-flex; gap: 4px; flex-shrink: 0 }
.develop-dots i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: develop-dot 1.2s ease-in-out infinite }
.develop-dots i:nth-child(2) { animation-delay: 0.15s } .develop-dots i:nth-child(3) { animation-delay: 0.3s }
@keyframes develop-dot { 0%, 80%, 100% { opacity: 0.25; transform: none } 40% { opacity: 1; transform: translateY(-3px) } }
@media (prefers-reduced-motion: reduce) { .develop-dots i { animation: none; opacity: 0.6 } }
/* copy a reply (added by chat.js) */
.develop-copy { margin-left: auto; min-height: 28px; padding: 0 var(--space-sm); font-size: var(--text-xs); font-weight: 500; background: transparent; color: var(--muted);
  box-shadow: inset 0 0 0 1px var(--rule-2) }
@media (hover: hover) { .develop-copy:hover { background: var(--paper-3); color: var(--ink) } }
.develop-compose-off { padding-top: var(--space-sm); border-top: 1px solid var(--rule) }
/* #latest under the sticky top bar (two rows from 40rem until the tabs join the brand row at 60rem) */
.develop-msgs > #latest { scroll-margin-top: calc(var(--bar-h) + env(safe-area-inset-top) + var(--space-lg)) }
@media (min-width: 40rem) and (max-width: 59.99rem) { .develop-msgs > #latest { scroll-margin-top: calc(var(--bar-h) + 3rem + var(--space-lg)) } }
.develop-rules { margin: 0; padding: 0 0 0 var(--space-md); display: grid; gap: var(--space-2xs); color: var(--muted); font-size: var(--text-sm) }
.develop-rules b { color: var(--ink-2); font-weight: 600 }

.develop-sum-top { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm) }
.develop-sum-top .pill { font-size: var(--text-sm); padding: var(--space-xs) var(--space-sm) }
.develop-figs { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)) }
.develop-figs > div { display: grid; gap: var(--space-3xs); min-width: 0 }
.develop-figs > div + div { border-left: 1px solid var(--rule); padding-left: var(--space-md) }
.develop-sum .kv { margin: 0 }
.develop-wt { display: grid; gap: var(--space-sm); padding-top: var(--space-sm); border-top: 1px solid var(--rule); min-width: 0 }
.develop-wt > div { display: grid; gap: var(--space-2xs); min-width: 0; justify-items: start }
.develop-cmd { display: block; justify-self: stretch; font-size: var(--text-xs); line-height: 1.5; padding: var(--space-xs) var(--space-sm); border-radius: var(--radius-inner);
  background: var(--paper-3); overflow-wrap: anywhere; user-select: all; -webkit-user-select: all }
.develop-status-form { padding-top: var(--space-sm); border-top: 1px solid var(--rule) }
.develop-ctx { display: grid; gap: var(--space-xs); padding-top: var(--space-sm); border-top: 1px solid var(--rule); min-width: 0 }
.develop-ctx-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-xs) var(--space-sm) }
.develop-ctx-n { font-variant-numeric: tabular-nums; font-weight: 600 }
.develop-ctx-form { margin-left: auto }
.develop-ctx .develop-hint { margin: 0 }
.develop-bar-warn { color: var(--warn) }
.develop-bar-warn::-webkit-progress-value { background: var(--warn) }
.develop-bar-warn::-moz-progress-bar { background: var(--warn) }

.develop-checks { list-style: none; margin: 0; padding: 0; display: grid }
.develop-checks > li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-sm); align-items: start; padding: var(--space-xs) 0; border-top: 1px solid var(--rule); overflow-wrap: anywhere }
.develop-checks > li:first-child { border-top: 0 }
.develop-box { position: relative; width: 18px; height: 18px; margin-top: var(--space-3xs); border-radius: 5px; box-shadow: inset 0 0 0 1.5px var(--rule-2); flex-shrink: 0 }
.develop-check-done { color: var(--muted) }
.develop-check-done .develop-box { background: var(--accent); box-shadow: none }
.develop-check-done .develop-box::after { content: ""; position: absolute; left: 6px; top: 2.5px; width: 5px; height: 10px; border: solid var(--accent-ink); border-width: 0 2px 2px 0; transform: rotate(45deg) }
`

export const develop: Module = {
  id: 'develop', title: 'Develop', group: 'develop',
  css: CSS,

  init: initStore,

  panel(_s, v) {
    return boardHead('Bảng task', 'Bạn giao, Claude trao đổi, bạn duyệt thì Claude làm.', '<a class="btn" href="/develop/new">+ Task mới</a>') + lanes(v)
  },

  waiting(_s, v): Waiting[] {
    return listTasks(v.db).filter(t => t.status === 'awaiting' || t.status === 'review')
      .map(t => ({ text: `#${t.id} ${cut(t.title, 70)}`, sub: `${STATUS_LABEL[t.status]}, ${repoName(t.repo)}`, at: t.updated_at, href: `/develop/task/${t.id}#latest` }))
  },

  alerts(_s, v): Alert[] {
    return listTasks(v.db).filter(t => (t.status === 'awaiting' || t.status === 'review') && v.now - t.updated_at > 86_400_000)
      .map(t => ({ tone: 'warn', text: `Task #${t.id} chờ bạn hơn 24h: ${cut(t.title, 60)}`, href: `/develop/task/${t.id}#latest` }))
  },

  routes: [
    { method: 'GET', path: '/develop/task/:id', handle: (req, v): Res => {
      const id = intParam(req), t = id ? getTask(v.db, id) : undefined
      if (!t) return { title: 'Không có task', body: board(section('Không tìm thấy', `${empty('Không có task với số này.')}<a href="/develop">Về bảng task</a>`)), status: 404 }
      // the reply box is open for the whole turn, and a reload would wipe what is being typed: chat.js keeps the page
      // current instead. Only a stopping turn (no box) reloads itself
      // without JavaScript, a page with a turn open still reloads every minute (noscript)
      const st = composeState(t, openTurn(v.db, t.id))
      return { title: `#${t.id} ${t.title}`, body: taskPage(v, t), noRefresh: true, noscriptRefresh: st !== 'reply' && st !== 'closed' }
    } },
    { method: 'GET', path: '/develop/new', handle: (req, v): Res => {
      const jira = req.query.get('jira') ?? ''
      return { title: 'Task mới', body: newPage(newForm(v, { title: req.query.get('title') ?? '', body: req.query.get('body') ?? '', repo: req.query.get('repo') ?? '', jira }), jira ? `từ Jira ${jira}` : ''), noRefresh: true }
    } },
    { method: 'POST', path: '/develop/new', handle: async (req, v): Promise<Res> => {
      const title = (req.form.get('title') ?? '').trim().slice(0, 200), repo = req.form.get('repo') ?? ''
      if (!title || !REPOS.some(r => r.key === repo)) return { title: 'Thiếu thông tin', body: newPage('<p class="bad-t">Cần tiêu đề và repo hợp lệ.</p>' + newForm(v)), status: 400, noRefresh: true }
      const jira = (req.form.get('jira') ?? '').trim().slice(0, 40) || null
      const id = createTask(v.db, { title, body: (req.form.get('body') ?? '').slice(0, 20000), repo, jira_key: jira, ...parseMode(req.form) })
      const mid = addMessage(v.db, id, 'owner', `${title}\n\n${req.form.get('body') ?? ''}`.trim())
      await attach(v, id, mid, imagesOf(req))
      // imported tasks wait for an explicit start: their text came from Jira, not from the owner's hand
      if (req.form.get('start') === '1') startDiscussion(v, id)
      return { redirect: `/develop/task/${id}#latest` }
    } },
    { method: 'POST', path: '/develop/task/:id/send', handle: async (req, v): Promise<Res> => {
      const id = intParam(req), t = id ? getTask(v.db, id) : undefined
      // chat.js posts with ?js=1 and gets {ok, why} instead of a page; the form without the script gets the redirect
      const js = req.query.get('js') === '1'
      const back = (ok: boolean, why = ''): Res => js ? { json: { ok, why } } : { redirect: t ? `/develop/task/${t.id}#latest` : '/develop' }
      if (!t) return back(false, 'Không có task này.')
      const text = (req.form.get('text') ?? '').trim().slice(0, 20000), mode = req.form.get('mode'), uploads = imagesOf(req)
      // with a turn open, a message joins it (the runner writes it into the session); "Duyệt và làm" needs a turn of its own
      const refused = () => { const st = composeState(t, openTurn(v.db, t.id)); return st === 'closed' ? 'Task đã đóng.' : st === 'cancel' ? 'Lượt đang dừng, gửi lại sau khi dừng xong.'
        : st !== 'reply' && mode === 'execute' ? '"Duyệt và làm" mở lại khi lượt đang chạy xong.' : '' }
      const no = refused()
      if (no) return back(false, no)
      // images only, and none usable: say why and stop, rather than an empty bubble and a paid turn about nothing
      if (!text && uploads.length && !uploads.some(usable)) {
        addMessage(v.db, t.id, 'system', `Không gửi: ${SKIP_NOTE}`); return back(false, SKIP_NOTE)
      }
      const live = openTurn(v.db, t.id)
      // the run mode applies from the next turn on, and only from the full box (a turn is running: the box hides it);
      // a form without the fields (a page from before them) keeps the task's, and one without `isolated` at all (not
      // even the hidden 0, a page from before the worktree box) keeps the task's own choice
      if (!live && req.form.has('effort')) setMode(v.db, t.id, { ...parseMode(req.form), ...(req.form.has('isolated') ? {} : { isolated: t.isolated }) })
      // images go with the turn; a session that has not started yet gets every image of the task
      const send = (ids: number[]) => t.session_started ? ids : allFiles(v, t.id)
      if (mode === 'execute') {
        const ids = await postWithImages(v, t.id, uploads, () => addMessage(v.db, t.id, 'owner', text ? `Duyệt: ${text}` : 'Duyệt, làm đi.'))
        // sips gave the event loop away: a second tap may have queued a turn meanwhile, and a task gets one at a time
        if (openTurn(v.db, t.id)) return back(false, 'Đã có lượt khác bắt đầu, tin đã lưu nhưng chưa duyệt.')
        // the runner writes the full instructions at start (a worktree path may not exist yet); the turn carries the owner's note
        queueTurn(v.db, t.id, 'execute', text, send(ids))
      } else {
        // an empty press starts the discussion of a task that has none, and nothing else
        if (!text && !uploads.length) { if (!live && !t.session_started) { startDiscussion(v, t.id); return back(true) } return back(false, 'Tin trống.') }
        const said = text || '(chỉ gửi ảnh)'
        const ids = await postWithImages(v, t.id, uploads, () => addMessage(v.db, t.id, 'owner', text))
        if (refused()) return back(false, refused())
        // joining an open turn: that turn carries the task already, so just this message and its own images (review
        // 2026-11-09); `said` lets the runner word it for the session it joins (a note during an approved turn)
        const open = openTurn(v.db, t.id), joins = !!open || !!t.session_started
        // a command opens its message: before it, a session not started yet gets the task from the runner (taskPreamble)
        queueTurn(v.db, t.id, 'discuss', joins || ai.isCommand(said) ? replyPrompt(said) : `${taskMessage(t)}\n\n${replyPrompt(said)}`, joins ? ids : send(ids), Date.now(), said)
        if (open?.kind === 'execute') setStatus(v.db, t.id, 'working') // still the approved turn's task: it stays in its column
      }
      return back(true)
    } },
    // the "/" suggestions of a task's reply box (chat.js asks once): what claude offers in its repo
    { method: 'GET', path: '/develop/task/:id/commands', handle: (req, v): Res => {
      const id = intParam(req), t = id ? getTask(v.db, id) : undefined
      if (!t) return { json: [], status: 404 }
      return { json: ai.features.commands ? commandsFor(v.db, t.repo).map(c => ({ ...c, description: cut(c.description, 140) })) : [] }
    } },
    { method: 'GET', path: '/develop/paste.js', handle: (): Res => ({ file: PASTE, type: 'text/javascript; charset=utf-8' }) },
    { method: 'GET', path: '/develop/chat.js', handle: (): Res => ({ file: CHAT, type: 'text/javascript; charset=utf-8' }) },
    // what changed on a task page since message `after`: chat.js polls it (2 s while a turn is open, 15 s otherwise)
    { method: 'GET', path: '/develop/task/:id/live', handle: (req, v): Res => {
      const id = intParam(req), t = id ? getTask(v.db, id) : undefined
      if (!t) return { json: { gone: true }, status: 404 }
      const p = parts(v, t), after = Number(req.query.get('after')) || 0
      return { json: { state: p.state, after: lastId(p.msgs), messages: p.msgs.map((m, i) => m.id > after ? p.msg(m, i) : '').filter(Boolean), v: versions(p),
        typing: p.typing, live: p.live, status: p.sum, steps: p.stepsPanel, note: composeNote(t, p.state), placeholder: placeholder(p.state), mode: modeLabel(t, resolvedModels(v.db)), count: p.msgs.length } }
    } },
    { method: 'GET', path: '/develop/file/:id', handle: (req, v): Res => {
      const id = intParam(req), f = id ? getFile(v.db, id) : undefined
      const gone = { title: 'Không có ảnh', body: board(section('Không tìm thấy', `${empty('Không tìm thấy ảnh này.')}<a href="/develop">Về bảng task</a>`)), status: 404, noRefresh: true }
      try { return f ? { file: readFileSync(f.path), type: f.mime } : gone } catch { return gone }
    } },
    { method: 'POST', path: '/develop/task/:id/cancel', handle: (req, v): Res => {
      const id = intParam(req); if (id) requestCancel(v.db, id)
      return { redirect: `/develop/task/${id ?? ''}#latest` }
    } },
    { method: 'POST', path: '/develop/task/:id/status', handle: (req, v): Res => {
      const id = intParam(req), to = req.form.get('to') as TaskStatus
      if (id && getTask(v.db, id) && ['done', 'cancelled', 'awaiting'].includes(to) && !openTurn(v.db, id)) {
        setStatus(v.db, id, to); addMessage(v.db, id, 'system', `Owner chuyển trạng thái: ${STATUS_LABEL[to]}.`)
      }
      return { redirect: `/develop/task/${id ?? ''}#latest` }
    } },
  ],
}
