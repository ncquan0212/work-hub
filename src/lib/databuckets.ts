// Databuckets through its MCP server, the only access that exists (owner rule R1). The server has one
// tool, chat_with_agent: an LLM agent that runs the EQL we hand it. Facts measured 2026-11-08
// (docs/sources.md, Databuckets):
//  - ~100 s per call (58–175 s); the query itself is 1–44 s. No retry: a timed-out call may still run.
//  - the reply prose is unstable (once in Chinese); the last ```json block ("Query results") is stable
//    and carries the EQL that really ran, so we compare it with ours and refuse a rewritten query;
//  - a result carries at most 1,000 rows; only the last step's rows come back;
//  - every call is saved as a chat and adds org-level "knowledge" on their side (accepted by the owner).
// The bearer token: DATABUCKETS_URL + DATABUCKETS_TOKEN in .env, else the one Claude Code already uses (~/.claude.json),
// read in place, never logged.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATASET, HOME } from '../config.ts'
import { NotConfigured } from '../core/types.ts'

export { DATASET } from '../config.ts'
const CALL_TIMEOUT = 300_000

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
  const blocks = [...reply.matchAll(/```json\s*([\s\S]*?)```/g)]
  if (!blocks.length) throw new Error('Databuckets: trả lời không có khối Query results')
  const j = JSON.parse(blocks.at(-1)![1])
  const list = (Array.isArray(j) ? j : [j]).filter(r => r && Array.isArray(r.data) && Array.isArray(r.data[0]))
  if (!list.length) throw new Error('Databuckets: khối Query results không có bảng data')
  return list
}

export type Row = Record<string, string | number | null>

/** Matrix (first row = headers) → objects. */
export function toRows(data: unknown[][]): Row[] {
  const [head, ...body] = data
  return body.map(r => Object.fromEntries((head as string[]).map((h, i) => [h, (r[i] ?? null) as string | number | null])))
}

export type Query = { eql: string; cols: string[] }

/**
 * Run EQL through the agent, exactly as written, in ONE chat call (each call costs ~100 s and a saved
 * chat on their side, so small queries share a call). Throws (no data at all) when the agent ran a
 * different query, returned a truncated result, missed a query, or failed.
 */
export async function runEql(queries: Query[], signal: AbortSignal, timeoutMs = CALL_TIMEOUT) {
  const s = await mcpSession(AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]))
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
  const res = await s.call('chat_with_agent', { user_question: question })
  const text = res?.content?.find((c: any) => c?.type === 'text')?.text
  if (!text) throw new Error('Databuckets: trả lời rỗng')
  const out = JSON.parse(text)
  if (out.agent_run_failed) throw new Error(`Databuckets: agent lỗi: ${String(out.reply ?? '').slice(0, 160)}`)
  let results: Result[]
  try { results = parseQueryResults(String(out.reply ?? '')) } catch (e) {
    // say what the agent answered instead (its prose, trimmed): usually why it would not run the query
    throw new Error(`${(e as Error).message}. Agent trả lời: "${String(out.reply ?? '').replace(/\s+/g, ' ').slice(0, 300)}"`)
  }
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
