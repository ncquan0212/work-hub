// E1 · Claude Code sessions and workflows of the last 24 h, read from the transcripts on disk.
// This is the panel that replaces asking an agent "báo cáo tiến độ".
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CODE, HOME } from '../config.ts'
import { ago, cut, empty, esc, pill, section, stale } from '../core/html.ts'
import type { DatabaseSync } from 'node:sqlite'
import { NotConfigured, type Module, type Tone } from '../core/types.ts'
import { projectDir } from '../lib/claude.ts'

const PROJECTS = join(HOME, '.claude/projects')
const HOME_DIR = projectDir(HOME), CODE_DIR = projectDir(CODE) // "/Users/me" → "-Users-me", "C:\Users\me" → "C--Users-me"
const DAY = 86_400_000

/** A transcript folder → the project's name: its path under codeDir, else under the home folder ("-Users-me-Code-app" → "app"). */
export function projectLabel(dir: string) {
  if (dir === HOME_DIR) return 'home'
  for (const p of [CODE_DIR + '-', HOME_DIR + '-']) if (dir.startsWith(p)) return dir.slice(p.length)
  return dir
}

function tailObjects(file: string, bytes = 65_536) {
  const { size } = statSync(file)
  const len = Math.min(bytes, size), buf = Buffer.alloc(len), fd = openSync(file, 'r')
  try { readSync(fd, buf, 0, len, size - len) } finally { closeSync(fd) }
  const lines = buf.toString('utf8').split('\n')
  if (len < size) lines.shift() // first line is cut
  return lines.flatMap(l => { try { return [JSON.parse(l)] } catch { return [] } })
}

// exited: the transcript ends with the `cost-state` record claude writes as its process exits (only into that session's
// own transcript: checked 2026-11-09 on every transcript of the day; a live session has none)
export type SessionInfo = { ts: number; prompt: string | null; title: string | null; last: 'end' | 'work' | 'interrupted' | null; exited: boolean }

export function sessionInfo(objs: any[]): SessionInfo {
  // Don't use file mtime: a `cost-state` record written at process shutdown touches every transcript.
  const s: SessionInfo = { ts: 0, prompt: null, title: null, last: null, exited: false }
  for (const o of objs) {
    if (!o || typeof o !== 'object') continue
    s.exited = o.type === 'cost-state' // true only while it is the last record: a resumed session writes after it
    if (o.timestamp) s.ts = Math.max(s.ts, Date.parse(o.timestamp) || 0)
    if (o.type === 'last-prompt') s.prompt = o.lastPrompt
    else if (o.type === 'ai-title') s.title = o.aiTitle
    else if (o.type === 'assistant') {
      // any finished stop (end_turn, stop_sequence, refusal, max_tokens) ends the turn; only tool_use continues it
      const r = o.message?.stop_reason
      s.last = r && r !== 'tool_use' ? 'end' : 'work'
    } else if (o.type === 'user' && !o.isMeta) {
      const c = o.message?.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join('') : ''
      if (/^<(local-)?command-/.test(text)) continue // a local slash command after the turn (e.g. /model) starts no turn
      s.last = text.startsWith('[Request interrupted') ? 'interrupted' : 'work'
    }
  }
  return s
}

export type SessionState = 'running' | 'background' | 'waiting' | 'interrupted' | 'silent'

export function sessionState(s: SessionInfo, now: number): Exclude<SessionState, 'background'> {
  if (s.last === 'interrupted') return 'interrupted'
  if (s.last === 'end') return 'waiting'                    // turn finished: waiting for the owner
  // mid-turn, but its process has exited (the owner's "Dừng" on a Develop task, a closed window): stopped, not hung.
  // Before 2026-11-09 these showed as "im lặng giữa lượt" on Hôm nay for a day
  if (s.exited) return 'interrupted'
  return now - s.ts < 10 * 60_000 ? 'running' : 'silent'   // mid-turn and quiet >10' = died (reboot) or a long tool
}

function recentlyWritten(subagentsDir: string, now: number) {
  if (!existsSync(subagentsDir)) return false
  return readdirSync(subagentsDir).some(f => f.startsWith('agent-') && f.endsWith('.jsonl')
    && now - statSync(join(subagentsDir, f)).mtimeMs < 2 * 60_000)
}

export type Session = SessionInfo & { project: string; sid: string; state: SessionState }
export type Workflow = { project: string; runId: string; name: string; state: string; startedAt: number; endedAt?: number; lastAt?: number
  summary?: string; agents?: number; started?: number; done?: number }

