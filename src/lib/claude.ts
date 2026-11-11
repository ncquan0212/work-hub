// Everything that is specific to Claude Code, the AI that runs Develop tasks (config `ai: "claude"`).
// Another AI = another file like this one; the contract and the probes it must pass: docs/architecture.md "Đổi AI".
// What the rest of the hub uses: `features`, `DEFAULT_LABEL`, `binary`, `turnArgs`, `message`, `parse` (→ NeutralEvent),
// `describeTool`. The runner (src/runner/runner.ts) sees the CLI's output only as NeutralEvents.
// Owner 2026-11-09: full access, because a task can be analysis or a report, not only code. Every MCP server
// (Databuckets with no cap), any command, no cost cap. A turn runs like the owner's own sessions: auto mode (its
// classifier blocks what is risky), and the owner's and the repo's settings and CLAUDE.md (≤ 5 agents, git status
// first …). The few hard rules are deny rules, which beat everything:
//  - no git push, no RC publish; secret files are not read;
//  - a discussion turn cannot edit the shared main working tree (`Edit(./**)`, cwd = the repo). Code changes only
//    in an execution turn, after the owner approves: in the main working tree (the default, owner 2026-11-09), or in
//    the task's own worktree when the task asks for one (`isolated`).
// Probed 2026-11-09 (CLI 2.1.289, runner env): Databuckets listed, both CLAUDE.md loaded, write in cwd denied,
// write outside allowed, `git push` denied. Not bypassPermissions: it would drop the classifier.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { APPS, CHROME_BROWSERS, CHROME_NOTE, CODE, DATA, HOME, RC_DIR, rcKeyPath, REPOS } from '../config.ts'
import type { RunMode, Task } from '../modules/develop/store.ts'
import { markerFile } from '../runner/chrome-guard.ts'

/** The folder name Claude Code gives a working directory under ~/.claude/projects: every character that is not a
 *  letter or a digit becomes '-' ("/Users/me/Code/app" → "-Users-me-Code-app", "C:\Users\me" → "C--Users-me"). */
export const projectDir = (path: string) => path.replace(/[^A-Za-z0-9]/g, '-')

/** What the runner reads from a turn's output, whatever the AI. One output line gives none, one or several. */
export type NeutralEvent =
  | { kind: 'model'; model: string }      // the model the turn really runs ("claude-fable-5-1")
  | { kind: 'session' }                    // the session exists: the next turn resumes it
  | { kind: 'text'; text: string }         // the AI speaks ('' = a step with nothing to show, e.g. thinking)
  | { kind: 'tool'; name: string; input: any; file?: string } // a tool call; `file`: the file it writes, if it is an edit
  | { kind: 'ack' }                        // a message written to stdin was taken
  | { kind: 'jobs'; pending: number }      // background jobs still running
  // one turn inside the session ended. cost: the session's running total. text: the turn's reply when the end carries it
  | { kind: 'end'; ok: boolean; cost: number | null; subtype?: string; text?: string }

