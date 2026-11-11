import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CMP, compare, looksLikeArm, type GroupFacts } from '../src/modules/track/compare.ts'
import { APPS } from '../src/config.ts'
import { queries, toTFacts } from '../src/modules/track/queries.ts'

const g = (days: Record<string, Record<number, Record<string, number>>>): GroupFacts =>
  new Map(Object.entries(days).map(([d, rds]) => [d, new Map(Object.entries(rds).map(([rd, kv]) => [Number(rd), new Map(Object.entries(kv))]))]))

test('compare: D0 rates with z-test, retention only for mature cohorts, means by daily wins', () => {
  const A = g({ '2026-11-01': { 0: { 'first_open.users': 1000, 'complete_onboard.users': 600, 'session_start.users': 1100, 'ad_revenue.n': 3000 }, 1: { 'session_start.users': 150 } },
    '2026-11-07': { 0: { 'first_open.users': 1000, 'complete_onboard.users': 600, 'session_start.users': 1000, 'ad_revenue.n': 3000 }, 1: { 'session_start.users': 900 } } })
  const B = g({ '2026-11-01': { 0: { 'first_open.users': 1000, 'complete_onboard.users': 700, 'session_start.users': 1000, 'ad_revenue.n': 3500 }, 1: { 'session_start.users': 200 } } })
  const onboard = compare(A, B, CMP.find(c => c.id === 'onboard')!, '2026-11-01', '2026-11-07', '2026-11-07')
  assert.equal(onboard.a.value, 0.6); assert.equal(onboard.b.value, 0.7); assert.ok(onboard.p! < 0.001)
  // the 11-07 cohort's D1 is 11-08, not pulled yet: excluded (its 900 would inflate A)
  const d1 = compare(A, B, CMP.find(c => c.id === 'd1')!, '2026-11-01', '2026-11-07', '2026-11-07')
  assert.equal(d1.a.value, 0.15); assert.equal(d1.b.value, 0.2) // over first_open (1000), not rd-0 sessions (1100)
  // a day-1 bucket that was never pulled is skipped, not counted as 0 returning users
  const notPulled = compare(A, B, CMP.find(c => c.id === 'd1')!, '2026-11-01', '2026-11-07', '2026-11-07', new Set(['2026-11-05']))
  assert.equal(notPulled.a.den, 0)
  const ads = compare(A, B, CMP.find(c => c.id === 'ads')!, '2026-11-01', '2026-11-07', '2026-11-07')
  assert.deepEqual([ads.wins, ads.days], [1, 1])
})

test('arm labels vs date-coded default labels', () => {
  assert.ok(looksLikeArm('SetC')); assert.ok(looksLikeArm('Set1'))
  assert.ok(!looksLikeArm('IL2611050')); assert.ok(!looksLikeArm('I2611020')); assert.ok(!looksLikeArm('_null_')); assert.ok(!looksLikeArm('NA'))
})

test('track facts: cohort = bucket day − retention day; partial buckets dropped', () => {
  const now = Date.parse('2026-11-08T01:30:00Z'), pkg = 'com.example.idol'
  const rows = [
    { time: 'Thu Nov  5 00:00:00 2026', app_id: pkg, app_version: '1.0.16', retention_day: 0, users: 1 },
    { time: 'Fri Nov  6 00:00:00 2026', app_id: pkg, app_version: '1.0.16', retention_day: 1, users: 40 },
    { time: 'Sat Nov  7 00:00:00 2026', app_id: pkg, app_version: '1.0.16', retention_day: 0, users: 500 },
    { time: 'Sun Nov  8 00:00:00 2026', app_id: pkg, app_version: '1.0.16', retention_day: 0, users: 9 },
  ]
  assert.deepEqual(toTFacts('ver', 'ret', rows, now).map(f => [f.cohort, f.rd, f.value]), [['2026-11-05', 1, 40], ['2026-11-07', 0, 500]])
})

test('D0 split: the Idol call-mode EQL only when an app is keyed idol; d0 and ret keep their places', () => {
  assert.deepEqual(queries('ver', 3).map(q => q.kind), ['d0', 'ret', 'mode'])
  const qs = queries('ver', 3, APPS.filter(a => a.key !== 'idol'))
  assert.deepEqual(qs.map(q => q.kind), ['d0', 'ret'])
  assert.ok(qs.every(q => !q.eql.includes('app_id in ()') && !q.eql.includes('.idol.')))
})

test('sign test on the days B beat A: two-sided binomial p', async () => {
  const { signP } = await import('../src/modules/track/index.ts')
  assert.equal(signP(6, 6), 0.03125)                     // 2 × (1/2)^6
  assert.ok(Math.abs(signP(12, 14) - 0.01294) < 1e-4)
  assert.equal(signP(1, 2), 1)                           // a split is no evidence
  assert.equal(signP(0, 6), signP(6, 6))                 // symmetric: losing every day is as clear as winning
})

// ───────────── Theo dõi bản 2: comparison runs ─────────────
import { openDb } from '../src/core/db.ts'
import {
  DAY, HOUR, armValue, bucketTime, cohortWindow, compareArms, dataSuggestion, meanLift, METRICS, propLift, rcEvents, rcSuggestions, rcSummary,
  runQueries, steadyStart, t975, toFacts, toHours, topTwo, verCmp, verdict, vnInput, vnTime, fromVnInput, type RcSum, type Run,
} from '../src/modules/track/runs.ts'
import { appPath, parseSteps, playTime } from '../src/modules/track/play.ts'
import {
  allVersions, confirmRun, daily, dueRuns, evaluate, getRun, getState, initStore, insertRun, listRuns, play, rcMatch, refreshRuns, runFacts, saveRun, suggest,
  updateRun, useRcTimes,
} from '../src/modules/track/store.ts'
import { readForm, runForm, runPage, runStats, boardPanel } from '../src/modules/track/view.ts'
import { track } from '../src/modules/track/index.ts'
import { dailyMissed } from '../src/core/scheduler.ts'
import { initNotify } from '../src/lib/notify.ts'

