// One SQLite file for everything that needs history or is written by the owner (report series, tasks,
// A/B registry, browser jobs). Each module creates and owns its tables, named `<moduleId>_<thing>`.
// WAL lets the hub and the Develop runner (a separate process) use it at the same time.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATA } from '../config.ts'

export function openDb(file = join(DATA, 'hub.db')) {
  if (file !== ':memory:') mkdirSync(DATA, { recursive: true })
  const db = new DatabaseSync(file)
  db.exec('pragma journal_mode = wal; pragma busy_timeout = 5000; pragma foreign_keys = on;')
  return db
}
