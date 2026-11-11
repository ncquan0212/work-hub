// Who may talk to the hub. Pure functions, unit-tested (test/core.test.ts).
//
// The server listens on 127.0.0.1 only. Requests arrive either
//  - locally (a browser or curl on this machine), Host = 127.0.0.1:PORT or localhost:PORT, or
//  - through `tailscale serve`, Host = the Mac's tailnet name. Tailscale 1.102.5 keeps the Host and
//    *overwrites* X-Forwarded-For with the caller's tailnet IP (ipn/ipnlocal/serve.go,
//    addProxyForwardedHeaders), so a device cannot forge it.
// LOAD-BEARING (DNS rebinding): any other Host is refused, so a web page that rebinds its own domain
// to 127.0.0.1 cannot read the hub.

export type AccessConfig = { port: number; tailnetHost: string; devices: Record<string, string[]> }

export type Verdict = { ok: true; who: string } | { ok: false; why: string }

export function checkAccess(host: string | undefined, xff: string | undefined, c: AccessConfig): Verdict {
  // local = straight to the port, never through serve: serve keeps whatever Host the client sent
  // (review 2026-11-08: a tailnet device could send `Host: 127.0.0.1:8787`), but it always sets X-Forwarded-For
  if (!xff && (host === `127.0.0.1:${c.port}` || host === `localhost:${c.port}`)) return { ok: true, who: 'local' }
  if (host !== c.tailnetHost) return { ok: false, why: `host ${String(host).slice(0, 80)}` }
  // serve sets exactly one address; take the last hop anyway so an appended list cannot smuggle one in
  const ip = String(xff ?? '').split(',').pop()!.trim()
  for (const [name, ips] of Object.entries(c.devices)) if (ips.includes(ip)) return { ok: true, who: name }
  return { ok: false, why: `device ${ip || '(no X-Forwarded-For)'}` }
}

/** Origins a browser may POST from (CSRF): the hub's own pages only. */
export function sameOrigin(origin: string | undefined, c: AccessConfig) {
  return origin === `https://${c.tailnetHost}` || origin === `http://127.0.0.1:${c.port}` || origin === `http://localhost:${c.port}`
}