const T = (s: string) => Date.parse(s)
const IDOL = 'com.example.idol'

test('RC template → default label and Firebase experiments on experiment_group', () => {
  const t = { parameters: { experiment_group: { defaultValue: { value: 'IL2611090' }, conditionalValues: {
    'General User': { experimentValue: { experimentId: 'abt_10', variantValue: [{ variantId: '0', value: 'Set1' }, { variantId: '1', value: "Set2'); drop" }, { variantId: '2', value: 'Set3' }], exposurePercent: 100 } },
    IOS: { value: 'NA' } } } }, parameterGroups: { g: { parameters: { other: { conditionalValues: { 'General User': { experimentValue: { experimentId: 'abt_10', variantValue: [{ noChange: true }] } } } } } } } }
  assert.deepEqual(rcSummary(t), { label: 'IL2611090', exps: [{ id: 'abt_10', cond: 'General User', arms: ['Set1', 'Set3'], exposure: 100 }] }) // a value unfit for EQL is dropped
  assert.deepEqual(rcSummary({ parameters: { experiment_group: { defaultValue: { useInAppDefault: true } } } }), { label: null, exps: [] })
})

test('RC history → events → suggestions (running or just ended experiments, recent label changes)', () => {
  const now = T('2026-11-09T15:00:00Z'), exp = (id: string, exposure = 100) => ({ id, cond: 'General User', arms: ['Set1', 'Set2'], exposure })
  const sums: RcSum[] = [
    { v: 1, at: T('2026-10-01T00:00:00Z'), by: 'x', label: 'IL2610010', exps: [exp('abt_1')] },
    { v: 2, at: T('2026-10-20T00:00:00Z'), by: 'x', label: 'IL2610010', exps: [] },                      // abt_1 ends (baseline had it: no start)
    { v: 3, at: T('2026-11-07T13:36:01Z'), by: 'x', label: 'IL2610010', exps: [exp('abt_10', 20)] },
    { v: 5, at: T('2026-11-09T03:47:00Z'), by: 'x', label: 'IL2611080', exps: [exp('abt_10', 100)] },
    { v: 4, at: T('2026-11-08T10:58:00Z'), by: 'x', label: 'IL2611080', exps: [exp('abt_10', 20)] },     // out of order on purpose
  ]
  const evs = rcEvents(sums)
  assert.deepEqual(evs.map(e => [e.v, e.type, e.exp?.id ?? e.label]), [[2, 'ab_end', 'abt_1'], [3, 'ab_start', 'abt_10'], [4, 'label', 'IL2611080'], [5, 'ab_exposure', 'abt_10']])
  const s = rcSuggestions('idol', evs, now)
  assert.equal(s.length, 2)
  assert.deepEqual([s[0].kind, s[0].arms, s[0].start_at, s[0].end_at, s[0].skey], ['ab', ['Set1', 'Set2'], T('2026-11-07T13:36:01Z'), null, 'rc:idol:abt_10'])
  assert.match(s[0].note!, /20% → 100%/)
  assert.deepEqual([s[1].kind, s[1].arms, s[1].skey], ['version', [], 'rc:idol:label:IL2611080']) // arms come from the hourly data
  // an experiment that ended more than 3 days ago is history, not a suggestion
  assert.equal(rcSuggestions('idol', rcEvents([...sums, { v: 6, at: T('2026-11-09T04:00:00Z'), by: 'x', label: 'IL2611080', exps: [] }]), now + 4 * DAY).filter(x => x.kind === 'ab').length, 0)
})

test('versions: semver order, the two biggest arms (each ≥ 5%), data suggestion from the daily split', () => {
  assert.ok(verCmp('1.0.9', '1.0.16') < 0)
  assert.deepEqual(topTwo(new Map([['1.0.16', 500], ['1.0.17', 480], ['1.0.15', 20]])), ['1.0.16', '1.0.17'])
  assert.deepEqual(topTwo(new Map([['1.0.16', 990], ['1.0.15', 10]])), []) // 100% rollout: no second arm
  const day = (m: Record<string, number>) => new Map(Object.entries(m))
  const s = dataSuggestion('xremote', [['2026-11-05', day({ '1.0.22': 300, '1.0.23': 3 })], ['2026-11-06', day({ '1.0.22': 200, '1.0.23': 80 })], ['2026-11-07', day({ '1.0.22': 150, '1.0.23': 150 })]])!
  assert.deepEqual([s.arms, s.start_at, s.source, s.skey], [['1.0.22', '1.0.23'], T('2026-11-06T00:00:00Z'), 'data', 'data:xremote:1.0.23'])
  assert.deepEqual(s.weights, [71, 29]) // the split on 11-06 (200 : 80), not 1:1: a staged rollout is no SRM
  assert.equal(dataSuggestion('xremote', [['2026-11-07', day({ '1.0.23': 400 })]]), null)
})

test('data-driven start: the first 6 steady hours with real volume, not stray labelled users', () => {
  const start = T('2026-11-07T13:00:00Z'), h = new Map<number, Map<string, number>>()
  for (let i = -10; i < 30; i++) h.set(start + i * HOUR, new Map(i < 0 ? [['Set1', 1], ['Set2', 2]] : [['Set1', 500 + (i % 3) * 20], ['Set2', 510]]))
  assert.equal(steadyStart(h, ['Set1', 'Set2']), start)
  h.set(start + 2 * HOUR, new Map([['Set1', 500]]))                         // an hour without arm B breaks the run
  assert.equal(steadyStart(h, ['Set1', 'Set2']), start + 3 * HOUR)
  assert.equal(steadyStart(new Map(), ['a', 'b']), null)
})

