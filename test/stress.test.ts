import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { Ledger } from "../core/ledger.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"
import { MetricsCollector } from "../core/metrics.js"

test("stress: 10 000 транзакций в мемпуле", () => {
  const chain = new Chain({ mempoolLimit: 20_000 })
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 100_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)

  const txs = Array.from({ length: 10_000 }, (_, i) =>
    buildTx(val, createWallet().address, 1000n, { nonce: i, fee: 10_000n - BigInt(i % 1000) }),
  )

  for (const tx of txs) chain.mempool.add(tx)
  assert.equal(chain.mempool.size, 10_000)

  // take batch
  const batch = chain.mempool.take(500)
  assert.equal(batch.length, 500)
  assert.equal(chain.mempool.size, 9_500)
})

test("stress: 1 000 блоков подряд", () => {
  const chain = new Chain({ maxBlockSize: 50 })
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 100_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)

  const start = performance.now()
  let slot = 1
  for (let i = 1; i <= 1000; i++) {
    const tx = buildTx(val, createWallet().address, 5n, { nonce: i - 1 })
    chain.mempool.add(tx)
    const txs = chain.mempool.take(10)
    const b = chain.propose(txs, val.privateKey, val.publicKey, slot++)
    chain.accept(b)
  }
  const end = performance.now()

  assert.equal(chain.height, 1000)
  assert.ok(end - start < 60_000, `1000 blocks must be < 60s, got ${(end - start) / 1000}s`)
})

test("stress: мониторинг памяти при 1 000 блоках", () => {
  const chain = new Chain({ maxBlockSize: 20 })
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 100_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)

  const memBefore = process.memoryUsage().heapUsed
  let slot = 1
  for (let i = 1; i <= 1000; i++) {
    const tx = buildTx(val, createWallet().address, 5n, { nonce: i - 1 })
    chain.mempool.add(tx)
    const txs = chain.mempool.take(5)
    const b = chain.propose(txs, val.privateKey, val.publicKey, slot++)
    chain.accept(b)
  }
  const memAfter = process.memoryUsage().heapUsed
  const memDelta = (memAfter - memBefore) / 1024 / 1024

  assert.equal(chain.height, 1000)
  assert.ok(memDelta < 100, `heap delta must be < 100 MB, got ${memDelta.toFixed(2)} MB`)
})

test("stress: mempool evict старые транзакции", () => {
  const chain = new Chain({ mempoolMaxAgeMs: 1000 })
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey

  // добавляем tx с "старым" timestamp
  const oldTx = buildTx(val, createWallet().address, 1000n, { nonce: 0, fee: 5000n })
  ;(oldTx as any).timestamp = Date.now() - 5000
  chain.mempool.add(oldTx)
  assert.equal(chain.mempool.size, 1)

  chain.mempool.evict()
  assert.equal(chain.mempool.size, 0, "старые tx должны быть удалены")
})

test("stress: MetricsCollector отслеживает метрики", () => {
  const metrics = new MetricsCollector()
  metrics.setPeerCount(3)

  for (let i = 0; i < 50; i++) {
    metrics.recordBlock(10)
  }

  const snap = metrics.snapshot()
  assert.equal(snap.blocksProduced, 50)
  assert.equal(snap.txsProcessed, 500)
  assert.equal(snap.peerCount, 3)
  assert.ok(snap.blockTime >= 0, "avg block time must be >= 0")
  assert.ok(snap.txThroughput >= 0, "tx throughput must be >= 0")
  assert.ok(snap.memoryUsage > 0, "memory usage must be > 0 MB")
})

test("stress: acceptBatch производительность", () => {
  const chain = new Chain({ maxBlockSize: 20 })
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 100_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)

  const blocks: any[] = []
  for (let i = 1; i <= 50; i++) {
    const tx = buildTx(val, createWallet().address, 5n, { nonce: i - 1 })
    chain.mempool.add(tx)
    const txs = chain.mempool.take(10)
    blocks.push(chain.propose(txs, val.privateKey, val.publicKey, i))
    chain.accept(blocks[blocks.length - 1])
  }

  // сбрасываем на genesis и применяем батч заново
  const genesisBlock = chain.blocks[0]
  chain.blocks = [genesisBlock]
  chain.prunedHeight = 0
  chain.ledger = new Ledger()
  // не вызываем genesis() повторно, оставляем старый генезис
  chain.ledger.get(val.address).balance = 100_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)

  const start = performance.now()
  chain.acceptBatch(blocks)
  const end = performance.now()

  assert.equal(chain.height, 50)
  assert.ok(end - start < 2000, `batch accept 50 blocks must be < 2000ms, got ${(end - start).toFixed(0)}`)
})
