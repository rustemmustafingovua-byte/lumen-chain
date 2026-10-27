/** Request signer: HMAC-SHA256 + timestamp validation. */
import { createHmac, timingSafeEqual } from "node:crypto"

const TIMESTAMP_WINDOW_MS = 5 * 60_000 // 5 минут

export function signRequest(secret: string, method: string, body: string, ts: number): string {
  const payload = `${ts}:${method}:${body}`
  return createHmac("sha256", secret).update(payload).digest("hex")
}

export function verifySignature(secret: string, method: string, body: string, ts: number, sig: string): boolean {
  const now = Date.now()
  if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) return false
  const expected = signRequest(secret, method, body, ts)
  try {
    const a = Buffer.from(sig, "hex")
    const b = Buffer.from(expected, "hex")
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
}
