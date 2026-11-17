// askAgent (2026-11-16): the polled ask_db_agent / get_agent_progress pair that replaced chat_with_agent. A fake session,
// no network: it must wait for completion, read every page, and never resubmit a run in a doubtful state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { askAgent } from '../src/lib/databuckets.ts'

const reply = (o: object) => ({ content: [{ type: 'text', text: JSON.stringify(o) }] })
function fake(progress: object[]) {
  const calls: { name: string; args: any }[] = []
  return { calls, call: async (name: string, args: object) => {
    calls.push({ name, args })
    return name === 'ask_db_agent' ? reply({ run_id: 'r1', session_id: 's1', status: 'queued', poll_after_seconds: 0 }) : reply(progress.shift()!)
  } }
}

test('askAgent: polls until completed, reads the extra pages, returns the result', async () => {
  const s = fake([
    { status: 'running', has_more: false, next_cursor: 3, poll_after_seconds: 0 },
    { status: 'completed', has_more: true, next_cursor: 5 },
    { status: 'completed', has_more: false, next_cursor: 6, result: { agent_run_failed: false, reply: 'ok' } },
  ])
  assert.deepEqual(await askAgent(s, 'q', AbortSignal.timeout(5_000), 0), { agent_run_failed: false, reply: 'ok' })
  assert.deepEqual(s.calls.map(c => c.name), ['ask_db_agent', 'get_agent_progress', 'get_agent_progress', 'get_agent_progress'])
  assert.deepEqual(s.calls.slice(1).map(c => c.args.after_cursor), [null, 3, 5])
})

test('askAgent: a doubtful run throws and is never asked again', async () => {
  const s = fake([{ status: 'outcome_unknown', has_more: false }])
  await assert.rejects(askAgent(s, 'q', AbortSignal.timeout(5_000), 0), /outcome_unknown, không gửi lại/)
  assert.equal(s.calls.filter(c => c.name === 'ask_db_agent').length, 1)
})
