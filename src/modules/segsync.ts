// Segment sync (D27): every morning, campaigns of one ad network that Databuckets saw in the last 7 days and that one
// segment of the app's `user_segments` RC parameter lacks are appended to it and published with rc.py. The only module
// that writes to a source: it only appends ids, never removes one, never touches another segment or parameter.
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import { APPS, DATA, DATASET, RC_DIR, rcKeyPath, SEGMENT_SYNC } from '../config.ts'
import { ago, cut, empty, esc, pill, section, stale } from '../core/html.ts'
import { NotConfigured, type Alert, type Module, type Tone } from '../core/types.ts'
import { runEql, type Row } from '../lib/databuckets.ts'
import { notify, noteDay } from '../lib/notify.ts'

const run = promisify(execFile)
const PARAM = 'user_segments'
const RC_PY = join(RC_DIR, 'rc.py')
const DIR = join(DATA, 'segsync')
// more new campaigns than this in one run looks like a broken query, not a launch: hold and ask the owner
export const MAX_NEW = 20
// Google Ads campaign ids. The only network set up so far; another one needs its own pattern
const ID_RE = /^\d{10,11}$/
const COLS = ['ua_campaign_id', 'ua_campaign', 'users']

export type Campaign = { id: string; name: string; users: number }
type Status = 'none' | 'held' | 'published' | 'failed'
export type Run = { at: number; status: Status; add: Campaign[]; total: number; seen: number; version?: number | null; why?: string; cmd?: string; error?: string }

// app_id is the Android package, so this already leaves iOS out (owner 16/11: Android only)
const eql = (pkg: string, mediaSource: string) =>
  `select ua_campaign_id, ua_campaign, count_distinct(user_pseudo_id) as users from ${DATASET} where app_id in ('${pkg}') regex_off and event_name in ('ua_conversion_data') regex_off and ua_media_source in ('${mediaSource}') regex_off since 7 days ago boost user_pseudo_id str 10`

/** Campaigns to append: ids of the network's format, with at least one user, that the segment lacks; most users first. */
export function pickNew(rows: Row[], have: Set<string>): Campaign[] {
  const out = new Map<string, Campaign>()
  for (const r of rows) {
    const id = String(r.ua_campaign_id ?? '').trim(), users = Number(r.users) || 0
    if (!ID_RE.test(id) || users < 1 || have.has(id)) continue
    const c = out.get(id)
    if (c) c.users += users // a renamed campaign: one row per name
    else out.set(id, { id, name: String(r.ua_campaign ?? ''), users })
  }
  return [...out.values()].sort((a, b) => b.users - a.users)
}

function rules(value: string, segment: string) {
  const list = JSON.parse(value)
  if (!Array.isArray(list)) throw new Error(`${PARAM} không phải mảng JSON`)
  const rule = list.find(r => r?.segment === segment)
  if (!rule) throw new Error(`${PARAM} không có segment ${segment}`)
  if (!Array.isArray(rule.campaign_id ??= [])) throw new Error(`${segment}.campaign_id không phải mảng`)
  return { list, rule }
}
/** The segment's campaign ids in the parameter's value. Throws when the value is not the rule list we expect. */
export const segmentIds = (value: string, segment: string): string[] => rules(value, segment).rule.campaign_id.map(String)
/** `value` with `ids` appended to the segment: every other rule and field stays as it was. */
export function appendIds(value: string, segment: string, ids: string[]) {
  const { list, rule } = rules(value, segment)
  rule.campaign_id = [...rule.campaign_id, ...ids.filter(id => !rule.campaign_id.includes(id))]
  return JSON.stringify(list)
}

async function rcpy(args: string[], key: string, signal: AbortSignal) {
  const { stdout } = await run('python3', [RC_PY, ...args], { env: { ...process.env, TV_RC_KEY: key }, signal, maxBuffer: 16 << 20 })
  return stdout
}
async function liveValue(key: string, signal: AbortSignal) {
  const v = JSON.parse(await rcpy(['get', PARAM], key, signal))?.defaultValue?.value
  if (typeof v !== 'string') throw new Error(`${PARAM} không có giá trị mặc định`)
  return v
}

