import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionInfo, sessionState } from '../src/modules/agents.ts'
import { parseListing } from '../src/modules/listing.ts'
import { parseLogLines } from '../src/modules/market.ts'
import { diffTemplates } from '../src/modules/rc.ts'
import { gradleVersion, parseStatus, pbxVersion } from '../src/modules/repos.ts'

test('git porcelain v2: branch, ahead/behind, dirty count', () => {
  const out = '# branch.oid abc\n# branch.head master\n# branch.upstream origin/master\n# branch.ab +2 -1\n1 .M N... a b c d e f app.kt\n? new.txt\n'
  assert.deepEqual(parseStatus(out), { branch: 'master', ahead: 2, behind: 1, dirty: 2 })
  assert.deepEqual(parseStatus('# branch.head dev\n'), { branch: 'dev', ahead: null, behind: null, dirty: 0 })
})

test('gradle version: kts and groovy syntax', () => {
  assert.deepEqual(gradleVersion('versionCode = 24\n versionName = "1.0.23"'), { code: '24', name: '1.0.23' })
  assert.deepEqual(gradleVersion('versionCode 165\n versionName "2.0.63"'), { code: '165', name: '2.0.63' })
})

test('pbxproj: picks the app target, not the widget', () => {
  const block = (plist: string, build: string, ver: string) =>
    `buildSettings = {\n\t\t\t\tCURRENT_PROJECT_VERSION = ${build};\n\t\t\t\tINFOPLIST_FILE = ${plist};\n\t\t\t\tMARKETING_VERSION = ${ver};\n\t\t\t};\n`
  const src = block('StreakWidget/Info.plist', '63', '2.8') + block('BrainTraining/Info.plist', '64', '2.9')
  assert.deepEqual(pbxVersion(src, 'BrainTraining/Info.plist'), { name: '2.9', code: '64' })
  assert.equal(pbxVersion(src, 'Other/Info.plist'), null)
})

test('session state from transcript tail', () => {
  const now = Date.parse('2026-11-07T10:00:00Z')
  const base = [{ type: 'last-prompt', lastPrompt: 'làm tiếp' }, { type: 'ai-title', aiTitle: 'Hub' }]
  const done = sessionInfo([...base, { type: 'assistant', timestamp: '2026-11-07T09:58:00Z', message: { stop_reason: 'end_turn' } }, { type: 'cost-state' }])
  assert.equal(done.prompt, 'làm tiếp'); assert.equal(done.title, 'Hub')
  assert.equal(sessionState(done, now), 'waiting')
  const working = sessionInfo([{ type: 'assistant', timestamp: '2026-11-07T09:58:00Z', message: { stop_reason: 'tool_use' } },
    { type: 'user', timestamp: '2026-11-07T09:58:30Z', message: { content: [{ type: 'tool_result' }] } }])
  assert.equal(sessionState(working, now), 'running')
  assert.equal(sessionState(working, now + 30 * 60_000), 'silent')
  const cut = sessionInfo([{ type: 'user', timestamp: '2026-11-07T09:59:00Z', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }])
  assert.equal(sessionState(cut, now), 'interrupted')
  // other finished stops end the turn; meta records and local commands after it don't reopen it
  const other = sessionInfo([{ type: 'assistant', timestamp: '2026-11-07T09:00:00Z', message: { stop_reason: 'stop_sequence' } },
    { type: 'user', isMeta: true, timestamp: '2026-11-07T09:01:00Z', message: { content: '<local-command-caveat>…' } },
    { type: 'user', timestamp: '2026-11-07T09:01:00Z', message: { content: '<command-name>/model</command-name>' } }, null, 42])
  assert.equal(sessionState(other, now), 'waiting')
  // mid-turn and quiet, but the process wrote its exit record: stopped (Dừng, a closed window), not "silent"
  const exited = sessionInfo([{ type: 'assistant', timestamp: '2026-11-07T09:58:00Z', message: { stop_reason: 'tool_use' } }, { type: 'last-prompt' }, { type: 'cost-state' }])
  assert.equal(sessionState(exited, now + 30 * 60_000), 'interrupted')
  // resumed after that exit: live again
  const resumed = sessionInfo([{ type: 'cost-state' }, { type: 'user', timestamp: '2026-11-07T09:59:00Z', message: { content: 'tiếp' } }])
  assert.equal(sessionState(resumed, now), 'running')
})

test('market-tool log: warns keyed by msg (+voter), info skipped, junk ignored', () => {
  const text = [
    '{"t":"2026-11-05T01:17:00.000Z","level":"warn","msg":"aivote failed","voter":"ChatGPT","err":"invalid_request_error"}',
    '{"t":"2026-11-05T01:18:00.000Z","level":"info","msg":"live"}',
    'not json', 'null', '42', // stderr shares the file; these used to throw and wedge the reader
    '{"t":"2026-11-05T01:19:00.000Z","level":"warn","msg":"telegram poll failed","err":"TypeError: fetch failed"}',
  ].join('\n')
  const r = parseLogLines(text)
  assert.deepEqual(r.warns.map(w => w.kind), ['aivote failed (ChatGPT)', 'telegram poll failed'])
  assert.equal(r.lastAt, Date.parse('2026-11-05T01:19:00.000Z'))
})

