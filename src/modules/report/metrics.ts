// What the Report shows, as data. A daily metric is Σnum (÷ Σden) over stored facts; the moving
// averages then sum numerators and denominators over the window (lib/stats.ts). To add a metric: add a
// line here (and, if it needs a new fact, a column or event in queries.ts).
import type { Pt } from '../../lib/stats.ts'

export type Unit = 'int' | 'num' | 'pct' | 'usd' | 'usd3' | 'sec' | 'min'
type Term = string | [string, number] // fact key, weight (default 1)

export type MetricDef = {
  id: string; label: string; unit: Unit; group: 'user' | 'biz' | 'ads' | 'tech' | 'app'
  num: Term[]; den?: Term[]; scale?: number
  apps?: string[]          // only for these apps (default all)
  base?: string            // fact that says "this day has data" (default session_start.users)
  note?: string
  key?: boolean            // shown in the summary table and on Hôm nay
}

const FMT = ['inters', 'native', 'banner', 'open', 'reward']
const FMT_LABEL: Record<string, string> = { inters: 'interstitial', native: 'native', banner: 'banner', open: 'app open', reward: 'rewarded' }
const IAP: Term[] = ['iap_sub_new_success.usd', 'iap_renew_success.usd', 'iap_product_new_success.usd', ['iap_sub_refund_success.usd', -1], ['iap_product_refund_success.usd', -1]]

