// One JSON object per line on stdout (launchd sends it to ~/Library/Logs/work-hub.log).
// Never log secrets or source content beyond short error messages.
export function log(level: 'info' | 'warn', msg: string, extra: object = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra }))
}
