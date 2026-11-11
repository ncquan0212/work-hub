// Develop pieces that differ from one copy or one OS to the next: the AI adapter (lib/claude.ts), Chrome off when the
// config names no browser, images without sips, the one-runner lock. No AI is run: the CLI is never called.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { openDb } from '../src/core/db.ts'
import { binary, parse, rulePath } from '../src/lib/claude.ts'
import { createTask, initStore, saveImages, storable, taskFiles } from '../src/modules/develop/store.ts'
import { beatRunner, claimRunner, releaseRunner, STALE_MS } from '../src/runner/runner.ts'

const SRC = join(import.meta.dirname, '../src')

test('claude: deny rules by absolute path, POSIX and Windows', () => {
  assert.equal(rulePath('/Users/x/Code/work-hub/data', 'darwin'), '//Users/x/Code/work-hub/data')
  assert.equal(rulePath('/home/x/work-hub/data', 'linux'), '//home/x/work-hub/data')
  // Claude Code matches POSIX-normalised paths on Windows
  assert.equal(rulePath('C:\\Users\\x\\Code\\work-hub\\data', 'win32'), '//c/Users/x/Code/work-hub/data')
})

test('claude: the CLI is CLAUDE_BIN, a known place, then PATH; on Windows never an npm .cmd', () => {
  const none = () => false
  assert.equal(binary({ CLAUDE_BIN: '/x/claude' }, 'darwin', none), '/x/claude')
  assert.equal(binary({}, 'linux', none), 'claude')
  assert.throws(() => binary({ CLAUDE_BIN: 'C:\\npm\\claude.cmd' }, 'win32', none), /claude\.exe/)
  assert.throws(() => binary({ PATH: 'C:\\npm' }, 'win32', p => p.endsWith('claude.cmd')), /native/)
  assert.match(binary({ PATH: 'C:\\npm;C:\\bin' }, 'win32', p => p.endsWith('claude.exe') && p.includes('bin')), /claude\.exe$/)
})

test('claude: stream-json lines as neutral events', () => {
  const p = (o: unknown) => parse(JSON.stringify(o))
  assert.deepEqual(p({ type: 'system', subtype: 'init', model: 'claude-opus-5-5', session_id: 's' }), [{ kind: 'model', model: 'claude-opus-5-5' }, { kind: 'session' }])
  assert.deepEqual(p({ type: 'user', isReplay: true, message: {} }), [{ kind: 'ack' }])
  assert.deepEqual(p({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: 'a.txt' } }, { type: 'text', text: 'ok' }] } }),
    [{ kind: 'tool', name: 'Write', input: { file_path: 'a.txt' }, file: 'a.txt' }, { kind: 'text', text: 'ok' }])
  assert.deepEqual(p({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: 'a.txt' } }] } }), [{ kind: 'tool', name: 'Read', input: { file_path: 'a.txt' } }], 'a read is not an edit')
  assert.deepEqual(p({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } }), [{ kind: 'text', text: '' }], 'thinking still counts as speaking')
  assert.deepEqual(p({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}, {}] }), [{ kind: 'jobs', pending: 2 }])
  assert.deepEqual(p({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.4, result: 'xong' }), [{ kind: 'end', ok: true, cost: 0.4, subtype: 'success', text: 'xong' }])
  assert.deepEqual(p({ type: 'result', subtype: 'error_during_execution', is_error: true }), [{ kind: 'end', ok: false, cost: null, subtype: 'error_during_execution', text: undefined }])
  assert.deepEqual([parse('not json'), parse('null'), parse('5')], [[], [], []])
})

/** Runs `code` (an ES module) in a node of its own, with the config file `config` (JSON text). */
function withConfig(config: string, code: string) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-cfg-'))
  try {
    writeFileSync(join(dir, 'config.json'), config)
    return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, HUB_CONFIG: join(dir, 'config.json'), HUB_DATA: dir } })
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('chrome: no browsers in the config = no Chrome box, no Chrome from a crafted form, no --chrome', () => {
  const r = withConfig('{}', `
    import { ai, chromeOn, parseMode, SYSTEM_RULES, RC_RULE } from '${SRC}/modules/develop/prompts.ts'
    import { develop } from '${SRC}/modules/develop/index.ts'
    import { openDb } from '${SRC}/core/db.ts'
    import { initStore } from '${SRC}/modules/develop/store.ts'
    const db = openDb(':memory:'); initStore(db)
    const page = develop.routes.find(r => r.method === 'GET' && r.path === '/develop/new').handle({ query: new URLSearchParams() }, { now: 0, db, csrf: 'c', slot: () => undefined })
    const args = ai.turnArgs({ session_started: 0, session_id: 's', model: null, effort: null, ultracode: 0, chrome: 1, isolated: 0 }, 'discuss', SYSTEM_RULES).join(' ')
    console.log(JSON.stringify({ chromeOn, chrome: parseMode(new URLSearchParams('chrome=1')).chrome, box: page.body.includes('name="chrome"'), flag: /--chrome|chrome-guard/.test(args), rc: RC_RULE }))`)
  assert.equal(r.status, 0, r.stderr)
  assert.deepEqual(JSON.parse(r.stdout), { chromeOn: false, chrome: 0, box: false, flag: false, rc: '' })
})