test('EQL of a run: `to` sent a day early, the echo expected with the real end; arms by first_open or install-day label', () => {
  const now = T('2026-11-09T15:30:00Z')
  const ab = runQueries({ id: 4, app: 'idol', kind: 'ab', arms: ['Set1', 'Set2'], start_at: T('2026-11-07T13:36:01Z'), end_at: null }, now, true)
  assert.deepEqual(ab.map(q => `${q.kind}:${q.arm}`), ['hour:*', 'd0:Set1', 'mode:Set1', 'ret:Set1', 'd0:Set2', 'mode:Set2', 'ret:Set2'])
  // the hourly window: 24 h before the start → the current hour; sent with `to` one day early
  assert.match(ab[0].eql, /experiment_group in \('Set1', 'Set2'\) regex_off and retention_day in \(0\) bucket 1 hour time from '2026-11-06 13:00:00' to '2026-11-08 15:59:59'$/)
  assert.match(ab[0].ran, /to '2026-11-09 15:59:59'$/)
  // stage 1: the arm's label on the install day, from the start to the start of today (UTC)
  assert.match(ab[1].eql, /experiment_group in \('Set1'\) regex_off and retention_day in \(0\) time from '2026-11-07 13:36:01' to '2026-11-07 23:59:59' boost time 10 \| /)
  assert.match(ab[1].ran, /time from '2026-11-07 13:36:01' to '2026-11-08 23:59:59' boost time 10 \| .* time from '2026-11-06 00:00:00' to '2026-11-09 23:59:59' boost user_pseudo_id str 10$/)
  assert.match(ab[3].ran, /retention_day between \(0, 7\) and include \$0.user_pseudo_id bucket 1 day time from '2026-11-06 00:00:00' to '2026-11-17 23:59:59'/)
  // version: first_open with the version; no Idol mode query for another app; no arm filter while arms are unknown
  const ver = runQueries({ id: 7, app: 'xremote', kind: 'version', arms: ['1.0.22', '1.0.23'], start_at: T('2026-11-05T00:00:00Z'), end_at: null }, now, true)
  assert.deepEqual(ver.map(q => q.kind), ['hour', 'd0', 'ret', 'd0', 'ret'])
  assert.match(ver[1].eql, /event_name in \('first_open'\) regex_off and app_version in \('1.0.22'\) regex_off time from '2026-11-05 00:00:00'/)
  const pending = runQueries({ id: 8, app: 'idol', kind: 'version', arms: [], start_at: T('2026-11-09T10:58:00Z'), end_at: null }, now, true)
  assert.equal(pending.length, 1); assert.doesNotMatch(pending[0].eql, /app_version in/)
  assert.match(pending[0].ran, /time from '2026-11-08 22:00:00' to '2026-11-09 15:59:59'$/) // unfiltered: 12 h before to 36 h after
  assert.throws(() => runQueries({ id: 9, app: 'idol', kind: 'ab', arms: ["Set1') or ('1"], start_at: T('2026-11-07T00:00:00Z'), end_at: null }, now, true))
  // an hourly window that was complete at the last refresh is not asked again
  assert.equal(runQueries({ id: 7, app: 'xremote', kind: 'version', arms: ['1.0.22', '1.0.23'], start_at: T('2026-10-20T00:00:00Z'), end_at: null, refreshed_at: T('2026-11-09T09:00:00Z') }, now, true)[0].kind, 'd0')
  // cohort window: never past today 00:00 UTC, at most 28 days of installs
  assert.deepEqual(cohortWindow({ start_at: T('2026-10-01T00:00:00Z'), end_at: null }, now), { from: T('2026-10-01T00:00:00Z'), to: T('2026-10-29T00:00:00Z') })
  assert.equal(cohortWindow({ start_at: T('2026-11-08T00:00:00Z'), end_at: T('2026-11-08T12:00:00Z') }, now).to, T('2026-11-08T12:00:00Z'))
})

test('rows → facts: d0 and mode as window totals, ret per install day; hourly rows by arm', () => {
  assert.equal(bucketTime('Sat Nov  7 13:00:00 2026'), T('2026-11-07T13:00:00Z'))
  const ret = toFacts({ arm: 'Set1', kind: 'ret' }, [{ time: 'Mon Nov  9 00:00:00 2026', event_name: 'session_start', retention_day: 2, events: 9, users: 5, rev: 0 },
    { time: 'Sun Nov  8 00:00:00 2026', event_name: 'ad_revenue', retention_day: 0, events: 30, users: 10, rev: 0.5 }, { time: 'Sun Nov  8 00:00:00 2026', event_name: 'x', retention_day: 9, events: 1, users: 1, rev: 0 }])
  assert.deepEqual(ret.map(f => [f.cohort, f.rd, f.key, f.value]), [['2026-11-07', 2, 'session_start.users', 5], ['2026-11-07', 2, 'session_start.n', 9],
    ['2026-11-08', 0, 'ad_revenue.users', 10], ['2026-11-08', 0, 'ad_revenue.n', 30], ['2026-11-08', 0, 'ad_revenue.rev', 0.5]])
  assert.deepEqual(toFacts({ arm: 'Set1', kind: 'mode' }, [{ mode: 'video', events: 7, users: 3 }]).map(f => [f.cohort, f.key, f.value]), [['*', 'prank_call_start.video.users', 3], ['*', 'prank_call_start.video.n', 7]])
  const h = toHours('version', [{ time: 'Sat Nov  7 13:00:00 2026', app_version: '1.0.16', users: 4 }, { time: 'Sat Nov  7 13:00:00 2026', app_version: '1.0.17', users: 6 }])
  assert.deepEqual([...h.get(T('2026-11-07T13:00:00Z'))!], [['1.0.16', 4], ['1.0.17', 6]])
})

