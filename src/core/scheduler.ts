// Runs each module's collector on its schedule and keeps its last result in a Slot.
// Rules (tested in test/core.test.ts):
//  - a run never overlaps the previous run of the same module;
//  - a run that passes the module's timeout is aborted (ctx.signal) and recorded as an error;
//  - a failed run keeps the previous data on screen (dataAt stays at the last success);
//  - one module failing or hanging never affects another;
//  - a run that throws NotConfigured is recorded as `unset`, not as a failure.
// After a run it records notifications (lib/notify.ts, once a day each): the module's "Gấp" alerts (tone bad), and
// the collector itself when it failed twice in a row (test/notify.test.ts).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { notify } from '../lib/notify.ts'
import { brief, cut } from './html.ts'
import { log } from './log.ts'
import type { Module, Slot, View } from './types.ts'

export type State = Record<string, Slot>

export function loadState(file: string): State {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return {} }
}

export function saveState(file: string, state: State, known?: Set<string>) {
  // never throws: it runs after every collector, and a rejection there (disk full) would kill the process
  try {
    // `npm run once <id>` beside the daemon writes newer slots: keep them instead of overwriting (and show them)
    const disk = loadState(file)
    for (const k of new Set([...Object.keys(state), ...Object.keys(disk)])) {
      if (known && !known.has(k)) continue // a removed module stays removed
      if ((disk[k]?.at ?? 0) > (state[k]?.at ?? 0)) state[k] = disk[k]
    }
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp` // `npm run once` may run beside the daemon
    writeFileSync(tmp, JSON.stringify(state))
    renameSync(tmp, file)
  } catch (e) { log('warn', 'snapshot save failed', { err: (e as Error).message }) }
}

/** Next time a daily 'HH:MM' (local time) schedule is due, strictly after `from`. */
export function nextDaily(hhmm: string, from: number) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(from); d.setHours(h, m, 0, 0)
  if (d.getTime() <= from) d.setDate(d.getDate() + 1)
  return d.getTime()
}

/** Whether a daily module missed its last slot (e.g. the Mac was off at 07:30) and must catch up now. */
export function dailyMissed(hhmm: string, lastAt: number | undefined, now: number) {
  const prev = nextDaily(hhmm, now) - 86_400_000
  return !lastAt || lastAt < prev
}

export class Scheduler {
  private busy = new Set<string>()
  private timers: NodeJS.Timeout[] = []
  next: Record<string, number> = {}

  readonly modules: Module[]; readonly state: State; readonly db: DatabaseSync; readonly onChange: () => void
  constructor(modules: Module[], state: State, db: DatabaseSync, onChange: () => void = () => {}) {
    this.modules = modules; this.state = state; this.db = db; this.onChange = onChange
  }

  /** Run one module's collector now. Resolves when it has settled (or timed out). */
  async run(m: Module): Promise<void> {
    if (!m.collect || this.busy.has(m.id)) return
    this.busy.add(m.id)
    const prev = this.state[m.id], at = Date.now(), ac = new AbortController(), failedBefore = !!prev?.at && prev.ok === false && !prev.unset
    if (m.daily) { this.state[m.id] = { ...this.state[m.id], triedAt: at } as Slot; this.onChange() }
    const ms = (m.timeout ?? 60) * 1000
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { ac.abort(new Error(`timeout ${ms / 1000}s`)); reject(new Error(`timeout ${ms / 1000}s`)) }, ms)
    })
    let settled = false
    // .then(): a collector that throws synchronously becomes a rejected run, not a stuck busy flag
    const work = Promise.resolve().then(() => m.collect!({ now: at, signal: ac.signal, db: this.db }))
      .finally(() => { settled = true })
    try {
      const data = await Promise.race([work, timeout])
      this.state[m.id] = { ok: true, at, dataAt: at, ms: Date.now() - at, data, ...(m.daily ? { triedAt: at } : {}) }
    } catch (e) {
      // keep the last good data, marked stale by dataAt
      const err = e instanceof Error ? e.message : String(e)
      // NotConfigured (types.ts): this copy has not set the source up. Recorded, never a failure, never notified.
      // By name, not instanceof: a copy of the class (two module graphs) must count too. Only for a source that never
      // produced data: one that worked and lost its login (firebase logout, key file moved) is a failure (review 11/11)
      const unset = (e as Error)?.name === 'NotConfigured' && !prev?.dataAt ? err : undefined
      this.state[m.id] = { ...this.state[m.id], ok: false, at, ms: Date.now() - at, error: err, unset }
      if (unset) { if (prev?.unset !== unset) log('info', 'collector not configured', { module: m.id, err }) }
      else log('warn', 'collector failed', { module: m.id, err })
      if (failedBefore && !unset) this.note(m, () => notify(this.db, { key: `collector:${m.id}`, title: `${m.title} lỗi hai lần liền`, body: cut(brief(err), 300), url: '/ops#health', tone: 'warn' }))
    } finally {
      clearTimeout(timer)
      this.onChange()
      this.noteUrgent(m)
      // a collector that ignores the abort signal still holds its slot until it really ends: no overlap
      if (settled) this.busy.delete(m.id)
      else work.catch(() => {}).finally(() => this.busy.delete(m.id))
    }
  }

  /** A notification must never fail a run. */
  private note(m: Module, f: () => void) {
    try { f() } catch (e) { log('warn', 'notify failed', { module: m.id, err: (e as Error).message }) }
  }

  /** The module's "Gấp" lines (alerts with tone bad) become notifications. Digits are left out of the key, so a figure
   *  that moves ("crash-free 98,9%" then "98,7%") does not ring again the same day; the link is in it, so two alerts
   *  told apart only by a number ("paywall 2", "paywall 3") each ring. */
  private noteUrgent(m: Module) {
    if (!m.alerts || this.state[m.id]?.unset) return // not set up: its old data rings nothing
    this.note(m, () => {
      const v: View = { now: Date.now(), db: this.db, csrf: '', slot: <D,>(id: string) => this.state[id] as Slot<D> | undefined }
      for (const a of m.alerts!(this.state[m.id], v)) {
        if (a.tone !== 'bad') continue
        const i = a.text.indexOf(': '), src = i > 0 && i < 40 ? a.text.slice(0, i) : '' // "XRemote: …", as Hôm nay shows it
        notify(this.db, { key: `alert:${m.id}:${a.href ?? ''}:${a.text.replace(/\d+(?:[.,]\d+)*/g, '#')}`, title: `Gấp: ${src || m.title}`, body: src ? a.text.slice(i + 2) : a.text, url: a.href ?? '/', tone: 'bad' })
      }
    })
  }

  start() {
    for (const m of this.modules) {
      if (!m.collect) continue
      if (m.daily) {
        const plan = () => {
          const at = nextDaily(m.daily!, Date.now()); this.next[m.id] = at
          // a ~24 h timer can fire a few ms before the wall clock reaches `at`; a run set right after 00:00 UTC (07:00 VN)
          // would then still see yesterday as "today" and drop it, so wait out the remainder first
          const fire = () => { if (Date.now() < at) this.timers.push(setTimeout(fire, at - Date.now())); else void this.run(m).finally(plan) }
          this.timers.push(setTimeout(fire, at - Date.now()))
        }
        // keyed on the last ATTEMPT: a daily run that failed is not retried on every restart (each Databuckets
        // call costs ~100 s and a saved chat on their side; owner rule: never retry automatically)
        const s = this.state[m.id]
        // a daily slot left "not set up" runs again at start: the person may have just filled data/config.json, and
        // every NotConfigured is thrown before any external call
        if (s?.unset || dailyMissed(m.daily, Math.max(s?.triedAt ?? 0, s?.at ?? 0) || undefined, Date.now())) void this.run(m)
        plan()
      } else if (m.every) {
        void this.run(m)
        this.next[m.id] = Date.now() + m.every * 1000
        this.timers.push(setInterval(() => { this.next[m.id] = Date.now() + m.every! * 1000; void this.run(m) }, m.every * 1000))
      }
    }
  }

  stop() { for (const t of this.timers) clearTimeout(t) }
}