const sessionCache = new Map<string, { size: number; info: SessionInfo }>()
const runCache = new Map<string, Workflow>() // finished workflow status files never change

export function scan(now: number) {
  const sessions: Session[] = [], workflows: Workflow[] = []
  if (!existsSync(PROJECTS)) throw new NotConfigured('chưa có ~/.claude/projects: phần này đọc transcript của Claude Code')
  for (const proj of readdirSync(PROJECTS)) {
    if (!proj.startsWith(HOME_DIR) && !proj.startsWith(CODE_DIR)) continue // skips throwaway /private/var probe projects
    const dir = join(PROJECTS, proj), project = projectLabel(proj)
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (f.endsWith('.jsonl')) {
        const st = statSync(p)
        if (now - st.mtimeMs > 2 * DAY) continue // cheap prefilter; the real age is the last timestamp
        let c = sessionCache.get(p)
        if (!c || c.size !== st.size) sessionCache.set(p, c = { size: st.size, info: sessionInfo(tailObjects(p)) })
        if (now - c.info.ts < DAY) {
          let state: SessionState = sessionState(c.info, now)
          // turn ended but an Agent-tool subagent it launched is still writing: work goes on in the background
          if (state === 'waiting' && recentlyWritten(join(dir, f.slice(0, -6), 'subagents'), now)) state = 'background'
          sessions.push({ project, sid: f.slice(0, -6), ...c.info, state })
        }
        continue
      }
      const wfDir = join(p, 'subagents/workflows')
      if (!existsSync(wfDir)) continue
      for (const runId of readdirSync(wfDir)) {
        // one bad run (half-written status file or journal after a reboot, a stray .DS_Store) must not blank the panel
        try {
          const statusFile = join(p, 'workflows', runId + '.json')
          if (existsSync(statusFile)) {
            let r = runCache.get(statusFile)
            if (!r) {
              const j = JSON.parse(readFileSync(statusFile, 'utf8'))
              r = { project, runId, name: j.workflowName, summary: j.summary, state: j.status, startedAt: j.startTime,
                endedAt: j.startTime + (j.durationMs ?? 0), agents: j.agentCount }
              runCache.set(statusFile, r)
            }
            if (now - (r.endedAt ?? 0) < DAY) workflows.push(r)
            continue
          }
          // No status file yet: still running, or orphaned (its session died, e.g. on reboot).
          const rd = join(wfDir, runId)
          if (!statSync(rd).isDirectory()) continue
          const files = readdirSync(rd).map(x => statSync(join(rd, x)))
          if (!files.length) continue
          const lastAt = Math.max(...files.map(x => x.mtimeMs)), startedAt = Math.min(...files.map(x => x.birthtimeMs))
          if (now - lastAt > DAY) continue
          const journal = join(rd, 'journal.jsonl')
          const recs = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').flatMap(l => { try { return [JSON.parse(l)?.type] } catch { return [] } }) : []
          const scripts = join(p, 'workflows/scripts')
          const script = existsSync(scripts) ? readdirSync(scripts).find(x => x.endsWith(`-${runId}.js`)) : undefined
          workflows.push({ project, runId, name: script?.slice(0, -(runId.length + 4)) ?? runId, startedAt, lastAt,
            state: now - lastAt < 15 * 60_000 ? 'running' : 'orphaned',
            started: recs.filter(t => t === 'started').length, done: recs.filter(t => t === 'result').length })
        } catch { /* skip this run */ }
      }
    }
  }
  const order: Record<string, number> = { running: 0, background: 0, silent: 1, orphaned: 1, interrupted: 2, waiting: 3 }
  sessions.sort((a, b) => (order[a.state] - order[b.state]) || b.ts - a.ts)
  workflows.sort((a, b) => ((order[a.state] ?? 4) - (order[b.state] ?? 4)) || (b.startedAt - a.startedAt))
  return { sessions, workflows }
}

// Tones: violet = your move, green = alive, amber = look at it, grey = history. Always a word in the pill.
const SESSION: Record<SessionState, [Tone, string]> = {
  running: ['ok', 'đang chạy'], background: ['ok', 'chạy nền'], waiting: ['warn', 'chờ bạn'],
  interrupted: ['mute', 'bị ngắt'], silent: ['warn', 'im >10′'],
}
const RUN: Record<string, [Tone, string]> = {
  running: ['ok', 'đang chạy'], completed: ['mute', 'xong'], killed: ['mute', 'đã dừng'], failed: ['bad', 'lỗi'], orphaned: ['warn', 'mồ côi'],
  seen: ['mute', 'mồ côi, đã xem'],
}

