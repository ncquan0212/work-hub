// UTC day helpers and Databuckets' day-bucket label, used by more than one module (report, track).
import type { Row } from './databuckets.ts'

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' }

/** The engine's bucket label "Thu Nov  5 00:00:00 2026" (UTC midnight) → "2026-11-05". */
export function bucketDay(t: unknown) {
  const m = String(t ?? '').match(/^\w{3} (\w{3}) +(\d{1,2}) \d\d:\d\d:\d\d (\d{4})$/)
  if (!m || !MONTHS[m[1]]) throw new Error(`Databuckets: không đọc được cột time "${String(t).slice(0, 40)}"`)
  return `${m[3]}-${MONTHS[m[1]]}-${m[2].padStart(2, '0')}`
}

export const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10)
export const addDays = (day: string, n: number) => utcDay(Date.parse(day + 'T00:00:00Z') + n * 86_400_000)

/** Complete days only: drop the first bucket (starts mid-day) and today's (still filling). */
export function completeDays(rows: Row[], now: number) {
  const days = [...new Set(rows.map(r => bucketDay(r.time)))].sort()
  const today = utcDay(now)
  return new Set(days.slice(1).filter(d => d < today))
}
