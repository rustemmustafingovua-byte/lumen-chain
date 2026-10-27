/**
 * Кастомные утверждения для тестов Lumen.
 */
import assert from "node:assert/strict"
import { Chain } from "../../core/chain.js"
import { MIN_STAKE } from "../../core/ledger.js"

export function assertEqual(actual: unknown, expected: unknown, message = ""): void {
  assert.strictEqual(actual, expected, message)
}

export function assertBlockHeight(chain: Chain, expected: number, message = ""): void {
  assert.strictEqual(
    chain.height,
    expected,
    message || `ожидалась высота ${expected}, получена ${chain.height}`,
  )
}

export function assertBlockPropagated(source: Chain, target: Chain, message = ""): void {
  assert.strictEqual(
    source.head?.hash,
    target.head?.hash,
    message || "блок не распространился между узлами",
  )
}

export function assertConsensusReached(chain: Chain, message = ""): void {
  assert.ok(
    chain.isFinalized(),
    message || `консенсус не достигнут: стейк ${chain.totalStake()}`,
  )
}

export function assertTransactionInBlock(chain: Chain, txSignature: string): void {
  const found = chain.blocks.some((b) => b.txs.some((t) => t.signature === txSignature))
  assert.ok(found, `транзакция не найдена в цепочке: ${txSignature.slice(0, 16)}...`)
}

export function assertBalance(chain: Chain, address: string, expected: bigint): void {
  assert.strictEqual(
    chain.ledger.balance(address),
    expected,
    `баланс ${address} не совпадает`,
  )
}

export function assertValidatorStaked(chain: Chain, publicKey: string, minExpected: bigint = MIN_STAKE): void {
  const v = chain.validators.get(publicKey)
  assert.ok(v, `валидатор не найден: ${publicKey.slice(0, 16)}...`)
  assert.ok(
    v.stake >= minExpected,
    `стейк ${v.stake} меньше минимального ${minExpected}`,
  )
}
