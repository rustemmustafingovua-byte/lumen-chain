import { test } from "node:test"
import assert from "node:assert/strict"
import { Chain, merkleRoot, blockHash } from "../core/chain.js"
import { Ledger, TX_FEE, MIN_STAKE, GENESIS_SUPPLY, stringify } from "../core/ledger.js"
import { createWallet, buildTx, makeRpc } from "../core/rpc.js"
import { addressFromPublicKey, verify, sha256 } from "../core/crypto.js"

function fundedChain() {
  const chain = new Chain()
  chain.genesis()
  const val = createWallet()
  chain.ledger.get(val.address).balance = 1_000_000_000_000n
  chain.ledger.get(val.address).publicKey = val.publicKey
  chain.addValidator(val.publicKey, MIN_STAKE * 10n)
  return { chain, val }
}

test("адреса детерминированы и валидны", () => {
  const w = createWallet()
  assert.match(w.address, /^[1-9A-HJ-NP-Za-km-z]{30,64}$/)
  assert.equal(addressFromPublicKey(w.publicKey), w.address)
})

test("подпись транзакции проверяется реестром", () => {
  const { chain, val } = fundedChain()
  const dest = createWallet().address
  const tx = buildTx(val, dest, 1000n, { nonce: 0 })
  const ok = chain.ledger.apply(tx)
  assert.equal(ok, true)
  assert.equal(chain.ledger.balance(dest), 1000n)
  assert.equal(chain.ledger.balance(val.address), 1_000_000_000_000n - 1000n - TX_FEE)
})

test("подделка подписи отвергается", () => {
  const { chain, val } = fundedChain()
  const tx = buildTx(val, createWallet().address, 1000n, { nonce: 0 })
  tx.amount = 999_999n
  assert.throws(() => chain.ledger.apply(tx), /bad signature/)
})

test("неверный nonce отвергается", () => {
  const { chain, val } = fundedChain()
  const tx = buildTx(val, createWallet().address, 1n, { nonce: 7 })
  assert.throws(() => chain.ledger.apply(tx), /bad nonce/)
})

test("стейкинг и анстейкинг меняют баланс", () => {
  const { chain, val } = fundedChain()
  const before = chain.ledger.balance(val.address)
  const stakeTx = buildTx(val, undefined, MIN_STAKE, { nonce: 0, data: "stake:" })
  chain.ledger.apply(stakeTx)
  assert.equal(chain.ledger.get(val.address).stake, MIN_STAKE)
  assert.equal(chain.ledger.balance(val.address), before - MIN_STAKE - TX_FEE)
  const unstakeTx = buildTx(val, undefined, MIN_STAKE, { nonce: 1, data: "unstake:" })
  chain.ledger.apply(unstakeTx)
  assert.equal(chain.ledger.get(val.address).stake, 0n)
})

test("блок проверяется: высота, prevHash, подпись, меркл", () => {
  const { chain, val } = fundedChain()
  const tx = buildTx(val, createWallet().address, 5n, { nonce: 0 })
  const b = chain.propose([tx], val.privateKey, val.publicKey, 1)
  assert.equal(b.header.merkleRoot, merkleRoot([sha256(stringify(tx))]))
  assert.equal(b.hash, blockHash(b))
  chain.accept(b)
  assert.equal(chain.height, 1)

  const bad = { ...b, header: { ...b.header, height: 5 } }
  assert.throws(() => chain.accept(bad), /bad height/)

  // следующий блок с испорченной подписью
  const tx2 = buildTx(val, createWallet().address, 7n, { nonce: 1 })
  const b2 = chain.propose([tx2], val.privateKey, val.publicKey, 2)
  const badSig = { ...b2, signature: "AAAA" }
  assert.throws(() => chain.accept(badSig), /bad (block )?signature/)
})

test("продюсер выбирается по весу стейка", () => {
  const { chain } = fundedChain()
  const p = chain.proposerForSlot(7)
  assert.ok(p)
  assert.equal(p, chain.proposerForSlot(7))
})

test("AMM: постоянное произведение и комиссия", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n)
  const out = l.quoteSwap(key, 1000n)
  assert.ok(out > 0n && out < 1000n, "curve must give less than the input")
  const beforeBase = l.pool(key)!.base
  const beforeQuote = l.pool(key)!.quote
  l.swap(key, 1000n)
  assert.equal(l.pool(key)!.base, beforeBase + 1000n)
  assert.ok(l.pool(key)!.quote < beforeQuote)
})

test("RPC отдаёт состояние", () => {
  const { chain, val } = fundedChain()
  const rpc = makeRpc(chain)
  assert.equal(rpc("lumen_blockNumber"), 0) // после генезиса высота головы = 0
  assert.equal(rpc("lumen_getBalance", [val.address]), (1_000_000_000_000n).toString())
  assert.equal(rpc("lumen_chainId"), "lumen-mainnet")
})

test("подпись блока проверяется публичным ключом валидатора", () => {
  const { chain, val } = fundedChain()
  const b = chain.propose([], val.privateKey, val.publicKey, 1)
  assert.equal(verify(val.publicKey, blockHash(b), b.signature), true)
})
