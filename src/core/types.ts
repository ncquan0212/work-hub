// The module contract. A part of the hub (one source, one feature) is one Module object in one file
// under src/modules/, listed once in src/registry.ts. Adding, changing or removing a part touches only
// that file and that line: the core (scheduler, server, pages) knows nothing about any module.
import type { DatabaseSync } from 'node:sqlite'

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'mute'

// Navigation groups, in menu order. A group with no registered module is hidden from the menu.
export const GROUPS = [
  { id: 'develop', label: 'Develop' },
  { id: 'report', label: 'Report' },
  { id: 'track', label: 'Theo dõi' },
  { id: 'ops', label: 'Vận hành' },
  { id: 'feedback', label: 'Phản hồi' },
] as const
export type GroupId = (typeof GROUPS)[number]['id']

/** Thrown by a collector whose source this copy has not set up (no app in data/config.json, no login, no key file,
 *  no Chrome profile for the role): the panel says "chưa cấu hình" with the reason, and it never counts as a failure
 *  (no "lỗi hai lần liền" notification). The message says what to set up, e.g. "chưa có app trong data/config.json". */
export class NotConfigured extends Error { override name = 'NotConfigured' }

/** Last result of one module's collector, as kept in memory and in data/snapshot.json. */
export type Slot<D = unknown> = {
  ok: boolean
  at: number        // when the last run finished
  dataAt?: number   // when `data` was collected; older than `at` after a failed run
  triedAt?: number  // when the last run started (daily modules: no second try the same day, even after a restart)
  ms?: number
  error?: string
  unset?: string    // the last run threw NotConfigured: what to set up (also in `error`, for `npm run once`). Not a failure
  data?: D
}

/** A line in "Cần để ý" on the Hôm nay page. */
// label: a chip word for a warn line (e.g. Lỗi); seen: a POST route that marks it seen (a "Đã xem" button, back to Hôm nay)
export type Alert = { tone: 'bad' | 'warn'; text: string; href?: string; label?: string; seen?: string }
/** A line in "Đang chờ bạn" on the Hôm nay page. */
export type Waiting = { text: string; sub?: string; href?: string; at?: number }

/** What a collector gets. `signal` aborts when the module's timeout passes: pass it to fetch/execFile. */
export interface Ctx { now: number; signal: AbortSignal; db: DatabaseSync }

/** What renderers get. `slot(id)` reads another module's last result: a soft dependency, which must
 *  render fine when that module is absent or has no data yet. */
export interface View { now: number; db: DatabaseSync; slot<D = any>(id: string): Slot<D> | undefined; csrf: string }

export type Req = {
  method: 'GET' | 'POST'
  path: string
  params: Record<string, string>   // from `:name` segments of the route path
  query: URLSearchParams
  form: URLSearchParams            // POST fields (urlencoded or multipart); empty for GET
  files: Upload[]                  // files of a multipart POST, non-empty ones only; the route checks what they are
  who?: string                     // the device by name (core/access.ts, by tailnet IP), 'local' at 127.0.0.1
}
/** A file from a multipart form. Name and type come from the client: never trust them. */
export type Upload = { field: string; name: string; data: Buffer }
/** A route answers with a page body (wrapped in the shared layout), JSON, a redirect, or a stored file. */
export type Res =
  // bare: no brand row, tabs or dock (a chart's full-screen view); noscriptRefresh: reload every minute only without JavaScript
  | { title: string; body: string; status?: number; noRefresh?: boolean; bare?: boolean; noscriptRefresh?: boolean }
  | { json: unknown; status?: number }
  | { redirect: string }
  | { file: Buffer; type: string } // a stored file (develop images); the route vouches for the type
export type Route = {
  method: 'GET' | 'POST'
  path: string // must start with "/<group>/"; `:name` segments become params
  handle(req: Req, v: View): Res | Promise<Res>
}

export interface Module<D = any> {
  id: string          // stable: key in the snapshot, in /api/<id> and in log lines
  title: string       // panel heading
  group: GroupId

  // Schedule: `every` seconds, or once a day at `daily` ('HH:MM', this machine's local time). Neither = no collector.
  every?: number
  daily?: string
  timeout?: number    // seconds, default 60
  collect?(ctx: Ctx): Promise<D>

  init?(db: DatabaseSync): void           // create the module's own tables (prefix them with the module id)
  start?(db: DatabaseSync): void          // serve mode only: start the module's own service (e.g. the browser bridge port)
  panel?(s: Slot<D> | undefined, v: View): string   // section on its group page
  today?(s: Slot<D> | undefined, v: View): string   // optional summary block on Hôm nay
  alerts?(s: Slot<D> | undefined, v: View): Alert[]
  waiting?(s: Slot<D> | undefined, v: View): Waiting[]
  routes?: Route[]
  css?: string        // the module's own styles, added to the shared stylesheet; selectors scoped to its own classes
}
