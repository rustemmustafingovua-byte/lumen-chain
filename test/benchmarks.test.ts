import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain, MAX_BLOCK_TXS } from "../core/chain.js"
import { Ledger, TX_FEE } from "../core/ledger.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"
import { MetricsCollector } from "../core/metrics.js"
import { Gossip, createMemoryBus, createMemoryTransport, peerIdFromPublicKey } from "../core/p2p.js"
import { Persistence } from "../core/persist.js"
import { join } from "node:path"
import { tmpdir } from "node:os"

const freshDb = () => join(tmpdir(), `lumen-bench-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)

function fundedChain(opts?: { maxBlockSize?: number }) {
  const chain = new Chain(opts)
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)
  return { chain, val }
}

// ---- benchmarks ----

test("benchmark: transaction throughput", () => {
  const { chain, val } = fundedChain()
  const dest = createWallet().address
  const txs = Array.from({ length: 1000 }, (_, i) => buildTx(val, dest, 1000n, { nonce: i }))

  const start = performance.now()
  for (let i = 0; i < txs.length; i++) {
    chain.mempool.add(txs[i])
  }
  const end = performance.now()
  const elapsed = end - start
  const throughput = 1000 / (elapsed / 1000)

  assert.ok(throughput > 1000, `throughput must be > 1k tx/s, got ${throughput.toFixed(0)}`)
  assert.equal(chain.mempool.size, 1000)
})

test("benchmark: block production speed", () => {
  const { chain, val } = fundedChain()
  const dest = createWallet().address
  for (let i = 0; i < 100; i++) {
    const tx = buildTx(val, dest, 1000n, { nonce: i })
    chain.mempool.add(tx)
  }

  const start = performance.now()
  let slot = 1
  for (let i = 0; i < 100; i++) {
    const txs = chain.mempool.take(50)
    const b = chain.propose(txs, val.privateKey, val.publicKey, slot++)
    chain.accept(b)
  }
  const end = performance.now()
  const elapsed = end - start
  const blocksPerSec = 100 / (elapsed / 1000)

  assert.ok(blocksPerSec > 50, `blocks/sec must be > 50, got ${blocksPerSec.toFixed(0)}`)
  assert.equal(chain.height, 100)
})

test("benchmark: persistence read/write speed", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = fundedChain()

  const blocks: any[] = []
  for (let i = 1; i <= 100; i++) {
    const tx = buildTx(val, createWallet().address, 5n, { nonce: i - 1 })
    const b = chain.propose([tx], val.privateKey, val.publicKey, i)
    chain.accept(b)
    blocks.push(b)
  }

  const writeStart = performance.now()
  for (const b of blocks) p.saveBlock(b)
  const writeEnd = performance.now()
  const writeMs = writeEnd - writeStart

  const readStart = performance.now()
  const loaded = p.getBlocks(1, 100)
  const readEnd = performance.now()
  const readMs = readEnd - readStart

  assert.equal(loaded.length, 100)
  assert.ok(writeMs < 2000, `write 100 blocks must be < 2000ms, got ${writeMs.toFixed(0)}`)
  assert.ok(readMs < 500, `read 100 blocks must be < 500ms, got ${readMs.toFixed(0)}`)
})

test("benchmark: p2p message latency", () => {
  const bus = createMemoryBus()
  const a = createMemoryTransport(bus)
  const b = createMemoryTransport(bus)
  bus.register("a", a)
  bus.register("b", b)

  const messages = 500
  let received = 0

  b.onMessage(() => {
    received++
  })

  const start = performance.now()
  for (let i = 0; i < messages; i++) {
    a.send("b", JSON.stringify({ ping: i }))
  }
  bus.flush()
  const end = performance.now()
  const latency = (end - start) / messages

  assert.equal(received, messages)
  assert.ok(latency < 0.5, `p2p msg latency must be < 0.5ms, got ${latency.toFixed(3)}`)
})

test("benchmark: mempool binary insertion vs sort", () => {
  const { chain } = fundedChain()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey

  const txs = Array.from({ length: 5000 }, (_, i) => buildTx(val, createWallet().address, 1000n, { nonce: i, fee: 1000n - BigInt(i) }))
  const start = performance.now()
  for (const tx of txs) chain.mempool.add(tx)
  const end = performance.now()
  assert.ok(end - start < 2000, `5000 inserts must be < 2000ms, got ${(end - start).toFixed(0)}`)
  assert.equal(chain.mempool.size, 5000)
})
