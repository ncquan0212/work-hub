// Databuckets through its MCP server, the only access that exists (owner rule R1). An LLM agent runs the EQL we hand
// it: ask_db_agent starts a run and get_agent_progress is polled until it completes (since 2026-11-16; the single
// chat_with_agent call it replaced is gone). Facts measured 2026-11-08 (docs/sources.md, Databuckets):
//  - ~100 s per call (58–175 s; 1–4 min with the polled tools); the query itself is 1–44 s. No retry: a timed-out call may still run.
//  - the reply prose is unstable (once in Chinese); the last ```json block ("Query results") is stable
//    and carries the EQL that really ran, so we compare it with ours and refuse a rewritten query;
//  - a result carries at most 1,000 rows; only the last step's rows come back;
//  - every call is saved as a chat and adds org-level "knowledge" on their side (accepted by the owner).
// The bearer token: DATABUCKETS_URL + DATABUCKETS_TOKEN in .env, else the one Claude Code already uses (~/.claude.json),
// read in place, never logged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DATASET, HOME } from '../config.ts'
import { NotConfigured } from '../core/types.ts'

export { DATASET } from '../config.ts'
// the polled agent first loads its own guides: 1–4 min a run on 2026-11-16, against ~100 s for chat_with_agent
const CALL_TIMEOUT = 600_000

type Mcp = { url?: unknown; headers?: Record<string, unknown> } | undefined
const fromMcp = (c: Mcp) => {
  const auth = Object.entries(c?.headers ?? {}).find(([k]) => k.toLowerCase() === 'authorization')?.[1]
  return c?.url && auth ? { url: String(c.url), auth: String(auth) } : null
}
/** Where the Databuckets MCP server and its token come from, in order: the .env pair (any AI, no Claude Code needed),
 *  Claude Code's user scope, then any of its project scopes. Null: none has it. */
export function findServer(env: Record<string, string | undefined>, claudeJson: any) {
  if (env.DATABUCKETS_URL && env.DATABUCKETS_TOKEN) {
    const t = env.DATABUCKETS_TOKEN.trim()
    return { url: env.DATABUCKETS_URL, auth: /^bearer\s/i.test(t) ? t : `Bearer ${t}` }
  }
  return fromMcp(claudeJson?.mcpServers?.databuckets)
    ?? Object.values(claudeJson?.projects ?? {}).map((p: any) => fromMcp(p?.mcpServers?.databuckets)).find(Boolean) ?? null
}

function claudeJson() {
  try { return JSON.parse(readFileSync(join(HOME, '.claude.json'), 'utf8')) } catch (e) {
    // a fixed message: JSON.parse's own quotes the file, which holds tokens
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('~/.claude.json không đọc được')
    return null
  }
}

function server() {
  if (!DATASET) throw new NotConfigured('đặt databucketsDataset trong data/config.json (docs/config.md)')
  // the .env pair alone first: a damaged ~/.claude.json must not stop a hub that does not need it
  const s = findServer(process.env, null) ?? findServer({}, claudeJson())
  if (!s) throw new NotConfigured('đặt DATABUCKETS_URL và DATABUCKETS_TOKEN trong .env, hoặc thêm MCP databuckets vào Claude Code (docs/config.md)')
  return s
}

