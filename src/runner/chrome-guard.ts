// Hard guard for Develop turns with Chrome on (architecture.md "Develop"), run by claude as a PreToolUse / PostToolUse hook that
// lib/claude.ts passes in --settings. CHROME_RULE asks the model to pick the owner's browser; this makes it so: every
// Claude in Chrome tool is refused until a select_browser of an owner-chosen deviceId has succeeded in this session.
// Without it the extension sends actions to whichever single browser is connected, and on this shared seat that can
// be someone else's Linux Chrome (review 2026-11-09). The runner deletes the marker before each turn, so a selection
// from an earlier turn (the Mac's Chrome may have gone since) never counts. Exit 2 = refuse; stderr goes to Claude.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const markerFile = (sessionId: string) => join(tmpdir(), `hub-chrome-${String(sessionId).replace(/[^\w-]/g, '')}`)

/** The decision for one hook event, given the deviceIds the config allows: null = allow, a string = refuse with that
 *  reason. Writes the marker on success. */
export function guard(e: { hook_event_name?: string; session_id?: string; tool_name?: string; tool_input?: any; tool_response?: unknown }, allowed: string[]) {
  const tool = String(e.tool_name ?? '').replace(/^mcp__claude-in-chrome__/, '')
  const marker = markerFile(e.session_id ?? '')
  if (e.hook_event_name === 'PostToolUse') {
    if (tool === 'select_browser' && allowed.includes(e.tool_input?.deviceId) && /Selected browser/.test(JSON.stringify(e.tool_response ?? '')))
      writeFileSync(marker, e.tool_input.deviceId)
    return null
  }
  if (tool === 'list_connected_browsers') return null
  if (tool === 'select_browser') return allowed.includes(e.tool_input?.deviceId) ? null : `Chỉ được chọn trình duyệt của owner: ${allowed.join(', ')}.`
  if (tool === 'switch_browser') return 'Không dùng switch_browser: owner đã chọn sẵn trình duyệt (xem quy định trình duyệt).'
  return existsSync(marker) ? null : 'Chưa chọn trình duyệt của owner: gọi list_connected_browsers rồi select_browser với một deviceId được phép.'
}

// Fails closed: a hook that crashes with any code but 2 lets the tool through, so every error (config unreadable, bad
// stdin) is a refusal. The config is imported here, inside the try, for the same reason.
if (import.meta.main) {
  try {
    const { CHROME_BROWSERS } = await import('../config.ts')
    const why = guard(JSON.parse(readFileSync(0, 'utf8')), CHROME_BROWSERS.map(b => b.id))
    if (why) { process.stderr.write(why); process.exit(2) }
  } catch (e) {
    process.stderr.write(`Hook kiểm trình duyệt bị lỗi nên chặn tool này: ${(e as Error).message}`)
    process.exit(2)
  }
}
