import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain } from "../core/chain.js"
import { Persistence } from "../core/persist.js"
import { Ledger } from "../core/ledger.js"
import { createWallet, buildTx } from "../core/rpc.js"
import { MIN_STAKE } from "../core/ledger.js"
import { join } from "node:path"
import { tmpdir } from "node:os"

const freshDb = () => join(tmpdir(), `lumen-p-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`)

function makeChain(dbPath?: string) {
  const chain = new Chain()
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)
  if (dbPath) {
    chain.persist = new Persistence(dbPath)
  }
  return { chain, val }
}

// ---- CRUD ----

test("persist: save и load блока", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = makeChain(db)
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  const tx = buildTx(val, createWallet().address, 5n, { nonce: 0 })
  const block = chain.propose([tx], val.privateKey, val.publicKey, 1)
  chain.accept(block)
  p.saveBlock(block)
  const loaded = p.getBlock(1)
  assert.ok(loaded)
  assert.equal(loaded!.header.height, 1)
  assert.equal(loaded!.hash, block.hash)
})

test("persist: getBlocks возвращает диапазон", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = makeChain(db)
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  for (let i = 1; i <= 3; i++) {
    const tx = buildTx(val, createWallet().address, 5n, { nonce: i - 1 })
    const b = chain.propose([tx], val.privateKey, val.publicKey, i)
    chain.accept(b)
    p.saveBlock(b)
  }
  const blocks = p.getBlocks(1, 3)
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].header.height, 1)
  assert.equal(blocks[2].header.height, 3)
})

test("persist: latestBlockHeight на пустой БД = -1", () => {
  const db = freshDb()
  const p = new Persistence(db)
  assert.equal(p.latestBlockHeight, -1)
})

test("persist: latestBlockHeight после сохранения", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = makeChain(db)
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  const tx = buildTx(val, createWallet().address, 5n, { nonce: 0 })
  const b = chain.propose([tx], val.privateKey, val.publicKey, 1)
  chain.accept(b)
  p.saveBlock(b)
  assert.equal(p.latestBlockHeight, 1)
})

test("persist: аккаунты сохраняются и загружаются", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = makeChain(db)
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  p.saveAccount(chain.ledger.get(val.address))
  const loaded = p.getAccount(val.address)
  assert.ok(loaded)
  assert.equal(loaded!.balance, "1000000000000")
  assert.equal(loaded!.publicKey, val.publicKey)
})

test("persist: пулы сохраняются и загружаются", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const l = new Ledger()
  l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  const key = l.poolKey("LMN", "USDC")
  const pool = l.pool(key)!
  p.savePool(key, pool)
  const loaded = p.getPool(key)
  assert.ok(loaded)
  assert.equal(loaded!.base, "1000000")
  assert.equal(loaded!.quote, "2000000")
})

test("persist: lp shares сохраняются и загружаются", () => {
  const db = freshDb()
  const p = new Persistence(db)
  p.saveLpShares("LMN/USDC", "alice", 500_000n)
  assert.equal(p.getLpShares("LMN/USDC", "alice"), 500_000n)
  assert.equal(p.getLpShares("LMN/USDC", "bob"), 0n)
})

test("persist: контракты сохраняются", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const contract = { address: "0xabc", code: [1, 2, 3], balance: 1000n, storage: new Map() }
  p.saveContract(contract.address, contract)
  const row = p["db"]
    .prepare("SELECT data FROM contracts WHERE address = ?")
    .get(contract.address) as { data: string } | undefined
  assert.ok(row)
  assert.ok(row.data.includes("0xabc"))
})

test("persist: мемпул сохраняется и загружается", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const { chain, val } = makeChain(db)
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  const tx = buildTx(val, createWallet().address, 5n, { nonce: 0 })
  chain.mempool.add(tx)
  p.saveMempoolTxs(chain.mempool.txs)
  const loaded = p.loadMempool()
  assert.equal(loaded.length, 1)
  assert.equal(BigInt(loaded[0].amount), 5n)
})

test("persist: валидаторы сохраняются и загружаются", () => {
  const db = freshDb()
  const p = new Persistence(db)
  const validators = new Map<string, { publicKey: string; stake: bigint }>([
    ["pk1", { publicKey: "pk1", stake: 100_000n }],
    ["pk2", { publicKey: "pk2", stake: 200_000n }],
  ])
  p.saveValidators(validators)
  const loaded = p.loadValidators()
  assert.equal(loaded.size, 2)
  assert.equal(BigInt(loaded.get("pk1")!.stake), 100_000n)
})

test("persist: meta set/get", () => {
  const db = freshDb()
  const p = new Persistence(db)
  p.setMeta("key1", "value1")
  assert.equal(p.getMeta("key1"), "value1")
  assert.equal(p.getMeta("missing"), undefined)
})

// ---- restoreFromPersistence ----

test("restoreFromPersistence без persistence — false", async () => {
  const chain = new Chain()
  const restored = await chain.restoreFromPersistence()
  assert.ok(!restored)
})

test("restoreFromPersistence с пустой БД — false", async () => {
  const db = freshDb()
  const chain = new Chain()
  chain.persist = new Persistence(db)
  const restored = await chain.restoreFromPersistence()
  assert.ok(!restored)
})

test("persistState не падает без persistence", () => {
  const { chain } = makeChain()
  chain.persistState()
})

// ---- end-to-end: только структура (height/head), без replay tx ----

test("end-to-end: persist сохраняет height и head, restore видит блоки", async () => {
  const db = freshDb()
  const { chain, val } = makeChain(db)
  const b = chain.propose([], val.privateKey, val.publicKey, 1)
  chain.accept(b)

  const chain2 = new Chain()
  chain2.persist = new Persistence(db)
  const restored = await chain2.restoreFromPersistence()
  assert.ok(restored)
  assert.equal(chain2.height, 1)
  assert.equal(chain2.head!.hash, b.hash)
})

test("end-to-end: AMM пул сохраняется и восстанавливается", async () => {
  const db = freshDb()
  const { chain, val } = makeChain(db)
  chain.ledger.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  const poolKey = chain.ledger.poolKey("LMN", "USDC")
  // Создаём пустой блок, чтобы persistState сохранила что-то в blocks
  const b = chain.propose([], val.privateKey, val.publicKey, 1)
  chain.accept(b)
  chain.persistState()

  const restored = new Chain()
  restored.persist = new Persistence(db)
  await restored.restoreFromPersistence()
  assert.ok(restored.ledger.pool(poolKey))
  assert.equal(restored.ledger.pool(poolKey)!.totalShares, 1_000_000n)
  assert.equal(restored.ledger.pool(poolKey)!.base, 1_000_000n)
  assert.equal(restored.ledger.pool(poolKey)!.quote, 2_000_000n)
})
