// The Develop runner end to end with a fake `claude` (a script that prints stream-json) and a
// temporary git repo: no tokens spent, no real repo touched.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { APPS, CHROME_BROWSERS, DATA, HOME, RC_DIR, rcKeyPath, REPOS, WORKTREES } from '../src/config.ts'
import { openDb } from '../src/core/db.ts'
import type { Req, View } from '../src/core/types.ts'
import { develop, steps } from '../src/modules/develop/index.ts'
import { projectDir, rulePath } from '../src/lib/claude.ts'
import { ai, parseMode, SYSTEM_RULES } from '../src/modules/develop/prompts.ts'
import { addMessage, commandsFor, composeState, contextShare, createTask, saveCommands, saveContext, getTask, initStore, messages, openTurn, queueTurn, requestCancel, turns, type RunMode, type Task, type Turn } from '../src/modules/develop/store.ts'
import { guard, markerFile } from '../src/runner/chrome-guard.ts'
import { Runner } from '../src/runner/runner.ts'

const FAKE = `#!/usr/bin/env node
const args = process.argv.slice(2)
const out = o => console.log(JSON.stringify(o))
const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]
// a discussion turn carries the deny rule that keeps it out of the main working tree; an execution turn does not
const mode = args.includes('Edit(./**)') ? 'discuss' : 'execute'
const res = (text, cost) => out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: cost, session_id: sid, result: text })
// like claude -p --input-format stream-json --replay-user-messages: the prompt is the first stdin line, each line is
// echoed back as it is taken, a later line is a reply written into the live session, and the process ends when stdin does
let buf = '', lines = 0, onLine = null, lag = null
process.stdin.on('data', d => {
  buf += d
  for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) {
    const msg = JSON.parse(buf.slice(0, i)).message
    if (lag && lines++) { lag(msg); continue } // this one is taken later, not on arrival
    out({ type: 'user', isReplay: true, message: msg })
    if (lag || lines++ === 0) run(msg.content); else onLine?.(typeof msg.content === 'string' ? msg.content : msg.content.find(b => b.type === 'text').text)
  }
})
// content is the prompt, or [text, ...image blocks] when the owner attached images
process.stdin.on('end', () => process.exit(0))
function run(content) {
  const prompt = typeof content === 'string' ? content : content.find(b => b.type === 'text').text
  if (prompt.includes('TICK')) { // a long job that keeps printing progress: alive past the idle limit, never past the cap
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w3' }] }); res('chạy lâu', 0.3)
    const t = setInterval(() => out({ type: 'system', subtype: 'task_progress', task_id: 'w3' }), 100)
    return setTimeout(() => { clearInterval(t); out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'xong lâu' }] } }); res('xong lâu', 0.5) }, prompt.includes('CAP') ? 5000 : 900)
  }
  if (prompt.includes('DIE')) { // waits on its job, then exits before it takes the reply written into it
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w6' }] }); res('chờ rồi thoát', 0.3)
    lag = () => process.exit(0)
    return
  }
  if (prompt.includes('LAG')) { // the job ends just as a reply arrives: the job's result comes first, then the reply is taken
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w5' }] }); res('chờ', 0.3)
    lag = msg => {
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'xong' }] } }); res('xong workflow', 0.4)
      setTimeout(() => { out({ type: 'user', isReplay: true, message: msg }); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'nhận' }] } }); res('nhận muộn', 0.45) }, 200)
    }
    return
  }
  if (prompt.includes('WAIT')) { // Claude waits on its job; a reply written meanwhile is answered at once, the job's result comes later
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w4' }] }); res('chờ workflow', 0.3)
    onLine = text => {
      out({ type: 'assistant', message: { content: [{ type: 'text', text: 'nhận' }] } }); res((text.includes('lượt THỰC HIỆN') ? 'ghi chú: ' : 'nhận: ') + text.split('\"\"\"')[1].trim(), 0.35)
      setTimeout(() => { out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'xong' }] } }); res('xong workflow', 0.4) }, 300)
    }
    return
  }
  if (prompt.includes('STALE')) { // --resume after "Dừng" killed a job: its stopped notice and an empty result come first (probed)
    out({ type: 'system', subtype: 'task_notification', task_id: 'w0', status: 'stopped' }); res('', 0.5)
    return setTimeout(() => {
      out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Workflow', input: {} }] } })
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w2' }] }); res('chạy lại', 0.6)
      setTimeout(() => { out({ type: 'assistant', message: { content: [{ type: 'text', text: 'xong lại' }] } }); out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); res('xong lại', 0.7) }, 200)
    }, 100)
  }
  const images = typeof content === 'string' ? 0 : content.filter(b => b.type === 'image' && b.source.data).length
  out({ type: 'system', subtype: 'init', session_id: sid, model: args.includes('--model') ? 'claude-' + args[args.indexOf('--model') + 1] + '-9-1' : 'claude-opus-5-5' })
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'README.md' } }] } })
  if (mode === 'execute') { // a Write the runner lists, and an Edit outside the repo it must drop (git refuses such paths)
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: require('path').join(process.cwd(), 'NEW.txt') } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/etc/hosts' } }] } })
    require('fs').writeFileSync('NEW.txt', 'x')
  }
  if (prompt.includes('FAIL')) { out({ type: 'result', subtype: 'error_during_execution', is_error: true, total_cost_usd: 1 }); process.exit(1) }
  // the weekly limit: a "success" result that is an error, its text the reason (turn 221, 2026-11-12)
  if (prompt.includes('LIMIT')) { out({ type: 'result', subtype: 'success', is_error: true, total_cost_usd: 1, result: "You've hit your weekly limit" }); process.exit(1) }
  if (prompt.includes('IMG')) return res('images=' + images, 0.1)
  if (prompt.includes('BG')) { // a background job outlives the first turn; its completion starts a second one (cost is a running total)
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1' }] }); res('đang chạy workflow', 0.25)
    return setTimeout(() => { out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); out({ type: 'assistant', message: { content: [{ type: 'text', text: 'xong: A1 A2' }] } }); res('xong: A1 A2', 0.4) }, 200)
  }
  // --resume restores the session's running cost, so a resumed turn reports the total so far
  res(mode + ' ' + (args.includes('--resume') ? 'resume' : 'new') + '\\n- [x] đọc\\n- [ ] sửa', args.includes('--resume') ? 0.5 : 0.25)
}
`