test('statistics: Katz interval for a ratio of proportions, batch means by install day for means, t quantiles', () => {
  const l = propLift(100, 1000, 120, 1000)!
  assert.ok(Math.abs(l.lift - 0.2) < 1e-9); assert.ok(Math.abs(l.lo! + 0.0659) < 5e-4); assert.ok(Math.abs(l.hi! - 0.5416) < 5e-4); assert.ok(Math.abs(l.p! - 0.1537) < 2e-3)
  assert.equal(propLift(0, 1000, 5, 1000), null)
  assert.equal(t975(1), 12.706); assert.equal(t975(30), 2.042); assert.ok(Math.abs(t975(60) - 2.000) < 0.003)
  const day = (d: string, num: number, den: number) => ({ day: d, num, den })
  const a = { num: 40, den: 400, days: [day('1', 10, 100), day('2', 10, 100), day('3', 10, 100), day('4', 10, 100)] }
  const b = { num: 46, den: 400, days: [day('1', 11, 100), day('2', 12, 100), day('3', 11.5, 100), day('4', 11.5, 100)] }
  const m = meanLift(a, b)!
  assert.ok(Math.abs(m.lift - 0.15) < 1e-9); assert.ok(m.lo! > 0 && m.hi! < 0.25, `${m.lo} ${m.hi}`) // steady +10..20% every day: clear
  assert.equal(meanLift({ ...a, days: a.days.slice(0, 3) }, b)!.lo, null)                             // 3 days: no interval
  const prop = METRICS.find(x => x.id === 'onboard')!
  assert.equal(verdict(prop, { num: 5, den: 50 }, { num: 9, den: 50 }, propLift(5, 50, 9, 50)).word, 'Mẫu nhỏ')
  assert.equal(verdict(prop, { num: 100, den: 1000 }, { num: 200, den: 1000 }, propLift(100, 1000, 200, 1000)).word, 'B tốt hơn')
})

test('per-day metrics: only install days old enough (one day spare); too few of them waits instead of "small sample"', () => {
  const g = (rows: [string, number, string, number][]) => {
    const m = new Map<string, Map<number, Map<string, number>>>()
    for (const [c, rd, k, v] of rows) { if (!m.has(c)) m.set(c, new Map()); const x = m.get(c)!; if (!x.has(rd)) x.set(rd, new Map()); x.get(rd)!.set(k, v) }
    return m
  }
  const A = g([['*', 0, 'session_start.users', 1000], ['2026-11-05', 0, 'session_start.users', 500], ['2026-11-05', 1, 'session_start.users', 100], ['2026-11-06', 0, 'session_start.users', 500], ['2026-11-06', 1, 'session_start.users', 400]])
  const d1 = METRICS.find(x => x.id === 'd1')!
  assert.deepEqual([armValue(A, d1, '2026-11-07').den, armValue(A, d1, '2026-11-07').value], [500, 0.2]) // 11-06 + 1 + 1 > 11-07: not yet
  const early = g([['*', 0, 'session_start.users', 1000], ['2026-11-04', 0, 'session_start.users', 50], ['2026-11-04', 1, 'session_start.users', 140]])
  assert.equal(compareArms(early, early, d1, '2026-11-07').c.word, 'Chờ đủ ngày')
})

test('Vietnam time in forms and pages', () => {
  assert.equal(vnTime(T('2026-11-07T13:36:01Z')), '20:36 07/11')
  assert.equal(vnInput(T('2026-11-07T13:36:01Z')), '2026-11-07T20:36')
  assert.equal(fromVnInput('2026-11-07T20:36'), T('2026-11-07T13:36:00Z'))
  assert.ok(Number.isNaN(fromVnInput('7/11 20:36')))
})

test('Play Console release page (best-effort until calibrated): dates, rollout steps, app path', () => {
  assert.equal(playTime('Rolled out on Nov 7, 2026, 10:23 AM'), T('2026-11-07T03:23:00Z'))
  assert.equal(playTime('7 thg 11, 2026 22:05'), T('2026-11-07T15:05:00Z'))
  assert.equal(playTime('07/11/2026 1:05 CH'), T('2026-11-07T06:05:00Z'))
  assert.equal(playTime('không có ngày'), null)
  const steps = parseSteps('Production\n\n17 (1.0.17)\nĐang phát hành cho 50% người dùng\n7 thg 11, 2026 10:00\n\n16 (1.0.16)\nĐã hoàn tất 100%\n\nversion 1.0.15 only')
  assert.deepEqual(steps, [{ version: '1.0.17', pct: 50, at: T('2026-11-07T03:00:00Z') }, { version: '1.0.16', pct: 100, at: null }])
  const page = { text: 'Apps\nIdol\ncom.example.idol\narrow_forward\nX\ncom.example.other\narrow_forward', links: [
    ['https://play.google.com/console/u/0/developers/88/app/111/app-dashboard', 'arrow_forward'], ['https://play.google.com/console/u/0/developers/88/app/222/app-dashboard', 'arrow_forward']] as [string, string][] }
  assert.equal(appPath(page, '88', IDOL), '/developers/88/app/111')
  assert.equal(appPath({ ...page, links: page.links.slice(0, 1) }, '88', IDOL), null) // counts differ: the page changed
})

