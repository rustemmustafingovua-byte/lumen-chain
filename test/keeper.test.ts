import { test } from "node:test"
import assert from "node:assert/strict"
import { decide, tick, sell, DEFAULT_POLICY, emptyState, type KeeperState } from "../keeper/keeper.js"
import { rollDay } from "../keeper/types.js"
import type { SwapQuote, Swapper } from "../keeper/types.js"

/** Подставной обменник: считает курс 1:2 и запоминает вызовы. */
class FakeSwapper implements Swapper {
  readonly symbol = "USDC"
  calls: { amountIn: bigint; minOut: bigint }[] = []
  rate = 2n
  failNext = false

  async quote(amountIn: bigint): Promise<SwapQuote> {
    return {
      amountOut: amountIn * this.rate,
      price: (amountIn * this.rate * 10n ** 18n) / amountIn,
      priceImpactBps: 0,
    }
  }

  async swap(amountIn: bigint, minAmountOut: bigint): Promise<string> {
    if (this.failNext) throw new Error("swap failed")
    this.calls.push({ amountIn, minOut: minAmountOut })
    return "0x" + "ab".repeat(32)
  }
}

const policy = { ...DEFAULT_POLICY, minAmount: 5n * 10n ** 6n, maxPerSwap: 100n * 10n ** 6n, maxPerDay: 200n * 10n ** 6n }

test("decide: ниже порога — ждём", () => {
  const d = decide(1n * 10n ** 6n, policy, emptyState())
  assert.equal(d.action, "skip")
})

test("decide: покупаем в пределах лимита", () => {
  const d = decide(50n * 10n ** 6n, policy, emptyState())
  assert.equal(d.action, "buy")
  assert.equal(d.action === "buy" ? d.amountIn : 0n, 50n * 10n ** 6n)
})

test("decide: упираемся в лимит за сделку", () => {
  const d = decide(500n * 10n ** 6n, policy, emptyState())
  assert.equal(d.action === "buy" ? d.amountIn : 0n, 100n * 10n ** 6n)
})

test("decide: упираемся в дневной лимит", () => {
  const state: KeeperState = { ...emptyState(), spentToday: 150n * 10n ** 6n }
  const d = decide(100n * 10n ** 6n, policy, state)
  assert.equal(d.action === "buy" ? d.amountIn : 0n, 50n * 10n ** 6n)
})

test("decide: дневной лимит исчерпан — ждём", () => {
  const state: KeeperState = { ...emptyState(), spentToday: 200n * 10n ** 6n }
  const d = decide(100n * 10n ** 6n, policy, state)
  assert.equal(d.action, "skip")
})

test("decide: проскальзывание выше лимита — не покупаем", () => {
  const d = decide(50n * 10n ** 6n, policy, emptyState(), {
    amountOut: 100n * 10n ** 6n,
    price: 2n,
    priceImpactBps: 500,
  })
  assert.equal(d.action, "skip")
})

test("tick: покупка, зачисление и журнал", async () => {
  const swapper = new FakeSwapper()
  const credited: { address: string; amount: bigint }[] = []
  const result = await tick(
    {
      swapper,
      creditor: {
        async credit(address, amount) {
          credited.push({ address, amount })
          return "0xdead"
        },
      },
      policy,
      state: emptyState(),
    },
    50n * 10n ** 6n,
    "lmn1target",
  )
  assert.equal(result.action, "buy")
  assert.equal(swapper.calls.length, 1)
  assert.equal(swapper.calls[0].amountIn, 50n * 10n ** 6n)
  // запас 2% от оценки
  assert.equal(swapper.calls[0].minOut, (100n * 10n ** 6n * 98n) / 100n)
  assert.equal(credited.length, 1)
  assert.equal(credited[0].address, "lmn1target")
  assert.equal(credited[0].amount, 100n * 10n ** 6n - (100n * 10n ** 6n * 50n) / 10000n)
})

test("tick: ниже порога — обмен не вызывается", async () => {
  const swapper = new FakeSwapper()
  const result = await tick({ swapper, policy, state: emptyState() }, 1n * 10n ** 6n, "lmn1target")
  assert.equal(result.action, "skip")
  assert.equal(swapper.calls.length, 0)
})

test("tick: падение обмена не ломает keeper", async () => {
  const swapper = new FakeSwapper()
  swapper.failNext = true
  await assert.rejects(
    () => tick({ swapper, policy, state: emptyState() }, 50n * 10n ** 6n, "lmn1target"),
    /swap failed/,
  )
})

test("sell: продажа LMN и соблюдение лимита", async () => {
  const swapper = new FakeSwapper()
  const r = await sell({ swapper, policy, state: emptyState() }, 20n * 10n ** 6n)
  assert.equal(r.action, "sell")
  assert.equal(swapper.calls.length, 1)

  const swapper2 = new FakeSwapper()
  const r2 = await sell({ swapper: swapper2, policy, state: { ...emptyState(), spentToday: 199n * 10n ** 6n } }, 20n * 10n ** 6n)
  assert.equal(r2.action, "skip")
  assert.equal(swapper2.calls.length, 0)
})

test("состояние: дневной лимит сбрасывается в новый день", () => {
  const state: KeeperState = { ...emptyState(), spentToday: 100n * 10n ** 6n, day: "2026-10-20" }
  const rolled = rollDay(state, new Date("2026-10-21T10:00:00Z"))
  assert.equal(rolled.spentToday, 0n)
  assert.equal(rolled.day, "2026-10-21")
})