test('runner: discuss, resume, execute in a worktree and in the main tree, failure, crash recovery', { skip: process.platform === 'win32' && 'the fake claude is a shebang script, which spawn cannot run on Windows' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-runner-'))
  try {
    const repo = join(dir, 'repo'); execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, 'README.md'), 'hi'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const claude = join(dir, 'claude'); writeFileSync(claude, FAKE); chmodSync(claude, 0o755)
    const db = openDb(':memory:'); initStore(db)
    const runner = new Runner({ db, repos: [{ key: 't', name: 'Test', repo }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 10_000 })

    const id = createTask(db, { title: 'Thêm nút', body: 'mô tả', repo: 't' })
    queueTurn(db, id, 'discuss', 'trao đổi')
    await Promise.all(runner.tick())
    let t = getTask(db, id)!
    assert.equal(t.status, 'awaiting'); assert.equal(t.session_started, 1); assert.equal(t.cost_usd, 0.25)
    assert.match(messages(db, id).at(-1)!.text, /^discuss new/)
    // the model claude ran, from its init event: on the turn, and as what the account default resolves to
    assert.equal(turns(db, id).at(-1)!.model_used, 'claude-opus-5-5')
    assert.deepEqual(db.prepare('select alias, model from develop_models').all().map(r => ({ ...r })), [{ alias: 'default', model: 'claude-opus-5-5' }])
    assert.deepEqual(steps(messages(db, id).at(-1)!.text), [{ done: true, text: 'đọc' }, { done: false, text: 'sửa' }])

    addMessage(db, id, 'owner', 'ok'); queueTurn(db, id, 'discuss', 'trả lời')
    await Promise.all(runner.tick())
    assert.match(messages(db, id).at(-1)!.text, /^discuss resume/)
    assert.equal(getTask(db, id)!.cost_usd, 0.5, 'task cost = the session total, not 0.25 + 0.5')

    // a background job (an ultracode workflow): the session stays open until a turn ends with nothing running
    const bg = createTask(db, { title: 'Phân tích', body: '', repo: 't' })
    queueTurn(db, bg, 'discuss', 'BG')
    await Promise.all(runner.tick())
    assert.deepEqual(messages(db, bg).filter(m => m.who === 'claude').map(m => m.text), ['đang chạy workflow', 'xong: A1 A2'])
    assert.equal(turns(db, bg).at(-1)!.status, 'done'); assert.equal(getTask(db, bg)!.cost_usd, 0.4)
    // the hung-turn limit counts silence, not time: a job printing progress outlives it; the hard cap still stops one
    const slow = new Runner({ db, repos: [{ key: 't', name: 'Test', repo }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 400, turnMaxMs: 2000 })
    const lj = createTask(db, { title: 'Lâu', body: '', repo: 't' })
    queueTurn(db, lj, 'discuss', 'TICK'); await Promise.all(slow.tick())
    assert.deepEqual(messages(db, lj).filter(m => m.who === 'claude').map(m => m.text), ['chạy lâu', 'xong lâu'])
    queueTurn(db, lj, 'discuss', 'TICK CAP'); await Promise.all(slow.tick())
    assert.equal(turns(db, lj).at(-1)!.status, 'failed', 'killed at the cap')
    assert.match(messages(db, lj).at(-1)!.text, /^Hub dừng lượt này: chạy quá/, 'the thread says the hub stopped it, and why')

    // owner 2026-11-09: while Claude waits on its job the page takes a reply, and the runner writes it into the live
    // session instead of making the owner stop the turn (which killed the job)
    const wt = createTask(db, { title: 'Chờ', body: '', repo: 't' })
    queueTurn(db, wt, 'discuss', 'WAIT')
    const running = runner.tick()
    for (let i = 0; i < 200 && !turns(db, wt).at(-1)!.waiting; i++) await new Promise(r => setTimeout(r, 20))
    assert.equal(turns(db, wt).at(-1)!.waiting, 1, 'the turn says Claude is waiting')
    const view = { now: Date.now(), db, csrf: 'x', slot: () => undefined } as unknown as View
    const page = develop.routes!.find(r => r.method === 'GET' && r.path === '/develop/task/:id')!
    const sendRoute = develop.routes!.find(r => r.method === 'POST' && r.path === '/develop/task/:id/send')!
    const call = (r: typeof page, form = '') => r.handle({ method: r.method, path: '', params: { id: String(wt) }, query: new URLSearchParams(), form: new URLSearchParams(form), files: [] } as unknown as Req, view)
    const shown = await call(page) as { body: string; noRefresh?: boolean }
    // one box for every state: data-state hides the run mode and "Duyệt và làm" (CSS), the server refuses the latter
    assert.match(shown.body, /data-state="waiting"/); assert.match(shown.body, /Dừng cả việc chạy nền/); assert.match(shown.body, /id="typing"[^]*chờ việc chạy nền/)
    assert.equal(shown.noRefresh, true, 'a page with the reply box open does not reload itself')
    await call(sendRoute, 'text=x&mode=execute') // "Duyệt và làm" needs a turn of its own: refused
    assert.equal(turns(db, wt).length, 1)
    // chat.js: the send answers JSON, and /live gives what changed after a message id
    const liveRoute = develop.routes!.find(r => r.method === 'GET' && r.path === '/develop/task/:id/live')!
    const js = (form: string) => sendRoute.handle({ method: 'POST', path: '', params: { id: String(wt) }, query: new URLSearchParams('js=1'), form: new URLSearchParams(form), files: [] } as unknown as Req, view)
    assert.deepEqual(await js('text=x&mode=execute'), { json: { ok: false, why: '"Duyệt và làm" mở lại khi lượt đang chạy xong.' } })
    const before = (await liveRoute.handle({ method: 'GET', path: '', params: { id: String(wt) }, query: new URLSearchParams(), form: new URLSearchParams(), files: [] } as unknown as Req, view) as { json: any }).json
    assert.equal(before.state, 'waiting'); assert.equal(before.messages.length, 1); assert.match(before.typing, /chờ việc chạy nền/)
    assert.deepEqual(await js('text=thêm điều kiện&mode=discuss'), { json: { ok: true, why: '' } })
    const after = (await liveRoute.handle({ method: 'GET', path: '', params: { id: String(wt) }, query: new URLSearchParams(`after=${before.after}`), form: new URLSearchParams(), files: [] } as unknown as Req, view) as { json: any }).json
    assert.equal(after.messages.length, 1, 'only what came after'); assert.match(after.messages[0], /class="msg me"[^]*thêm điều kiện/)
    runner.tick() // absorbs the reply into the running session
    await Promise.all(running)
    assert.deepEqual(messages(db, wt).filter(m => m.who === 'claude').map(m => m.text), ['chờ workflow', 'nhận: thêm điều kiện', 'xong workflow'])
    assert.deepEqual(turns(db, wt).map(x => [x.status, x.waiting]), [['done', 0], ['merged', 0]])

    // a reply written just as the job ends: stdin stays open until claude has taken it and answered
    const lt = createTask(db, { title: 'Muộn', body: '', repo: 't' })
    queueTurn(db, lt, 'discuss', 'LAG')
    const lagging = runner.tick()
    for (let i = 0; i < 200 && !turns(db, lt).at(-1)!.waiting; i++) await new Promise(r => setTimeout(r, 20))
    queueTurn(db, lt, 'discuss', 'trả lời muộn'); runner.tick()
    await Promise.all(lagging)
    assert.deepEqual(messages(db, lt).filter(m => m.who === 'claude').map(m => m.text), ['chờ', 'xong workflow', 'nhận muộn'])

    // a note during an approved turn is worded for that turn, not as a discussion (review 2026-11-09)
    const ex = createTask(db, { title: 'Làm', body: '', repo: 't' })
    queueTurn(db, ex, 'execute', 'WAIT')
    const exRun = runner.tick()
    for (let i = 0; i < 200 && !turns(db, ex).at(-1)!.waiting; i++) await new Promise(r => setTimeout(r, 20))
    const exSend = develop.routes!.find(r => r.method === 'POST' && r.path === '/develop/task/:id/send')!
    await exSend.handle({ method: 'POST', path: '', params: { id: String(ex) }, query: new URLSearchParams('js=1'), form: new URLSearchParams('text=đổi màu nút&mode=discuss'), files: [] } as unknown as Req,
      { now: Date.now(), db, csrf: 'x', slot: () => undefined } as unknown as View)
    runner.tick(); await Promise.all(exRun)
    assert.ok(messages(db, ex).some(m => m.who === 'claude' && m.text === 'ghi chú: đổi màu nút'), 'worded as a note for the approved turn')
    // a reply written into a session that ends before taking it goes back to the queue and runs on its own
    const die = createTask(db, { title: 'Chết', body: '', repo: 't' })
    queueTurn(db, die, 'discuss', 'DIE')
    const dieRun = runner.tick()
    for (let i = 0; i < 200 && !turns(db, die).at(-1)!.waiting; i++) await new Promise(r => setTimeout(r, 20))
    queueTurn(db, die, 'discuss', 'còn đó không', [], Date.now(), 'còn đó không'); runner.tick()
    await Promise.all(dieRun)
    assert.deepEqual(turns(db, die).map(x => x.status), ['done', 'queued'], 'not marked merged and lost')
    await Promise.all(runner.tick())
    assert.equal(turns(db, die).at(-1)!.status, 'done'); assert.match(messages(db, die).at(-1)!.text, /^discuss resume/)

    // resumed after the owner stopped a turn whose job was running: the stale empty result must not end the session
    // (it did on task #5: the new job was killed by claude 10 minutes later)
    queueTurn(db, bg, 'discuss', 'STALE')
    await Promise.all(runner.tick())
    assert.deepEqual(messages(db, bg).filter(m => m.who === 'claude').map(m => m.text).slice(-2), ['chạy lại', 'xong lại'])
    assert.equal(turns(db, bg).at(-1)!.status, 'done'); assert.equal(getTask(db, bg)!.cost_usd, 0.7)

    // images attached to a turn go in as image blocks; one whose file is gone is left out
    const pic = join(dir, 'a.png'); writeFileSync(pic, Buffer.from('89504e470d0a1a0a', 'hex'))
    const f1 = Number(db.prepare(`insert into develop_files (task_id, message_id, mime, path, bytes, at) values (?, 0, 'image/png', ?, 8, 0)`).run(bg, pic).lastInsertRowid)
    const f2 = Number(db.prepare(`insert into develop_files (task_id, message_id, mime, path, bytes, at) values (?, 0, 'image/png', ?, 8, 0)`).run(bg, join(dir, 'gone.png')).lastInsertRowid)
    queueTurn(db, bg, 'discuss', 'IMG', [f1, f2])
    await Promise.all(runner.tick())
    assert.equal(messages(db, bg).at(-1)!.text, 'images=1')

    // a task that asks for its own worktree
    const iso = createTask(db, { title: 'Riêng', body: '', repo: 't', isolated: 1 })
    queueTurn(db, iso, 'execute', '')
    await Promise.all(runner.tick())
    const it = getTask(db, iso)!
    assert.equal(it.status, 'review')
    assert.equal(it.branch, `hub/task-${iso}`)
    assert.ok(it.worktree && existsSync(join(it.worktree, 'NEW.txt')), 'edit lands in the worktree')
    assert.ok(!existsSync(join(repo, 'NEW.txt')), 'main working tree untouched')
    assert.match(messages(db, iso).at(-1)!.text, /File mới: NEW\.txt/)

    // the default: straight in the main working tree, where another session has uncommitted work of its own
    writeFileSync(join(repo, 'OTHER.txt'), 'not mine')
    queueTurn(db, id, 'execute', '')
    await Promise.all(runner.tick())
    t = getTask(db, id)!
    assert.equal(t.status, 'review'); assert.equal(t.worktree, null)
    assert.ok(existsSync(join(repo, 'NEW.txt')), 'edit lands in the main tree')
    assert.match(messages(db, id).at(-1)!.text, /chỉ các file lượt này sửa[^]*File mới: NEW\.txt$/)
    assert.doesNotMatch(messages(db, id).at(-1)!.text, /OTHER|hosts/, "another session's files and paths outside the repo are left out")

    queueTurn(db, id, 'discuss', 'FAIL please')
    await Promise.all(runner.tick())
    assert.equal(turns(db, id).at(-1)!.status, 'failed')
    assert.match(messages(db, id).at(-1)!.text, /Lượt chạy lỗi \(error_during_execution\)/)
    queueTurn(db, id, 'discuss', 'LIMIT please')
    await Promise.all(runner.tick())
    assert.match(messages(db, id).at(-1)!.text, /Lượt chạy lỗi \(You've hit your weekly limit\)/, 'the reason, not "success"')
    assert.match(await runner.diffSummary(join(dir, 'gone'), [join(dir, 'gone', 'a.txt')]), /Không đọc được diff/, 'a folder gone: a line, not a throw')
    assert.equal(getTask(db, id)!.status, 'awaiting')

    // a turn left "running" by a dead runner is failed on the next pass
    db.prepare(`insert into develop_turns (task_id, kind, prompt, status, pid, created_at) values (?, 'discuss', 'x', 'running', 999999, 0)`).run(id)
    runner.tick()
    assert.equal(turns(db, id).at(-1)!.status, 'failed')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// architecture.md "Thông báo": what the owner's devices hear about from the runner, once per turn and result
test('runner: notifications when a task waits for the owner, a job finishes, a turn fails or is cut off', { skip: process.platform === 'win32' && 'the fake claude is a shebang script, which spawn cannot run on Windows' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-runner-'))
  try {
    const repo = join(dir, 'repo'); execFileSync('git', ['init', '-q', repo])
    writeFileSync(join(repo, 'README.md'), 'hi'); execFileSync('git', ['-C', repo, 'add', '.']); execFileSync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    const claude = join(dir, 'claude'); writeFileSync(claude, FAKE); chmodSync(claude, 0o755)
    const db = openDb(':memory:'); initStore(db)
    const runner = new Runner({ db, repos: [{ key: 't', name: 'Test', repo }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 10_000 })
    const run = async (title: string, kind: 'discuss' | 'execute', prompt: string) => {
      const id = createTask(db, { title, body: '', repo: 't' }); queueTurn(db, id, kind, prompt); await Promise.all(runner.tick())
      return { id, turn: turns(db, id).at(-1)!.id }
    }
    const a = await run('Hỏi **nút**', 'discuss', 'trao đổi')
    const b = await run('Nền', 'discuss', 'BG')
    const c = await run('Hỏng', 'discuss', 'FAIL')
    const d = await run('Làm', 'execute', 'làm')
    const e = createTask(db, { title: 'Ngắt', body: '', repo: 't' })
    db.prepare(`insert into develop_turns (task_id, kind, prompt, status, pid, created_at) values (?, 'discuss', 'x', 'running', null, 0)`).run(e)
    runner.tick()
    const eTurn = turns(db, e).at(-1)!.id
    const rows = () => db.prepare('select key, title, body, url, tone from notify_items order by id').all().map(r => ({ ...r }))
    assert.deepEqual(rows(), [
      { key: `develop:turn:${a.turn}:end`, title: `Claude trả lời: #${a.id} Hỏi **nút**`, body: 'discuss new - [x] đọc - [ ] sửa', url: `/develop/task/${a.id}#latest`, tone: 'info' },
      // the job's report is the news; the session closing on it right after is not said again
      { key: `develop:turn:${b.turn}:job:2`, title: `Việc chạy nền xong: #${b.id} Nền`, body: 'xong: A1 A2', url: `/develop/task/${b.id}#latest`, tone: 'info' },
      { key: `develop:turn:${c.turn}:end`, title: `Lượt lỗi: #${c.id} Hỏng`, body: 'Lượt chạy lỗi (error_during_execution).', url: `/develop/task/${c.id}#latest`, tone: 'warn' },
      { key: `develop:turn:${d.turn}:end`, title: `Làm xong, cần xem thay đổi: #${d.id} Làm`, body: 'execute new - [x] đọc - [ ] sửa', url: `/develop/task/${d.id}#latest`, tone: 'info' },
      { key: `develop:turn:${eTurn}:end`, title: `Lượt bị ngắt: #${e} Ngắt`, body: 'Runner khởi động lại giữa lượt.', url: `/develop/task/${e}#latest`, tone: 'warn' },
    ])
    // a turn the owner stopped says nothing; the hub stopping a hung one does
    const slow = new Runner({ db, repos: [{ key: 't', name: 'Test', repo }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 400, turnMaxMs: 1000 })
    const h = createTask(db, { title: 'Treo', body: '', repo: 't' }); queueTurn(db, h, 'discuss', 'TICK CAP'); await Promise.all(slow.tick())
    // (its job never finished, so no "Việc chạy nền xong")
    assert.deepEqual(rows().slice(5).map(r => [r.title, r.body, r.tone]), [[`Hub dừng lượt: #${h} Treo`, 'Hub dừng lượt này: chạy quá 0 giờ.', 'warn']])
    const s = createTask(db, { title: 'Dừng', body: '', repo: 't' }); queueTurn(db, s, 'discuss', 'TICK CAP')
    const stopping = slow.tick()
    for (let i = 0; i < 100 && !turns(db, s).at(-1)!.started_at; i++) await new Promise(r => setTimeout(r, 10))
    requestCancel(db, s); slow.tick(); await Promise.all(stopping)
    assert.equal(turns(db, s).at(-1)!.status, 'cancelled'); assert.equal(rows().length, 6)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('model names: the version a choice really ran as, from claude\'s init event', async () => {
  const { modelName, modelChoice } = await import('../src/modules/develop/prompts.ts')
  assert.equal(modelName('claude-fable-5-1'), 'Fable 5.1'); assert.equal(modelName('claude-haiku-4-5-20251001'), 'Haiku 4.5'); assert.equal(modelName('gpt-x'), 'gpt-x')
  assert.equal(modelChoice('fable'), 'Fable 5.1', 'static label before any run')
  assert.equal(modelChoice('fable', new Map([['fable', 'claude-fable-5-2']])), 'Fable 5.2', 'an alias that moved shows its new version')
  assert.equal(modelChoice(null, new Map([['default', 'claude-opus-5-5']])), 'Opus 5.5')
})

test('deny rules: a discussion edits no repo and no worktree; an execution any repo, or only its own worktree', () => {
  const t = { session_started: 0, session_id: 's', model: null, effort: null, ultracode: 0, chrome: 0, isolated: 0, worktree: null } as unknown as Task
  const trees = REPOS.map(r => `Edit(${rulePath(resolve(r.repo))}/**)`), worktrees = `Edit(${rulePath(resolve(WORKTREES))}/**)`
  const denied = (a: string[]) => a.slice(a.indexOf('--disallowedTools') + 1, a.indexOf('--output-format'))
  const discuss = denied(ai.turnArgs(t, 'discuss', [])), execute = denied(ai.turnArgs(t, 'execute', []))
  const iso = denied(ai.turnArgs({ ...t, isolated: 1 } as Task, 'execute', []))
  assert.ok(trees.length >= 2)
  for (const r of [...trees, worktrees, 'Edit(./**)']) assert.ok(discuss.includes(r), `discussion: ${r}`)
  for (const r of [...trees, worktrees]) assert.ok(!execute.includes(r), `execution: ${r}`)
  for (const r of trees) assert.ok(iso.includes(r), `own worktree: ${r} read-only`)
  assert.ok(!iso.includes(worktrees), 'its own worktree stays writable')
})

test('run mode: flags for model, thinking and ultracode; none by default', () => {
  const discussArgs = (t: Task) => ai.turnArgs(t, 'discuss', SYSTEM_RULES)
  const flags = (m: Partial<RunMode>) => discussArgs({ session_started: 0, session_id: 's', model: null, effort: null, ultracode: 0, chrome: 0, isolated: 0, ...m } as Task).join(' ')
  assert.doesNotMatch(flags({}), /--model|--effort|--settings|--chrome/)
  assert.match(flags({ model: 'sonnet', effort: 'max' }), /--model sonnet --effort max --append-system-prompt /)
  assert.match(flags({ ultracode: 1 }), /--setting-sources user,project,local --settings \{"ultracode":true,"workflowSizeGuideline":"small"\} --append-system-prompt /)
  // the browsers the config allows (test/fixtures/config.json), in the system prompt with the config's note
  const [b1, b2] = CHROME_BROWSERS.map(b => b.id)
  assert.match(flags({ chrome: 1 }), new RegExp(`--settings \\{"hooks":\\{"PreToolUse":\\[\\{"matcher":"mcp__claude-in-chrome__\\.\\*"[^]*chrome-guard\\.ts[^]*--chrome --append-system-prompt [^]*${b1}[^]*${b2}[^]* --disallowedTools`))
  assert.doesNotMatch(flags({ chrome: 1 }), /trên Mac/)
  assert.match(flags({ chrome: 1, ultracode: 1 }), /--settings \{"ultracode":true,"workflowSizeGuideline":"small","hooks":/)
  assert.match(flags({}), /Read\(~\/\*\*\/key\.properties\) [^]*Read\(~\/\*\*\/\.env\*\)|Read\(~\/\*\*\/\.env\*\)[^]*Read\(~\/\*\*\/key\.properties\)/, 'secret denies anchored at home, not only under cwd')
  assert.doesNotMatch(flags({ chrome: 1 }), /0000000000ff/)
  // pushes and shared-tree wipes, plain or behind -C/-c (probed with claude 2026-11-09); a worktree is off limits to a discussion turn
  for (const r of ['Bash(git -C * push *)', 'Bash(git -c * push)', 'Bash(git stash *)', 'Bash(git reset --hard)', 'Bash(git add .)', 'Edit(//wt/t1/**)'])
    assert.ok(discussArgs({ session_started: 0, session_id: 's', worktree: '/wt/t1', model: null, effort: null, ultracode: 0, chrome: 0, isolated: 0 } as Task).includes(r), r)
  assert.doesNotMatch(flags({}), /Bash\(git \* push/, 'not `git * push`: it would refuse a commit message that says push')
  // RC (probed with claude 2026-11-09): the keys and a publish are denied, rc.py and its README are not, and every turn is told about it
  assert.match(flags({}), /Bash\(\*rc\.py\*--yes\*\) PowerShell\(\*rc\.py\*--yes\*\) Bash\(\*rc\.py\* api \*\) PowerShell\(\*rc\.py\* api \*\)/)
  // every command rule for PowerShell too: claude on Windows runs commands there when it finds no Git Bash
  for (const r of ['PowerShell(git push)', 'PowerShell(git -C * push *)', 'PowerShell(git reset --hard)', 'PowerShell(git add .)'])
    assert.ok(flags({}).split(' --disallowedTools ')[1].includes(r), r)
  assert.ok(flags({}).includes(`Read(${rulePath(RC_DIR)}/*-access.json)`), 'the RC keys where this copy keeps them')
  assert.ok(!flags({}).includes(`${rulePath(RC_DIR)}/**`), 'not the whole folder: README and rc.py are for tasks')
  assert.ok(flags({}).includes(`Read(${rulePath(resolve(DATA))}/**)`), "the hub's own data/, wherever it was cloned")
  // the RC rule only where rc.py is (the owner's tool, not in git), with the paths of this copy
  const key = rcKeyPath(APPS.find(a => a.rcKey)!)!.replace(HOME, '~')
  if (existsSync(join(RC_DIR, 'rc.py'))) assert.ok(flags({}).includes(`--append-system-prompt Remote Config`) && flags({}).includes(`TV_RC_KEY=${key} `))
  else assert.doesNotMatch(flags({}), /Remote Config/)
  assert.match(flags({}), /docs\/agent\/decisions\.md/, 'every turn is told about decisions.md')
  assert.ok(flags({}).includes(join(HOME, '.claude/projects', projectDir(HOME), 'memory/MEMORY.md')), 'and the home memory')
  // the reply box for the whole turn (owner 2026-11-09): a new turn, joins the open one, or none
  const turn = (status: string, waiting = 0) => ({ status, waiting }) as Turn
  assert.deepEqual([undefined, turn('queued'), turn('running'), turn('running', 1), turn('cancel')].map(o => composeState({ status: 'awaiting' }, o)), ['reply', 'queued', 'live', 'waiting', 'cancel'])
  assert.equal(composeState({ status: 'done' }, undefined), 'closed')
  // the worktree box sends a hidden 0 first, so a box left unticked still says so
  assert.equal(parseMode(new URLSearchParams('effort=&isolated=0&isolated=1')).isolated, 1)
  assert.equal(parseMode(new URLSearchParams('effort=&isolated=0')).isolated, 0)
  assert.deepEqual(parseMode(new URLSearchParams('model=toString&effort=off&ultracode=1&chrome=1&isolated=1')), { model: null, effort: null, ultracode: 1, chrome: 1, isolated: 1 })
  assert.deepEqual(parseMode(new URLSearchParams('model=claude-haiku-5-5&effort=xhigh')), { model: 'claude-haiku-5-5', effort: 'xhigh', ultracode: 0, chrome: 0, isolated: 0 })
})

test('chrome guard: browser tools only after an owner-chosen browser was selected in this session', () => {
  const allowed = CHROME_BROWSERS.map(b => b.id), sid = `test-${process.pid}`, mine = allowed[0], other = '00000000-0000-4000-8000-0000000000ff'
  const pre = (tool: string, input: object = {}) => guard({ hook_event_name: 'PreToolUse', session_id: sid, tool_name: `mcp__claude-in-chrome__${tool}`, tool_input: input }, allowed)
  rmSync(markerFile(sid), { force: true })
  try {
    assert.equal(pre('list_connected_browsers'), null)
    assert.match(pre('navigate', { url: 'https://console.firebase.google.com' })!, /Chưa chọn/, 'nothing works before a selection')
    assert.match(pre('select_browser', { deviceId: other })!, /Chỉ được chọn/, "never someone else's browser")
    assert.match(pre('switch_browser')!, /switch_browser/)
    assert.equal(pre('select_browser', { deviceId: mine }), null)
    guard({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'mcp__claude-in-chrome__select_browser', tool_input: { deviceId: mine }, tool_response: [{ type: 'text', text: 'No browser with that id.' }] }, allowed)
    assert.match(pre('tabs_context_mcp')!, /Chưa chọn/, 'a failed selection does not count')
    guard({ hook_event_name: 'PostToolUse', session_id: sid, tool_name: 'mcp__claude-in-chrome__select_browser', tool_input: { deviceId: mine }, tool_response: [{ type: 'text', text: 'Selected browser "Browser 1".' }] }, allowed)
    assert.equal(pre('tabs_context_mcp'), null)
  } finally { rmSync(markerFile(sid), { force: true }) }
})


test('paste.js: a valid script, on both image forms under a URL that changes with the file', async () => {
  execFileSync(process.execPath, ['--check', join(import.meta.dirname, '../src/modules/develop/paste.js')])
  const db = openDb(':memory:'); initStore(db)
  const id = createTask(db, { title: 'x', body: '', repo: REPOS[0].key })
  const v = { now: Date.now(), db, csrf: 'c', slot: () => undefined } as unknown as View
  const route = (p: string) => develop.routes!.find(r => r.method === 'GET' && r.path === p)!
  const req = (params = {}) => ({ method: 'GET', path: '', params, query: new URLSearchParams(), form: new URLSearchParams(), files: [] }) as unknown as Req
  const js = await route('/develop/paste.js').handle(req(), v) as { file: Buffer; type: string }
  assert.equal(js.type, 'text/javascript; charset=utf-8')
  const tag = `<script src="/develop/paste.js?v=${createHash('sha256').update(js.file).digest('hex').slice(0, 12)}" defer></script>`
  for (const p of ['/develop/task/:id', '/develop/new']) {
    const body = (await route(p).handle(req({ id: String(id) }), v) as { body: string }).body
    assert.ok(body.includes(tag), p); assert.ok(body.includes('data-max="6"'), p)
  }
  // a page from before the worktree box (it has `effort`, not `isolated`) keeps the task's choice when it posts
  db.prepare('update develop_tasks set isolated = 1, session_started = 1 where id = ?').run(id)
  const send = develop.routes!.find(r => r.method === 'POST' && r.path === '/develop/task/:id/send')!
  await send.handle({ ...req({ id: String(id) }), method: 'POST', form: new URLSearchParams('text=hi&model=&effort=&mode=discuss') } as Req, v)
  assert.equal(getTask(db, id)!.isolated, 1)
})

test('Dừng stops the running turn and keeps the replies sent during it; the page shows the running turn', () => {
  const db = openDb(':memory:'); initStore(db)
  const id = createTask(db, { title: 'x', body: '', repo: 't' })
  queueTurn(db, id, 'discuss', 'a'); db.prepare(`update develop_turns set status = 'running' where task_id = ?`).run(id)
  queueTurn(db, id, 'discuss', 'reply', [], Date.now(), 'reply')
  assert.equal(openTurn(db, id)!.status, 'running', 'not the queued reply: the page would say "waiting for the runner"')
  requestCancel(db, id)
  assert.deepEqual(turns(db, id).map(t => t.status), ['cancel', 'queued'])
  // nothing running yet: the queued turns are what is stopped, and the thread says so
  const b = createTask(db, { title: 'y', body: '', repo: 't' })
  queueTurn(db, b, 'discuss', 'first'); queueTurn(db, b, 'discuss', 'second')
  requestCancel(db, b)
  assert.deepEqual(turns(db, b).map(t => t.status), ['cancelled', 'cancelled'])
  assert.match(messages(db, b).at(-1)!.text, /huỷ cả 1 tin đang chờ/)
  db.close()
})

// claude's output for commands, as probed 2026-11-16 (plan §12): /context is answered locally and never echoed, /compact
// is echoed but says nothing of its own and may show an old message again, a skill is echoed as its expansion
const FAKE_COMMANDS = `#!/usr/bin/env node
const out = o => console.log(JSON.stringify(o))
const args = process.argv.slice(2), sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1]
const mode = args.includes('Edit(./**)') ? 'discuss' : 'execute'
const say = (text, used) => out({ type: 'assistant', parent_tool_use_id: null, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }], usage: { input_tokens: 10, cache_read_input_tokens: used - 10, cache_creation_input_tokens: 0 } } })
const res = text => out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, session_id: sid, result: text,
  modelUsage: { 'claude-opus-5-5': { contextWindow: 1000000 }, 'claude-haiku-4-5-20251001': { contextWindow: 200000 } } })
out({ type: 'system', subtype: 'init', session_id: sid, model: 'claude-opus-5-5' })
out({ type: 'system', subtype: 'commands_changed', commands: [{ name: 'compact', description: 'Free up context', argumentHint: '<instructions>' }, { name: 'doctor', description: 'terminal only' }, { name: 'simplify', description: 'Review the changed code' }] })
let buf = '', held = null // while a background job runs, claude holds a command until the turn it is in ends
process.stdin.on('data', d => {
  buf += d
  for (let i; (i = buf.indexOf('\\n')) >= 0; buf = buf.slice(i + 1)) take(JSON.parse(buf.slice(0, i)).message.content)
})
function take(text) {
    if (held && text.startsWith('/')) return held.push(text)
    if (text === 'JOB') {
      out({ type: 'user', isReplay: true, message: { content: text } })
      out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'w1' }] }); res('chờ việc nền'); held = []
      return setTimeout(() => {
        out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] }); say('báo cáo việc nền', 70010); res('báo cáo việc nền')
        const h = held; held = null; setTimeout(() => h.forEach(take), 100) // it takes them a moment after the report
      }, 400)
    }
    if (text === 'AUTO') { // a long turn: claude compacts by itself near the limit and goes on working
      out({ type: 'user', isReplay: true, message: { content: text } })
      say('làm', 820000)
      out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 820000, post_tokens: 9000 } })
      say('làm tiếp', 90010); res('xong việc dài')
      return
    }
    if (text === '/context') {
      out({ type: 'assistant', parent_tool_use_id: null, local_command_source: '<local-command-stdout>## Context Usage', message: { model: '<synthetic>', content: [{ type: 'text', text: '## Context Usage' }], usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } })
      res('## Context Usage\\n**Tokens:** 60k / 1M')
    } else if (text.startsWith('/compact')) {
      out({ type: 'user', isReplay: true, message: { content: '<local-command-stdout>Compacted</local-command-stdout>' } })
      out({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 150000, post_tokens: 4000 } })
      if (text !== '/compact') say('một tin cũ hiện lại', 149000) // a bare /compact shows nothing again: no text at all in its turn
      res('')
    } else if (text.startsWith('/')) {
      out({ type: 'user', isReplay: true, message: { content: '<command-name>' + text.split(' ')[0] + '</command-name>' } })
      say(mode + ' chạy ' + text, 60010); res(mode + ' chạy ' + text)
    } else {
      out({ type: 'user', isReplay: true, message: { content: text } })
      say('đã đọc', 50010); res(text.includes('Tin kế tiếp là lệnh') ? 'đã đọc task' : 'trả lời thường')
    }
}
process.stdin.on('end', () => process.exit(0))
`

test('runner: commands and skills as they are, the context and its size, /context and /compact end their turn', { skip: process.platform === 'win32' && 'the fake claude is a shebang script, which spawn cannot run on Windows' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-cmd-'))
  try {
    const repo = join(dir, 'repo'); execFileSync('git', ['init', '-q', repo])
    const claude = join(dir, 'claude'); writeFileSync(claude, FAKE_COMMANDS); chmodSync(claude, 0o755)
    const db = openDb(':memory:'); initStore(db)
    // a hung turn would fail here in 3 s rather than time the test out
    const runner = new Runner({ db, repos: [{ key: 't', name: 'Test', repo }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 3000 })
    const claudeSaid = (id: number) => messages(db, id).filter(m => m.who === 'claude').map(m => m.text)

    // the first message of a session is a skill: the task goes in first, then the skill as it is
    const id = createTask(db, { title: 'Dọn code', body: 'Màn paywall', repo: 't' })
    queueTurn(db, id, 'discuss', '/simplify')
    await Promise.all(runner.tick())
    assert.equal(turns(db, id).at(-1)!.status, 'done')
    assert.deepEqual(claudeSaid(id), ['đã đọc task', 'discuss chạy /simplify'])
    let t = getTask(db, id)!
    assert.equal(t.context_used, 60010); assert.equal(t.context_window, 1000000, "the window of the model that answered, not the side model's")
    assert.equal(contextShare(t), 0.06001)
    assert.deepEqual(commandsFor(db, 't').map(c => c.name), ['compact', 'simplify'], 'terminal-only commands are not offered')
    assert.deepEqual(commandsFor(db, 'other').map(c => c.name), ['compact', 'simplify'], 'a repo with no turn yet borrows the latest list')

    // /context: answered without an echo, and the turn still ends; a local answer is no context figure
    queueTurn(db, id, 'discuss', '/context')
    await Promise.all(runner.tick())
    assert.equal(turns(db, id).at(-1)!.status, 'done', '/context must not hang the turn')
    assert.match(claudeSaid(id).at(-1)!, /^## Context Usage/)
    assert.equal(getTask(db, id)!.context_used, 60010)

    // /compact: says nothing itself, the turn ends, a line in the thread; the old message shown again is not taken
    queueTurn(db, id, 'discuss', '/compact giữ quyết định')
    await Promise.all(runner.tick())
    assert.equal(turns(db, id).at(-1)!.status, 'done', '/compact must not hang the turn')
    assert.match(messages(db, id).at(-1)!.text, /^Đã compact: trước đó context có 150k token/)
    assert.ok(!claudeSaid(id).includes('một tin cũ hiện lại'), 'an old message shown again after compact is not a new reply')
    t = getTask(db, id)!
    assert.equal(t.context_used, 60010, 'nor its context figure'); assert.ok(t.compact_at); assert.equal(contextShare(t), null, 'compacted: no share until Claude answers again')

    queueTurn(db, id, 'discuss', '/compact')
    await Promise.all(runner.tick())
    assert.equal(turns(db, id).at(-1)!.status, 'done', 'a compact that prints nothing else still ends the turn')

    // a command sent while Claude waits on a background job is held by claude until the job's report turn ends: that
    // report is not its ack (review 2026-11-16), the command still runs in the session and the turn ends
    queueTurn(db, id, 'discuss', 'JOB')
    const job = runner.tick()
    for (let i = 0; i < 200 && !turns(db, id).at(-1)!.waiting; i++) await new Promise(r => setTimeout(r, 10))
    queueTurn(db, id, 'discuss', '/context'); runner.tick()
    await Promise.all(job)
    assert.deepEqual(claudeSaid(id).slice(-3).map(s => s.slice(0, 16)), ['chờ việc nền', 'báo cáo việc nền', '## Context Usage'])
    assert.deepEqual(turns(db, id).slice(-2).map(x => x.status), ['done', 'merged'], 'the command went into the session, nothing left to requeue')

    // an automatic compact goes on working: the figures after it are new
    queueTurn(db, id, 'discuss', 'AUTO')
    await Promise.all(runner.tick())
    t = getTask(db, id)!
    assert.equal(t.context_used, 90010); assert.ok(contextShare(t), 'a new figure after an automatic compact')
    assert.match(messages(db, id).find(m => m.text.startsWith('Claude tự compact'))!.text, /trước đó context có 820k token/)

    // "Duyệt và làm" with a command as the note: the turn's message is the command as it is
    queueTurn(db, id, 'execute', '/simplify')
    await Promise.all(runner.tick())
    assert.equal(claudeSaid(id).at(-1), 'execute chạy /simplify')
    assert.ok(contextShare(getTask(db, id)!), 'a new answer brings the share back')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('page: the context figure, a warning from 75% on the task and its card, Compact, the "/" list; a command is sent as it is', async () => {
  const db = openDb(':memory:'); initStore(db)
  const id = createTask(db, { title: 'x', body: 'mô tả', repo: REPOS[0].key })
  const v = { now: Date.now(), db, csrf: 'c', slot: () => undefined } as unknown as View
  const route = (m: string, p: string) => develop.routes!.find(r => r.method === m && r.path === p)!
  const req = (form = '') => ({ method: 'GET', path: '', params: { id: String(id) }, query: new URLSearchParams(), form: new URLSearchParams(form), files: [] }) as unknown as Req
  const page = async () => (await route('GET', '/develop/task/:id').handle(req(), v) as { body: string }).body
  let body = await page()
  assert.match(body, /Context<\/span><span class="develop-hint">có số sau câu trả lời đầu tiên/)
  assert.doesNotMatch(body, /value="\/compact"/, 'no session yet: nothing to compact')
  assert.match(body, /id="compose-cmds" role="listbox"/); assert.match(body, /aria-controls="compose-cmds"/)

  db.prepare('update develop_tasks set session_started = 1, context_used = 160000, context_window = 200000, context_at = ? where id = ?').run(Date.now(), id)
  body = await page()
  assert.match(body, /160k \/ 200k, 80%/); assert.match(body, /class="develop-bar develop-bar-warn" value="160000" max="200000"/)
  assert.match(body, /<input type="hidden" name="text" value="\/compact"><button type="submit" class="ghost">Compact/)
  assert.match(develop.panel!(undefined, v) as string, /Context 80%/, 'the card warns too')
  db.prepare('update develop_tasks set context_used = 100000 where id = ?').run(id)
  assert.doesNotMatch(develop.panel!(undefined, v) as string, /Context \d+%/, 'not under 75%')

  // the reply box: a command goes as it is; plain text is still framed as the owner's words
  const send = route('POST', '/develop/task/:id/send')
  await send.handle({ ...req('text=/compact&mode=discuss'), method: 'POST' } as Req, v)
  assert.equal(turns(db, id).at(-1)!.prompt, '/compact')
  db.prepare(`update develop_turns set status = 'done'`).run()
  await send.handle({ ...req('text=xem /context giúp&mode=discuss'), method: 'POST' } as Req, v)
  assert.match(turns(db, id).at(-1)!.prompt, /^Owner trả lời[^]*xem \/context giúp/)
  db.prepare(`update develop_turns set status = 'done'`).run()
  const cmdTask = createTask(db, { title: 'Review', body: '/code-review high', repo: REPOS[0].key })
  await send.handle({ ...req('text=chỉ xem Paywall.kt&mode=discuss'), params: { id: String(cmdTask) }, method: 'POST' } as unknown as Req, v)
  assert.match(turns(db, cmdTask).at(-1)!.prompt, /^Task #\d+: Review[^]*"{3}\n\/code-review high\n"{3}[^]*chỉ xem Paywall\.kt/, 'framed: the reply is not taken as the arguments of the command')
  // compacted: the old figure is from before, the page says so instead of a share
  db.prepare('update develop_tasks set compact_at = ? where id = ?').run(Date.now() + 1, id)
  assert.match(await page(), /Vừa compact, trước đó 100k/)

  // another model answers (the run mode changed): no share until its size is known
  db.prepare('update develop_tasks set compact_at = null, context_window = 200000, context_model = ? where id = ?').run('claude-haiku-5-5', id)
  saveContext(db, id, 250000, 'claude-opus-5-5')
  assert.equal(getTask(db, id)!.context_window, null); assert.equal(contextShare(getTask(db, id)!), null)
  db.prepare('update develop_tasks set context_window = 1000000 where id = ?').run(id)
  saveContext(db, id, 252000, 'claude-opus-5-5')
  assert.equal(getTask(db, id)!.context_window, 1000000, 'the same model keeps its size')
  // the "/" list: what claude listed for this repo, descriptions cut short
  saveCommands(db, REPOS[0].key, [{ name: 'simplify', description: 'x'.repeat(300), hint: '' }])
  const list = (await route('GET', '/develop/task/:id/commands').handle(req(), v) as { json: { name: string; description: string }[] }).json
  assert.equal(list[0].name, 'simplify'); assert.ok(list[0].description.length <= 141)
  db.close()
})

test('runner: an execution that wrote in another repo lists the changes of each repo', { skip: process.platform === 'win32' && 'the fake claude is a shebang script, which spawn cannot run on Windows' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-two-'))
  try {
    const repo = join(dir, 'xr'), other = join(dir, 'xc')
    for (const r of [repo, other]) {
      execFileSync('git', ['init', '-q', r]); writeFileSync(join(r, 'README.md'), 'hi')
      execFileSync('git', ['-C', r, 'add', '.']); execFileSync('git', ['-C', r, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'])
    }
    // writes what the owner's note names: a file here, and one in the other repo (its path in the note)
    const fake = `#!/usr/bin/env node
const out = o => console.log(JSON.stringify(o)), fs = require('fs'), path = require('path')
process.stdin.once('data', d => {
  const text = JSON.parse(String(d).split('\\n')[0]).message.content
  out({ type: 'user', isReplay: true, message: { content: text } })
  const there = /TWO (\\S+)/.exec(text)[1], files = [path.join(process.cwd(), 'A.txt'), path.join(there, 'B.txt')]
  for (const f of files) fs.writeFileSync(f, 'x')
  out({ type: 'assistant', message: { content: files.map(f => ({ type: 'tool_use', name: 'Write', input: { file_path: f } })) } })
  out({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.1, result: 'xong hai repo' })
})
process.stdin.on('end', () => process.exit(0))
`
    const claude = join(dir, 'claude'); writeFileSync(claude, fake); chmodSync(claude, 0o755)
    const db = openDb(':memory:'); initStore(db)
    const runner = new Runner({ db, repos: [{ key: 'xr', name: 'XRemote', repo }, { key: 'xc', name: 'XCast', repo: other }], bin: claude, worktrees: join(dir, 'wt'), turnTimeoutMs: 3000 })
    const id = createTask(db, { title: 'Sửa cả hai', body: '', repo: 'xr' })
    db.prepare('update develop_tasks set session_started = 1 where id = ?').run(id)
    queueTurn(db, id, 'execute', `TWO ${other}`)
    await Promise.all(runner.tick())
    const diff = messages(db, id).at(-1)!.text
    assert.match(diff, /theo repo:\n\nXRemote:\n[^]*File mới: A\.txt\n\nXCast:\n[^]*File mới: B\.txt$/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
