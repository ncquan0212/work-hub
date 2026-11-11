// The Develop runner's logic, separate from its process wrapper (main.ts) so it can be tested with a
// fake `claude` and a temporary repo (test/runner.test.ts). AI-neutral: what is specific to the AI (its arguments, its
// stdin and output formats) comes through `ai` (prompts.ts → lib/claude.ts), its output as NeutralEvents.
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { cut } from '../core/html.ts'
import { log } from '../core/log.ts'
import { notify, type Note } from '../lib/notify.ts'
import { ai, executeNote, executePrompt, SYSTEM_RULES, TURN_MAX_MS, TURN_TIMEOUT_MS } from '../modules/develop/prompts.ts'
import { addMessage, getFile, getTask, noteModel, setStatus, type Task, type Turn } from '../modules/develop/store.ts'

const run = promisify(execFile)
type Repo = { key: string; name: string; repo: string }
/** bin: the AI's CLI (ai.binary(), or a fake one in the tests). */
export type RunnerOptions = { db: DatabaseSync; repos: Repo[]; bin: string; worktrees: string; turnTimeoutMs?: number; turnMaxMs?: number }

/** The child's environment: only what the CLI needs (on Windows: where the user's profile and app data are). The hub's
 *  .env (JIRA_PAT …) never reaches a turn, and GIT_OPTIONAL_LOCKS=0 keeps any git the turn runs from taking index.lock in
 *  shared working trees. */
export function childEnv(src: NodeJS.ProcessEnv = process.env) {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM',
    'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'TEMP', 'TMP', 'PATHEXT', 'ComSpec',
    // not secrets: where claude finds Git Bash on Windows, and the config the Chrome hook must read (the runner's own)
    'CLAUDE_CODE_GIT_BASH_PATH', 'HUB_CONFIG', 'HUB_DATA']
  return { ...Object.fromEntries(keep.filter(k => src[k] != null).map(k => [k, src[k]!])), GIT_OPTIONAL_LOCKS: '0' }
}

const alive = (pid: number | null) => { if (!pid) return false; try { process.kill(pid, 0); return true } catch { return false } }

// One runner at a time: a second one would fail the first one's turns as "dead" (review 2026-11-08). Each runner beats
// every BEAT_MS in hub.db; one that starts while another live process beat under STALE_MS ago leaves. Not `ps`, which
// Windows lacks. A runner that exits removes its row, so a restart (old killed, new started) goes through at once; one
// killed outright leaves a row whose pid is gone, and pid reuse (after a reboot) is ruled out by the beat's age.
export const BEAT_MS = 10_000, STALE_MS = 30_000
/** Takes the runner slot for `pid`. Returns the pid of the live runner that holds it, or null once it is ours. */
export function claimRunner(db: DatabaseSync, pid = process.pid, now = Date.now()): number | null {
  db.exec('begin immediate') // two runners starting together: the second waits here, then sees the first one's beat
  try {
    const o = db.prepare('select pid, beat from develop_runner where id = 1').get() as { pid: number; beat: number } | undefined
    if (o && o.pid !== pid && now - o.beat < STALE_MS && alive(o.pid)) return o.pid
    db.prepare('insert into develop_runner (id, pid, beat) values (1, ?, ?) on conflict (id) do update set pid = excluded.pid, beat = excluded.beat').run(pid, now)
    return null
  } finally { db.exec('commit') }
}
export const beatRunner = (db: DatabaseSync, pid = process.pid, now = Date.now()) => db.prepare('update develop_runner set beat = ? where id = 1 and pid = ?').run(now, pid)
export const releaseRunner = (db: DatabaseSync, pid = process.pid) => db.prepare('delete from develop_runner where pid = ?').run(pid)

/** Records a Develop notification (architecture.md "Thông báo"; the hub pushes it). The key names the turn and what happened,
 *  so nothing repeats. A notification never fails a turn. */
