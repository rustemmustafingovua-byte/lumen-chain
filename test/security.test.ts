import { test } from "node:test"
import assert from "node:assert/strict"
import { checkRateLimit, rateLimitMetrics } from "../core/rate-limiter.js"
import { signRequest, verifySignature } from "../core/signer.js"
import { makeRpc } from "../core/rpc.js"
import { Chain } from "../core/chain.js"

/* =========================================================================
 * Rate limiter
 * ========================================================================= */

test("rate limiter: free IP limit 100 req/min", () => {
  const ip = "10.0.0.1"
  for (let i = 0; i < 100; i++) {
    const r = checkRateLimit(ip, undefined)
    assert.ok(r.ok)
  }
  const r = checkRateLimit(ip, undefined)
  assert.ok(!r.ok)
  assert.ok(r.retryAfter > 0)
})

test("rate limiter: API key limit 1000 req/min", () => {
  const key = "test-key-1"
  for (let i = 0; i < 1000; i++) {
    const r = checkRateLimit(undefined, key)
    assert.ok(r.ok)
  }
  const r = checkRateLimit(undefined, key)
  assert.ok(!r.ok)
})

test("rate limiter: different keys are independent", () => {
  const keyA = "key-a"
  const keyB = "key-b"
  for (let i = 0; i < 1001; i++) {
    checkRateLimit(undefined, keyA)
  }
  const r = checkRateLimit(undefined, keyB)
  assert.ok(r.ok, "keyB should not be rate limited")
})

test("rate limiter: metrics report active buckets", () => {
  checkRateLimit("1.2.3.4", undefined)
  checkRateLimit(undefined, "mykey")
  const m = rateLimitMetrics()
  assert.ok(m.freeActive >= 1)
  assert.ok(m.keyActive >= 1)
})

/* =========================================================================
 * Request signer
 * ========================================================================= */

test("signer: valid signature passes", () => {
  const secret = "my-secret"
  const method = "lumen_blockNumber"
  const body = "{}"
  const ts = Date.now()
  const sig = signRequest(secret, method, body, ts)
  assert.ok(verifySignature(secret, method, body, ts, sig))
})

test("signer: wrong secret fails", () => {
  const sig = signRequest("secret-a", "m", "{}", Date.now())
  assert.ok(!verifySignature("secret-b", "m", "{}", Date.now(), sig))
})

test("signer: timestamp too old fails", () => {
  const secret = "s"
  const method = "m"
  const body = "{}"
  const oldTs = Date.now() - 6 * 60_000 // 6 min ago
  const sig = signRequest(secret, method, body, oldTs)
  assert.ok(!verifySignature(secret, method, body, oldTs, sig))
})

test("signer: timestamp too far in future fails", () => {
  const secret = "s"
  const method = "m"
  const body = "{}"
  const futureTs = Date.now() + 6 * 60_000
  const sig = signRequest(secret, method, body, futureTs)
  assert.ok(!verifySignature(secret, method, body, futureTs, sig))
})

/* =========================================================================
 * Input validation in RPC
 * ========================================================================= */

test("rpc: rejects unknown method", () => {
  const chain = new Chain()
  chain.genesis()
  const rpc = makeRpc(chain)
  assert.throws(() => rpc("hack_method" as any), /unknown method/)
})

test("rpc: rejects string param > 256 chars", () => {
  const chain = new Chain()
  chain.genesis()
  const rpc = makeRpc(chain)
  const long = "a".repeat(257)
  assert.throws(() => rpc("lumen_getBalance", [long]), /too long/)
})

test("rpc: normal params pass validation", () => {
  const chain = new Chain()
  chain.genesis()
  const rpc = makeRpc(chain)
  const addr = chain.ledger.accounts.keys().next().value!
  const bal = rpc("lumen_getBalance", [addr])
  assert.ok(typeof bal === "string")
})