// Sessions the Develop runner drives are its tasks' (the Develop board shows them): left out here, or every task turn
// listed itself again under "Đang chờ bạn" (2026-11-09). A soft dependency: no develop table, nothing left out
function developSessions(db: DatabaseSync) {
  try { return new Set((db.prepare('select session_id from develop_tasks').all() as { session_id: string }[]).map(r => r.session_id)) } catch { return new Set<string>() }
}
// orphans the owner has marked seen ("Đã xem" on Hôm nay): still listed, no longer an alert
const seenRuns = (db: DatabaseSync) => new Set((db.prepare('select run_id from agents_seen').all() as { run_id: string }[]).map(r => r.run_id))

type Data = ReturnType<typeof scan>

/** One line of the panel: state pill, bold title, meta spans (no dot-joins), an optional quoted excerpt. */
const item = ([tone, label]: [Tone, string], title: string, meta: string[], quote?: string | null) =>
  `<li${label ? '' : ' class="agents-plain"'}>${label ? pill(tone, label) : '<span></span>'}<span class="agents-title">${esc(title)}</span><div class="agents-meta">${meta.map(m => `<span>${esc(m)}</span>`).join('')}</div>${quote ? `<p class="agents-quote">${esc(quote)}</p>` : ''}</li>`

const group = (title: string, lines: string[]) => lines.length
  // a group where no row has a chip drops the chip column, so its titles line up with the heading
  ? `<h3>${esc(title)} <span class="agents-n">${lines.length}</span></h3><ul class="list agents-list${lines.every(l => l.startsWith('<li class="agents-plain"')) ? ' agents-nochip' : ''}">${lines.join('')}</ul>` : ''

const CSS = String.raw`
.agents-cols { display: grid; gap: var(--space-lg); min-width: 0 }
@media (min-width: 48rem) { .agents-cols { grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) } }
.agents-col { display: grid; gap: var(--space-xs); align-content: start; min-width: 0 }
.agents-col > h3 { display: flex; align-items: baseline; gap: var(--space-xs); margin: var(--space-md) 0 0 }
.agents-col > h3:first-child { margin-top: 0 }
.agents-n { color: var(--muted); font-weight: 400; font-variant-numeric: tabular-nums }
/* phone: pill and meta on one line, the title under them at full width; from 40rem the pills get their own column */
.agents-list > li { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-2xs) var(--space-sm); align-items: center }
.agents-list .pill { justify-self: start }
.agents-title { grid-column: 1 / -1; font-weight: 600; line-height: 1.4; overflow-wrap: anywhere }
.agents-meta { grid-row: 1; grid-column: 2; display: flex; flex-wrap: wrap; gap: 0 var(--space-sm); font-size: var(--text-sm); color: var(--muted); min-width: 0 }
.agents-meta > :first-child { color: var(--ink-2); font-weight: 500; overflow-wrap: anywhere }
.agents-quote { grid-column: 1 / -1; padding-left: var(--space-xs); border-left: 2px solid var(--rule-2); font-size: var(--text-sm); color: var(--muted);
  overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden }
@media (min-width: 40rem) {
  .agents-list { grid-template-columns: max-content minmax(0, 1fr); column-gap: var(--space-sm) } /* rows without a chip leave no empty column */
  .agents-list > li { grid-column: 1 / -1; grid-template-columns: subgrid; row-gap: var(--space-3xs); align-items: start }
  .agents-title, .agents-meta, .agents-quote { grid-column: 2; grid-row: auto }
  .agents-list .pill { grid-row: 1 / span 2; margin-top: 1px }
  .agents-quote { margin-top: var(--space-2xs) }
}
.agents .empty { padding: 0 }
/* a row without a chip (the state its group already names): title, then meta, then the quote */
.agents-list > li.agents-plain { grid-template-columns: minmax(0, 1fr) }
.agents-list > li.agents-plain > span:empty { display: none }
.agents-list > li.agents-plain > .agents-meta { grid-row: auto; grid-column: 1 / -1 }
@media (min-width: 40rem) {
  .agents-list > li.agents-plain { grid-template-columns: subgrid }
  .agents-list > li.agents-plain > .agents-meta { grid-column: 2 }
  /* a group where no row has a chip: one column, titles flush with the heading */
  .agents-list.agents-nochip { grid-template-columns: minmax(0, 1fr) }
  .agents-list.agents-nochip > li > .agents-title, .agents-list.agents-nochip > li > .agents-meta, .agents-list.agents-nochip > li > .agents-quote { grid-column: 1 }
}
`

