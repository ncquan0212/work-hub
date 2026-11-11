// work-hub runner: a separate service (launchd com.work-hub.runner) that runs the Develop board's AI turns. The hub
// only writes rows (tasks, messages, queued turns); this process picks queued turns, runs the AI's CLI (lib/claude.ts:
// `claude -p` with its permissions), streams progress into develop_activity and writes the reply back as a message.
// Restarting the hub never kills a turn.
//   node src/runner/main.ts            run forever
//   node src/runner/main.ts once       start what is queued, wait for it, exit (manual check)
import { join } from 'node:path'
import { CODE, ENABLED, REPOS } from '../config.ts'
import { openDb } from '../core/db.ts'
import { log } from '../core/log.ts'
import { ai } from '../modules/develop/prompts.ts'
import { initStore } from '../modules/develop/store.ts'
import { BEAT_MS, beatRunner, claimRunner, releaseRunner, Runner } from './runner.ts'

if (!ENABLED.has('develop')) { console.error('Module develop đang tắt trong config (modules): runner không có việc gì, thoát.'); process.exit(0) }
let bin: string
try { bin = ai.binary() } catch (e) { console.error((e as Error).message); process.exit(1) }

const db = openDb()
initStore(db)
const other = claimRunner(db)
if (other) { console.error(`runner đang chạy (pid ${other}); thoát.`); process.exit(1) }
process.on('exit', () => { try { releaseRunner(db) } catch { /* db closed */ } })
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => process.exit(0))
setInterval(() => { try { beatRunner(db) } catch (e) { log('warn', 'runner beat failed', { err: (e as Error).message }) } }, BEAT_MS).unref()

const runner = new Runner({ db, repos: REPOS, bin, worktrees: join(CODE, '.hub-worktrees') })

if (process.argv[2] === 'once') {
  await Promise.all(runner.tick())
  releaseRunner(db)
  db.close()
} else {
  log('info', 'runner started', { bin })
  const loop = () => {
    try { for (const p of runner.tick()) p.catch(e => log('warn', 'turn failed', { err: (e as Error).message })) }
    catch (e) { log('warn', 'runner tick failed', { err: (e as Error).message }) }
  }
  setInterval(loop, 3000)
  loop()
}
