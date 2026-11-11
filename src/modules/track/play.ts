// T3: release history from Play Console (rollout % and when), read from the console's own page in the `falcon` Chrome
// profile through the bridge (no API we may use: owner rules R1/R2), once a day, read-only. Nobody has seen this page
// through the extension yet: the page text is saved as a sample (data/bridge-samples, chmod 600) and the parser is
// best-effort; until it reads a rollout with a time the page says "cần hiệu chỉnh". Calibrate from the first sample.
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { APPS, DATA, PROFILE_LABELS } from '../../config.ts'
import { bridgePage, loggedOut, type PageResult } from '../../lib/bridge.ts'

export type Step = { version: string; pct: number; at: number | null }
export type PlayApp = { app: string; steps: Step[]; sample?: string; error?: string }

function sample(name: string, p: PageResult) {
  const dir = join(DATA, 'bridge-samples')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const f = join(dir, `${name}.txt`)
  writeFileSync(f, `${p.finalUrl}\n${p.title}\n\n${p.text}\n\n--- links ---\n${p.links.map(l => l.join(' | ')).join('\n')}`, { mode: 0o600 })
  chmodSync(f, 0o600)
  return f
}

/** The console path of an app ("/developers/…/app/…") on its developer's app list: the n-th package line in the text
 *  pairs with the n-th app-dashboard link (the same layout consoles.ts reads; nothing when the counts differ). */
export function appPath(p: Pick<PageResult, 'text' | 'links'>, dev: string, pkg: string) {
  const pkgs = p.text.split('\n').map(l => l.trim()).filter(l => /^[a-zA-Z]\w*(\.\w+){2,}$/.test(l))
  const links = p.links.map(([href]) => href.match(new RegExp(`/developers/${dev}/app/\\d+(?=/app-dashboard)`))?.[0]).filter(Boolean) as string[]
  const i = pkgs.indexOf(pkg)
  return i >= 0 && pkgs.length === links.length ? links[i] : null
}

const MON: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 }
/** A date (and time) as the console prints it, English or Vietnamese, read as Vietnam time:
 *  "Nov 7, 2026, 10:23 AM", "7 thg 11, 2026 10:23", "07/11/2026 10:23". Null when there is none. */
export function playTime(s: string): number | null {
  let y: number, mo: number, d: number
  const en = s.match(/\b([A-Z][a-z]{2})[a-z]* (\d{1,2}), (\d{4})/), vi = s.match(/\b(\d{1,2}) (?:thg|tháng) (\d{1,2}),? (\d{4})/), num = s.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})/)
  if (en && MON[en[1].toLowerCase()] != null) [y, mo, d] = [Number(en[3]), MON[en[1].toLowerCase()], Number(en[2])]
  else if (vi) [y, mo, d] = [Number(vi[3]), Number(vi[2]) - 1, Number(vi[1])]
  else if (num) [y, mo, d] = [Number(num[3]), Number(num[2]) - 1, Number(num[1])]
  else return null
  const t = s.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM|SA|CH)?/i)
  let h = t ? Number(t[1]) : 0
  if (t?.[3] && /PM|CH/i.test(t[3]) && h < 12) h += 12
  if (t?.[3] && /AM|SA/i.test(t[3]) && h === 12) h = 0
  return Date.UTC(y, mo, d, h - 7, t ? Number(t[2]) : 0)
}

/** Rollout steps in the release page text, best-effort: a block that names a version ("1.0.17" or "17 (1.0.17)") and a
 *  percentage of users, with the date written in the same block. Exported for tests; calibrate on the saved sample. */
export function parseSteps(text: string): Step[] {
  const out: Step[] = []
  const blocks = text.normalize('NFC').split(/\n\s*\n/)
  for (const b of blocks) {
    const v = b.match(/\b(\d+\.\d+\.\d+)\b/)?.[1]
    const pct = b.match(/(\d{1,3}(?:[.,]\d+)?)\s?%/)?.[1]
    if (!v || pct == null) continue
    const p = Number(pct.replace(',', '.'))
    if (!(p > 0 && p <= 100) || out.some(s => s.version === v && s.pct === p)) continue
    out.push({ version: v, pct: p, at: playTime(b) })
  }
  return out
}

/** Read each app's production track page. Console paths are cached (they do not change); a failing page costs only its app. */
export async function readPlay(db: DatabaseSync, signal: AbortSignal, paths: Map<string, string>): Promise<PlayApp[]> {
  const out: PlayApp[] = []
  const lists = new Map<string, PageResult | Error>()
  const page = async (url: string) => { try { return await bridgePage(db, 'falcon', url, signal, undefined, 120_000) } catch (e) { if (signal.aborted) throw e; return e instanceof Error ? e : new Error(String(e)) } }
  for (const a of APPS) {
    const dev = a.playDev // the app's Play developer account (config): none, no release history
    if (!dev) continue
    let path = paths.get(a.key) ?? null
    if (!path) {
      if (!lists.has(dev)) lists.set(dev, await page(`https://play.google.com/console/u/0/developers/${dev}/app-list`))
      const list = lists.get(dev)!
      if (list instanceof Error) { out.push({ app: a.key, steps: [], error: list.message }); continue }
      if (loggedOut(list.finalUrl)) throw new Error(`${PROFILE_LABELS.falcon} chưa đăng nhập Play Console`)
      path = appPath(list, dev, a.pkg)
      if (!path) { out.push({ app: a.key, steps: [], sample: sample(`play-app-list-${dev}`, list), error: 'không tìm thấy app trong danh sách (cần hiệu chỉnh)' }); continue }
      paths.set(a.key, path)
    }
    const p = await page(`https://play.google.com/console/u/0${path}/tracks/production`)
    if (p instanceof Error) { out.push({ app: a.key, steps: [], error: p.message }); continue }
    if (loggedOut(p.finalUrl)) throw new Error(`${PROFILE_LABELS.falcon} chưa đăng nhập Play Console`)
    const f = sample(`play-releases-${a.key}`, p), steps = parseSteps(p.text)
    out.push({ app: a.key, steps, sample: f, error: steps.some(s => s.at != null) ? undefined : 'đọc được trang nhưng chưa nhận ra % rollout kèm giờ (cần hiệu chỉnh)' })
  }
  return out
}
