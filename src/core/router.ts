// Path matching for module routes: "/develop/task/:id" matches "/develop/task/42" with { id: '42' }.
import type { Route } from './types.ts'

export function match(routes: Route[], method: string, path: string) {
  const parts = path.split('/').filter(Boolean)
  for (const r of routes) {
    if (r.method !== method) continue
    const want = r.path.split('/').filter(Boolean)
    if (want.length !== parts.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length && ok; i++) {
      if (want[i].startsWith(':')) {
        try { params[want[i].slice(1)] = decodeURIComponent(parts[i]) } catch { ok = false }
      } else ok = want[i] === parts[i]
    }
    if (ok) return { route: r, params }
  }
  return null
}
