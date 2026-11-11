// Crashlytics reports through v1alpha, the undocumented API the Firebase CLI/MCP itself uses
// (firebase-tools lib/crashlytics/*): Google may change it without notice. Auth: the owner's Firebase
// CLI login (lib/google.ts). Used by the crash panel (last 24 h) and the Report (one UTC day at a time).
import { firebaseUserToken, getJson } from './google.ts'

// Spread calls out: the API has a per-minute read quota (429 when the 35-day backfill fired ~280 calls at once).
let nextAt = 0
async function pace() {
  const wait = nextAt - Date.now()
  nextAt = Math.max(Date.now(), nextAt) + 1200 // ≤ 50 calls a minute
  if (wait > 0) await new Promise(r => setTimeout(r, wait))
}

function url(appId: string, report: string, start: number, end: number, extra: [string, string][]) {
  const q = new URLSearchParams([['filter.interval.start_time', new Date(start).toISOString()], ['filter.interval.end_time', new Date(end).toISOString()], ...extra])
  return `https://firebasecrashlytics.googleapis.com/v1alpha/projects/${appId.split(':')[1]}/apps/${appId}/reports/${report}?${q}`
}

/** Users in the interval and users hit by FATAL crashes / ANRs. appSummary without a filter counts
 *  NON_FATAL too (xremote 2026-11-07: 98.88% unfiltered vs 99.78% FATAL-only); FATAL-only is the console's number. */
export async function summary(appId: string, start: number, end: number, signal?: AbortSignal) {
  const tok = await firebaseUserToken()
  await pace()
  const fatal = await getJson(url(appId, 'appSummary', start, end, [['filter.issue.error_types', 'FATAL']]), tok, signal)
  await pace()
  const anr = await getJson(url(appId, 'appSummary', start, end, [['filter.issue.error_types', 'ANR']]), tok, signal)
  const m = fatal.groups?.[0]?.metrics?.[0] ?? {}
  return {
    crashFree: m.crashFreeUsersPercentage != null ? Number(m.crashFreeUsersPercentage) : null,
    crashUsers: Number(m.impactedUsersCount ?? 0),
    totalUsers: Number(m.totalUsersCount ?? 0),
    anrUsers: Number(anr.groups?.[0]?.metrics?.[0]?.impactedUsersCount ?? 0),
  }
}

export type Issue = { title: string; subtitle: string; type: string; uri: string; versions: string[]; users: number; events: number }

export async function topIssues(appId: string, start: number, end: number, size: number, signal?: AbortSignal): Promise<Issue[]> {
  const tok = await firebaseUserToken()
  await pace()
  const top = await getJson(url(appId, 'topIssues', start, end, [['page_size', String(size)], ['filter.issue.error_types', 'FATAL'], ['filter.issue.error_types', 'ANR']]), tok, signal)
  return (top.groups ?? []).map((g: any) => ({
    title: g.issue?.title, subtitle: g.issue?.subtitle, type: g.issue?.errorType, uri: g.issue?.uri,
    versions: [g.issue?.firstSeenVersion, g.issue?.lastSeenVersion].filter(Boolean),
    users: Number(g.metrics?.[0]?.impactedUsersCount ?? 0), events: Number(g.metrics?.[0]?.eventsCount ?? 0),
  }))
}