/** One JSON-RPC exchange over MCP streamable HTTP; the reply is JSON or a short SSE stream. */
async function rpc(url: string, headers: Record<string, string>, body: object, signal: AbortSignal) {
  const r = await fetch(url, { method: 'POST', signal, headers: { ...headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body) })
  if (!r.ok && r.status !== 202) throw new Error(`MCP HTTP ${r.status}`)
  const session = r.headers.get('mcp-session-id')
  const text = await r.text()
  if (!('id' in body)) return { session, msg: null } // notification: no reply
  let msg: any = null
  if ((r.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for (const ev of text.split(/\r?\n\r?\n/)) {
      const data = ev.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')
      if (!data) continue
      try { const j = JSON.parse(data); if (j.id === (body as any).id) msg = j } catch { /* keep-alive */ }
    }
  } else msg = JSON.parse(text)
  if (!msg) throw new Error('MCP: không có trả lời')
  if (msg.error) throw new Error(`MCP ${msg.error.code}: ${String(msg.error.message).slice(0, 160)}`)
  return { session, msg }
}

export async function mcpSession(signal: AbortSignal) {
  const { url, auth } = server()
  const base: Record<string, string> = { authorization: auth }
  const init = await rpc(url, base, { jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'work-hub', version: '1' } } }, signal)
  const headers = init.session ? { ...base, 'mcp-session-id': init.session, 'mcp-protocol-version': init.msg.result?.protocolVersion ?? '2025-06-18' } : base
  await rpc(url, headers, { jsonrpc: '2.0', method: 'notifications/initialized' }, signal)
  let id = 2
  return {
    listTools: async () => (await rpc(url, headers, { jsonrpc: '2.0', id: id++, method: 'tools/list' }, signal)).msg.result,
    call: async (name: string, args: object) => (await rpc(url, headers, { jsonrpc: '2.0', id: id++, method: 'tools/call', params: { name, arguments: args } }, signal)).msg.result,
  }
}

/** Normalised EQL for comparison. The agent rewrites cosmetically (adds `opt_skip_save` and sort
 *  keywords, drops or adds self-aliases like `app_id as app_id`); anything else counts as a change. */
export function normEql(e: string) {
  return e.toLowerCase()
    .replace(/\bopt_skip_save\b/g, ' ')
    .replace(/\s+(asc|desc)\b/g, ' ')
    .replace(/\b([a-z_][a-z0-9_.]*)\s+as\s+\1\b/g, '$1')
    .replace(/\s+/g, ' ').replace(/\s*([(),|])\s*/g, '$1').trim()
}

/** Where two normalised EQLs first differ, with a little context on both sides. */
export function eqlDiff(want: string, got: string) {
  let i = 0
  while (i < want.length && want[i] === got[i]) i++
  return `ta: "…${want.slice(Math.max(0, i - 40), i + 60)}" / chạy: "…${got.slice(Math.max(0, i - 40), i + 60)}"`
}

type Result = { data: unknown[][]; eql?: string; steps?: unknown[][]; rows?: number; duration?: number }

/** The "Query results" block at the end of an agent reply → one result per query that ran. */
export function parseQueryResults(reply: string): Result[] {
  try {
    const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/g)]
    if (!blocks.length) throw new Error('Databuckets: trả lời không có khối Query results')
    const j = JSON.parse(blocks.at(-1)![1])
    const list = (Array.isArray(j) ? j : [j]).filter(r => r && Array.isArray(r.data) && Array.isArray(r.data[0]))
    if (!list.length) throw new Error('Databuckets: khối Query results không có bảng data')
    return list
  } catch (e) {
    // say what the agent answered instead (its prose, trimmed): usually why it would not run the query. Here, not in
    // the callers: Theo dõi's askAll had no such catch, so its failures said nothing (đợt #10, 2026-11-12)
    throw new Error(`${(e as Error).message}. Agent trả lời: "${reply.replace(/\s+/g, ' ').slice(0, 300)}"`)
  }
}

export type Row = Record<string, string | number | null>

/** Matrix (first row = headers) → objects. */
export function toRows(data: unknown[][]): Row[] {
  const [head, ...body] = data
  return body.map(r => Object.fromEntries((head as string[]).map((h, i) => [h, (r[i] ?? null) as string | number | null])))
}

export type Query = { eql: string; cols: string[] }

const textJson = (res: any) => {
  const text = res?.content?.find((c: any) => c?.type === 'text')?.text
  if (!text) throw new Error('Databuckets: trả lời rỗng')
  return JSON.parse(text)
}

/**
 * One question to the Databuckets agent, waited for: ask_db_agent returns a run id at once, get_agent_progress is
 * polled at the pace it asks for (pages of a run read back to back). Never resubmits: a run in any state but
 * queued/running/completed (outcome_unknown, session_busy…) throws, since it may have run. Returns the agent's result
 * ({ agent_run_failed, reply, … }, what chat_with_agent used to answer).
 */