test('ai: an AI with no adapter is a clear error, unless Develop is off', () => {
  const load = `import('${SRC}/modules/develop/prompts.ts').then(() => console.log('ok'), e => console.log(e.message))`
  assert.match(withConfig('{"ai":"codex"}', load).stdout, /"ai": "codex" chưa được hỗ trợ/)
  assert.equal(withConfig('{"ai":"codex","modules":["report"]}', load).stdout.trim(), 'ok')
})

test('chrome guard fails closed: a bad event or an unreadable config refuses the tool (exit 2)', () => {
  const guard = join(SRC, 'runner/chrome-guard.ts')
  const run = (input: string, env: NodeJS.ProcessEnv = process.env) => spawnSync(process.execPath, [guard], { input, encoding: 'utf8', env })
  const list = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'x', tool_name: 'mcp__claude-in-chrome__list_connected_browsers' })
  assert.equal(run(list).status, 0, 'a good event with a readable config passes')
  assert.equal(run('not json').status, 2)
  const dir = mkdtempSync(join(tmpdir(), 'hub-cfg-'))
  try {
    writeFileSync(join(dir, 'config.json'), '{ broken')
    const r = run(list, { ...process.env, HUB_CONFIG: join(dir, 'config.json') })
    assert.equal(r.status, 2); assert.match(r.stderr, /chặn/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('images without sips: PNG/JPEG/WebP/GIF kept as they came up to 3.5 MB; HEIC and larger ones skipped', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')
  const webp = Buffer.from('RIFF\0\0\0\0WEBPVP8 '), heic = Buffer.from('\0\0\0\x18ftypheic')
  const big = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)])
  assert.deepEqual([png, webp, heic, big].map(b => storable(b, false)), [true, true, false, false])
  assert.deepEqual([heic, big].map(b => storable(b, true)), [true, true], 'sips takes HEIC and shrinks large ones')
  const db = openDb(':memory:'); initStore(db)
  const task = createTask(db, { title: 't', body: '', repo: 'x' })
  const dir = mkdtempSync(join(tmpdir(), 'hub-img-'))
  try {
    const { ids, skipped } = await saveImages(db, task, 7, [{ data: png }, { data: heic }, { data: webp }, { data: big }], dir, false)
    assert.equal(ids.length, 2); assert.equal(skipped, 2)
    const fs = taskFiles(db, task)
    assert.deepEqual(fs.map(f => f.mime), ['image/png', 'image/webp'])
    assert.ok(readFileSync(fs[0].path).equals(png), 'the bytes as they came'); assert.match(fs[1].path, /\.webp$/)
    assert.equal(readdirSync(dir).length, 2, 'nothing else left on disk')
  } finally { rmSync(dir, { recursive: true, force: true }); db.close() }
})

test('runner lock: one runner at a time by heartbeat in hub.db; a restart or a dead holder goes through', () => {
  const db = openDb(':memory:'); initStore(db)
  const t0 = 1_000_000, dead = 2 ** 22 + 12345 // above any pid macOS or Linux hands out by default
  assert.equal(claimRunner(db, process.pid, t0), null, 'first runner takes the slot')
  assert.equal(claimRunner(db, dead, t0 + 5_000), process.pid, 'a second one leaves while the first beats')
  beatRunner(db, process.pid, t0 + STALE_MS)
  assert.equal(claimRunner(db, dead, t0 + STALE_MS + 5_000), process.pid, 'the beat keeps it')
  assert.equal(claimRunner(db, dead, t0 + 2 * STALE_MS + 1), null, 'a beat older than STALE_MS: taken over')
  // the holder died without cleaning up (killed outright): its row is fresh but its pid is gone
  assert.equal(claimRunner(db, process.pid, t0 + 2 * STALE_MS + 2), null, 'a fresh beat of a dead pid does not hold it')
  // a restart: the old runner removes its row on exit, the new one starts at once
  releaseRunner(db, process.pid)
  assert.equal(claimRunner(db, dead, t0 + 2 * STALE_MS + 3), null)
  db.close()
})

test('runner main: exits with a message when Develop is off in the config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hub-cfg-'))
  try {
    writeFileSync(join(dir, 'config.json'), '{"modules":["report"]}')
    const out = execFileSync(process.execPath, [join(SRC, 'runner/main.ts')], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HUB_CONFIG: join(dir, 'config.json'), HUB_DATA: dir } })
    assert.equal(out, '')
    assert.deepEqual(readdirSync(dir), ['config.json'], 'no hub.db opened')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
