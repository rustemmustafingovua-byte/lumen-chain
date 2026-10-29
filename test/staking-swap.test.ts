/**
 * Stake and swap as chain transactions: signed, included in a block,
 * reflected in balances, and restored from disk. Also the devnet HTTP API.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Chain } from "../core/chain.js"
import {
  DEVNET_LIQUIDITY_LMN,
  DEVNET_LIQUIDITY_USDC,
  DEVNET_POOL,
  DEVNET_VALIDATOR_GRANT,
  DEVNET_VALIDATOR_USDC,
  devnetWallet,
  queueStake,
  queueSwap,
} from "../core/devnet.js"
import {
  EARLY_VALIDATORS_ADDRESS,
  FAUCET_ADDRESS,
  GENESIS_SUPPLY,
  MIN_STAKE,
  PREMINE_EARLY,
  TREASURY_ADDRESS,
  TX_FEE,
} from "../core/ledger.js"
import { createExplorerServer } from "../cli/explorer.js"
import { Persistence } from "../core/persist.js"

const FAUCET_GRANT = 100_000_000_000_000n

function devnet(): Chain {
  const chain = new Chain({ network: "devnet" })
  chain.genesis()
  return chain
}

function mine(chain: Chain, slot: number) {
  const w = devnetWallet()
  const txs = chain.mempool.take(100)
  const block = chain.propose(txs, w.privateKey, w.publicKey, slot)
  chain.accept(block)
  chain.rewardProposer(w.publicKey)
  return block
}

function conservedLmn(chain: Chain): bigint {
  return chain.ledger.totalSupply() + (chain.ledger.pool(DEVNET_POOL)?.base ?? 0n)
}

function conservedUsdc(chain: Chain): bigint {
  let assets = 0n
  for (const account of chain.ledger.accounts.values()) {
    assets += account.assets?.USDC ?? 0n
  }
  return assets + (chain.ledger.pool(DEVNET_POOL)?.quote ?? 0n)
}

test("devnet genesis funds a validator and an LMN/USDC pool without minting", () => {
  const chain = devnet()
  const w = devnetWallet()
  const account = chain.ledger.get(w.address)
  assert.equal(chain.network, "devnet")
  assert.equal(account.publicKey, w.publicKey)
  assert.equal(account.stake, MIN_STAKE)
  assert.equal(account.balance, DEVNET_VALIDATOR_GRANT - MIN_STAKE)
  assert.equal(chain.ledger.assetBalance(w.address, "USDC"), DEVNET_VALIDATOR_USDC)
  assert.equal(chain.validators.get(w.publicKey)?.stake, MIN_STAKE)
  assert.equal(chain.ledger.balance(FAUCET_ADDRESS), FAUCET_GRANT - DEVNET_VALIDATOR_GRANT)
  assert.equal(chain.ledger.balance(TREASURY_ADDRESS), (GENESIS_SUPPLY * 60n) / 100n - DEVNET_LIQUIDITY_LMN)
  const pool = chain.ledger.pool(DEVNET_POOL)!
  assert.equal(pool.base, DEVNET_LIQUIDITY_LMN)
  assert.equal(pool.quote, DEVNET_LIQUIDITY_USDC)
  assert.equal(pool.feeBps, 30n)
  assert.equal(conservedLmn(chain), GENESIS_SUPPLY + FAUCET_GRANT)
  assert.equal(conservedUsdc(chain), DEVNET_LIQUIDITY_USDC + DEVNET_VALIDATOR_USDC)
})

test("stake is included in a block, pays the early-validator bonus, and updates weight", () => {
  const chain = devnet()
  const w = devnetWallet()
  const before = chain.ledger.balance(w.address)
  const earlyBefore = chain.ledger.balance(EARLY_VALIDATORS_ADDRESS)
  const tx = queueStake(chain, w, MIN_STAKE)
  assert.equal(chain.mempool.size, 1)

  const block = mine(chain, 1)
  const proposerCut = TX_FEE - (TX_FEE * 80n) / 100n
  assert.equal(block.txs.length, 1)
  assert.equal(block.txs[0].signature, tx.signature)
  assert.equal(chain.height, 1)
  assert.equal(chain.ledger.get(w.address).stake, MIN_STAKE * 2n)
  // Stake amount comes back as the early-validator bonus; the fee is split and the proposer cut returns.
  assert.equal(chain.ledger.balance(w.address), before - TX_FEE + proposerCut)
  assert.equal(chain.ledger.balance(EARLY_VALIDATORS_ADDRESS), earlyBefore - MIN_STAKE)
  assert.equal(chain.ledger.balance(EARLY_VALIDATORS_ADDRESS), PREMINE_EARLY - MIN_STAKE)
  assert.equal(chain.validators.get(w.publicKey)?.stake, MIN_STAKE * 2n)
  assert.equal(chain.ledger.get(w.address).nonce, 1)
  assert.equal(conservedLmn(chain), GENESIS_SUPPLY + FAUCET_GRANT - (TX_FEE * 40n) / 100n)
})

test("stake below the minimum does not move funds", () => {
  const chain = devnet()
  const w = devnetWallet()
  const before = chain.ledger.balance(w.address)
  assert.throws(() => queueStake(chain, w, MIN_STAKE - 1n), /stake below minimum/)
  assert.equal(chain.ledger.balance(w.address), before)
  assert.equal(chain.ledger.get(w.address).stake, MIN_STAKE)
  assert.equal(chain.mempool.size, 0)
})

test("selling LMN and buying it back moves the pool and keeps both assets conserved", () => {
  const chain = devnet()
  const w = devnetWallet()
  const sellAmount = 1_000_000n
  const lmnBefore = chain.ledger.balance(w.address)
  const usdcBefore = chain.ledger.assetBalance(w.address, "USDC")
  const poolBefore = chain.ledger.pool(DEVNET_POOL)!
  const baseBefore = poolBefore.base
  const quoteBefore = poolBefore.quote
  const kBefore = baseBefore * quoteBefore
  const quoted = chain.ledger.quoteSwap(DEVNET_POOL, sellAmount)

  queueSwap(chain, w, "sell", sellAmount)
  mine(chain, 1)
  const proposerCut = TX_FEE - (TX_FEE * 80n) / 100n

  const poolAfterSell = chain.ledger.pool(DEVNET_POOL)!
  assert.equal(chain.ledger.balance(w.address), lmnBefore - sellAmount - TX_FEE + proposerCut)
  assert.equal(chain.ledger.assetBalance(w.address, "USDC"), usdcBefore + quoted)
  assert.equal(poolAfterSell.base, baseBefore + sellAmount)
  assert.equal(poolAfterSell.quote, quoteBefore - quoted)
  assert.ok(poolAfterSell.base * poolAfterSell.quote > kBefore, "swap fee stays in the pool")

  const buyAmount = quoted / 2n
  const quotedLmn = chain.ledger.quoteBuy(DEVNET_POOL, buyAmount)
  const lmnMid = chain.ledger.balance(w.address)
  const usdcMid = chain.ledger.assetBalance(w.address, "USDC")
  queueSwap(chain, w, "buy", buyAmount)
  mine(chain, 2)

  assert.equal(chain.ledger.assetBalance(w.address, "USDC"), usdcMid - buyAmount)
  assert.equal(chain.ledger.balance(w.address), lmnMid + quotedLmn - TX_FEE + proposerCut)
  assert.ok(quotedLmn > 0n)
  assert.equal(conservedLmn(chain), GENESIS_SUPPLY + FAUCET_GRANT - ((TX_FEE * 40n) / 100n) * 2n)
  assert.equal(conservedUsdc(chain), DEVNET_LIQUIDITY_USDC + DEVNET_VALIDATOR_USDC)
  assert.notEqual(chain.ledger.stateRoot(), "")
})

test("a swap against an empty pool is rejected before the balance changes", () => {
  const chain = new Chain()
  chain.genesis()
  const w = devnetWallet()
  chain.ledger.get(w.address).balance = 1_000_000_000_000n
  chain.ledger.get(w.address).publicKey = w.publicKey
  const before = chain.ledger.balance(w.address)
  assert.throws(() => queueSwap(chain, w, "sell", 1_000n), /swap yields nothing/)
  assert.equal(chain.ledger.balance(w.address), before)
  assert.equal(chain.mempool.size, 0)
})

test("stake and swap survive a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lumen-devnet-"))
  const db = join(dir, "chain.db")
  const chain = devnet()
  chain.persist = new Persistence(db)
  const w = devnetWallet()
  queueStake(chain, w, MIN_STAKE)
  queueSwap(chain, w, "sell", 2_000_000n)
  mine(chain, 1)
  const root = chain.ledger.stateRoot()
  const stake = chain.ledger.get(w.address).stake
  const usdc = chain.ledger.assetBalance(w.address, "USDC")
  const height = chain.height

  const restored = new Chain()
  restored.persist = new Persistence(db)
  assert.equal(await restored.restoreFromPersistence(), true)
  assert.equal(restored.network, "devnet")
  assert.equal(restored.height, height)
  assert.equal(restored.ledger.stateRoot(), root)
  assert.equal(restored.ledger.get(w.address).stake, stake)
  assert.equal(restored.ledger.assetBalance(w.address, "USDC"), usdc)
  assert.equal(restored.ledger.pool(DEVNET_POOL)!.base, chain.ledger.pool(DEVNET_POOL)!.base)
  assert.equal(restored.validators.get(w.publicKey)?.stake, stake)
  chain.persist.close()
  restored.persist?.close()
})

test("devnet HTTP stake and swap are included when the node produces a block", async () => {
  const chain = devnet()
  const w = devnetWallet()
  const server = createExplorerServer({ chain, wallet: w, devnet: true })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  const base = `http://127.0.0.1:${port}`
  try {
    const info = await fetch(`${base}/api/devnet/info`).then((r) => r.json()) as { address: string; chainId: string; stake: string }
    assert.equal(info.address, w.address)
    assert.equal(info.chainId, "lumen-devnet")
    assert.equal(info.stake, MIN_STAKE.toString())

    const denied = await fetch(`${base}/api/devnet/stake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "1" }),
    })
    assert.equal(denied.status, 400)

    const queued = await fetch(`${base}/api/devnet/stake`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: MIN_STAKE.toString() }),
    })
    assert.equal(queued.status, 202)
    mine(chain, 1)
    const staked = await fetch(`${base}/api/devnet/info`).then((r) => r.json()) as { stake: string; usdc: string }
    assert.equal(staked.stake, (MIN_STAKE * 2n).toString())

    const swap = await fetch(`${base}/api/devnet/swap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ direction: "sell", amount: "1000000" }),
    })
    assert.equal(swap.status, 202)
    const usdcBefore = BigInt(staked.usdc)
    mine(chain, 2)
    const after = await fetch(`${base}/api/devnet/info`).then((r) => r.json()) as { usdc: string; balance: string }
    assert.ok(BigInt(after.usdc) > usdcBefore)

    const rpc = await fetch(`${base}/api/rpc`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "lumen_getAssetBalance", params: [w.address, "USDC"] }),
    }).then((r) => r.json()) as { result: string }
    assert.equal(rpc.result, after.usdc)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
})

test("devnet routes stay closed unless the node is a devnet", async () => {
  const chain = new Chain()
  chain.genesis()
  const server = createExplorerServer({ chain })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/devnet/info`)
    assert.equal(res.status, 404)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())))
  }
})
