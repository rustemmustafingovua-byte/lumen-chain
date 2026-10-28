import { test } from "node:test"
import assert from "node:assert/strict"
import { MetricsCollector } from "../core/metrics.js"

test("metrics: snapshot на старте", () => {
  const m = new MetricsCollector()
  const snap = m.snapshot()
  assert.equal(snap.blocksProduced, 0)
  assert.equal(snap.txsProcessed, 0)
  assert.equal(snap.peerCount, 0)
  assert.ok(snap.blockTime === 0)
  assert.ok(snap.txThroughput === 0)
})

test("metrics: recordBlock накапливает значения", async () => {
  const m = new MetricsCollector()
  m.setPeerCount(5)
  for (let i = 0; i < 3; i++) {
    m.recordBlock(10)
    if (i < 2) await new Promise((r) => setTimeout(r, 5))
  }
  const snap = m.snapshot()
  assert.equal(snap.blocksProduced, 3)
  assert.equal(snap.txsProcessed, 30)
  assert.equal(snap.peerCount, 5)
  assert.ok(snap.blockTime > 0)
})

test("metrics: toJson сериализуется", () => {
  const m = new MetricsCollector()
  m.recordBlock(1)
  const json = m.toJson()
  const obj = JSON.parse(json)
  assert.equal(typeof obj, "object")
  assert.equal(typeof obj.blockTime, "number")
  assert.equal(typeof obj.txThroughput, "number")
  assert.equal(typeof obj.peerCount, "number")
  assert.equal(typeof obj.memoryUsage, "number")
  assert.equal(typeof obj.blocksProduced, "number")
  assert.equal(typeof obj.txsProcessed, "number")
})
