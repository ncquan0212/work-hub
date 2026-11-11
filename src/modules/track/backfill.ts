// One-off: fill Theo dõi with the last 5 install days (2 Databuckets calls; 8 days went over 1,000 rows). Retention D7 per group
// appears after a week of daily runs.   npm run track:backfill
import { openDb } from '../../core/db.ts'
import { runEql } from '../../lib/databuckets.ts'
import { initStore, saveRan, saveTFacts } from './index.ts'
import { coveredDays, queries, toTFacts, type Dim } from './queries.ts'

const db = openDb(); initStore(db)
const now = Date.now(), signal = AbortSignal.timeout(20 * 60_000)
let failed = 0
const only = process.argv.slice(2)
for (const dim of (['ver', 'exp'] as Dim[]).filter(d => !only.length || only.includes(d))) {
  try {
    const qs = queries(dim, 6), res = await runEql(qs.map(q => ({ eql: q.eql, cols: q.cols })), signal)
    const facts = res.flatMap((r, i) => toTFacts(dim, qs[i].kind, r.rows, now))
    saveTFacts(db, facts); saveRan(db, dim, coveredDays(res[1].rows, now)); console.log(`ok ${dim}: ${facts.length} facts`)
  } catch (e) { failed++; console.log(`ERR ${dim}: ${(e as Error).message}`) }
}
db.close()
process.exit(failed ? 1 : 0)
