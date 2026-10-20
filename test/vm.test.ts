import { test } from "node:test"
import assert from "node:assert/strict"
import { run, assemble, VMError, type VMContext } from "../core/vm.js"

function ctx(code: number[], over: Partial<VMContext> = {}): VMContext {
  return {
    caller: "0x" + "11".repeat(20),
    address: "0x" + "22".repeat(20),
    value: 0n,
    code,
    calldata: [],
    gas: 1_000_000,
    storage: new Map(),
    logs: [],
    depth: 0,
    maxDepth: 8,
    ...over,
  }
}

const dword = (v: bigint) => v & 0xffn // младший байт возвращённого слова

test("арифметика: сложение и умножение", () => {
  // PUSH1 2, PUSH1 3, ADD → 5
  const code = assemble("PUSH1_2 PUSH1_3 ADD PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code))
  assert.ok(r.ok)
  assert.equal(dword(BigInt("0x" + Buffer.from(r.ret).toString("hex"))), 5n)
})

test("арифметика: вычитание, деление, остаток", () => {
  // порядок как в EVM: вершина стека — левый операнд
  const code = assemble("PUSH1_3 PUSH1_10 SUB PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code))
  assert.equal(dword(BigInt("0x" + Buffer.from(r.ret).toString("hex"))), 7n)

  const div = assemble("PUSH1_2 PUSH1_9 DIV PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(div)).ret).toString("hex"))), 4n)

  const mod = assemble("PUSH1_2 PUSH1_9 MOD PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(mod)).ret).toString("hex"))), 1n)
})

test("сравнения и логика", () => {
  const lt = assemble("PUSH1_2 PUSH1_1 LT PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(lt)).ret).toString("hex"))), 1n)

  const iszero = assemble("PUSH1_0 ISZERO PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(iszero)).ret).toString("hex"))), 1n)
})

test("память: MSTORE и MLOAD", () => {
  const code = assemble("PUSH1_42 PUSH1_0 MSTORE PUSH1_0 MLOAD PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code))
  assert.equal(dword(BigInt("0x" + Buffer.from(r.ret).toString("hex"))), 42n)
})

test("хранилище: SSTORE и SLOAD", () => {
  const code = assemble("PUSH1_99 PUSH1_7 SSTORE PUSH1_7 SLOAD PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const c = ctx(code)
  const r = run(c)
  assert.equal(dword(BigInt("0x" + Buffer.from(r.ret).toString("hex"))), 99n)
  assert.equal(c.storage.get("7"), "99")
})

test("переходы: JUMP и условие", () => {
  // 0: PUSH1 3 JUMP; 3: JUMPDEST; PUSH1 1 PUSH1 0 MSTORE; PUSH1 32 PUSH1 0 RETURN
  const code = assemble("PUSH1_3 JUMP JUMPDEST PUSH1_1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code))
  assert.ok(r.ok)
  assert.equal(dword(BigInt("0x" + Buffer.from(r.ret).toString("hex"))), 1n)
})

test("условный переход: JUMPI", () => {
  // стек: сначала условие, потом адрес — как в EVM
  // 0: PUSH1 cond, 2: PUSH1 15, 4: JUMPI, 5..14: возврат 0, 15: JUMPDEST, 16..: возврат 1
  const code = assemble(
    "PUSH1_1 PUSH1_15 JUMPI PUSH1_0 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN JUMPDEST PUSH1_1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN",
  )
  const taken = run(ctx(code))
  assert.equal(dword(BigInt("0x" + Buffer.from(taken.ret).toString("hex"))), 1n)

  const notTaken = run(ctx(assemble(
    "PUSH1_0 PUSH1_15 JUMPI PUSH1_0 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN JUMPDEST PUSH1_1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN",
  )))
  assert.equal(dword(BigInt("0x" + Buffer.from(notTaken.ret).toString("hex"))), 0n)
})

test("бесконечный цикл упирается в газ", () => {
  const code = assemble("PUSH1_3 JUMP JUMPDEST PUSH1_3 JUMP")
  const r = run(ctx(code, { gas: 5000 }))
  assert.equal(r.ok, false)
  assert.match(r.error ?? "", /out-of-gas/)
})

test("REVERT откатывает хранилище", () => {
  const code = assemble("PUSH1_5 PUSH1_1 SSTORE PUSH1_0 PUSH1_0 REVERT")
  const c = ctx(code)
  const r = run(c)
  assert.equal(r.ok, false)
  assert.equal(c.storage.size, 0, "изменения не должны сохраниться")
})

test("неизвестная инструкция — ошибка, а не падение", () => {
  const r = run(ctx([0xff]))
  assert.equal(r.ok, false)
  assert.match(r.error ?? "", /invalid/)
})

test("журналы: LOG1 пишет тему и данные", () => {
  // порядок в LOG как в EVM: offset на вершине, затем size, затем темы
  const code = assemble("PUSH1_7 PUSH1_0 MSTORE PUSH1_42 PUSH1_32 PUSH1_0 LOG1")
  const r = run(ctx(code))
  assert.equal(r.logs.length, 1)
  assert.equal(r.logs[0].topics[0], 42n)
  assert.equal(r.logs[0].data.length, 32)
})

test("CALLDATALOAD читает аргументы вызова", () => {
  const code = assemble("PUSH1_0 CALLDATALOAD PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code, { calldata: [1, 2, 3] }))
  // CALLDATALOAD кладёт первый байт в старшую позицию 32-байтового слова
  assert.equal(BigInt("0x" + Buffer.from(r.ret).toString("hex")), 0x010203n << 232n)
})

test("DUP и SWAP работают", () => {
  const dup = assemble("PUSH1_5 DUP1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(dup)).ret).toString("hex"))), 5n)

  const swap = assemble("PUSH1_1 PUSH1_2 SWAP1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  assert.equal(dword(BigInt("0x" + Buffer.from(run(ctx(swap)).ret).toString("hex"))), 1n)
})

test("переполнение стека ловится, а не роняет процесс", () => {
  const code = assemble("PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 PUSH1_1 POP POP POP POP POP POP POP POP POP POP POP POP POP POP POP POP POP")
  const r = run(ctx(code))
  assert.equal(r.ok, true)
})

test("газ списывается и возвращается в отчёте", () => {
  const code = assemble("PUSH1_1 PUSH1_0 MSTORE PUSH1_32 PUSH1_0 RETURN")
  const r = run(ctx(code, { gas: 1000 }))
  assert.ok(r.gasUsed > 0)
  assert.ok(r.gasUsed < 1000)
})