function save(db: DatabaseSync, r: Run) {
  db.prepare('insert into segsync_runs (at, status, added, total, seen, version, why, cmd, error) values (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(r.at, r.status, JSON.stringify(r.add), r.total, r.seen, r.version ?? null, r.why ?? null, r.cmd ?? null, r.error ?? null)
  return r
}
const history = (db: DatabaseSync, n: number) => (db.prepare('select * from segsync_runs order by id desc limit ?').all(n) as any[])
  .map(x => ({ ...x, add: JSON.parse(x.added) as Campaign[] }) as Run)

const names = (cs: Campaign[]) =>
  cs.map(c => `${c.id} ${cut(c.name, 50)} (${c.users} user)`).join('; ')

const TONE: Record<Status, [Tone, string]> = { none: ['mute', 'không có campaign mới'], held: ['warn', 'chờ publish'], published: ['ok', 'đã publish'], failed: ['bad', 'lỗi'] }

export const segsync: Module<Run> = {
  id: 'segsync', title: 'Segment theo network', group: 'ops', daily: '07:05', timeout: 15 * 60, // runEql may wait 10 min, then rc.py

  init(db) {
    db.exec(`create table if not exists segsync_runs (id integer primary key, at integer not null, status text not null,
      added text not null, total integer not null, seen integer not null default 0, version integer, why text, cmd text, error text)`)
  },

  async collect({ db, signal, now }) {
    const cfg = SEGMENT_SYNC
    if (!cfg) throw new NotConfigured('chưa có segmentSync trong data/config.json')
    const app = APPS.find(a => a.key === cfg.app)
    if (!app) throw new NotConfigured(`segmentSync.app "${cfg.app}" không có trong apps`)
    const key = rcKeyPath(app)
    if (!key || !existsSync(key)) throw new NotConfigured(`app ${app.key} chưa có file key Remote Config (rcKey)`)
    if (!existsSync(RC_PY)) throw new NotConfigured(`không thấy ${RC_PY}`)
    if (!DATASET) throw new NotConfigured('chưa có databucketsDataset')

    const [r] = await runEql([{ eql: eql(app.pkg, cfg.mediaSource), cols: COLS }], signal)
    const before = await liveValue(key, signal)
    const have = segmentIds(before, cfg.segment)
    const add = pickNew(r.rows, new Set(have))
    // seen: campaigns Databuckets returned; 0 every day would mean the query broke, not that no campaign runs
    const base = { at: now, add, total: have.length, seen: new Set(r.rows.map(x => x.ua_campaign_id)).size }
    if (!add.length) return save(db, { ...base, status: 'none' })

    mkdirSync(DIR, { recursive: true })
    const file = join(DIR, `${PARAM}-${noteDay(now)}.json`)
    writeFileSync(file, appendIds(before, cfg.segment, add.map(c => c.id)))
    const cmd = `TV_RC_KEY=${key} ${RC_PY} set ${PARAM} --file ${file} --yes`
    const why = cfg.autoPublish === false ? 'autoPublish tắt' : add.length > MAX_NEW ? `${add.length} campaign mới, quá ngưỡng ${MAX_NEW}` : ''
    if (why) {
      notify(db, { key: 'segsync:held', tone: 'warn', url: '/ops#segsync', title: `${add.length} campaign mới chờ thêm vào ${cfg.segment}`, body: `${why}. ${names(add)}` }, now)
      return save(db, { ...base, status: 'held', why, cmd })
    }
    try {
      // ponytail: rc.py re-reads the template, so a change to this one parameter in the few seconds since liveValue is
      // overwritten. Append inside rc.py if anyone else ever edits user_segments by script.
      if (!(await rcpy(['set', PARAM, '--file', file], key, signal)).includes('validate-only OK')) throw new Error('rc.py: kiểm thử không qua')
      const out = await rcpy(['set', PARAM, '--file', file, '--yes'], key, signal)
      const version = Number(/PUBLISHED -> version (\d+)/.exec(out)?.[1]) || null
      const after = new Set(segmentIds(await liveValue(key, signal), cfg.segment))
      const missing = add.filter(c => !after.has(c.id))
      if (missing.length) throw new Error(`đã publish nhưng RC vẫn thiếu ${missing.length} ID: ${missing.map(c => c.id).join(', ')}`)
      notify(db, { key: 'segsync:published', url: '/ops#segsync', title: `Đã thêm ${add.length} campaign vào ${cfg.segment}${version ? ` (RC v${version})` : ''}`, body: names(add) }, now)
      return save(db, { ...base, status: 'published', version })
    } catch (e) {
      if (signal.aborted) throw e
      const error = cut((e as Error).message, 300)
      notify(db, { key: 'segsync:failed', tone: 'warn', url: '/ops#segsync', title: `Không thêm được campaign vào ${cfg.segment}`, body: `${error}. Lệnh tự chạy: ${cmd}` }, now)
      save(db, { ...base, status: 'failed', cmd, error })
      throw e
    }
  },

  panel(s, v) {
    const runs = history(v.db, 7)
    const note = SEGMENT_SYNC ? `${SEGMENT_SYNC.mediaSource} → ${SEGMENT_SYNC.segment}` : ''
    if (!runs.length) return section(this.title, stale(s, v.now) + empty('Chưa chạy lần nào. Chạy lúc 07:05.'), note, 'segsync')
    const [last, ...older] = runs
    const [tone, word] = TONE[last.status]
    const head = `<p>${pill(tone, word)}${last.version ? ` RC v${esc(last.version)}` : ''} <span class="muted">${esc(ago(last.at, v.now))}, Databuckets thấy ${esc(last.seen)} campaign trong 7 ngày, segment có ${esc(last.total)} ID trước lần chạy</span></p>`
    const adds = last.add.length ? `<ul class="list">${last.add.map(c => `<li><code>${esc(c.id)}</code> ${esc(cut(c.name, 60))} <span class="muted">${esc(c.users)} user</span></li>`).join('')}</ul>` : ''
    const extra = (last.why ? `<p class="sub warn-t">${esc(last.why)}</p>` : '') + (last.error ? `<p class="sub bad-t">${esc(last.error)}</p>` : '')
      + (last.cmd && last.status !== 'published' ? `<p class="sub">Lệnh để tự chạy:</p><pre><code>${esc(last.cmd)}</code></pre>` : '')
    const past = older.length ? `<p class="sub muted">Trước đó: ${older.map(r => `${esc(ago(r.at, v.now))} ${esc(TONE[r.status][1])}${r.add.length ? ` (${r.add.length})` : ''}`).join(' · ')}</p>` : ''
    return section(this.title, stale(s, v.now) + head + adds + extra + past, note, 'segsync')
  },

  alerts(_s, v): Alert[] {
    const [last] = history(v.db, 1)
    if (!last || v.now - last.at > 2 * 86_400_000 || (last.status !== 'held' && last.status !== 'failed')) return []
    return [{ tone: 'warn', href: '/ops#segsync', label: last.status === 'failed' ? 'Lỗi' : undefined,
      text: `${last.add.length} campaign mới chưa vào segment: ${last.why || last.error || ''}` }]
  },
}
