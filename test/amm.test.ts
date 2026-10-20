import { test } from "node:test"
import assert from "node:assert/strict"
import { Ledger, AMM_FEE_BPS } from "../core/ledger.js"

/**
 * Доли LP: вкладчику принадлежит часть пула, чужие доли вывести нельзя,
 * комиссия остаётся в пуле и повышает цену доли.
 */
test("добавление ликвидности выпускает доли", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  const shares = l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  assert.equal(shares, 1_000_000n)
  assert.equal(l.sharesOf(key, "alice"), 1_000_000n)
  assert.equal(l.pool(key)!.totalShares, 1_000_000n)
})

test("второй вкладчик получает пропорциональные доли", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  const bob = l.addLiquidity("LMN", "USDC", 500_000n, 1_000_000n, "bob")
  assert.equal(bob, 500_000n)
  assert.equal(l.pool(key)!.totalShares, 1_500_000n)
  assert.equal(l.sharesOf(key, "bob"), 500_000n)
})

test("чужие доли вывести нельзя", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  assert.throws(() => l.removeLiquidity(key, "bob"), /no shares/)
  assert.throws(() => l.removeLiquidity(key, "alice", 2_000_000n), /not enough shares/)
})

test("вывод ликвидности возвращает пропорциональные резервы", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "alice")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 2_000_000n, "bob")
  const [base, quote] = l.removeLiquidity(key, "alice")
  assert.equal(base, 1_000_000n)
  assert.equal(quote, 2_000_000n)
  assert.equal(l.pool(key)!.totalShares, 1_000_000n)
  assert.equal(l.sharesOf(key, "alice"), 0n)
  assert.equal(l.sharesOf(key, "bob"), 1_000_000n)
})

test("комиссия остаётся в пуле и повышает цену доли", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  const before = l.pool(key)!
  const priceBefore = (before.base * 1_000_000n) / before.totalShares

  // покупаем LMN за USDC: комиссия 0.3% остаётся в пуле
  const out = l.swap(key, 100_000n) // продаём 100k LMN в пул
  assert.ok(out > 0n)
  const after = l.pool(key)!
  assert.equal(after.totalShares, before.totalShares) // доли не меняются при свопах
  const priceAfter = (after.base * 1_000_000n) / after.totalShares
  assert.ok(priceAfter > priceBefore, "цена доли должна вырасти после комиссии")
})

test("комиссия остаётся в резерве пула", () => {
  const l = new Ledger()
  const key = l.poolKey("LMN", "USDC")
  l.addLiquidity("LMN", "USDC", 1_000_000n, 1_000_000n, "alice")
  const fee = (100_000n * AMM_FEE_BPS) / 10_000n
  const out = l.swap(key, 100_000n)
  const p = l.pool(key)!
  // пул получает весь base (включая комиссию), но отдаёт quote как будто получил effIn
  assert.equal(p.base, 1_100_000n)
  assert.equal(p.quote, 1_000_000n - out)
  // и потому комиссия физически лежит в базовом резерве
  assert.ok(p.base - 1_000_000n > fee)
  // цена доли при этом выросла
  const priceBefore = 1_000_000n
  const priceAfter = (p.base * 1_000_000n) / p.totalShares
  assert.ok(priceAfter > priceBefore)
})

test("пустое добавление ликвидности отвергается", () => {
  const l = new Ledger()
  assert.throws(() => l.addLiquidity("LMN", "USDC", 0n, 1_000n, "alice"), /positive/)
  assert.throws(() => l.addLiquidity("LMN", "USDC", 1_000n, 0n, "alice"), /positive/)
})