test('store: bản 1 tests become runs, suggestions deduplicated, arms filled from the hours, SRM and verdict notified once', () => {
  const db = openDb(':memory:'), now = T('2026-11-09T15:00:00Z')
  db.exec(`create table track_tests (id integer primary key, app text not null, name text not null, cond text, arms text not null, weights text not null, start_day text not null, end_day text, note text, created_at integer not null)`)
  db.prepare(`insert into track_tests values (1, 'idol', 'abt_9 nút X', 'AB_NativeCollap_Close_1103', '["SetC","SetD"]', '[1,1]', '2026-11-03', null, null, 1)`).run()
  initStore(db); initStore(db)
  const runs = listRuns(db)
  assert.deepEqual(runs.map(r => [r.kind, r.status, r.arms, r.start_at, r.skey]), [['ab', 'active', ['SetC', 'SetD'], T('2026-11-03T00:00:00Z'), 'test:1']])
  // RC: abt_9 is the migrated test (same condition and arms), abt_10 is new; a label change waits for its arms
  const rcv = db.prepare('insert into track_rcv (app, v, at, by, label, exps) values (?, ?, ?, ?, ?, ?)')
  rcv.run('idol', 91, T('2026-11-03T09:00:00Z'), 'x', 'IL2610290', '[]')
  rcv.run('idol', 92, T('2026-11-03T09:32:43Z'), 'x', 'IL2610290', JSON.stringify([{ id: 'abt_9', cond: 'AB_NativeCollap_Close_1103', arms: ['SetC', 'SetD'], exposure: 100 }]))
  rcv.run('idol', 103, T('2026-11-07T13:36:01Z'), 'x', 'IL2610290', JSON.stringify([{ id: 'abt_10', cond: 'General User', arms: ['Set1', 'Set2'], exposure: 100 }]))
  rcv.run('idol', 105, T('2026-11-09T10:58:48Z'), 'x', 'IL2611090', JSON.stringify([{ id: 'abt_10', cond: 'General User', arms: ['Set1', 'Set2'], exposure: 100 }]))
  suggest(db, now, new Set(['idol'])); suggest(db, now, new Set(['idol']))
  const s = listRuns(db, ['suggested'])
  assert.deepEqual(s.map(r => r.skey).sort(), ['rc:idol:abt_10', 'rc:idol:label:IL2611090'])
  const notes = () => db.prepare('select key, tone from notify_items order by id').all().map((x: any) => `${x.key}:${x.tone}`)
  assert.deepEqual(notes(), [`track:suggest:${s.find(r => r.kind === 'ab')!.id}:info`]) // the label one waits for its arms
  // hourly rows fill the pending version suggestion's arms (newest two by installs after the change) and notify then
  const lbl = s.find(r => r.kind === 'version')!
  const hours = [0, 1, 2, 3, 4, 5, 6].flatMap(i => [{ time: new Date(T('2026-11-09T11:00:00Z') + i * HOUR).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/, (_, w, d, m, y, t) => `${w} ${m} ${d.padStart(2, ' ')} ${t} ${y}`), app_version: '1.0.16', users: 50 },
    { time: new Date(T('2026-11-09T11:00:00Z') + i * HOUR).toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (.+) GMT$/, (_, w, d, m, y, t) => `${w} ${m} ${d.padStart(2, ' ')} ${t} ${y}`), app_version: '1.0.17', users: 48 }])
  saveRun(db, lbl, runQueries(lbl, now, false), [hours], now)
  assert.deepEqual(getRun(db, lbl.id)!.arms, ['1.0.16', '1.0.17'])
  assert.equal(getRun(db, lbl.id)!.alt_at, T('2026-11-09T11:00:00Z'))
  assert.equal(notes().length, 2)
  assert.deepEqual(dueRuns(listRuns(db), now + HOUR).map(r => r.id).includes(lbl.id), false) // refreshed: next one in 6 h
  // confirm the A/B suggestion, then feed its cohort rows: SRM (1000 vs 1400 on 1:1) is notified once, verdict once
  const ab = s.find(r => r.kind === 'ab')!
  confirmRun(db, ab.id)
  const run = getRun(db, ab.id)! as Run
  assert.deepEqual([run.status, run.metric, run.refreshed_at], ['active', 'd1', null])
  const qs = runQueries(run, now, true)
  const d0 = (n: number, onb: number) => [{ event_name: 'session_start', events: n * 2, users: n, rev: 0 }, { event_name: 'complete_onboard', events: onb, users: onb, rev: 0 }]
  const ret = (n: number, d1: number) => [{ time: 'Sat Nov  7 00:00:00 2026', event_name: 'session_start', retention_day: 0, events: n, users: n, rev: 0 }, { time: 'Sun Nov  8 00:00:00 2026', event_name: 'session_start', retention_day: 1, events: d1, users: d1, rev: 0 }]
  const rows = qs.map(q => q.kind === 'hour' ? [] : q.kind === 'mode' ? [] : q.kind === 'd0' ? d0(q.arm === 'Set1' ? 1000 : 1400, 300) : ret(q.arm === 'Set1' ? 1000 : 1400, q.arm === 'Set1' ? 100 : 280))
  saveRun(db, run, qs, rows, T('2026-11-10T15:00:00Z'))
  assert.equal(getRun(db, ab.id)!.srm, 1)
  assert.equal(runFacts(db, ab.id).get('Set2')!.get('*')!.get(0)!.get('session_start.users'), 1400)
  assert.equal(getRun(db, ab.id)!.decided_at, null, 'D1 10% → 20% two days in is provisional: the run decides after 7 days of installs')
  evaluate(db, getRun(db, ab.id)!, T('2026-11-10T16:00:00Z'))
  assert.deepEqual(notes().filter(k => k.startsWith('track:srm') || k.startsWith('track:verdict')), [`track:srm:${ab.id}:warn`])
  // editing what defines the cohort drops its numbers
  updateRun(db, ab.id, { ...getRun(db, ab.id)!, start_at: T('2026-11-07T14:00:00Z'), status: 'active' })
  assert.equal(runFacts(db, ab.id).size, 0); assert.equal(getRun(db, ab.id)!.srm, 0)
  // a hand-written run with the same two versions makes a data suggestion redundant
  insertRun(db, { app: 'xremote', kind: 'version', name: 'x', arms: ['1.0.22', '1.0.23'], weights: [1, 1], start_at: now, end_at: null, source: 'manual', cond: null, exp_id: null, note: null, skey: null }, 'active', now)
  db.prepare(`insert into track_facts values ('xremote', '2026-11-08', 'ver', '1.0.22', 0, 'first_open.users', 100), ('xremote', '2026-11-08', 'ver', '1.0.23', 0, 'first_open.users', 100)`).run()
  suggest(db, now, new Set())
  assert.equal(listRuns(db, ['suggested']).filter(r => r.app === 'xremote').length, 0)
})

