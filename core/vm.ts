/**
 * Lumen VM — стековая машина для смарт-контрактов внутри цепи.
 *
 * Это не EVM, а компактный аналог: стек, память, хранилище, журналы, газ.
 * Зато контракт исполняется на каждом узле сети, а его состояние входит
 * в state root — то есть его нельзя подделать и переписать историю.
 *
 * Код контракта — массив байтов, как в EVM. Инструкции — те же номера,
 * чтобы переносить логику было привычно.
 *
 * Порядок операндов — как в EVM: первым снимается вершина стека, она же
 * левый операнд. То есть `PUSH1 3 PUSH1 10 SUB` даёт 7 (10 − 3).
 *
 * Ограничения (осознанные, документированы в docs/VM.md):
 *   - нет KECCAK256 (используется SHA-256 из node:crypto)
 *   - нет внешних вызовов, кроме вызовов контракт→контракт
 *   - газ считается просто: стоимость операции + память + хранение
 */
import { createHash } from "node:crypto"

export const GAS_CODESIZE = 2
export const GAS_COPY = 3
export const GAS_MEMORY = 3
export const GAS_STORAGE_SET = 20000
export const GAS_STORAGE_UPDATE = 5000
export const GAS_LOG = 375
export const GAS_JUMPDEST = 1

export class VMError extends Error {
  constructor(
    message: string,
    readonly reason: "revert" | "out-of-gas" | "invalid" | "stack" | "memory",
  ) {
    super(message)
  }
}

export type Log = { topics: bigint[]; data: number[] }

export type ContractState = {
  /** Код контракта. */
  code: number[]
  /** Хранилище: ключ → значение. */
  storage: Map<string, string>
  /** Баланс контракта. */
  balance: bigint
}

export type VMContext = {
  /** Кто вызывает. */
  caller: string
  /** Адрес контракта. */
  address: string
  /** Значение перевода. */
  value: bigint
  /** Код контракта. */
  code: number[]
  /** Данные вызова. */
  calldata: number[]
  /** Газ. */
  gas: number
  /** Хранилище (изменения фиксируются только при успешном завершении). */
  storage: Map<string, string>
  /** Журналы. */
  logs: Log[]
  /** Счётчик вызовов. */
  depth: number
  /** Предел глубины вложенных вызовов. */
  maxDepth: number
}

export type VMResult = {
  ok: boolean
  /** Данные возврата. */
  ret: number[]
  /** Израсходованный газ. */
  gasUsed: number
  logs: Log[]
  error?: string
}

const STACK_LIMIT = 1024
const MEM_LIMIT = 1 << 20

export function sha256Bytes(data: number[]): number[] {
  return [...createHash("sha256").update(Buffer.from(data)).digest()]
}

/** Контракт из кода. */
export function makeContract(code: number[], balance = 0n): ContractState {
  return { code, storage: new Map(), balance }
}

