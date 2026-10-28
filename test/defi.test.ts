/**
 * Тесты расширенных DeFi-фич lumen-chain:
 *   - лимитные ордера (LimitOrderEngine)
 *   - DCA (DCAEngine)
 *   - yield-агрегатор (YieldAggregator)
 *   - NFT-маркетплейс (NFTMarketplace)
 *   - CLI команды для новых фич
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { Ledger } from "../core/ledger.js"
import { LimitOrderEngine } from "../core/limit-order.js"
import { DCAEngine } from "../core/dca.js"
import { YieldAggregator } from "../core/yield.js"
import { NFTMarketplace } from "../core/nft.js"
import { spawn } from "node:child_process"
import { join } from "node:path"
import { mkdirSync, existsSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { createWallet } from "../core/rpc.js"

// ---- helpers ----

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, "")
}

function runCli(
  args: string[],
  envHome?: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env = { ...process.env, HOME: envHome ?? process.env.HOME ?? tmpdir() }
    const LUMEN_TS = join(process.cwd(), "cli", "lumen.ts")
    const TSX = process.execPath
    const ARGS = [join(process.cwd(), "node_modules", ".bin", "tsx")]
    const child = spawn(TSX, [...ARGS, LUMEN_TS, ...args], { env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d.toString()))
    child.stderr.on("data", (d) => (stderr += d.toString()))
    child.on("close", (code) => resolve({ code: code ?? 0, stdout: stripAnsi(stdout), stderr }))
  })
}

function makeHome(overrides: { wallet?: boolean } = {}): string {
  const dir = join(tmpdir(), `lumen-defi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  mkdirSync(join(dir, ".lumen"), { recursive: true })
  if (overrides.wallet) {
    const w = createWallet()
    writeFileSync(join(dir, ".lumen", "wallet.json"), JSON.stringify(w))
  }
  return dir
}

// ---- Limit Orders ----

test("limit order: create, cancel, list", () => {
  const engine = new LimitOrderEngine(":memory:")
  const ledger = new Ledger()
  ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")

  // create
  const order = engine.create("alice", "LMN/USDC", "buy", 100_000n, 10_000n)
  assert.ok(order.id > 0)
  assert.equal(order.status, "open")
  assert.equal(order.amount, 100_000n)

  // list
  const open = engine.listOpen()
  assert.ok(open.some((o) => o.id === order.id))

  // cancel
  const cancelled = engine.cancel(order.id)
  assert.ok(cancelled)
  assert.equal(cancelled!.status, "cancelled")
  assert.equal(engine.listOpen().length, 0)
})

test("limit order: cancel non-existent returns undefined", () => {
  const engine = new LimitOrderEngine(":memory:")
  assert.equal(engine.cancel(9999), undefined)
})

test("limit order: amount 0 throws", () => {
  const engine = new LimitOrderEngine(":memory:")
  assert.throws(() => engine.create("x", "LMN/USDC", "buy", 0n, 1n), /amount/)
})

test("limit order: price 0 throws", () => {
  const engine = new LimitOrderEngine(":memory:")
  assert.throws(() => engine.create("x", "LMN/USDC", "buy", 1n, 0n), /цена/)
})

test("limit order: match executes when price hits", () => {
  const engine = new LimitOrderEngine(":memory:")
  const ledger = new Ledger()
  ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  // give bob enough balance
  ledger.get("bob").balance = 1_000_000_000_000n
  // marketPrice = 10_000; place buy order at price 20_000 (above market) -> executes
  const order = engine.create("bob", "LMN/USDC", "buy", 10_000n, 20_000n)
  const result = engine.match(ledger)
  assert.ok(result.executed.some((e) => e.id === order.id), "expected order to execute")
})

test("limit order: match skips when price not hit", () => {
  const engine = new LimitOrderEngine(":memory:")
  const ledger = new Ledger()
  ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  engine.create("bob", "LMN/USDC", "buy", 10_000n, 100n) // very low price
  const result = engine.match(ledger)
  assert.equal(result.executed.length, 0)
  assert.ok(result.skipped >= 1)
})

// ---- DCA ----

test("DCA: create plan, list, cancel", () => {
  const dca = new DCAEngine(":memory:")
  const plan = dca.create("alice", "LMN/USDC", 1000n, 10, 5)
  assert.ok(plan.id > 0)
  assert.equal(plan.active, true)
  assert.equal(plan.interval, 10)

  const active = dca.listActive()
  assert.ok(active.some((p) => p.id === plan.id))

  const cancelled = dca.cancel(plan.id)
  assert.ok(cancelled)
  assert.equal(dca.listActive().length, 0)
})

test("DCA: cancel non-existent returns false", () => {
  const dca = new DCAEngine(":memory:")
  assert.equal(dca.cancel(9999), false)
})

test("DCA: amount 0 throws", () => {
  const dca = new DCAEngine(":memory:")
  assert.throws(() => dca.create("x", "LMN/USDC", 0n, 5, 1), /amount/)
})

test("DCA: interval 0 throws", () => {
  const dca = new DCAEngine(":memory:")
  assert.throws(() => dca.create("x", "LMN/USDC", 100n, 0, 1), /interval/)
})

test("DCA: executeAtBlock triggers at right block", () => {
  const dca = new DCAEngine(":memory:")
  const ledger = new Ledger()
  ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  ledger.get("alice").balance = 10_000_000_000_000n

  dca.create("alice", "LMN/USDC", 1000n, 5, 10)
  // before nextBlock
  let r = dca.executeAtBlock(5, ledger)
  assert.equal(r.executed.length, 0)
  // at nextBlock
  r = dca.executeAtBlock(10, ledger)
  assert.equal(r.executed.length, 1)
  assert.equal(r.executed[0].id, 1)
})

// ---- Yield ----

test("yield: create and get position", () => {
  const y = new YieldAggregator(":memory:")
  const pos = y.createPosition("LMN/USDC", "alice", 1000n)
  assert.equal(pos.staked, 1000n)
  assert.equal(pos.rewardDebt, 0n)
  const got = y.get("LMN/USDC", "alice")
  assert.ok(got)
  assert.equal(got!.staked, 1000n)
})

test("yield: compound adds rewardDebt to staked", () => {
  const y = new YieldAggregator(":memory:")
  y.createPosition("LMN/USDC", "alice", 1000n)
  // manually set rewardDebt
  y["db"].prepare("UPDATE yield_positions SET rewardDebt = '500' WHERE pool = ? AND owner = ?").run("LMN/USDC", "alice")
  const compounded = y.compound("LMN/USDC", "alice")
  assert.equal(compounded!.staked, 1500n)
  assert.equal(compounded!.rewardDebt, 0n)
})

test("yield: autoCompoundAll compounds all with rewards", () => {
  const y = new YieldAggregator(":memory:")
  const ledger = new Ledger()
  ledger.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  y.createPosition("LMN/USDC", "alice", 1000n)
  y["db"].prepare("UPDATE yield_positions SET rewardDebt = '200' WHERE pool = ? AND owner = ?").run("LMN/USDC", "alice")

  const result = y.autoCompoundAll(ledger, "LMN/USDC")
  assert.equal(result.compounded, 1)
  assert.equal(result.skipped, 0)
})

// ---- NFT ----

test("nft: mint creates NFT with owner", () => {
  const nft = new NFTMarketplace(":memory:")
  const created = nft.mint("alice", "ipfs://test-uri")
  assert.ok(created.id > 0)
  assert.equal(created.owner, "alice")
  assert.equal(created.creator, "alice")
  assert.equal(created.uri, "ipfs://test-uri")
})

test("nft: list requires ownership, buy transfers NFT and LMN", () => {
  const nft = new NFTMarketplace(":memory:")
  const ledger = new Ledger()
  ledger.get("alice").balance = 1_000_000n
  ledger.get("bob").balance = 2_000_000n

  const created = nft.mint("alice", "ipfs://x")
  const listing = nft.list(created.id, "alice", 500_000n)
  assert.ok(listing)
  assert.equal(listing.price, 500_000n)

  const result = nft.buy(created.id, "bob", ledger)
  assert.ok(result)
  assert.equal(result!.nft.owner, "bob")
  assert.equal(ledger.get("alice").balance, 1_500_000n) // 1_000_000 + 500_000
  assert.equal(ledger.get("bob").balance, 1_500_000n) // 2_000_000 - 500_000
})

test("nft: buy own NFT throws", () => {
  const nft = new NFTMarketplace(":memory:")
  const ledger = new Ledger()
  ledger.get("alice").balance = 1_000_000n
  const created = nft.mint("alice", "ipfs://x")
  nft.list(created.id, "alice", 100n)
  assert.throws(() => nft.buy(created.id, "alice", ledger), /собственный/)
})

test("nft: buy non-listed returns undefined", () => {
  const nft = new NFTMarketplace(":memory:")
  const ledger = new Ledger()
  const created = nft.mint("alice", "ipfs://x")
  const result = nft.buy(created.id, "bob", ledger)
  assert.equal(result, undefined)
})

// ---- CLI tests ----

test("CLI: order create и cancel", async () => {
  const home = makeHome({ wallet: true })
  const r1 = await runCli(["order", "create", "LMN/USDC", "1000", "10000"], home)
  assert.equal(r1.code, 0)
  assert.ok(r1.stdout.includes("ордер #"))

  const idMatch = r1.stdout.match(/#(\d+)/)
  assert.ok(idMatch)
  const id = idMatch[1]

  const r2 = await runCli(["order", "cancel", id], home)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("отменён"))
})

test("CLI: order create без аргументов — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["order", "create"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen order create"))
})

test("CLI: order cancel без id — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["order", "cancel"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen order cancel"))
})

test("CLI: dca create создаёт план", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["dca", "create", "LMN/USDC", "1000", "10"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("DCA план #"))
})

test("CLI: dca create без аргументов — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["dca", "create"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen dca create"))
})

test("CLI: yield auto работает", async () => {
  const r = await runCli(["yield", "auto", "LMN/USDC"])
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("авто-компаундинг"))
})

test("CLI: nft mint создаёт NFT", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["nft", "mint", "ipfs://test"], home)
  assert.equal(r.code, 0)
  assert.ok(r.stdout.includes("NFT #"))
})

test("CLI: nft mint без uri — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["nft", "mint"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen nft mint"))
})

test("CLI: nft list и buy", async () => {
  const sellerHome = makeHome({ wallet: true })
  const buyerHome = makeHome({ wallet: true })
  const r1 = await runCli(["nft", "mint", "ipfs://xyz"], sellerHome)
  const idMatch = r1.stdout.match(/#(\d+)/)
  assert.ok(idMatch)
  const id = idMatch[1]

  const r2 = await runCli(["nft", "list", id, "1000"], sellerHome)
  assert.equal(r2.code, 0)
  assert.ok(r2.stdout.includes("выставлен"))

  const r3 = await runCli(["nft", "buy", id], buyerHome)
  assert.equal(r3.code, 0)
  assert.ok(r3.stdout.includes("куплен"))
})

test("CLI: nft buy без id — exit 2", async () => {
  const home = makeHome({ wallet: true })
  const r = await runCli(["nft", "buy"], home)
  assert.equal(r.code, 2)
  assert.ok(r.stdout.includes("lumen nft buy"))
})