test('pages: run page and board render and escape source text; the form refuses bad input', () => {
  const db = openDb(':memory:'), now = T('2026-11-09T15:00:00Z')
  initStore(db)
  const id = insertRun(db, { app: 'idol', kind: 'ab', name: '<script>x</script>', arms: ['Set1', 'Set2'], weights: [1, 1], start_at: now - 2 * DAY, end_at: null, source: 'manual', cond: '"><img>', exp_id: null, note: '<b>n</b>', skey: null }, 'active', now)!
  const v = { now, db, slot: () => undefined, csrf: 't' } as any
  const html = runPage(v, getRun(db, id)!) + boardPanel(undefined, v)
  assert.ok(!html.includes('<script>x') && !html.includes('"><img>') && !html.includes('<b>n</b>'))
  assert.match(html, /&#60;script&#62;x/)
  const f = (o: Record<string, string>) => readForm(new URLSearchParams({ app: 'idol', kind: 'ab', name: 'n', arms: 'Set1, Set2', start: '2026-11-07T20:36', ...o }), fromVnInput)
  assert.equal(f({}).why, ''); assert.deepEqual(f({}).run.weights, [1, 1]); assert.equal(f({}).run.start_at, T('2026-11-07T13:36:00Z'))
  assert.match(f({ arms: "Set1, Set2'" }).why, /chữ, số/)
  assert.match(f({ weights: '1' }).why, /Tỉ lệ/)
  assert.match(f({ end: '2026-11-07T20:00' }).why, /Kết thúc/)
  assert.match(f({ arms: 'Set1' }).why, /2 đến 6/)
})

// ───────────── review fixes 2026-11-09 ─────────────

const brainRun = (db: any, name: string, start: number, now: number) =>
  insertRun(db, { app: 'brain', kind: 'ab', name, arms: ['Set1', 'Set2'], weights: [1, 1], start_at: start, end_at: null, source: 'manual', cond: null, exp_id: null, note: null, skey: null }, 'active', now, 'd1')!
/** One refresh of a brain run: per arm [new users, D1 returning, onboarded] on the 11-01 cohort. */
function feed(db: any, id: number, now: number, arms: Record<string, [number, number, number]>) {
  const r = getRun(db, id)!, qs = runQueries(r, now, true)
  saveRun(db, r, qs, qs.map(q => {
    const [n, d1, onb] = arms[q.arm] ?? [0, 0, 0]
    return q.kind === 'd0' ? [{ event_name: 'session_start', events: n, users: n, rev: 0 }, { event_name: 'complete_onboard', events: onb, users: onb, rev: 0 }]
      : q.kind === 'ret' ? [{ time: 'Sun Nov  1 00:00:00 2026', event_name: 'session_start', retention_day: 0, events: n, users: n, rev: 0 }, { time: 'Mon Nov  2 00:00:00 2026', event_name: 'session_start', retention_day: 1, events: d1, users: d1, rev: 0 }] : []
  }), now)
}

test('decision: provisional before the horizon, decided once after it (no difference too), then kept; only the primary concludes', () => {
  const db = openDb(':memory:'), start = T('2026-11-01T00:00:00Z')
  initStore(db); initNotify(db)
  const notes = () => db.prepare(`select key, title from notify_items where key like 'track:verdict:%' order by id`).all() as { key: string; title: string }[]
  const id = brainRun(db, 'AB', start, start)
  assert.equal(getRun(db, id)!.horizon, 7)
  // 7 days of installs end 11-08 00:00: the last install day 11-07, mature for D1 when 11-09 is pulled
  feed(db, id, T('2026-11-05T12:00:00Z'), { Set1: [1000, 100, 300], Set2: [1000, 200, 600] })
  assert.equal(getRun(db, id)!.decided_at, null); assert.equal(notes().length, 0)
  const call = (word: string) => runStats(db, getRun(db, id)!).cmps.find(x => x.m.id === word)!.c
  assert.deepEqual(call('d1'), { tone: 'mute', word: 'Tạm thời: B tốt hơn' })
  assert.deepEqual(call('onboard'), { tone: 'mute', word: 'Tham khảo' }) // 30% → 60% is clear, but not the primary metric
  feed(db, id, T('2026-11-09T20:00:00Z'), { Set1: [1000, 100, 300], Set2: [1000, 200, 600] }) // pulled_to 11-08: not yet
  assert.equal(getRun(db, id)!.decided_at, null)
  feed(db, id, T('2026-11-10T01:00:00Z'), { Set1: [1000, 100, 300], Set2: [1000, 200, 600] })
  assert.deepEqual([getRun(db, id)!.decided_at, getRun(db, id)!.decision], [T('2026-11-10T01:00:00Z'), 'better'])
  assert.match(notes()[0].title, /AB: B tốt hơn ở Retention D1/)
  // later refreshes show live numbers; the conclusion stays and nothing notifies again
  feed(db, id, T('2026-11-10T07:00:00Z'), { Set1: [1000, 100, 300], Set2: [1000, 100, 300] })
  assert.equal(getRun(db, id)!.decision, 'better'); assert.equal(notes().length, 1)
  assert.deepEqual(call('d1'), { tone: 'ok', word: 'B tốt hơn' })
  assert.equal(runStats(db, getRun(db, id)!).cmps.find(x => x.m.id === 'd1')!.l!.lift, 0)
  // an A/A run concludes "no clear difference", and says so once
  const aa = brainRun(db, 'AA', start, start)
  feed(db, aa, T('2026-11-10T01:00:00Z'), { Set1: [1000, 100, 300], Set2: [1000, 104, 300] })
  assert.equal(getRun(db, aa)!.decision, 'none'); assert.match(notes()[1].title, /AA: Chưa thấy khác biệt ở Retention D1/)
  assert.match(runPage({ now: T('2026-11-10T02:00:00Z'), db, csrf: 't' } as any, getRun(db, aa)!), /Đã kết luận ngày 10\/11/)
  // the form: a horizon field, 1 to 28 days
  assert.match(runForm({ db, csrf: 't' } as any, new URLSearchParams(), null), /Số ngày trước khi kết luận<input type="number" name="horizon"[^>]*value="7"/)
  const f = (o: Record<string, string>) => readForm(new URLSearchParams({ app: 'idol', kind: 'ab', name: 'n', arms: 'Set1, Set2', start: '2026-11-07T20:36', ...o }), fromVnInput)
  assert.equal(f({}).run.horizon, 7); assert.equal(f({ horizon: '14' }).run.horizon, 14); assert.match(f({ horizon: '0' }).why, /từ 1 đến 28/)
})

test('a refresh is stamped before its Databuckets call, the daily pull asks only by version, Play is stamped before its pages', async () => {
  const db = openDb(':memory:'), now = T('2026-11-09T15:00:00Z')
  initStore(db)
  const id = brainRun(db, 'AB', now - 2 * DAY, now)
  let ac = new AbortController(), seen: unknown
  await assert.rejects(refreshRuns(db, now, ac.signal, [], async () => { seen = getRun(db, id)!.refreshed_at; ac.abort(); throw new Error('timeout') }))
  assert.equal(seen, now)
  assert.equal(dueRuns(listRuns(db), now + HOUR).length, 0) // a restart after the timeout does not send it again
  const calls: string[][] = []
  ac = new AbortController()
  await assert.rejects(daily(db, now, ac.signal, [], async () => { seen = getState(db, 'd0')!.at; ac.abort(); throw new Error('timeout') }))
  assert.equal(seen, now)
  await daily(db, now + DAY, new AbortController().signal, [], async qs => { calls.push(qs.map(q => q.eql)); return qs.map(() => ({ rows: [] })) as any })
  assert.equal(calls.length, 1); assert.match(calls[0][0], /app_version/); assert.doesNotMatch(calls.join(), /experiment_group/)
  await play(db, now, new AbortController().signal, async () => { seen = getState(db, 'play')!.at; return [] })
  assert.equal(seen, now)
})

test('RC precise times survive a save of the form when their minute is unchanged', () => {
  const old = { start_at: T('2026-11-07T13:36:01.250Z'), end_at: T('2026-11-08T02:02:05Z') }
  const f = (o: Record<string, string>) => readForm(new URLSearchParams({ app: 'idol', kind: 'ab', name: 'n', arms: 'Set1, Set2', start: '2026-11-07T20:36', end: '2026-11-08T09:02', ...o }), fromVnInput, old).run
  assert.deepEqual([f({}).start_at, f({}).end_at], [old.start_at, old.end_at])
  assert.deepEqual([f({ start: '2026-11-07T20:37', end: '' }).start_at, f({ start: '2026-11-07T20:37', end: '' }).end_at], [T('2026-11-07T13:37:00Z'), null])
})

test('an experiment that changes arms (Brain abt_35): an ab_arms event, a run for the new arms, on the timeline and in the notes', () => {
  const exp = (arms: string[]) => [{ id: 'abt_35', cond: 'General User', arms, exposure: 100 }]
  const t0 = T('2026-11-08T03:00:00Z'), t1 = t0 + 2.5 * HOUR, now = T('2026-11-09T15:00:00Z')
  const sums: RcSum[] = [{ v: 1, at: t0 - DAY, by: 'x', label: 'B1', exps: [] }, { v: 2, at: t0, by: 'x', label: 'B1', exps: exp(['Set1', 'Set2']) }, { v: 3, at: t1, by: 'x', label: 'B1', exps: exp(['Set3', 'Set4']) }]
  const evs = rcEvents(sums)
  assert.deepEqual(evs.map(e => [e.type, e.from ?? null]), [['ab_start', null], ['ab_arms', 'Set1/Set2']])
  const s = rcSuggestions('brain', evs, now)
  assert.deepEqual(s.map(x => [x.arms.join('/'), x.start_at, x.end_at, x.skey]), [['Set1/Set2', t0, t1, 'rc:brain:abt_35'], ['Set3/Set4', t1, null, 'rc:brain:abt_35:Set3/Set4']])
  assert.match(s[0].note!, /Nhánh đổi sang Set3\/Set4/); assert.match(s[1].note!, /đổi nhánh Set1\/Set2 → Set3\/Set4/)
  // store: the Set1/Set2 suggestion made before the change gets its end; the new arms are a suggestion of their own
  const db = openDb(':memory:')
  initStore(db)
  const rcv = db.prepare('insert into track_rcv (app, v, at, by, label, exps) values (?, ?, ?, ?, ?, ?)')
  for (const x of sums.slice(0, 2)) rcv.run('brain', x.v, x.at, x.by, x.label, JSON.stringify(x.exps))
  suggest(db, now, new Set(['brain']))
  assert.equal(listRuns(db, ['suggested'])[0].end_at, null)
  rcv.run('brain', 3, t1, 'x', 'B1', JSON.stringify(sums[2].exps))
  suggest(db, now, new Set(['brain']))
  const runs = listRuns(db, ['suggested']).filter(r => r.app === 'brain')
  assert.deepEqual(runs.map(r => [r.arms.join('/'), r.end_at]).sort(), [['Set1/Set2', t1], ['Set3/Set4', null]])
  assert.deepEqual(runs.map(r => rcMatch(db, r)!.start).sort(), [t0, t1]) // "Dùng giờ RC" keeps each run on its own arms
  assert.match(boardPanel(undefined, { now, db, csrf: 't', slot: () => undefined } as any), /<i class="track-mk ab" style="[^"]*" title="[^"]*: abt_35 đổi nhánh Set1\/Set2 → Set3\/Set4">/)
})

test('Play waits for the next 08:30 after the first start; SRM is a warn line, not a "Gấp"; long tags wrap', () => {
  const db = openDb(':memory:'), now = Date.now()
  initStore(db)
  assert.equal(dailyMissed('08:30', getState(db, 'play')?.at, now), false)
  const id = brainRun(db, 'AB', now - 3 * DAY, now)
  db.prepare('update track_runs set srm = 1 where id = ?').run(id)
  assert.deepEqual(track.alerts!(undefined, { now, db } as any).map(a => a.tone), ['warn'])
  assert.match(track.css!, /\.track-aside \.kv dd \{ white-space: normal;[^}]*overflow-wrap: anywhere/)
  assert.match(track.css!, /\.track-aside \.tag \{ white-space: normal; max-width: 100%; overflow-wrap: anywhere/)
})

test('small samples: means need 100 users an arm; only install days with a real share of the arm count as days', () => {
  const ads = METRICS.find(x => x.id === 'ads')!
  assert.equal(verdict(ads, { num: 300, den: 50 }, { num: 600, den: 50 }, null).word, 'Mẫu nhỏ')
  const day = (d: string, num: number, den: number) => ({ day: d, num, den })
  const real = [day('2', 100, 100), day('3', 100, 100), day('4', 100, 100)], stray = day('1', 9, 3)
  const a = { num: 309, den: 303, days: [stray, ...real] }, b = { num: 336, den: 303, days: [day('1', 3, 3), day('2', 110, 100), day('3', 112, 100), day('4', 111, 100)] }
  assert.equal(meanLift(a, b)!.how, 'chưa đủ ngày (3/4)') // the 3-user day before the start is no measurement
  assert.equal(meanLift({ ...a, days: [...a.days, day('5', 100, 100)] }, { ...b, days: [...b.days, day('5', 109, 100)] })!.how, 't trên tỉ số từng ngày, 4 ngày')
})

test('RC versions: every page is read; an unfinished listing throws (history not complete)', async () => {
  const pages: Record<string, any> = { u: { versions: [{ versionNumber: '3' }], nextPageToken: 'p2' }, 'u&pageToken=p2': { versions: [{ versionNumber: '2' }] } }
  assert.deepEqual((await allVersions(async x => pages[x], 'u')).map(v => v.versionNumber), ['3', '2'])
  await assert.rejects(allVersions(async () => ({ versions: [], nextPageToken: 'again' }), 'u'))
})

test('pulled_to only after cohort queries, cleared on confirm; "Dùng giờ RC" leaves a dismissed run dismissed', () => {
  const db = openDb(':memory:'), now = T('2026-11-09T15:00:00Z')
  initStore(db)
  const id = brainRun(db, 'AB', now - 2 * HOUR, now)
  const r = getRun(db, id)!, qs = runQueries(r, now, true)
  assert.deepEqual(qs.map(q => q.kind), ['hour']) // started today: no complete install day yet
  saveRun(db, r, qs, [[]], now)
  assert.equal(getRun(db, id)!.pulled_to, null)
  const sid = insertRun(db, { app: 'idol', kind: 'ab', name: 'S', arms: ['Set1', 'Set2'], weights: [1, 1], start_at: T('2026-11-07T13:36:01Z'), end_at: null, source: 'rc', cond: 'General User', exp_id: 'abt_10', note: null, skey: 'rc:idol:abt_10' }, 'suggested', now)!
  db.prepare(`update track_runs set pulled_to = '2026-11-08' where id = ?`).run(sid)
  confirmRun(db, sid)
  assert.equal(getRun(db, sid)!.pulled_to, null)
  db.prepare('insert into track_rcv (app, v, at, by, label, exps) values (?, ?, ?, ?, ?, ?)').run('idol', 1, T('2026-11-01T00:00:00Z'), 'x', 'IL', '[]')
  db.prepare('insert into track_rcv (app, v, at, by, label, exps) values (?, ?, ?, ?, ?, ?)').run('idol', 2, T('2026-11-07T13:36:01Z'), 'x', 'IL', JSON.stringify([{ id: 'abt_10', cond: 'General User', arms: ['Set1', 'Set2'], exposure: 100 }]))
  const did = insertRun(db, { app: 'idol', kind: 'ab', name: 'D', arms: ['Set1', 'Set2'], weights: [1, 1], start_at: T('2026-11-07T00:00:00Z'), end_at: null, source: 'manual', cond: 'General User', exp_id: null, note: null, skey: null }, 'dismissed', now)!
  const v = { now, db, csrf: 't' } as any
  assert.doesNotMatch(runPage(v, getRun(db, did)!), /rc-times/)
  useRcTimes(db, did)
  assert.deepEqual([getRun(db, did)!.status, getRun(db, did)!.start_at], ['dismissed', T('2026-11-07T13:36:01Z')])
})
