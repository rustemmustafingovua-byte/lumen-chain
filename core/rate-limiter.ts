/** Rate limiter: per-IP and per-API-key buckets. */
const FREE_LIMIT = 100 // req/min
const KEY_LIMIT = 1000 // req/min
const WINDOW_MS = 60_000

type Bucket = { ts: number; count: number }

const ipBuckets = new Map<string, Bucket>()
const keyBuckets = new Map<string, Bucket>()

function prune(buckets: Map<string, Bucket>, now: number) {
  for (const [k, b] of buckets) {
    if (now - b.ts >= WINDOW_MS) buckets.delete(k)
  }
}

export function checkRateLimit(ip: string | undefined, apiKey: string | undefined): { ok: boolean; retryAfter: number } {
  const now = Date.now()
  prune(ipBuckets, now)
  prune(keyBuckets, now)

  if (apiKey) {
    const b = keyBuckets.get(apiKey) ?? { ts: now, count: 0 }
    b.count++
    keyBuckets.set(apiKey, b)
    if (b.count > KEY_LIMIT) {
      const retryAfter = Math.max(0, Math.ceil((WINDOW_MS - (now - b.ts)) / 1000))
      return { ok: false, retryAfter }
    }
    return { ok: true, retryAfter: 0 }
  }

  const clientIp = ip ?? "unknown"
  const b = ipBuckets.get(clientIp) ?? { ts: now, count: 0 }
  b.count++
  ipBuckets.set(clientIp, b)
  if (b.count > FREE_LIMIT) {
    const retryAfter = Math.max(0, Math.ceil((WINDOW_MS - (now - b.ts)) / 1000))
    return { ok: false, retryAfter }
  }
  return { ok: true, retryAfter: 0 }
}

export function rateLimitMetrics() {
  return {
    freeActive: ipBuckets.size,
    keyActive: keyBuckets.size,
  }
}
