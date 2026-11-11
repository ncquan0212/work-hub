import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { APPS } from '../src/config.ts'
import { normEql, parseQueryResults } from '../src/lib/databuckets.ts'
import { chiSquare, movingAvg, outlier, twoProp } from '../src/lib/stats.ts'
import { COHORT, cohortPoint, METRICS, point } from '../src/modules/report/metrics.ts'
import { bucketDay, cohortQueries, completeDays, eql, formatQueries, pairs, toCohort, toFacts } from '../src/modules/report/queries.ts'

const near = (a: number | null | undefined, b: number, eps = 1e-6) => assert.ok(a != null && Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('moving average: ratios sum num and den over the window; counts take the mean; gaps', () => {
  const ratio = [{ num: 1, den: 10 }, { num: 9, den: 10 }, { num: 0, den: 80 }]
  near(movingAvg(ratio, 3)[2], 10 / 100) // not the mean of 10%, 90%, 0%
  assert.deepEqual(movingAvg([{ num: 2, den: null }, { num: 4, den: null }, { num: 6, den: null }], 2), [null, 3, 5])
  assert.deepEqual(movingAvg([{ num: 1, den: null }, null, null, { num: 1, den: null }], 4), [null, null, null, null]) // 2 of 4 days < 3/4
})

test('outlier: last value against the 28 days before it', () => {
  const flat = Array.from({ length: 28 }, (_, i) => 100 + (i % 2 ? 1 : -1))
  assert.equal(outlier([...flat, 101]), null)
  assert.ok(outlier([...flat, 130])!.z > 2)
  assert.equal(outlier([...flat.slice(0, 10), 130]), null) // too little history
})

test('chi-square SRM and two-proportion z-test match known values', () => {
  const srm = chiSquare([59635, 59735], [1, 1]) // Idol Set1/Set2, research 2026-11-08: p = 0.77
  near(srm.p, 0.772, 0.005)
  assert.ok(chiSquare([1000, 1300], [1, 1]).p < 1e-8)
  near(chiSquare([10, 10, 10], [1, 1, 1]).p, 1)
  const z = twoProp(100, 1000, 130, 1000)!
  near(z.z, 2.098, 0.01); near(z.p, 0.0359, 0.002)
  assert.equal(twoProp(5000, 50, 300, 1000), null) // numerator above denominator is not a proportion (was NaN)
})

test('Databuckets: bucket label, complete days, facts and cohort cells', () => {
  assert.equal(bucketDay('Thu Nov  5 00:00:00 2026'), '2026-11-05')
  assert.throws(() => bucketDay('2026-11-05'))
  const now = Date.parse('2026-11-08T01:00:00Z')
  const rows = ['Thu Nov  5 00:00:00 2026', 'Fri Nov  6 00:00:00 2026', 'Sat Nov  7 00:00:00 2026', 'Sun Nov  8 00:00:00 2026'].map(time => ({
    time, app_id: 'com.example.idol', event_name: 'ad_revenue', events: 10, users: 5, rev: 1.5, rev_usd: 0 }))
  assert.deepEqual([...completeDays(rows, now)], ['2026-11-06', '2026-11-07']) // first bucket partial, today's still filling
  const facts = toFacts('core', rows, now)
  assert.deepEqual(facts.filter(f => f.day === '2026-11-06').map(f => [f.key, f.value]), [['ad_revenue.users', 5], ['ad_revenue.n', 10], ['ad_revenue.rev', 1.5]])
  const coh = toCohort([
    { time: 'Thu Nov  5 00:00:00 2026', app_id: 'com.example.xcast', retention_day: 0, event_name: 'session_start', users: 1, rev: 0 },
    { time: 'Fri Nov  6 00:00:00 2026', app_id: 'com.example.xcast', retention_day: 1, event_name: 'session_start', users: 40, rev: 0 },
    { time: 'Fri Nov  6 00:00:00 2026', app_id: 'com.example.xcast', retention_day: 1, event_name: 'ad_revenue', users: 30, rev: 2 },
    { time: 'Sun Nov  8 00:00:00 2026', app_id: 'com.example.xcast', retention_day: 0, event_name: 'session_start', users: 9, rev: 0 },
  ], now, [0, 1], ['xcast'])
  // the only covered (complete) day here is 11-06: zero cells first (rd 0 and 1), then the real values
  assert.deepEqual(coh.filter(c => c.cohort === '2026-11-05'), [{ app: 'xcast', cohort: '2026-11-05', rd: 1, users: 0, rev: 0 },
    { app: 'xcast', cohort: '2026-11-05', rd: 1, users: 40 }, { app: 'xcast', cohort: '2026-11-05', rd: 1, rev: 2 }])
  assert.equal(coh.filter(c => c.users === 0 && c.rev === 0).length, 2) // 1 covered day × 2 rd
})

test('metrics: base fact decides "no data"; signed IAP terms; cohort maturity', () => {
  const arpdau = METRICS.find(m => m.id === 'arpdau')!, iap = METRICS.find(m => m.id === 'iap')!, crash = METRICS.find(m => m.id === 'crash_free')!
  const day = new Map([['session_start.users', 100], ['ad_revenue.rev', 4], ['iap_sub_new_success.usd', 3], ['iap_sub_refund_success.usd', 1]])
  assert.deepEqual(point(arpdau, day), { num: 6, den: 100 })
  assert.deepEqual(point(iap, day), { num: 2, den: null })
  assert.equal(point(iap, new Map()), null)             // no DAU row = no data, not 0
  assert.equal(point(crash, day), null)                 // crash metrics need Crashlytics' own base
  assert.deepEqual(point(crash, new Map([['crash.total', 1000], ['crash.users', 3]])), { num: 997, den: 1000 })
  const d7 = COHORT.find(c => c.id === 'd7')!, ltv3 = COHORT.find(c => c.id === 'ltv3')!
  const cells = new Map([[0, { users: 230, rev: 1 }], [1, { users: 50, rev: 0.5 }], [2, { users: 30, rev: 0 }], [3, { users: 20, rev: 0.25 }], [7, { users: 10, rev: 0.1 }]])
  assert.equal(cohortPoint(d7, '2026-11-01', 200, cells, '2026-11-07'), null) // D7 falls on 11-08, not pulled yet
  assert.deepEqual(cohortPoint(d7, '2026-11-01', 200, cells, '2026-11-08'), { num: 10, den: 200 }) // size = first_open, not rd-0 sessions
  assert.deepEqual(cohortPoint(ltv3, '2026-11-01', 200, cells, '2026-11-08'), { num: 1.75, den: 200 })
  const holed = new Map([...cells].filter(([rd]) => rd !== 2))
  assert.equal(cohortPoint(ltv3, '2026-11-01', 200, holed, '2026-11-08'), null) // a day not pulled is not 0 revenue
  assert.equal(cohortPoint(COHORT.find(c => c.id === 'd3')!, '2026-11-01', undefined, cells, '2026-11-08'), null) // no first_open yet
})

test('Databuckets reply: several results; EQL rewrites that are only cosmetic still match', () => {
  const reply = 'blah\nQuery results:\n```json\n[{"data":[["a"],[1]],"eql":"select a from X opt_skip_save"},{"data":[["b"],[2]],"eql":"select b as b from Y"}]\n```'
  const r = parseQueryResults(reply)
  assert.equal(r.length, 2)
  assert.equal(normEql(r[1].eql!), normEql('select b from Y'))
  assert.notEqual(normEql('select a from X since 3 days ago'), normEql('select a from X since 4 days ago'))
})

test('bigChart: labels in %, the latest day always labelled, the end value, a fixed-size rug', async () => {
  const { bigChart } = await import('../src/lib/svg.ts')
  const days = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`)
  const html = bigChart({ title: 'DAU <x>', days, fmt: v => String(v), markers: [{ day: '2026-10-05', label: 'RC v9' }],
    series: [{ label: 'theo ngày', cls: 'raw', values: days.map((_, i) => i) }, { label: 'MA7', cls: 's1', values: days.map((_, i) => (i < 6 ? null : i - 3)) }] })
  assert.match(html, /aria-label="DAU &#60;x&#62;"/, "the title is escaped")
  assert.match(html, /<span style="left:100\.00%">31\/10<\/span><\/div><\/div>$/, 'the last x label is the last day')
  assert.equal(html.match(/class="bc-x"[^]*/)![0].match(/<span/g)!.length, 11, 'a tick every 3 days over 31: about ten')
  assert.match(html, /class="bc-end"><span style="top:[\d.]+%">27<\/span>/)
  assert.match(html, /class="bc-rug" style="left:13\.33%" title="05\/10: RC v9"/)
  assert.equal(bigChart({ title: '', days, fmt: String, series: [{ label: '', cls: 'raw', values: days.map(() => null) }] }), '<p class="muted">Chưa đủ số liệu để vẽ.</p>')
})

test('Report queries follow the apps: Idol modes only with an idol app, cohorts by pair above 4 apps', () => {
  assert.equal(formatQueries(4).length, 2) // the fixture has Idol: formats and call modes, one call
  const noIdol = formatQueries(4, APPS.filter(a => a.key !== 'idol'))
  assert.equal(noIdol.length, 1)
  assert.doesNotMatch(noIdol[0].eql, /prank_call_start|app_id in \(\)/)
  assert.deepEqual(pairs(['a', 'b', 'c', 'd', 'e']), [['a', 'b'], ['c', 'd'], ['e']])
  const rds = [0, 1]
  // up to 4 apps: the one EQL the owner's hub always sent, byte for byte
  assert.deepEqual(cohortQueries(3, rds).map(q => q.eql), [eql.cohort(3, rds)])
  assert.deepEqual(cohortQueries(3, rds, ['a', 'b', 'c', 'd', 'e']).map(q => q.apps), [['a', 'b'], ['c', 'd'], ['e']])
  const [idolXremote] = cohortQueries(3, rds, ['idol', 'xremote', 'brain', 'xcast', 'x5'])
  assert.match(idolXremote.eql, /app_id in \('com\.example\.xremote', 'com\.example\.idol'\)/)
})

/** Runs each module's collect in a child hub with this config (and a throwaway data folder): what it throws. */
function collectWith(config: object, ids: string[]): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), 'hub-test-')), file = join(dir, 'config.json')
  const at = (id: string) => new URL(`../src/modules/${id === 'report' || id === 'track' ? `${id}/index` : id}.ts`, import.meta.url).href
  try {
    writeFileSync(file, JSON.stringify(config))
    const script = `const out = {}
      for (const [id, url] of ${JSON.stringify(ids.map(id => [id, at(id)]))}) {
        try { await (await import(url))[id].collect({ now: Date.now(), signal: AbortSignal.timeout(2000), db: null }); out[id] = 'no throw' }
        catch (e) { out[id] = e.name + ': ' + e.message }
      }
      console.log(JSON.stringify(out))`
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, HUB_CONFIG: file, HUB_DATA: dir }, encoding: 'utf8' }))
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

test('a copy that has not set a source up says so (NotConfigured), and calls nothing', () => {
  const ids = ['report', 'track', 'crash', 'rc', 'listing', 'consoles', 'gmail']
  const none = collectWith({}, ids)
  for (const id of ids) assert.equal(none[id], 'NotConfigured: chưa có app trong data/config.json', id)
  // one app, nothing else set up: no Firebase app id, no RC key file, no Play account, no Chrome profile
  const keys = mkdtempSync(join(tmpdir(), 'hub-rc-'))
  try {
    const one = collectWith({ rcKeyDir: keys, apps: [{ key: 'x', name: 'X', pkg: 'com.example.x', rcKey: 'x-rc.json' }] }, ['crash', 'rc', 'consoles', 'gmail'])
    assert.match(one.crash, /^NotConfigured: .*appId/)
    assert.ok(one.rc.startsWith('NotConfigured: ') && one.rc.includes(keys), one.rc)
    assert.match(one.consoles, /^NotConfigured: Play Console cần playDev/)
    assert.match(one.gmail, /^NotConfigured: .*chromeProfiles\.publisher/)
  } finally { rmSync(keys, { recursive: true, force: true }) }
})