export const METRICS: MetricDef[] = [
  // Người dùng
  { id: 'dau', label: 'DAU', unit: 'int', group: 'user', num: ['session_start.users'], key: true, note: 'user khác nhau có session_start' },
  { id: 'new', label: 'User mới', unit: 'int', group: 'user', num: ['first_open.users'], key: true },
  { id: 'sess', label: 'Session / DAU', unit: 'num', group: 'user', num: ['session_start.n'], den: ['session_start.users'] },
  { id: 'onboard', label: 'Hoàn thành onboarding', unit: 'pct', group: 'user', num: ['complete_onboard.users'], den: ['first_open.users'],
    note: 'user complete_onboard ÷ user mới; Idol ngoài Tier1 không gửi event này' },
  // Kinh doanh
  { id: 'iaa', label: 'Doanh thu ads', unit: 'usd', group: 'biz', num: ['ad_revenue.rev'], key: true, note: 'sum(revenue) của ad_revenue, ước tính từ SDK' },
  { id: 'iap', label: 'Doanh thu IAP', unit: 'usd', group: 'biz', num: IAP, note: 'event server, đã trừ refund; chỉ Android' },
  { id: 'arpdau', label: 'ARPDAU', unit: 'usd3', group: 'biz', num: ['ad_revenue.rev', ...IAP], den: ['session_start.users'], key: true },
  { id: 'arpdau_ads', label: 'ARPDAU ads', unit: 'usd3', group: 'biz', num: ['ad_revenue.rev'], den: ['session_start.users'] },
  { id: 'paywall', label: 'Thấy paywall', unit: 'pct', group: 'biz', num: ['iap_purchase_show.users'], den: ['session_start.users'] },
  { id: 'paywall_cr', label: 'Mua / thấy paywall', unit: 'pct', group: 'biz', num: ['iap_purchase_success.users'], den: ['iap_purchase_show.users'] },
  // Ads
  { id: 'reach', label: 'DAU thấy ads', unit: 'pct', group: 'ads', num: ['ad_revenue.users'], den: ['session_start.users'] },
  { id: 'imps', label: 'Ads / DAU', unit: 'num', group: 'ads', num: ['ad_revenue.n'], den: ['session_start.users'], note: 'đếm ad_revenue, không đếm ads_show' },
  { id: 'ecpm', label: 'eCPM', unit: 'usd', group: 'ads', num: ['ad_revenue.rev'], den: ['ad_revenue.n'], scale: 1000 },
  ...FMT.flatMap((f): MetricDef[] => [
    { id: `imps_${f}`, label: `Ads / DAU (${FMT_LABEL[f]})`, unit: 'num', group: 'ads', num: [`fmt.${f}.n`], den: ['session_start.users'], base: 'fmt._ran' },
    { id: `ecpm_${f}`, label: `eCPM (${FMT_LABEL[f]})`, unit: 'usd', group: 'ads', num: [`fmt.${f}.rev`], den: [`fmt.${f}.n`], scale: 1000, base: 'fmt._ran' },
    { id: `share_${f}`, label: `Tỉ trọng doanh thu (${FMT_LABEL[f]})`, unit: 'pct', group: 'ads', num: [`fmt.${f}.rev`], den: FMT.map(x => `fmt.${x}.rev`), base: 'fmt._ran' },
  ]),
  // Kỹ thuật (Crashlytics, FATAL only)
  { id: 'crash_free', label: 'Crash-free user', unit: 'pct', group: 'tech', num: ['crash.total', ['crash.users', -1]], den: ['crash.total'], base: 'crash.total', key: true },
  { id: 'anr', label: 'User bị ANR', unit: 'pct', group: 'tech', num: ['anr.users'], den: ['crash.total'], base: 'crash.total' },

  // Riêng từng app (plan 3b)
  { id: 'play', label: 'DAU chơi game', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['brain'], num: ['enter_game_play.users'], den: ['session_start.users'] },
  { id: 'levels', label: 'Level / người chơi', unit: 'num', group: 'app', base: 'ev._ran', apps: ['brain'], num: ['game_level_stats.n'], den: ['game_level_stats.users'] },
  { id: 'play_min', label: 'Phút chơi / người chơi', unit: 'min', group: 'app', base: 'ev._ran', apps: ['brain'], num: ['game_level_stats.play'], den: ['game_level_stats.users'], scale: 1 / 60 },
  { id: 'test', label: 'DAU làm test', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['brain'], num: ['enter_test_play.users'], den: ['session_start.users'] },
  { id: 'daily_task', label: 'DAU xong bài tập ngày', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['brain'], num: ['complete_game_3_daily_task.users'], den: ['session_start.users'] },

  { id: 'video_dau', label: 'DAU gọi video', unit: 'pct', group: 'app', base: 'mode._ran', apps: ['idol'], num: ['prank_call_start.video.users'], den: ['session_start.users'],
    note: 'mẫu DAU. Định nghĩa của insight 75521 (mẫu user onboarding D0, theo version) nằm ở Theo dõi. Chỉ Tier1' },
  { id: 'video_calls', label: 'Lượt gọi video / người gọi', unit: 'num', group: 'app', base: 'mode._ran', apps: ['idol'], num: ['prank_call_start.video.n'], den: ['prank_call_start.video.users'] },
  { id: 'answer', label: 'Nghe máy / lượt gọi', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['prank_call_answer.n'], den: ['prank_call_start.n'] },
  { id: 'call_s', label: 'Giây mỗi cuộc gọi', unit: 'sec', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['prank_call_end.dur'], den: ['prank_call_end.n'], note: 'mọi kết quả kết thúc' },
  { id: 'chat', label: 'DAU mở chat', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['chat_open.users'], den: ['session_start.users'], note: 'chỉ Tier1' },
  { id: 'surprise', label: 'Nhận surprise / hiện surprise', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['surprise_accept.n'], den: ['surprise_show.n'] },
  { id: 'screen_call', label: 'DAU vào màn gọi (mọi nước)', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['enter_screen_call.users'], den: ['session_start.users'],
    note: 'số thay thế ngoài Tier1 (owner chốt 08/11); không tách video/audio' },
  { id: 'screen_chat', label: 'DAU vào màn chat (mọi nước)', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['idol'], num: ['enter_screen_chat.users'], den: ['session_start.users'] },

  { id: 'connect', label: 'DAU kết nối TV', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['xremote', 'xcast'], num: ['remote_tv_connected.users'], den: ['session_start.users'] },
  { id: 'keys', label: 'Phím bấm / user có bấm', unit: 'num', group: 'app', base: 'ev._ran', apps: ['xremote', 'xcast'], num: ['remote_key_pressed.n'], den: ['remote_key_pressed.users'] },
  { id: 'cast', label: 'DAU cast', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['xremote', 'xcast'], num: ['cast_started.users'], den: ['session_start.users'] },
  { id: 'cast_ok', label: 'Cast phát được / bắt đầu', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['xcast', 'xremote'], num: ['cast_played.n'], den: ['cast_started.n'] },
  { id: 'mirror', label: 'DAU mirror', unit: 'pct', group: 'app', base: 'ev._ran', apps: ['xremote', 'xcast'], num: ['mirror_start_result.users'], den: ['session_start.users'] },
]

export const GROUP_LABEL: Record<MetricDef['group'], string> = { user: 'Người dùng', biz: 'Kinh doanh', ads: 'Ads', tech: 'Kỹ thuật', app: 'Riêng app' }

export const metricsFor = (app: string) => METRICS.filter(m => !m.apps || m.apps.includes(app))

