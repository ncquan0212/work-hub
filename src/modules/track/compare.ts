// Comparing two groups of new users (two versions, or two A/B arms) over a range of install days.
// Pure functions over stored facts; tested in test/track.test.ts.
import { twoProp } from '../../lib/stats.ts'

/** cohort day → rd → key → value, for one group. */
export type GroupFacts = Map<string, Map<number, Map<string, number>>>

export type CmpDef = { id: string; label: string; num: string; den: string; kind: 'prop' | 'mean'; unit: 'pct' | 'num' | 'usd3'; apps?: string[]; rd?: number }

// D0 metrics follow the owner's insight 75521 (Idol Vesion Insight): rates per new user on install day,
// video/audio/chat rates per user who finished onboarding.
export const CMP: CmpDef[] = [
  { id: 'onboard', label: 'Hoàn thành onboarding (D0)', num: 'complete_onboard.users', den: 'first_open.users', kind: 'prop', unit: 'pct' },
  { id: 'ads', label: 'Ads / user mới (D0)', num: 'ad_revenue.n', den: 'first_open.users', kind: 'mean', unit: 'num' },
  { id: 'ltv0', label: 'LTV ads D0', num: 'ad_revenue.rev', den: 'first_open.users', kind: 'mean', unit: 'usd3' },
  { id: 'paywall', label: 'Thấy paywall (D0)', num: 'iap_purchase_show.users', den: 'first_open.users', kind: 'prop', unit: 'pct' },
  { id: 'buy', label: 'Mua IAP (D0)', num: 'iap_purchase_success.users', den: 'first_open.users', kind: 'prop', unit: 'pct' },
  { id: 'video', label: 'VideoUserRate (D0)', num: 'prank_call_start.video.users', den: 'complete_onboard.users', kind: 'prop', unit: 'pct', apps: ['idol'] },
  { id: 'video_n', label: 'VideoRate: lượt video / user onboarding', num: 'prank_call_start.video.n', den: 'complete_onboard.users', kind: 'mean', unit: 'num', apps: ['idol'] },
  { id: 'audio', label: 'AudioUserRate (D0)', num: 'prank_call_start.audio.users', den: 'complete_onboard.users', kind: 'prop', unit: 'pct', apps: ['idol'] },
  { id: 'chat', label: 'ChatUserRate (D0)', num: 'chat_open.users', den: 'complete_onboard.users', kind: 'prop', unit: 'pct', apps: ['idol'] },
  { id: 'play', label: 'Chơi game (D0)', num: 'enter_game_play.users', den: 'first_open.users', kind: 'prop', unit: 'pct', apps: ['brain'] },
  { id: 'connect', label: 'Kết nối TV (D0)', num: 'remote_tv_connected.users', den: 'first_open.users', kind: 'prop', unit: 'pct', apps: ['xremote', 'xcast'] },
  { id: 'cast', label: 'Cast (D0)', num: 'cast_started.users', den: 'first_open.users', kind: 'prop', unit: 'pct', apps: ['xremote', 'xcast'] },
  // retention per group is NOT valid with grouped queries: both app_version and experiment_group are the
  // value at event time (users update; experiment_group follows the current RC value: Idol users installed on
  // 11-04 in SetC/SetD carried IL2611050 the next day). Kept here for a future funnel-based query; the pages
  // leave them out (noRetention).
  { id: 'd1', label: 'Retention D1', num: 'session_start.users', den: 'first_open.users', kind: 'prop', unit: 'pct', rd: 1 },
  { id: 'd3', label: 'Retention D3', num: 'session_start.users', den: 'first_open.users', kind: 'prop', unit: 'pct', rd: 3 },
  { id: 'd7', label: 'Retention D7', num: 'session_start.users', den: 'first_open.users', kind: 'prop', unit: 'pct', rd: 7 },
]

/** Σ num and Σ den over the install days in [from, to]. Retention counts only cohorts whose day N was
 *  pulled (`ran` = bucket days the query covered; a day not covered is skipped, never read as 0). */
export function totals(g: GroupFacts | undefined, d: CmpDef, from: string, to: string, lastDay: string, ran?: Set<string>) {
  let num = 0, den = 0, days = 0
  const perDay: { day: string; v: number }[] = []
  for (const [day, byRd] of g ?? []) {
    if (day < from || day > to) continue
    const rd = d.rd ?? 0
    if (rd > 0) {
      const due = new Date(Date.parse(day + 'T00:00:00Z') + rd * 86_400_000).toISOString().slice(0, 10)
      if (due > lastDay || (ran && !ran.has(due))) continue
    }
    const dn = byRd.get(0)?.get(d.den) ?? 0
    if (!dn) continue
    const nm = byRd.get(rd)?.get(d.num) ?? 0
    num += nm; den += dn; days++
    perDay.push({ day, v: nm / dn })
  }
  return { num, den, days, value: den ? num / den : null, perDay }
}

/** A vs B on one metric: values, relative change, and evidence (z-test for rates, day-by-day wins for means). */
export function compare(a: GroupFacts | undefined, b: GroupFacts | undefined, d: CmpDef, from: string, to: string, lastDay: string, ran?: Set<string>) {
  const ta = totals(a, d, from, to, lastDay, ran), tb = totals(b, d, from, to, lastDay, ran)
  const lift = ta.value && tb.value != null ? tb.value / ta.value - 1 : null
  let evidence: { p?: number; wins?: number; days?: number } = {}
  if (d.kind === 'prop' && ta.den && tb.den) {
    const z = twoProp(ta.num, ta.den, tb.num, tb.den)
    if (z) evidence = { p: z.p }
  } else {
    const am = new Map(ta.perDay.map(x => [x.day, x.v]))
    const both = tb.perDay.filter(x => am.has(x.day))
    evidence = { wins: both.filter(x => x.v > am.get(x.day)!).length, days: both.length }
  }
  return { a: ta, b: tb, lift, ...evidence }
}

/** Experiment-group values that look like test arms (not the date-coded default labels like IL2611050). */
export function looksLikeArm(v: string) {
  return !!v && !/^(_null_|_empty_|NA|null|undefined|none)$/i.test(v) && !/^[A-Z]{1,3}\d{6,8}$/.test(v)
}