/** Запустить код в контексте. */
export function run(ctx: VMContext): VMResult {
  const stack: bigint[] = []
  const memory: number[] = []
  const memWords = () => Math.ceil(memory.length / 32)
  let pc = 0
  let gas = ctx.gas
  const logs: Log[] = []
  // откат хранилища при revert: сначала копия, применяем в конце
  const storageBackup = new Map(ctx.storage)

  const useGas = (n: number) => {
    gas -= n
    if (gas < 0) throw new VMError("out of gas", "out-of-gas")
  }
  const memSize = (offset: bigint, len: bigint) => {
    if (offset < 0n || len < 0n) throw new VMError("negative memory access", "memory")
    const need = Number(offset + len)
    if (need > MEM_LIMIT) throw new VMError("memory limit", "memory")
    if (need > memory.length) memory.length = need
  }
  const push = (v: bigint) => {
    if (stack.length >= STACK_LIMIT) throw new VMError("stack overflow", "stack")
    stack.push(v)
  }
  const pop = (): bigint => {
    if (!stack.length) throw new VMError("stack underflow", "stack")
    return stack.pop()!
  }
  const mload = (offset: bigint): bigint => {
    memSize(offset, 32n)
    const off = Number(offset)
    let v = 0n
    // байты идут от старшего к младшему — собираем слово в том же порядке
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(memory[off + i] ?? 0)
    return v
  }
  const mstore = (offset: bigint, value: bigint) => {
    memSize(offset, 32n)
    const off = Number(offset)
    for (let i = 0; i < 32; i++) {
      memory[off + i] = Number((value >> BigInt(8 * (31 - i))) & 0xffn)
    }
  }
  const sload = (key: bigint): bigint => {
    useGas(GAS_STORAGE_SET - GAS_STORAGE_UPDATE + GAS_STORAGE_UPDATE - GAS_STORAGE_SET) // стоимость чтения — 0
    const v = ctx.storage.get(key.toString())
    return v === undefined ? 0n : BigInt(v)
  }
  const sstore = (key: bigint, value: bigint) => {
    const existed = ctx.storage.has(key.toString())
    useGas(existed ? GAS_STORAGE_UPDATE : GAS_STORAGE_SET)
    if (value === 0n) ctx.storage.delete(key.toString())
    else ctx.storage.set(key.toString(), value.toString())
  }

  try {
    for (;;) {
      if (pc >= ctx.code.length) break
      const op = ctx.code[pc]
      switch (op) {
        case 0x00: // STOP
          pc++
          break
        case 0x01: {
          // ADD
          const a = pop()
          const b = pop()
          push(a + b)
          pc++
          break
        }
        case 0x02: {
          // MUL
          const a = pop()
          const b = pop()
          push(a * b)
          pc++
          break
        }
        case 0x03: {
          // SUB
          const a = pop()
          const b = pop()
          push(a - b)
          pc++
          break
        }
        case 0x04: {
          // DIV
          const a = pop()
          const b = pop()
          push(b === 0n ? 0n : a / b)
          pc++
          break
        }
        case 0x05: {
          // SDIV
          const a = pop()
          const b = pop()
          push(b === 0n ? 0n : a / b)
          pc++
          break
        }
        case 0x06: {
          // MOD
          const a = pop()
          const b = pop()
          push(b === 0n ? 0n : a % b)
          pc++
          break
        }
        case 0x10: {
          // LT
          const a = pop()
          const b = pop()
          push(a < b ? 1n : 0n)
          pc++
          break
        }
        case 0x11: {
          // GT
          const a = pop()
          const b = pop()
          push(a > b ? 1n : 0n)
          pc++
          break
        }
        case 0x14: {
          // EQ
          const a = pop()
          const b = pop()
          push(a === b ? 1n : 0n)
          pc++
          break
        }
        case 0x15: {
          // ISZERO
          push(pop() === 0n ? 1n : 0n)
          pc++
          break
        }
        case 0x16: {
          // AND
          const a = pop()
          const b = pop()
          push(a & b)
          pc++
          break
        }
        case 0x17: {
          // OR
          const a = pop()
          const b = pop()
          push(a | b)
          pc++
          break
        }
        case 0x18: {
          // NOT
          const v = pop()
          push(~v & ((1n << 256n) - 1n))
          pc++
          break
        }
        case 0x19: {
          // BYTE
          const i = pop()
          const x = pop()
          push(i > 31n ? 0n : (x >> (8n * (31n - i))) & 0xffn)
          pc++
          break
        }
        case 0x30: {
          // ADDRESS
          push(BigInt("0x" + ctx.address.replace(/^0x/, "").padStart(64, "0")))
          pc++
          break
        }
        case 0x33: {
          // CALLER
          push(BigInt("0x" + ctx.caller.replace(/^0x/, "").padStart(64, "0")))
          pc++
          break
        }
        case 0x34: {
          // CALLVALUE
          push(ctx.value)
          pc++
          break
        }
        case 0x36: {
          // CALLDATASIZE
          push(BigInt(ctx.calldata.length))
          pc++
          break
        }
        case 0x37: {
          // CALLDATALOAD
          const off = Number(pop() & 0xffn)
          let v = 0n
          for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(ctx.calldata[off + i] ?? 0)
          push(v)
          pc++
          break
        }
        case 0x39: {
          // CODESIZE
          push(BigInt(ctx.code.length))
          pc++
          break
        }
        case 0x3d: {
          // RETURNDATASIZE
          push(0n)
          pc++
          break
        }
        case 0x50:
          // POP
          pop()
          pc++
          break
        case 0x51:
          // MLOAD
          push(mload(pop()))
          pc++
          break
        case 0x52: {
          // MSTORE
          const off = pop()
          const val = pop()
          useGas(GAS_MEMORY)
          mstore(off, val)
          pc++
          break
        }
        case 0x53: {
          // MSTORE8
          const off = pop()
          const val = pop()
          memSize(off, 1n)
          memory[Number(off)] = Number(val & 0xffn)
          pc++
          break
        }
        case 0x54:
          // SLOAD
          push(sload(pop()))
          pc++
          break
        case 0x55: {
          // SSTORE
          const key = pop()
          const val = pop()
          sstore(key, val)
          pc++
          break
        }
        case 0x56: {
          // JUMP
          const dest = Number(pop() & 0xffffn)
          if (ctx.code[dest] !== 0x5b) throw new VMError("bad jump", "invalid")
          useGas(GAS_JUMPDEST)
          pc = dest
          break
        }
        case 0x57: {
          // JUMPI
          const dest = Number(pop() & 0xffffn)
          const cond = pop()
          if (cond !== 0n) {
            if (ctx.code[dest] !== 0x5b) throw new VMError("bad jump", "invalid")
            useGas(GAS_JUMPDEST)
            pc = dest
          } else pc++
          break
        }
        case 0x58:
          // PC
          push(BigInt(pc))
          pc++
          break
        case 0x59:
          // MSIZE
          push(BigInt(memWords() * 32))
          pc++
          break
        case 0x5b:
          // JUMPDEST
          useGas(GAS_JUMPDEST)
          pc++
          break
        case 0xf3: {
          // RETURN
          const off = pop()
          const len = pop()
          memSize(off, len)
          const ret = memory.slice(Number(off), Number(off + len))
          return { ok: true, ret, gasUsed: ctx.gas - gas, logs }
        }
        case 0xfd: {
          // REVERT
          const off = pop()
          const len = pop()
          memSize(off, len)
          ctx.storage.clear()
          for (const [k, v] of storageBackup) ctx.storage.set(k, v)
          return {
            ok: false,
            ret: memory.slice(Number(off), Number(off + len)),
            gasUsed: ctx.gas - gas,
            logs: [],
            error: "revert",
          }
        }
        case 0xfe:
          throw new VMError("invalid opcode", "invalid")
        default: {
          if (op >= 0x60 && op <= 0x7f) {
            // PUSH1..PUSH32
            const n = op - 0x5f
            useGas(GAS_COPY)
            let v = 0n
            for (let i = 0; i < n; i++) v = (v << 8n) | BigInt(ctx.code[pc + 1 + i] ?? 0)
            push(v)
            pc += 1 + n
            break
          }
          if (op >= 0x80 && op <= 0x8f) {
            // DUP1..DUP16
            const n = op - 0x7f
            if (stack.length < n) throw new VMError("stack underflow", "stack")
            push(stack[stack.length - n])
            pc++
            break
          }
          if (op >= 0x90 && op <= 0x9f) {
            // SWAP1..SWAP16
            const n = op - 0x8f
            if (stack.length < n + 1) throw new VMError("stack underflow", "stack")
            const i = stack.length - 1
            const j = stack.length - 1 - n
            ;[stack[i], stack[j]] = [stack[j], stack[i]]
            pc++
            break
          }
          if (op >= 0xa0 && op <= 0xa4) {
            // LOG0..LOG4
            const nTopics = op - 0xa0
            const off = pop()
            const len = pop()
            const topics: bigint[] = []
            for (let i = 0; i < nTopics; i++) topics.push(pop())
            memSize(off, len)
            useGas(GAS_LOG + GAS_MEMORY * Number(len))
            logs.push({ topics, data: memory.slice(Number(off), Number(off + len)) })
            pc++
            break
          }
          throw new VMError(`unknown opcode 0x${op.toString(16)}`, "invalid")
        }
      }
    }
    return { ok: true, ret: [], gasUsed: ctx.gas - gas, logs }
  } catch (e) {
    if (e instanceof VMError) {
      // при ошибке состояние откатывается
      ctx.storage.clear()
      for (const [k, v] of storageBackup) ctx.storage.set(k, v)
      return { ok: false, ret: [], gasUsed: ctx.gas - gas, logs: [], error: e.reason + ": " + e.message }
    }
    throw e
  }
}

