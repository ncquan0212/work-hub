// work-hub entry point.
//   node src/main.ts            serve: run the collectors on their schedules and serve the pages
//   node src/main.ts once [id…] run collectors once (all scheduled by `every`, or the ids given) and print ok/error
// Setup: docs/setup.md. Architecture: docs/architecture.md. Per-person settings: data/config.json (docs/config.md).
import { join } from 'node:path'
import { ACCESS, DATA, ENABLED } from './config.ts'
import { openDb } from './core/db.ts'
import { log } from './core/log.ts'
import { loadState, saveState, Scheduler } from './core/scheduler.ts'
import { startServer } from './core/server.ts'
import { MODULES as ALL } from './registry.ts'

// Each copy runs the modules its data/config.json names (config.ts DEFAULT_MODULES when it names none).
for (const id of ENABLED) if (!ALL.some(m => m.id === id)) log('warn', 'unknown module in config', { id })
const MODULES = ALL.filter(m => ENABLED.has(m.id))
const SNAP = join(DATA, 'snapshot.json')
const ids = new Set<string>()
for (const m of MODULES) { if (ids.has(m.id)) throw new Error(`duplicate module id ${m.id}`); ids.add(m.id) }

const db = openDb()
for (const m of MODULES) m.init?.(db)
const state = loadState(SNAP)
// a module removed from the registry leaves nothing behind; one switched off in config keeps its last slot, so
// switching it back on does not rerun a daily collector at once (Report: 4 Databuckets calls)
const known = new Set(ALL.map(m => m.id))
for (const k of Object.keys(state)) if (!known.has(k)) delete state[k]
// HUB_PAUSE=report,track pauses those collectors and their own services (pages still render): for a test
// server beside the real one, or to stop one source without editing the registry. HUB_PAUSE=* pauses all, so a
// preview (`PORT=8790 HUB_PAUSE=* node src/main.ts`) only renders pages from the shared data and calls nothing.
const pauseList = (process.env.HUB_PAUSE ?? '').split(',').map(x => x.trim()).filter(Boolean)
const paused = new Set(pauseList.includes('*') ? MODULES.map(m => m.id) : pauseList)
const scheduler = new Scheduler(MODULES.filter(m => !paused.has(m.id)), state, db, () => saveState(SNAP, state, known))

process.on('unhandledRejection', e => log('warn', 'unhandled rejection', { err: String((e as Error)?.stack ?? e).split('\n').slice(0, 3).join(' | ') }))

if (process.argv[2] === 'once') {
  const want = process.argv.slice(3)
  const list = MODULES.filter(m => m.collect && (want.length ? want.includes(m.id) : !!m.every))
  if (want.length && list.length !== want.length) throw new Error(`unknown or switched-off module: ${want.filter(w => !list.some(m => m.id === w)).join(', ')}`)
  await Promise.all(list.map(m => scheduler.run(m)))
  for (const m of list) {
    const s = state[m.id]
    console.log(m.id.padEnd(10), s?.ok ? 'ok ' : s?.unset ? '-- ' : 'ERR', `${s?.ms ?? '-'}ms`, s?.ok ? '' : s?.unset ?? s?.error ?? '')
  }
  db.close()
} else {
  scheduler.start()
  for (const m of MODULES) if (!paused.has(m.id)) m.start?.(db) // a paused bridge must not take port 8788 from the real hub
  startServer({ modules: MODULES, scheduler, db, access: ACCESS })
}