/** What this AI offers; the Develop forms show a field only when it is here. */
export const features = {
  // Chrome off on Windows until probed there: claude runs hooks in PowerShell when it finds no Git Bash, the guard's
  // command line does not parse there, and a hook that fails that way does not block (review 2026-11-11)
  images: true, effort: true, chrome: process.platform !== 'win32', background: true, cost: true,
  // keys are what --model gets. Haiku by full id: the `haiku` alias still means Haiku 4.5 (probe 2026-11-09; opus,
  // sonnet and fable resolve to Opus 5.5, Sonnet 5.5 and Fable 5.1)
  // Labels with the version each value resolved to (CLI 2.1.289, init event, 2026-11-10). They are the fallback: the page
  // shows what the runner last saw claude run for each (develop_models), so a CLI update that moves an alias shows up
  models: { opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', 'claude-haiku-5-5': 'Haiku 5.5', fable: 'Fable 5.1' } as Record<string, string>,
  // Thinking = effort only. No "off": on Sonnet 5.5 neither --thinking disabled nor alwaysThinkingEnabled:false stopped it
  // (probe 2026-11-09: a puzzle answered "2" still spent ~360 output tokens, 458 with thinking on). Adaptive models decide.
  efforts: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' } as Record<string, string>,
}

/** What a task with no model and no effort runs (the account's own), as ~/.claude/settings.json says, read once: `model`;
 *  `effortLevel`, or the one effortLevel every `modelSettings` entry has (the owner's: xhigh for each). '' = unknown. */
export const DEFAULT_LABEL = (() => {
  try {
    const s = JSON.parse(readFileSync(join(HOME, '.claude/settings.json'), 'utf8'))
    const per = new Set(Object.values(s?.modelSettings ?? {}).map((m: any) => m?.effortLevel))
    const one = per.size === 1 ? [...per][0] : undefined
    const effort = typeof s?.effortLevel === 'string' ? s.effortLevel : typeof one === 'string' ? one : ''
    return { model: typeof s?.model === 'string' ? Object.hasOwn(features.models, s.model) ? features.models[s.model] : s.model : '', effort }
  } catch { return { model: '', effort: '' } }
})()

/** The claude CLI: CLAUDE_BIN, where the native installer puts it, Homebrew's, then PATH. Windows: the native claude.exe
 *  only, since spawn without a shell cannot run npm's claude.cmd. Throws there with what to do. */
export function binary(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform, exists: (p: string) => boolean = existsSync) {
  const win = platform === 'win32'
  const onPath = () => (env.PATH ?? '').split(';').flatMap(d => d ? ['.exe', '.cmd', '.bat'].map(x => join(d, `claude${x}`)) : []).find(exists)
  const bin = env.CLAUDE_BIN || [join(HOME, '.local/bin', win ? 'claude.exe' : 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'].find(exists)
    || (win && onPath()) || 'claude'
  if (win && /\.(cmd|bat)$/i.test(bin)) throw new Error(`${bin}: runner chỉ chạy được claude.exe của bản cài native (không qua shell). Cài bản native, hoặc đặt CLAUDE_BIN là đường dẫn claude.exe.`)
  return bin
}

/** An absolute path the way Claude Code's permission rules write it: '//' then the path from the root. On Windows it
 *  matches POSIX-normalised paths (C:\Users\x → /c/Users/x), so the rule there reads //c/Users/x. */
export const rulePath = (path: string, platform: NodeJS.Platform = process.platform) =>
  '/' + (platform === 'win32' ? path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`) : path)

// Flags only, never env: CLAUDE_CODE_EFFORT_LEVEL would beat --effort. Passed on every turn, --resume included:
// none of this survives the process (probed 2026-11-09, CLI 2.1.289).
// Ultracode: the keyword in a -p prompt does nothing (only typed prompts count); the setting does. small = aim under
// 5 agents, the owner's cap (the CLI default, medium, is under 10).
// Chrome: --chrome gives the Claude in Chrome tools. Several browsers are connected to the shared account and the tool
// says to ask the user, which nobody can answer here: the owner's choice goes in the system prompt (CHROME_RULE), and
// a hook (src/runner/chrome-guard.ts) refuses every browser tool until one of those browsers is selected.
const GUARD = `"${process.execPath}" "${join(import.meta.dirname, '../runner/chrome-guard.ts')}"`
const CHROME_HOOKS = {
  PreToolUse: [{ matcher: 'mcp__claude-in-chrome__.*', hooks: [{ type: 'command', command: GUARD }] }],
  PostToolUse: [{ matcher: 'mcp__claude-in-chrome__select_browser', hooks: [{ type: 'command', command: GUARD }] }],
}
function modeArgs(m: RunMode, rules: string[]) {
  // a task saved with Chrome on, in a copy whose list of browsers is now empty: off (no browser is anyone's to pick)
  const chrome = features.chrome && !!m.chrome && CHROME_BROWSERS.length > 0
  const settings = { ...(m.ultracode ? { ultracode: true, workflowSizeGuideline: 'small' } : {}), ...(chrome ? { hooks: CHROME_HOOKS } : {}) }
  return [...(m.model ? ['--model', m.model] : []), ...(m.effort ? ['--effort', m.effort] : []),
    ...(Object.keys(settings).length ? ['--settings', JSON.stringify(settings)] : []),
    ...(chrome ? ['--chrome'] : []), '--append-system-prompt', [...rules, ...(chrome ? [CHROME_RULE] : [])].join('\n\n')]
}

const CHROME_RULE = [
  'Trình duyệt (Claude in Chrome): owner đã chọn sẵn trình duyệt cho task này; trong phiên này không ai trả lời được câu hỏi.',
  'Chỉ được dùng các trình duyệt sau, chọn bằng select_browser theo deviceId. Đây là các profile Chrome của owner:',
  ...(CHROME_NOTE ? [CHROME_NOTE] : []),
  ...CHROME_BROWSERS.map(b => `- ${b.id} (${b.name})`),
  'Gọi list_connected_browsers rồi select_browser cái đầu tiên đang kết nối; nếu trang cần dùng chưa đăng nhập ở đó thì select_browser cái còn lại.',
  'Không bao giờ chọn trình duyệt nào khác, kể cả khi tool bảo hỏi người dùng; một hook từ chối mọi tool trình duyệt cho tới khi chọn đúng.',
  'Không có cái nào đang kết nối thì không dùng trình duyệt và báo owner.',
  'Mở tab mới cho việc của task (tabs_create_mcp), không dùng tab owner đang mở, đóng tab của mình khi xong.',
  'Chỉ đọc trang. Không bấm nút ghi (lưu, publish, xoá, gửi, đổi cấu hình) trừ khi owner yêu cầu rõ trong task.',
].join('\n')

// Unanchored patterns only match under the turn's cwd, and the real secrets sit in the main working trees, outside
// every worktree (key.properties, .env are untracked; review 2026-11-09): the ~/ copies cover them from anywhere.
const SECRET_FILES = ['.env*', 'key.properties', 'local.properties', '*.keystore', '*.jks', '*.p8', '*.pem']
// git: a push, and what wipes uncommitted work in the main tree that other sessions share (decisions.md D15): the owner's
// CLAUDE.md asks for this, the deny rules hold it. Also behind `-C dir` / `-c k=v`; not `git * push`, which would
// refuse `git commit -m "fix push notifications"`
const GIT_DENY = ['push', 'stash', 'reset --hard', 'clean', 'checkout .', 'checkout -- .', 'restore .', 'add -A', 'add --all', 'add .']
// rc.py: a publish (--yes) and raw api calls (can POST). The flag goes anywhere, hence the middle `*`; it also refuses a
// commit message naming both (probed 2026-11-09)
const RC_DENY = ['*rc.py*--yes*', '*rc.py* api *']
// every command rule for both shell tools: on Windows claude runs commands with its PowerShell tool when it finds no
// Git Bash, and a Bash(...) rule does not cover it (the CLI builds both forms itself; macOS accepts both, probe 11/11)
const shells = (c: string) => [`Bash(${c})`, `PowerShell(${c})`]
// RC service-account keys: the *-access.json files in RC_DIR (README and rc.py there are for tasks to read, RC_RULE),
// and any app key the config puts elsewhere or names otherwise
const RC_KEYS = [`${rulePath(resolve(RC_DIR))}/*-access.json`, ...APPS.map(rcKeyPath)
  .filter((p): p is string => !!p && !(dirname(p) === RC_DIR && p.endsWith('-access.json'))).map(p => rulePath(resolve(p)))]
// Secret files outside HOME too: codeDir, repos and this clone may sit anywhere (D:\Code, /srv/code); under HOME the
// ~/** copies already cover them, so the owner's list does not change
const ROOTS = [...new Set([CODE, ...REPOS.map(r => r.repo), join(import.meta.dirname, '../..')].map(p => resolve(p)))]
  .filter(p => { const r = relative(HOME, p); return r.startsWith('..') || isAbsolute(r) }).map(p => rulePath(p))
const DENY = [
  ...GIT_DENY.flatMap(c => ['', '-C * ', '-c * '].flatMap(o => [...shells(`git ${o}${c}`), ...shells(`git ${o}${c} *`)])),
  ...RC_DENY.flatMap(shells), ...SECRET_FILES.flatMap(f => [`Read(**/${f})`, `Read(~/**/${f})`, ...ROOTS.map(r => `Read(${r}/**/${f})`)]),
  // the hub's own data/ (bridge.key, csrf.secret, vapid.json, hub.db), wherever this copy was cloned
  'Read(~/.claude.json)', 'Read(~/.claude/.credentials.json)', ...RC_KEYS.map(p => `Read(${p})`), `Read(${rulePath(resolve(DATA))}/**)`, 'Read(~/.config/**)', 'Read(~/.ssh/**)', 'Read(~/.gradle/**)',
]

// The prompt goes in on stdin as stream-json, not after -p: with stdin open the session lives on after a turn, so a
// background job (a Workflow, a background Bash) can finish and Claude answers with its result. A -p prompt exits at
// the end of the turn and loses it (probed 2026-11-09). The runner closes stdin once a turn ends with nothing running.
const args = (t: Task, deny: string[], rules: string[]) => [
  '-p', '--input-format', 'stream-json', ...(t.session_started ? ['--resume', t.session_id] : ['--session-id', t.session_id]),
  '--permission-mode', 'auto', '--permission-prompts', 'none', '--setting-sources', 'user,project,local', ...modeArgs(t, rules),
  // each stdin message comes back once claude takes it (isReplay): the runner keeps stdin open until all were answered
  '--disallowedTools', ...deny, '--output-format', 'stream-json', '--verbose', '--replay-user-messages',
]
/** The CLI arguments of one turn. `rules`: the AI-neutral system prompt every turn gets (prompts.ts SYSTEM_RULES).
 *  A discussion turn edits nothing: not the main tree (its cwd), not a worktree the task has. Also forgets the browser
 *  chosen in an earlier turn (chrome-guard.ts): the Mac's Chrome may have gone since. */
export function turnArgs(t: Task, kind: 'discuss' | 'execute', rules: string[]) {
  rmSync(markerFile(t.session_id), { force: true })
  return args(t, kind === 'discuss' ? ['Edit(./**)', ...(t.worktree ? [`Edit(${rulePath(t.worktree)}/**)`] : []), ...DENY] : DENY, rules)
}

/** The turn's prompt, and the images the owner attached to it, as the stream-json line written to claude's stdin. */
export const message = (prompt: string, images: { mime: string; data: Buffer }[] = []) => JSON.stringify({ type: 'user', message: { role: 'user',
  content: images.length ? [{ type: 'text', text: prompt }, ...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data.toString('base64') } }))] : prompt } }) + '\n'

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])
/** One line of claude's stream-json output as NeutralEvents. */
export function parse(line: string): NeutralEvent[] {
  let o: any; try { o = JSON.parse(line) } catch { return [] }
  if (!o || typeof o !== 'object') return []
  const ev: NeutralEvent[] = []
  // the model claude really runs (an alias like "fable" follows CLI updates)
  if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string' && o.model) ev.push({ kind: 'model', model: o.model })
  if (o.session_id) ev.push({ kind: 'session' })
  if (o.type === 'user' && o.isReplay) ev.push({ kind: 'ack' })
  if (o.type === 'assistant') {
    const blocks = Array.isArray(o.message?.content) ? o.message.content : []
    const said: NeutralEvent[] = blocks.flatMap((c: any): NeutralEvent[] => {
      if (c?.type === 'tool_use') {
        const f = c.input?.file_path ?? c.input?.notebook_path
        return [{ kind: 'tool', name: String(c.name), input: c.input, ...(EDIT_TOOLS.has(c.name) && typeof f === 'string' ? { file: f } : {}) }]
      }
      return c?.type === 'text' && typeof c.text === 'string' ? [{ kind: 'text', text: c.text }] : []
    })
    ev.push(...(said.length ? said : [{ kind: 'text', text: '' } as const])) // a thinking block still means Claude is at it
  }
  if (o.type === 'system' && o.subtype === 'background_tasks_changed') ev.push({ kind: 'jobs', pending: o.tasks?.length ?? 0 })
  // one result per turn inside the session: a turn that started a background job ends with "started", and the job's
  // completion starts another turn. total_cost_usd is the session's running total: background agents included (probe
  // 2026-11-09: 0.41 then 0.67), and every earlier turn too, since --resume restores it (task #3: 2.11, 2.54, 6.55, 7.04, 7.66)
  if (o.type === 'result') ev.push({ kind: 'end', ok: !o.is_error, cost: o.total_cost_usd == null ? null : Number(o.total_cost_usd),
    subtype: o.subtype == null ? undefined : String(o.subtype), text: o.result == null ? undefined : String(o.result) })
  return ev
}

/** Short human line for one tool call in the stream (shown live on the task page). */
export function describeTool(name: string, input: any): string {
  const s = (v: unknown, n = 90) => String(v ?? '').replace(/\s+/g, ' ').slice(0, n)
  switch (name) {
    case 'Read': return `Đọc ${s(input?.file_path)}`
    case 'Edit': case 'MultiEdit': return `Sửa ${s(input?.file_path)}`
    case 'Write': return `Ghi ${s(input?.file_path)}`
    case 'Grep': return `Tìm "${s(input?.pattern, 50)}"`
    case 'Glob': return `Liệt kê ${s(input?.pattern, 60)}`
    case 'Bash': return `$ ${s(input?.command, 100)}`
    default: return name
  }
}
