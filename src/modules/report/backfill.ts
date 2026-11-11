// One-off: fill the Report with the past 35 days. About 10 Databuckets calls (~15 min) + Crashlytics
// per day. Each Databuckets result must stay under 1,000 rows, hence the app pairs and per-app cohorts.
//   npm run report:backfill                 (all)
//   npm run report:backfill -- core cohort  (only jobs whose name contains one of the words)
import { APPS } from '../../config.ts'
import { openDb } from '../../core/db.ts'
import { runEql } from '../../lib/databuckets.ts'
import { crashDays } from './index.ts'
import { COLS, eql, pairs, toCohort, toFacts } from './queries.ts'
import { initStore, saveCohort, saveFacts } from './store.ts'

const DAYS = 36 // 35 complete days + the partial first bucket
const LONG = 480_000 // per call: long ranges take longer than the daily 300 s budget
const RDS = [0, 1, 2, 3, 4, 5, 6, 7, 14, 30] // enough for LTV D7 and retention D1/3/7/14/30
const db = openDb(); initStore(db)
const signal = AbortSignal.timeout(60 * 60_000)
const now = Date.now()
const t0 = Date.now()
const say = (m: string) => console.log(`${Math.round((Date.now() - t0) / 1000)}s ${m}`)
const keys = APPS.map(a => a.key)
if (!keys.length) { console.log('chưa có app trong data/config.json'); process.exit(1) }

const jobs: [string, () => Promise<number>][] = [
  ...pairs(keys).flatMap((pair): [string, () => Promise<number>][] => [
    [`core ${pair}`, async () => { const [r] = await runEql([{ eql: eql.core(DAYS, pair), cols: COLS.core }], signal, LONG); const f = toFacts('core', r.rows, now, pair); saveFacts(db, f); return f.length }],
    [`app events ${pair}`, async () => { const [r] = await runEql([{ eql: eql.appEvents(DAYS, pair), cols: COLS.appEvents }], signal, LONG); const f = toFacts('appEvents', r.rows, now, pair); saveFacts(db, f); return f.length }],
  ]),
  // separate calls: together they outlived 300 s over 36 days (2026-11-08)
  ['formats', async () => { const [f] = await runEql([{ eql: eql.formats(DAYS), cols: COLS.formats }], signal, LONG); const facts = toFacts('formats', f.rows, now); saveFacts(db, facts); return facts.length }],
  ...(keys.includes('idol') ? [['idol video', async () => { const [m] = await runEql([{ eql: eql.idolModes(DAYS), cols: COLS.idolModes }], signal, LONG); const facts = toFacts('idolModes', m.rows, now, ['idol']); saveFacts(db, facts); return facts.length }] as [string, () => Promise<number>]] : []),
  ...keys.map((app): [string, () => Promise<number>] => [`cohort ${app}`, async () => {
    const [r] = await runEql([{ eql: eql.cohort(DAYS, RDS, [app]), cols: COLS.cohort }], signal, LONG); const c = toCohort(r.rows, now, RDS, [app]); saveCohort(db, c); return c.length
  }]),
  ['crashlytics 35 days', () => crashDays(db, now, 35, signal)],
]

// optional filter: `npm run report:backfill -- core cohort` runs only the jobs whose name contains a word
const only = process.argv.slice(2)
let failed = 0
for (const [name, f] of jobs.filter(([n]) => !only.length || only.some(w => n.includes(w)))) {
  say(`… ${name}`)
  try { say(`ok ${name}: ${await f()} rows`) } catch (e) { failed++; say(`ERR ${name}: ${(e as Error).message}`) }
}
db.close()
say(failed ? `xong, ${failed} phần lỗi (chạy lại được, dữ liệu ghi đè)` : 'xong')
process.exit(failed ? 1 : 0)