export async function askAgent(s: { call(name: string, args: object): Promise<any> }, question: string, signal: AbortSignal, minWaitMs = 5_000) {
  const start = textJson(await s.call('ask_db_agent', { user_question: question }))
  const { run_id, session_id } = start
  if (!run_id || !session_id) throw new Error(`Databuckets: ask_db_agent không trả run_id (${String(start.status ?? '?')})`)
  let cursor: number | null = null, wait = Number(start.poll_after_seconds) * 1000, result: any = null
  for (;;) {
    await sleep(Math.max(minWaitMs, Number.isFinite(wait) ? wait : 10_000), undefined, { signal })
    let p: any
    do {
      p = textJson(await s.call('get_agent_progress', { run_id, session_id, after_cursor: cursor }))
      cursor = p.next_cursor ?? cursor
      result = p.result ?? result
    } while (p.has_more)
    if (p.status === 'completed') {
      if (!result) throw new Error('Databuckets: lượt chạy xong nhưng không có kết quả')
      return result
    }
    if (p.status !== 'queued' && p.status !== 'running') throw new Error(`Databuckets: lượt chạy ở trạng thái ${String(p.status)}, không gửi lại`)
    wait = Number(p.poll_after_seconds) * 1000
  }
}

/**
 * Run EQL through the agent, exactly as written, in ONE chat call (each call costs ~100 s and a saved
 * chat on their side, so small queries share a call). Throws (no data at all) when the agent ran a
 * different query, returned a truncated result, missed a query, or failed.
 */
export async function runEql(queries: Query[], signal: AbortSignal, timeoutMs = CALL_TIMEOUT) {
  const sig = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
  const s = await mcpSession(sig)
  const question = [
    'READ-ONLY: do not create, save, schedule, send or modify any report, dashboard, insight, alert or email.',
    queries.length === 1
      ? 'Execute the EQL below exactly as written, once. No exploration, no follow-up queries, no chart, no rewriting.'
      : `Execute each of the ${queries.length} EQL queries below exactly as written, once each, in order. No exploration, no follow-up queries, no chart, no rewriting.`,
    // the agent always translates EQL into its own query model; asking it to refuse rather than "change" made it
    // refuse everything (2026-11-08), so ask for a faithful translation instead. runEql still checks the result.
    'Translate it faithfully into your query model: keep every clause (bucket 1 day, since N days ago, retention_day, every filter value); do not drop or add anything.',
    'Reply with the Query results block only.',
    ...queries.flatMap((q, i) => [queries.length > 1 ? `Query ${i + 1}:` : '', '```', q.eql, '```']).filter(Boolean),
  ].join('\n')
  const out = await askAgent(s, question, sig)
  if (out.agent_run_failed) throw new Error(`Databuckets: agent lỗi: ${String(out.reply ?? '').slice(0, 160)}`)
  const results = parseQueryResults(String(out.reply ?? ''))
  return queries.map((q, i) => {
    const want = normEql(q.eql)
    const r = results.find(x => x.eql && normEql(x.eql) === want)
    if (!r) {
      const ran = results[i]?.eql ?? results[0]?.eql
      throw new Error(ran ? `Databuckets: agent đã đổi EQL (truy vấn ${i + 1}): ${eqlDiff(want, normEql(ran))}` : `Databuckets: thiếu kết quả truy vấn ${i + 1}`)
    }
    const last = r.steps?.at(-1)
    const total = Array.isArray(last) ? Number(last[1]) : NaN
    // every hub query is designed to stay under 1,000 rows: 1,000 means the preview cap cut it, steps or not
    if (total > r.data.length - 1 || r.data.length - 1 >= 1000) throw new Error(`Databuckets: kết quả bị cắt (${Number.isNaN(total) ? '≥1000' : total} dòng, nhận ${r.data.length - 1})`)
    const head = r.data[0] as string[]
    const missing = q.cols.filter(c => !head.includes(c))
    if (missing.length) throw new Error(`Databuckets: thiếu cột ${missing.join(', ')} (truy vấn ${i + 1})`)
    return { rows: toRows(r.data), eql: r.eql ?? q.eql, ms: Math.round((r.duration ?? 0) * 1000) }
  })
}