test('RC diff: parameters (incl. groups) and conditions, key order does not matter', () => {
  const a = {
    conditions: [{ name: 'Tier1', expression: "device.country in ['US']" }, { name: 'Old', expression: 'true' }],
    parameters: { same: { defaultValue: { value: '1' }, valueType: 'STRING' }, gone: { defaultValue: { value: 'x' } },
      edited: { defaultValue: { value: 'a' }, conditionalValues: { Tier1: { value: 'b' } } } },
    parameterGroups: { ads: { parameters: { grouped: { defaultValue: { value: '1' } } } } },
  }
  const b = {
    conditions: [{ expression: "device.country in ['US','GB']", name: 'Tier1' }, { name: 'New', expression: 'false' }],
    parameters: { same: { valueType: 'STRING', defaultValue: { value: '1' } }, fresh: { defaultValue: { value: 'y' } },
      edited: { defaultValue: { value: 'a' }, conditionalValues: { Tier1: { value: 'c' } } } },
    parameterGroups: { ads: { parameters: { grouped: { defaultValue: { value: '2' } } } } },
  }
  assert.deepEqual(diffTemplates(a, b), {
    added: ['fresh'], removed: ['gone'], changed: ['edited', 'grouped'],
    condAdded: ['New'], condRemoved: ['Old'], condChanged: ['Tier1'], condOrder: false,
  })
  const two = (names: string[]) => ({ conditions: names.map(name => ({ name, expression: 'true' })), parameters: {} })
  assert.equal(diffTemplates(two(['A', 'B']), two(['B', 'A'])).condOrder, true) // priority changed, nothing else
})

test('Play listing: JSON-LD rating, labelled installs and date; absent stays absent', () => {
  const ld = (o: object) => `<script type="application/ld+json" nonce="x">${JSON.stringify(o)}</script>`
  const page = ld({ '@type': 'SoftwareApplication', name: 'Live Idol', aggregateRating: { ratingValue: '4.797', ratingCount: '2367' } })
    + '<div class="ClM7O">500K+</div><div class="g1rdde">Downloads</div>'
    + '<div class="lXlx5">Updated on</div><div class="xg1aie">Nov 5, 2026</div>'
  assert.deepEqual(parseListing(page), { title: 'Live Idol', rating: 4.797, ratings: 2367, installs: '500K+', updated: 'Nov 5, 2026' })
  // a page without its own rating (other apps' cards further down carry "4.4") must not report one
  const none = ld({ '@type': 'SoftwareApplication', name: 'XRemote' }) + '<div aria-label="Rated 4.4 stars out of five stars">4.4</div>'
    + '<div class="ClM7O">Rated for 3+</div><div class="g1rdde">Downloads</div>'
  assert.deepEqual(parseListing(none), { title: 'XRemote', rating: null, ratings: null, installs: null, updated: null })
})

test('agents: Develop task sessions are left to the Develop board; an orphan marked seen is no longer an alert', async () => {
  const { openDb } = await import('../src/core/db.ts')
  const { agents } = await import('../src/modules/agents.ts')
  const { initStore, createTask, getTask } = await import('../src/modules/develop/store.ts')
  const db = openDb(':memory:'); initStore(db); agents.init!(db)
  const dev = getTask(db, createTask(db, { title: 't', body: '', repo: 'x' }))!.session_id
  const now = Date.parse('2026-11-09T12:00:00Z'), v = { now, db, csrf: 'c', slot: () => undefined } as any
  const sess = (sid: string, state: string) => ({ project: 'p', sid, state, ts: now - 60_000, prompt: 'q', title: null, last: 'end', exited: false })
  const s = { ok: true, at: now, data: { sessions: [sess(dev, 'waiting'), sess('own', 'waiting'), sess(dev, 'silent')],
    workflows: [{ project: 'p', runId: 'wf_abc-123', name: 'review', state: 'orphaned', startedAt: now - 9e5, lastAt: now - 8e5, started: 1, done: 0 }] } } as any
  assert.deepEqual(agents.waiting!(s, v).map(w => w.text), ['p: q'], 'only the session that is not a Develop task')
  const al = agents.alerts!(s, v)
  assert.deepEqual(al.map(a => a.text), ['Workflow mồ côi: review (p)'], 'no "silent" alert for a Develop task session')
  assert.equal(al[0].seen, '/ops/agents/seen?run=wf_abc-123')
  const r = agents.routes!.find(x => x.path === '/ops/agents/seen')!
  assert.deepEqual(r.handle({ query: new URLSearchParams('run=wf_abc-123'), form: new URLSearchParams() } as any, v), { redirect: '/' })
  r.handle({ query: new URLSearchParams("run=x'); drop table agents_seen;--"), form: new URLSearchParams() } as any, v) // not a run id: ignored
  assert.deepEqual(agents.alerts!(s, v), [])
  assert.match(agents.panel!(s, v), /Mồ côi, đã xem/)
  db.close()
})
