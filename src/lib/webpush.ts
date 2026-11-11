// Web Push with node:crypto only (architecture.md "Thông báo", owner 2026-11-09): VAPID per RFC 8292 and the payload
// encrypted per RFC 8291 (aes128gcm, RFC 8188). Tested against RFC 8291 Appendix A and a simulated subscriber that
// decrypts what it gets (test/notify.test.ts). No Google Cloud project (R1): the push service only checks our VAPID key.
// The key pair is made once into data/vapid.json (mode 600). It is a secret like the others in data/: never copy,
// log or render it. Only the public half leaves the hub, as the applicationServerKey the browsers subscribe with.
import { createCipheriv, createECDH, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ACCESS, DATA } from '../config.ts'

export type Vapid = { key: KeyObject; publicKey: string /* base64url, uncompressed P-256 point */ }
export type Sub = { endpoint: string; p256dh: string; auth: string }

const b64u = (b: Uint8Array) => Buffer.from(b).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url')
const hkdf = (ikm: Buffer, salt: Buffer, info: string | Buffer, n: number) => Buffer.from(hkdfSync('sha256', ikm, salt, info, n))

// a damaged file is not replaced: every device would have to subscribe again. The message is fixed because the
// parser's own (and createPrivateKey's) can quote the file, which holds the private key, and delivery logs it
const DAMAGED = 'data/vapid.json hỏng: sửa tay hoặc xoá, rồi mọi máy bật lại thông báo'
const readJwk = (file: string) => { const s = readFileSync(file, 'utf8'); try { return JSON.parse(s) } catch { throw new Error(DAMAGED) } }

/** The hub's VAPID key pair, made on first use. 'wx' keeps two processes from each writing their own. */
export function vapidKeys(file = join(DATA, 'vapid.json')): Vapid {
  let jwk: any
  try { jwk = readJwk(file) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
    try { writeFileSync(file, JSON.stringify(jwk), { mode: 0o600, flag: 'wx' }) } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2
      jwk = readJwk(file)
    }
  }
  let key: KeyObject
  try { key = createPrivateKey({ key: jwk, format: 'jwk' }) } catch { throw new Error(DAMAGED) }
  // the last 65 bytes of a P-256 SPKI are the uncompressed point
  return { key, publicKey: b64u(createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-65)) }
}

/** RFC 8292's `sub`: a contact for the push service, the hub's own https address. With no tailnet host (local only) the
 *  hub has none, and a localhost one is refused by some push services (Apple: BadJwtToken): a mailto at example.com
 *  (RFC 2606) is well formed and reaches nobody, which is all a push service checks. */
export const vapidSubject = (host = ACCESS.tailnetHost) => host ? `https://${host}` : 'mailto:work-hub@example.com'

/** RFC 8292 Authorization header for one push endpoint: a JWT (ES256) for the endpoint's origin, valid 12 h. */
export function vapidAuth(endpoint: string, v: Vapid, now = Date.now(), subject = vapidSubject()) {
  const part = (o: object) => b64u(Buffer.from(JSON.stringify(o)))
  const input = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })}`
  const sig = sign('sha256', Buffer.from(input), { key: v.key, dsaEncoding: 'ieee-p1363' }) // JOSE wants r || s, not DER
  return `vapid t=${input}.${b64u(sig)}, k=${v.publicKey}`
}

/** RFC 8291: `plain` encrypted for one subscription, as one aes128gcm record (header, then ciphertext). `salt` and
 *  `serverKey` (the ephemeral private key) are random unless given: only the RFC's test vector gives them. */
export function encrypt(plain: Buffer, p256dh: string, auth: string, o: { salt?: Buffer; serverKey?: Buffer } = {}) {
  if (plain.length > 3800) throw new Error('push payload too large') // push services take 4096 bytes of body
  const ua = unb64u(p256dh), ecdh = createECDH('prime256v1')
  if (o.serverKey) ecdh.setPrivateKey(o.serverKey); else ecdh.generateKeys()
  const as = ecdh.getPublicKey(), salt = o.salt ?? randomBytes(16)
  const ikm = hkdf(ecdh.computeSecret(ua), unb64u(auth), Buffer.concat([Buffer.from('WebPush: info\0'), ua, as]), 32)
  const c = createCipheriv('aes-128-gcm', hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16), hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12))
  const body = Buffer.concat([c.update(Buffer.concat([plain, Buffer.from([2])])), c.final(), c.getAuthTag()]) // 0x02: the last record
  const head = Buffer.alloc(21); salt.copy(head); head.writeUInt32BE(4096, 16); head[20] = as.length
  return Buffer.concat([head, as, body])
}

/** Sends one push; resolves to the push service's HTTP status (201 delivered, 404/410 the subscription is gone). */
export async function sendPush(s: Sub, payload: unknown, v: Vapid) {
  const r = await fetch(s.endpoint, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
    // ttl: a device off for longer finds it in the bell's list instead. urgency high: every push here is shown to the
    // owner, and Android only wakes from Doze for high (FCM)
    headers: { authorization: vapidAuth(s.endpoint, v), 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream',
      ttl: String(6 * 3600), urgency: 'high' },
    body: encrypt(Buffer.from(JSON.stringify(payload)), s.p256dh, s.auth),
  })
  await r.body?.cancel()
  return r.status
}