export const agents: Module<Data> = {
  id: 'agents', title: 'Agent', group: 'ops', every: 60, timeout: 30, css: CSS,

  async collect({ now }) { return scan(now) },

  init(db) { db.exec('create table if not exists agents_seen (run_id text primary key, at integer not null)') },

  routes: [{
    method: 'POST', path: '/ops/agents/seen', handle: (req, v) => {
      const run = req.query.get('run') ?? ''
      if (/^wf_[\w-]{3,40}$/.test(run)) v.db.prepare('insert or ignore into agents_seen (run_id, at) values (?, ?)').run(run, Date.now())
      return { redirect: '/' }
    },
  }],

  panel(s, v) {
    const d = s?.data
    const o = { span: 2 as const, cls: 'agents' }
    if (!d) return section(this.title, empty('Đang lấy lần đầu…'), '', 'agents', o)
    const dev = developSessions(v.db), seen = seenRuns(v.db)
    const session = (x: Session) => item(x.state === 'waiting' || x.state === 'running' ? ['mute', ''] : SESSION[x.state] ?? ['mute', x.state], cut(x.title ?? x.prompt ?? x.sid.slice(0, 8), 110),
      [x.project, ago(x.ts, v.now)], x.title && x.prompt ? cut(x.prompt, 200) : null)
    // what waits for the owner leads, newest first; then what is still working (scan order: running, then silent)
    const own = d.sessions.filter(x => !dev.has(x.sid))
    const yours = own.filter(x => x.state === 'waiting' || x.state === 'interrupted').sort((a, b) => b.ts - a.ts)
    const live = own.filter(x => x.state !== 'waiting' && x.state !== 'interrupted')
    const runs = d.workflows.map(w => item(w.state === 'completed' ? ['mute', ''] : RUN[w.state === 'orphaned' && seen.has(w.runId) ? 'seen' : w.state] ?? ['mute', w.state], w.name,
      [w.project, w.state === 'running' || w.state === 'orphaned' ? `${w.done}/${w.started} agent` : `${w.agents ?? '?'} agent`, ago(w.lastAt ?? w.endedAt, v.now)],
      w.summary ? cut(w.summary, 200) : null))
    const sessions = group('Chờ bạn', yours.map(session)) + group('Đang làm', live.map(session))
    return section(this.title, `${stale(s, v.now)}<div class="agents-cols">
      <div class="agents-col">${sessions || `<h3>Session</h3>${empty('Không có session nào trong 24 giờ qua.')}`}</div>
      <div class="agents-col">${group('Workflow', runs) || `<h3>Workflow</h3>${empty('Không có workflow nào trong 24 giờ qua.')}`}</div></div>`, '24 giờ qua', 'agents', o)
  },

  alerts(s, v) {
    const d = s?.data
    if (!d) return []
    const dev = developSessions(v.db), seen = seenRuns(v.db)
    return [
      ...d.workflows.filter(w => w.state === 'orphaned' && !seen.has(w.runId)).map(w => ({ tone: 'warn' as const, text: `Workflow mồ côi: ${w.name} (${w.project})`, href: '/ops',
        seen: `/ops/agents/seen?run=${encodeURIComponent(w.runId)}` })),
      ...d.sessions.filter(x => x.state === 'silent' && !dev.has(x.sid)).map(x => ({ tone: 'warn' as const, text: `Session ${x.project} im lặng giữa lượt, ${ago(x.ts, v.now)}`, href: '/ops' })),
    ]
  },

  waiting(s, v) {
    // sessions whose turn ended or was cut in the last 12 h: they are waiting for the owner
    const dev = developSessions(v.db)
    return (s?.data?.sessions ?? []).filter(x => (x.state === 'waiting' || x.state === 'interrupted') && !dev.has(x.sid) && v.now - x.ts < 12 * 3_600_000).slice(0, 8)
      .map(x => ({ text: `${x.project}: ${cut(x.title ?? x.prompt ?? x.sid.slice(0, 8), 80)}`, sub: x.state === 'interrupted' ? 'bị ngắt' : 'xong lượt, chờ bạn', at: x.ts, href: '/ops' }))
  },
}