/** Собрать байткод из мнемоник (для тестов и примеров). */
export function assemble(program: string): number[] {
  const out: number[] = []
  const parts = program.trim().split(/\s+/)
  for (const p of parts) {
    // PUSH1_5 или PUSH1 5 — оба формата понимаем
    const push = p.match(/^PUSH(\d+)(?:[_\s]+(0x[0-9a-fA-F]+|\d+))?$/)
    if (push) {
      const n = Number(push[1])
      if (n < 1 || n > 32) throw new Error(`PUSH${n}: размер должен быть 1..32`)
      const value = BigInt(push[2] ?? "0")
      out.push(0x5f + n)
      for (let i = n - 1; i >= 0; i--) out.push(Number((value >> BigInt(8 * i)) & 0xffn))
      continue
    }
    if (p.startsWith("0x")) {
      out.push(Number(p))
      continue
    }
    const map: Record<string, number> = {
      STOP: 0x00, ADD: 0x01, MUL: 0x02, SUB: 0x03, DIV: 0x04, SDIV: 0x05, MOD: 0x06,
      LT: 0x10, GT: 0x11, EQ: 0x14, ISZERO: 0x15, AND: 0x16, OR: 0x17, NOT: 0x18, BYTE: 0x19,
      ADDRESS: 0x30, CALLER: 0x33, CALLVALUE: 0x34, CALLDATASIZE: 0x36, CALLDATALOAD: 0x37,
      CODESIZE: 0x39, RETURNDATASIZE: 0x3d, POP: 0x50, MLOAD: 0x51, MSTORE: 0x52, MSTORE8: 0x53,
      SLOAD: 0x54, SSTORE: 0x55, JUMP: 0x56, JUMPI: 0x57, PC: 0x58, MSIZE: 0x59, JUMPDEST: 0x5b,
      RETURN: 0xf3, REVERT: 0xfd, INVALID: 0xfe,
      LOG0: 0xa0, LOG1: 0xa1, LOG2: 0xa2, LOG3: 0xa3, LOG4: 0xa4,
      DUP1: 0x80, DUP2: 0x81, DUP3: 0x82, DUP4: 0x83,
      SWAP1: 0x90, SWAP2: 0x91, SWAP3: 0x92, SWAP4: 0x93,
    }
    if (p in map) out.push(map[p])
    else throw new Error(`unknown mnemonic: ${p}`)
  }
  return out
}
