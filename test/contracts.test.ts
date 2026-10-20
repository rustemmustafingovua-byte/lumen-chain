import { test } from "node:test"
import assert from "node:assert/strict"
import { Ledger, LedgerError, hexToBytes } from "../core/ledger.js"
import { assemble } from "../core/vm.js"
import { createWallet, buildTx } from "../core/rpc.js"

const hex = (bytes: number[]) => Buffer.from(bytes).toString("hex")

function funded(w = createWallet()) {
  const l = new Ledger()
  l.get(w.address).balance = 1_000_000_000_000n
  l.get(w.address).publicKey = w.publicKey
  return { l, w }
}

/**
 * Контракт-счётчик: при вызове увеличивает своё хранилище.
 * Конструктор ничего не возвращает — значит исполняемый код = код инициализации
 * (как в EVM, когда конструктор не отдаёт runtime-код).
 */
const COUNTER = assemble("PUSH1_0 SLOAD PUSH1_1 ADD PUSH1_0 SSTORE STOP")

test("контракт деплоится и появляется в состоянии", () => {
  const { l, w } = funded()
  const tx = buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(COUNTER)}` })
  l.apply(tx)
  assert.equal(l.contracts.size, 1)
  const addr = [...l.contracts.keys()][0]
  assert.match(addr, /^0x[0-9a-f]{40}$/)
})

test("вызов контракта меняет его хранилище", () => {
  const { l, w } = funded()
  l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(COUNTER)}` }))
  const addr = [...l.contracts.keys()][0]

  // конструктор отработал при деплое и оставил 1
  assert.equal(l.contracts.get(addr)!.storage.get("0"), "1")

  l.apply(buildTx(w, undefined, 0n, { nonce: 1, data: `call:${addr}:` }))
  assert.equal(l.contracts.get(addr)!.storage.get("0"), "2")

  l.apply(buildTx(w, undefined, 0n, { nonce: 2, data: `call:${addr}:` }))
  assert.equal(l.contracts.get(addr)!.storage.get("0"), "3")
})

test("вызов неизвестного контракта — ошибка", () => {
  const { l, w } = funded()
  assert.throws(
    () => l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: "call:0xdeadbeef:" })),
    /unknown contract/,
  )
})

test("кривой код контракта — ошибка, а не падение сети", () => {
  const { l, w } = funded()
  assert.throws(
    () => l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: "deploy:ff" })),
    LedgerError,
  )
})

test("state root учитывает состояние контрактов", () => {
  const { l, w } = funded()
  const before = l.stateRoot()
  l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(COUNTER)}` }))
  const afterDeploy = l.stateRoot()
  assert.notEqual(afterDeploy, before, "деплой меняет корень состояния")

  const addr = [...l.contracts.keys()][0]
  l.apply(buildTx(w, undefined, 0n, { nonce: 1, data: `call:${addr}:` }))
  assert.notEqual(l.stateRoot(), afterDeploy, "вызов меняет корень состояния")
})

test("корень состояния одинаков у узлов с одинаковой историей", () => {
  const w = createWallet()
  const a = funded(w)
  const b = funded(w)
  // одинаковый отправитель и код → одинаковый адрес контракта
  a.l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(COUNTER)}` }))
  b.l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(COUNTER)}` }))
  assert.equal(a.l.stateRoot(), b.l.stateRoot())
})

test("газ ограничивает бесконечный цикл в контракте", () => {
  const { l, w } = funded()
  const loop = assemble("PUSH1_3 JUMP JUMPDEST PUSH1_3 JUMP")
  l.maxContractGas = 1000n
  assert.throws(
    () => l.apply(buildTx(w, undefined, 0n, { nonce: 0, data: `deploy:${hex(loop)}` })),
    /out-of-gas/,
  )
})

test("hexToBytes разбирает байты", () => {
  assert.deepEqual(hexToBytes("00ff10"), [0, 255, 16])
  assert.deepEqual(hexToBytes("0x00ff"), [0, 255])
  assert.throws(() => hexToBytes("0"), /odd hex/)
  assert.throws(() => hexToBytes("zz"), /bad hex/)
})