function note(db: DatabaseSync, task: Pick<Task, 'id' | 'title'>, key: string, what: string, body: string, tone: Note['tone'] = 'info') {
  // a reply on a lock screen: one line, without the markdown marks that would show as they are
  const text = cut(body.replace(/\*\*|`/g, '').replace(/^#+\s*/gm, ''), 300)
  try { notify(db, { key: `develop:${key}`, title: `${what}: #${task.id} ${cut(task.title, 80)}`, body: text, url: `/develop/task/${task.id}#latest`, tone }) }
  catch (e) { log('warn', 'notify failed', { task: task.id, err: (e as Error).message }) }
}

export class Runner {
  readonly o: RunnerOptions
  private running = new Map<number, ChildProcess>() // turn id → child
  private active = new Set<number>()                // turn ids from pick-up to finish (covers the worktree step)
  private absorbers = new Map<number, () => number>() // turn id → writes the task's queued replies into that live session
  constructor(o: RunnerOptions) { this.o = o }

  /** Turns marked running by a runner that died (reboot, crash) are failed, so the task does not hang. */
  recover() {
    const { db } = this.o
    for (const t of db.prepare(`select * from develop_turns where status in ('running', 'cancel')`).all() as Turn[]) {
      if (this.active.has(t.id) || alive(t.pid)) continue
      db.prepare(`update develop_turns set status = 'failed', ended_at = ?, error = ? where id = ?`).run(Date.now(), 'runner dừng giữa lượt', t.id)
      // a reply already waiting runs next on its own: no need to send anything again
      const next = db.prepare(`select 1 from develop_turns where task_id = ? and status = 'queued'`).get(t.task_id)
      addMessage(db, t.task_id, 'system', `Lượt chạy bị ngắt (runner khởi động lại).${next ? ' Tin bạn gửi sau đó sẽ chạy tiếp.' : ' Gửi lại để chạy tiếp.'}`)
      setStatus(db, t.task_id, 'awaiting')
      const task = getTask(db, t.task_id)
      if (task) note(db, task, `turn:${t.id}:end`, 'Lượt bị ngắt', 'Runner khởi động lại giữa lượt.', 'warn')
    }
  }

  /** Worktree for a task's first execution turn: <worktrees>/<repo>-task<id>, branch hub/task-<id>, from HEAD. */
  async ensureWorktree(t: Task) {
    if (t.worktree && existsSync(t.worktree)) return t
    const repo = this.o.repos.find(r => r.key === t.repo)
    if (!repo) throw new Error(`repo ${t.repo} không có trong danh sách`)
    mkdirSync(this.o.worktrees, { recursive: true })
    const dir = join(this.o.worktrees, `${t.repo}-task${t.id}`), branch = `hub/task-${t.id}`
    // the branch survives `git worktree remove` (the page's own cleanup hint): reuse it then
    const has = await run('git', ['-C', repo.repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false)
    const args = ['-C', repo.repo, 'worktree', 'add', ...(has ? [dir, branch] : ['-b', branch, dir, 'HEAD'])]
    try { await run('git', args, { timeout: 60_000 }) } catch (e) {
      // the folder was deleted by hand (not `git worktree remove`): git still lists it; -f re-adds it at the same path
      if (!/already registered|missing but/.test(String((e as { stderr?: string }).stderr ?? e))) throw e
      await run('git', [...args.slice(0, 4), '-f', ...args.slice(4)], { timeout: 60_000 })
    }
    this.o.db.prepare('update develop_tasks set worktree = ?, branch = ? where id = ?').run(dir, branch, t.id)
    addMessage(this.o.db, t.id, 'system', `Đã tạo worktree ${dir} (branch ${branch}) từ HEAD của ${repo.name}.`)
    return getTask(this.o.db, t.id)!
  }

  /** Changes against HEAD in `dir`, all of them or only `paths` (absolute; any outside `dir` are dropped, git refuses them). */
  async diffSummary(dir: string, paths?: string[]) {
    let real = dir; try { real = realpathSync(dir) } catch { /* gone: git says so below */ }
    const roots = [dir, real].map(r => r + sep), spec = paths?.filter(p => roots.some(r => p.startsWith(r)))
    if (spec && !spec.length) return 'Không có file nào trong repo được sửa bằng Edit/Write (sửa bằng lệnh Bash thì không liệt kê được).'
    const tail = spec ? ['--', ...spec] : []
    try {
      const [stat, status] = await Promise.all([
        run('git', ['-C', dir, '--no-optional-locks', '--literal-pathspecs', 'diff', '--stat', 'HEAD', ...tail], { timeout: 20_000 }),
        run('git', ['-C', dir, '--no-optional-locks', '--literal-pathspecs', 'status', '--porcelain', ...tail], { timeout: 20_000 }),
      ])
      const untracked = status.stdout.split('\n').filter(l => l.startsWith('??')).map(l => l.slice(3))
      return (stat.stdout.trim() || 'Không có thay đổi so với HEAD.') + (untracked.length ? `\nFile mới: ${untracked.join(', ')}` : '')
    } catch (e) { return `Không đọc được diff: ${(e as Error).message}` }
  }

  /** Runs one turn to the end: reply, cost and status written. */
  async start(turn: Turn): Promise<void> {
    const { db } = this.o
    let task = getTask(db, turn.task_id)!
    let cwd = this.o.repos.find(r => r.key === task.repo)?.repo
    try {
      if (!cwd) throw new Error(`repo ${task.repo} không có trong danh sách`)
      // the main working tree is the default (owner 2026-11-09); a worktree only when the task asks for one
      if (turn.kind === 'execute' && task.isolated) { task = await this.ensureWorktree(task); cwd = task.worktree! }
    } catch (e) {
      db.prepare(`update develop_turns set status = 'failed', ended_at = ?, error = ? where id = ?`).run(Date.now(), (e as Error).message, turn.id)
      addMessage(db, task.id, 'system', `Không bắt đầu được: ${(e as Error).message}`)
      note(db, task, `turn:${turn.id}:end`, 'Lượt lỗi', `Không bắt đầu được: ${(e as Error).message}`, 'warn')
      return setStatus(db, task.id, 'awaiting')
    }
    // the owner may have pressed "Dừng" while the worktree was being created
    if ((db.prepare('select status from develop_turns where id = ?').get(turn.id) as { status: string }).status === 'cancel') {
      db.prepare(`update develop_turns set status = 'cancelled', ended_at = ? where id = ?`).run(Date.now(), turn.id)
      addMessage(db, task.id, 'system', 'Đã dừng lượt chạy theo yêu cầu.')
      return setStatus(db, task.id, 'awaiting')
    }
    // discussion prompts are complete at queue time; an execution turn carries the owner's note and gets
    // its instructions here, now that the worktree path is known
    const args = ai.turnArgs(task, turn.kind, SYSTEM_RULES)
    const child = spawn(this.o.bin, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv() })
    child.stdin!.on('error', () => { /* claude exited before we closed stdin */ })
    const act = db.prepare('insert into develop_activity (task_id, turn_id, at, text) values (?, ?, ?, ?)')
    // images the owner attached go in as image blocks; a file gone from disk is left out rather than failing the turn
    const images = (files: string | null) => !ai.features.images ? [] : (JSON.parse(files ?? '[]') as number[]).flatMap(id => {
      const f = getFile(db, id)
      try { return f ? [{ mime: f.mime, data: readFileSync(f.path) }] : [] } catch { return [] }
    })
    // every message written counts; the AI acks each one when it takes it (Claude: --replay-user-messages)
    let sent = 0, echoed = 0, waiting = 0, dying = '' // dying: why the hub is ending it, or that claude reported an error
    const merged: number[] = [] // replies written into this session, in order (stdin message i + 1)
    const write = (prompt: string, files: string | null) => { child.stdin!.write(ai.message(prompt, images(files))); sent++ }
    const setWaiting = (w: number) => { if (w !== waiting) db.prepare('update develop_turns set waiting = ? where id = ?').run(waiting = w, turn.id) }
    write(turn.kind === 'execute' ? executePrompt(task, turn.prompt) : turn.prompt, turn.files)
    // a reply the owner sends while Claude waits on its background job (the page allows it then) goes into this
    // session, so the job keeps running; before 2026-11-09 the only way to say something was "Dừng", which killed it
    const absorb = () => {
      // too late (stdin closed, or the process is on its way out): it stays queued and starts its own turn after this one
      if (child.stdin!.writableEnded || dying || child.exitCode !== null || child.signalCode !== null) return 0
      const qs = db.prepare(`select * from develop_turns where task_id = ? and kind = 'discuss' and status = 'queued' order by id`).all(task.id) as Turn[]
      let n = 0
      for (const q of qs) {
        if (db.prepare(`update develop_turns set status = 'merged', started_at = ?, ended_at = ? where id = ? and status = 'queued'`).run(Date.now(), Date.now(), q.id).changes === 0) continue
        // worded for the session it joins: a note during an approved turn is not a discussion (review 2026-11-09)
        write(turn.kind === 'execute' && q.said != null ? executeNote(q.said) : q.prompt, q.files); merged.push(q.id); n++
        act.run(task.id, turn.id, Date.now(), 'Claude nhận tin trả lời của bạn')
      }
      if (n) setWaiting(0)
      return n
    }
    this.absorbers.set(turn.id, absorb)
    this.running.set(turn.id, child)
    db.prepare(`update develop_turns set pid = ? where id = ?`).run(child.pid ?? null, turn.id)
    log('info', 'turn started', { task: task.id, turn: turn.id, kind: turn.kind, pid: child.pid })

    let lastText = '', result = null as { ok: boolean; subtype?: string } | null, stderr = '', pending = 0, replies = 0, cost = 0, spoke = false
    let said = '', jobs = false, jobDoneAt = -1 // Claude's latest reply; a background job ran; `replies` when one finished
    const edited = new Set<string>() // files this turn wrote through the tools: in the shared main tree, git diff alone shows other sessions' work too
    // killed only when hung: no output for turnTimeoutMs (a running workflow prints progress), or past turnMaxMs
    const idle = this.o.turnTimeoutMs ?? TURN_TIMEOUT_MS, max = this.o.turnMaxMs ?? TURN_MAX_MS
    const stop = (why: string) => () => { dying = why; child.kill('SIGTERM') }
    let quiet = setTimeout(stop(`không có output ${Math.round(idle / 60_000)} phút`), idle)
    const cap = setTimeout(stop(`chạy quá ${Math.round(max / 3_600_000)} giờ`), max)
    createInterface({ input: child.stdout! }).on('line', line => {
      clearTimeout(quiet); quiet = setTimeout(stop(`không có output ${Math.round(idle / 60_000)} phút`), idle)
      for (const e of ai.parse(line)) {
        // the model the AI really runs (an alias like "fable" follows CLI updates): kept per turn and per choice
        if (e.kind === 'model') {
          db.prepare('update develop_turns set model_used = ? where id = ?').run(e.model, turn.id)
          noteModel(db, task.model ?? 'default', e.model)
        }
        else if (e.kind === 'session') { if (!task.session_started) { db.prepare('update develop_tasks set session_started = 1 where id = ?').run(task.id); task.session_started = 1 } }
        else if (e.kind === 'ack') echoed++
        else if (e.kind === 'text' || e.kind === 'tool') {
          spoke = true; setWaiting(0)
          if (e.kind === 'tool') {
            act.run(task.id, turn.id, Date.now(), ai.describeTool(e.name, e.input))
            if (e.file) edited.add(resolve(cwd!, e.file))
          }
          else if (e.text.trim()) lastText = e.text
        }
        else if (e.kind === 'jobs') { pending = e.pending; if (pending) jobs = true }
        else if (e.kind === 'end') {
          // one end per turn inside the session: a turn that started a background job ends with "started", and the
          // job's completion starts another turn. Each answer goes into the thread as it comes. The cost is the
          // session's running total (lib/claude.ts)
          result = e; cost = Number(e.cost ?? 0) || cost
          if (!e.ok && !dying) dying = 'error' // it may exit now: a reply written after this could be lost
          const text = String(e.text ?? lastText).trim(); lastText = ''
          if (text) { addMessage(db, task.id, 'claude', text); replies++; said = text }
          // the job's own report is in: tell the owner now (a workflow can run 45 minutes), not only when the session closes
          if (jobs && !pending && e.ok) { jobs = false; jobDoneAt = replies; note(db, task, `turn:${turn.id}:job:${replies}`, 'Việc chạy nền xong', said || 'Xem kết quả trong task.') }
          // a resumed session first reports the background job the previous process died with (owner's "Dừng") as stopped:
          // an empty success result with no turn behind it, while our prompt still waits in claude's queue. Closing stdin
          // there leaves the real turn running with input closed, and claude -p kills a job that turn starts 600 s after
          // it ends (CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS; task #5, 2026-11-09, probed). So only a turn that spoke, or failed.
          // and only once the AI has taken every message written (a reply it has not started yet would run with stdin closed)
          if (!pending && (spoke || !e.ok) && echoed >= sent && !absorb()) child.stdin!.end()
          else if (pending && !child.stdin!.writableEnded) setWaiting(1) // the page now takes a reply
          spoke = false
        }
      }
    })
    child.stderr!.on('data', (b: Buffer) => { stderr = (stderr + b.toString()).slice(-2000) })
    const code = await new Promise<number | null>(resolve => { child.on('close', resolve); child.on('error', () => resolve(-1)) })
    clearTimeout(quiet); clearTimeout(cap); this.running.delete(turn.id); this.absorbers.delete(turn.id)
    setWaiting(0)
    // replies written but never taken (the process ended first) go back to the queue and run on their own
    const unread = merged.slice(Math.max(0, echoed - 1))
    for (const q of unread) db.prepare(`update develop_turns set status = 'queued', started_at = null, ended_at = null where id = ? and status = 'merged'`).run(q)

    const cancelled = (db.prepare('select status from develop_turns where id = ?').get(turn.id) as { status: string }).status === 'cancel'
    const ok = !cancelled && code === 0 && !!result?.ok
    const reply = replies ? '' : lastText.trim() // a crash before any result: keep the last thing Claude said
    const killed = dying && dying !== 'error' ? dying : '' // the hub stopped it (hung): say so, not the last result's subtype
    const why = cancelled ? 'owner huỷ' : killed ? `hub dừng: ${killed}` : `${result?.subtype ?? `exit ${code}`}${stderr ? `: ${stderr.slice(-300)}` : ''}`
    db.prepare(`update develop_turns set status = ?, ended_at = ?, cost_usd = ?, error = ? where id = ?`)
      .run(cancelled ? 'cancelled' : ok ? 'done' : 'failed', Date.now(), cost, ok ? null : why, turn.id)
    // the turn row keeps the session total after it; the task's cost IS that total (adding them counted turns twice)
    if (cost) db.prepare('update develop_tasks set cost_usd = ? where id = ?').run(cost, task.id)
    if (reply) { addMessage(db, task.id, 'claude', reply); said = reply }
    if (cancelled) addMessage(db, task.id, 'system', 'Đã dừng lượt chạy theo yêu cầu.')
    else if (killed) addMessage(db, task.id, 'system', `Hub dừng lượt này: ${killed}.`)
    else if (!ok) addMessage(db, task.id, 'system', `Lượt chạy lỗi (${result?.subtype ?? `exit ${code}`}).`)
    if (turn.kind === 'execute') addMessage(db, task.id, 'system', task.isolated
      ? `Thay đổi trong worktree:\n${await this.diffSummary(cwd!)}`
      : `Thay đổi so với HEAD, chỉ các file lượt này sửa trong working tree chính:\n${await this.diffSummary(cwd!, [...edited])}`)
    setStatus(db, task.id, ok && turn.kind === 'execute' ? 'review' : 'awaiting')
    // the task now waits for the owner. Stopped by the owner: nothing to say. Ended right on the job report: already said
    const end = `turn:${turn.id}:end`
    if (!cancelled && !ok) note(db, task, end, killed ? 'Hub dừng lượt' : 'Lượt lỗi', killed ? `Hub dừng lượt này: ${killed}.` : `Lượt chạy lỗi (${result?.subtype ?? `exit ${code}`}).`, 'warn')
    else if (ok && turn.kind === 'execute') note(db, task, end, 'Làm xong, cần xem thay đổi', said || 'Xem thay đổi trong task.')
    else if (ok && jobDoneAt !== replies) note(db, task, end, 'Claude trả lời', said || 'Xem trong task.')
    log('info', 'turn ended', { task: task.id, turn: turn.id, ok, code, cost })
  }

  /** One scheduling pass: recover, cancel, start every queued turn. No cap on turns at once (owner 2026-11-11: "bỏ qua
   *  trần đi, tôi sẽ tự kiểm soát"; it was 2, and a turn waiting on its background job kept a slot). */
  tick(): Promise<void>[] {
    const { db } = this.o
    this.recover()
    for (const t of db.prepare(`select * from develop_turns where status = 'cancel'`).all() as Turn[]) this.running.get(t.id)?.kill('SIGTERM')
    for (const absorb of this.absorbers.values()) absorb()
    const queued = db.prepare(`select * from develop_turns q where status = 'queued'
      and not exists (select 1 from develop_turns r where r.task_id = q.task_id and r.status in ('running', 'cancel'))
      and q.id = (select min(id) from develop_turns s where s.task_id = q.task_id and s.status = 'queued') order by id`).all() as Turn[]
    return queued.flatMap(t => {
      // claim it now, before any await and atomically, so neither the next tick nor another runner picks it again
      if (db.prepare(`update develop_turns set status = 'running', started_at = ? where id = ? and status = 'queued'`).run(Date.now(), t.id).changes === 0) return []
      // set where every turn starts: a reply that missed the last session must not run under "Chờ bạn" (review 2026-11-09)
      setStatus(db, t.task_id, t.kind === 'execute' ? 'working' : 'discussing')
      this.active.add(t.id)
      return [this.start(t).finally(() => this.active.delete(t.id))]
    })
  }
}