const term = (t: Term): [string, number] => typeof t === 'string' ? [t, 1] : t

/** One day of a metric from that day's facts; null when the day has no data for it (its base fact and
 *  DAU must both be there, so a day the query never covered is not a false 0). */
export function point(m: MetricDef, facts: Map<string, number> | undefined): Pt {
  if (!facts || !facts.has(m.base ?? 'session_start.users')) return null
  if (m.base && m.base !== 'crash.total' && m.den?.includes('session_start.users') && !facts.has('session_start.users')) return null
  const sum = (ts: Term[]) => ts.reduce((a, t) => { const [k, w] = term(t); return a + w * (facts.get(k) ?? 0) }, 0)
  const s = m.scale ?? 1
  if (!m.den) return { num: s * sum(m.num), den: null }
  const den = sum(m.den)
  return den > 0 ? { num: s * sum(m.num), den } : null
}

// Cohort metrics, by install day: retention Dn and cumulative ad LTV Dn (plan 3a).
export type CohortDef = { id: string; label: string; kind: 'ret' | 'ltv'; n: number; unit: Unit; key?: boolean }
export const COHORT: CohortDef[] = [
  { id: 'd1', label: 'Retention D1', kind: 'ret', n: 1, unit: 'pct', key: true },
  { id: 'd3', label: 'Retention D3', kind: 'ret', n: 3, unit: 'pct' },
  { id: 'd7', label: 'Retention D7', kind: 'ret', n: 7, unit: 'pct' },
  { id: 'd14', label: 'Retention D14', kind: 'ret', n: 14, unit: 'pct' },
  { id: 'd30', label: 'Retention D30', kind: 'ret', n: 30, unit: 'pct' },
  { id: 'ltv0', label: 'LTV ads D0', kind: 'ltv', n: 0, unit: 'usd3' },
  { id: 'ltv3', label: 'LTV ads D3', kind: 'ltv', n: 3, unit: 'usd3' },
  { id: 'ltv7', label: 'LTV ads D7', kind: 'ltv', n: 7, unit: 'usd3' },
]

/** Cohort point for one install day. Size = first_open users that UTC day (one event per user): the
 *  Kotlin SDK counts retention_day in the device's time zone, so session_start at rd 0 double-counts users
 *  whose day 0 crosses UTC midnight (review 2026-11-08). Numerators keep a ±1 day blur on Kotlin apps.
 *  `cells` = rd → {users, rev}; a missing cell = not pulled → no point; `lastDay` = last day pulled. */
export function cohortPoint(d: CohortDef, cohort: string, size: number | undefined, cells: Map<number, { users: number; rev: number }> | undefined, lastDay: string): Pt {
  if (!cells || !size) return null
  const due = new Date(Date.parse(cohort + 'T00:00:00Z') + d.n * 86_400_000).toISOString().slice(0, 10)
  if (due > lastDay) return null // not mature yet
  if (d.kind === 'ret') { const c = cells.get(d.n); return c ? { num: c.users, den: size } : null }
  let rev = 0
  for (let k = 0; k <= d.n; k++) { const c = cells.get(k); if (!c) return null; rev += c.rev }
  return { num: rev, den: size }
}

export function fmtUnit(u: Unit, v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—'
  switch (u) {
    case 'int': return Math.round(v).toLocaleString('vi-VN')
    case 'num': return v.toLocaleString('vi-VN', { maximumFractionDigits: 2 })
    case 'pct': return (v * 100).toLocaleString('vi-VN', { maximumFractionDigits: v < 0.1 ? 2 : 1 }) + '%'
    case 'usd': return '$' + v.toLocaleString('vi-VN', { maximumFractionDigits: v < 100 ? 2 : 0 })
    case 'usd3': return '$' + v.toLocaleString('vi-VN', { maximumFractionDigits: 4 })
    case 'sec': return v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' s'
    case 'min': return v.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ' phút'
  }
}

/** Compact axis label (10K, 1,2M). */
export function axisUnit(u: Unit, v: number) {
  if (u === 'pct') return (v * 100).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + '%'
  const pre = u === 'usd' || u === 'usd3' ? '$' : ''
  const a = Math.abs(v)
  if (a >= 1e6) return pre + (v / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'M'
  if (a >= 1e4) return pre + (v / 1e3).toLocaleString('vi-VN', { maximumFractionDigits: 0 }) + 'K'
  return pre + v.toLocaleString('vi-VN', { maximumFractionDigits: a < 1 ? 3 : a < 10 ? 2 : 0 })
}
