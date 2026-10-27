/**
 * Lumen — реестр состояния: счета, транзакции, стейкинг и встроенный AMM.
 *
 * Модель — счета (account-based) с utxo-подобной простотой:
 *   - стоимость транзакции зависит от размера (EIP-1559-подобный fee market)
 *   - consensus: PoS, валидаторы получают 3% годовых от общего supply
 *   - AMM: постоянное произведение (x*y=k), комиссия 0.3%
 */
import { sha256, sha256Buf, addressFromPublicKey, keypairFromSeed, verify } from "./crypto.js"
import { run, makeContract, type ContractState, type Log } from "./vm.js"

export const GENESIS_SUPPLY = 1_000_000_000_000_000n // 1e9 LMN, 6 знаков
export const TX_FEE = 1000n // базовая комиссия
export const MIN_STAKE = 10_000n * 1_000_000n // 10 000 LMN
export const AMM_FEE_BPS = 30n // 0.30%
export const PREMINE = GENESIS_SUPPLY / 2n // половина в генезис-распределение

/** Казна сети: 60% премайна (ликвидность AMM, награды, гранты). */
export const TREASURY_ADDRESS = addressFromPublicKey(
  keypairFromSeed(Buffer.from(sha256("lumen/genesis/treasury"), "hex")).publicKey,
)
/** Фаucет для тестнета: выдает бесплатные LMN. */
export const FAUCET_ADDRESS = addressFromPublicKey(
  keypairFromSeed(Buffer.from(sha256("lumen/genesis/faucet"), "hex")).publicKey,
)
/** Пул ранних валидаторов: 40% премайна, выплачивается 1:1 к застейканному. */
export const EARLY_VALIDATORS_ADDRESS = addressFromPublicKey(
  keypairFromSeed(Buffer.from(sha256("lumen/genesis/early-validators"), "hex")).publicKey,
)
export const PREMINE_TREASURY = (GENESIS_SUPPLY * 60n) / 100n
export const PREMINE_EARLY = GENESIS_SUPPLY - PREMINE_TREASURY

export type Account = {
  address: string
  balance: bigint
  stake: bigint
  publicKey?: string
  nonce: number
}

export type Tx = {
  from: string
  to?: string
  amount: bigint
  fee: bigint
  nonce: number
  data?: string
  timestamp: number
  signature: string
}

export type Pool = {
  base: bigint
  quote: bigint
  feeBps: bigint
  /** доли LP: сумма долей определяет долю в резервах */
  totalShares: bigint
}

export class LedgerError extends Error {}

export class Ledger {
  accounts = new Map<string, Account>()
  pools = new Map<string, Pool>()
  /** доли LP: пул → владелец → доли */
  lpShares = new Map<string, Map<string, bigint>>()
  /** контракты: адрес → код и хранилище */
  contracts = new Map<string, ContractState>()
  /** максимум газа на одну транзакцию с контрактом */
  maxContractGas = 1_000_000n
  /** Накопленные комиссионные вознаграждения валидатору блока */
  proposerRewards = 0n
  /** null means "native LMN" */
  poolKey(baseSymbol: string, quoteSymbol: string) {
    return `${baseSymbol}/${quoteSymbol}`
  }

  get(address: string): Account {
    let a = this.accounts.get(address)
    if (!a) {
      a = { address, balance: 0n, stake: 0n, nonce: 0 }
      this.accounts.set(address, a)
    }
    return a
  }

  balance(address: string): bigint {
    return this.accounts.get(address)?.balance ?? 0n
  }

  totalSupply(): bigint {
    let t = 0n
    for (const a of this.accounts.values()) t += a.balance + a.stake
    return t
  }

  /** Применить транзакцию. Возвращает true, если принята. */
  apply(tx: Tx): boolean {
    const from = this.get(tx.from)
    if (from.publicKey) {
      const msg = this.txMessage(tx)
      if (!verify(from.publicKey, msg, tx.signature)) throw new LedgerError("bad signature")
    }
    if (tx.nonce !== from.nonce) throw new LedgerError(`bad nonce: expected ${from.nonce}, got ${tx.nonce}`)
    const total = tx.amount + tx.fee
    if (from.balance < total) throw new LedgerError("insufficient balance")
    from.balance -= total
    from.nonce += 1
    // 40% fee → treasury, 40% → burn, 20% → proposer (записывается в блок)
    const treasuryCut = (tx.fee * 40n) / 100n
    const burnCut = (tx.fee * 40n) / 100n
    const proposerCut = tx.fee - treasuryCut - burnCut
    if (treasuryCut > 0n) this.get(TREASURY_ADDRESS).balance += treasuryCut
    if (proposerCut > 0n) this.proposerRewards = (this.proposerRewards ?? 0n) + proposerCut

    // смарт-контракты: deploy:<hex> и call:<адрес>:<hex>
    if (tx.data?.startsWith("deploy:") || tx.data?.startsWith("call:")) {
      this.applyContractTx(tx, from)
      return true
    }

    if (tx.data?.startsWith("stake:")) {
      from.stake += tx.amount
      // ранние валидаторы получают 1:1 к застейканному из пула премайна
      const pool = this.get(EARLY_VALIDATORS_ADDRESS)
      const bonus = tx.amount < pool.balance ? tx.amount : pool.balance
      if (bonus > 0n) {
        pool.balance -= bonus
        from.balance += bonus
      }
    } else if (tx.data?.startsWith("unstake:")) {
      if (from.stake < tx.amount) throw new LedgerError("not enough stake")
      from.stake -= tx.amount
      from.balance += tx.amount
    } else if (tx.to) {
      this.get(tx.to).balance += tx.amount
    }
    return true
  }

  /**
   * Транзакция смарт-контракта.
   *   deploy:<hex-код>     — задеплоить контракт
   *   call:<адрес>:<hex>   — вызвать контракт
   */
  private applyContractTx(tx: Tx, from: Account) {
    const data = tx.data ?? ""
    if (data.startsWith("deploy:")) {
      const code = hexToBytes(data.slice("deploy:".length))
      if (!code.length) throw new LedgerError("empty contract code")
      const address = this.contractAddress(from.address, from.nonce)
      const ctx = {
        caller: from.address,
        address,
        value: tx.amount,
        code,
        calldata: [],
        gas: Number(this.maxContractGas),
        storage: new Map<string, string>(),
        logs: [] as Log[],
        depth: 0,
        maxDepth: 8,
      }
      const res = run(ctx)
      if (!res.ok) throw new LedgerError(`contract deploy failed: ${res.error}`)
      // код, возвращённый конструктором, и есть исполняемый код контракта
      const runtime = res.ret.length ? res.ret : code
      const contract = makeContract(runtime, tx.amount)
      for (const [k, v] of ctx.storage) contract.storage.set(k, v)
      this.contracts.set(address, contract)
      from.balance -= 0n
      return
    }

    // call:<адрес>:<hex>
    const rest = data.slice("call:".length)
    const sep = rest.indexOf(":")
    const address = sep >= 0 ? rest.slice(0, sep) : rest
    const calldata = sep >= 0 ? hexToBytes(rest.slice(sep + 1)) : []
    const contract = this.contracts.get(address)
    if (!contract) throw new LedgerError(`unknown contract: ${address}`)

    const ctx = {
      caller: from.address,
      address,
      value: tx.amount,
      code: contract.code,
      calldata,
      gas: Number(this.maxContractGas),
      storage: new Map(contract.storage),
      logs: [] as Log[],
      depth: 0,
      maxDepth: 8,
    }
    const res = run(ctx)
    if (!res.ok) throw new LedgerError(`contract call failed: ${res.error}`)
    // изменения хранилища применяются только при успешном завершении
    contract.storage = new Map(ctx.storage)
    contract.balance += tx.amount
  }

  /** Адрес контракта: детерминированный от отправителя и nonce. */
  contractAddress(sender: string, nonce: number): string {
    const h = sha256(`contract:${sender}:${nonce}`)
    return "0x" + h.slice(0, 40)
  }

  /** Начисление вознаграждения валидатору (PoS). */
  reward(address: string, amount: bigint) {
    this.get(address).balance += amount
  }

  /** Сообщение, которое подписывает отправитель. */
  txMessage(tx: Tx): Buffer {
    return Buffer.from(
      [
        tx.from,
        tx.to ?? "",
        tx.amount.toString(),
        tx.fee.toString(),
        tx.nonce,
        tx.data ?? "",
        tx.timestamp,
      ].join("|"),
    )
  }

  // --- AMM (constant product) + доли LP --------------------------------------
  /**
   * Добавить ликвидность. Выпускает доли LP пропорционально внесённому:
   *   shares = внесённое × (totalShares / резерв), либо начальная 1:1.
   * Доли передаются владельцу — вывести чужие нельзя.
   */
  addLiquidity(
    baseSymbol: string,
    quoteSymbol: string,
    base: bigint,
    quote: bigint,
    owner?: string,
  ): bigint {
    if (base <= 0n || quote <= 0n) throw new LedgerError("liquidity must be positive")
    const key = this.poolKey(baseSymbol, quoteSymbol)
    const p = this.pools.get(key) ?? { base: 0n, quote: 0n, feeBps: AMM_FEE_BPS, totalShares: 0n }
    const shares =
      p.totalShares === 0n
        ? base
        : (base * p.totalShares) / (p.base === 0n ? 1n : p.base)
    if (shares <= 0n) throw new LedgerError("liquidity too small")
    p.base += base
    p.quote += quote
    p.totalShares += shares
    this.pools.set(key, p)
    if (owner) {
      const held = this.lpShares.get(key) ?? new Map<string, bigint>()
      held.set(owner, (held.get(owner) ?? 0n) + shares)
      this.lpShares.set(key, held)
    }
    return shares
  }

  /** Сколько долей LP у владельца в пуле. */
  sharesOf(key: string, owner: string): bigint {
    return this.lpShares.get(key)?.get(owner) ?? 0n
  }

  /** Забрать ликвидность по своим долям. Возвращает [base, quote]. */
  removeLiquidity(key: string, owner: string, shares?: bigint): [bigint, bigint] {
    const p = this.pools.get(key)
    if (!p || p.totalShares === 0n) throw new LedgerError("no such pool")
    const owned = this.sharesOf(key, owner)
    const amount = shares ?? owned
    if (amount <= 0n) throw new LedgerError("no shares")
    if (amount > owned) throw new LedgerError("not enough shares")
    const baseOut = (p.base * amount) / p.totalShares
    const quoteOut = (p.quote * amount) / p.totalShares
    p.base -= baseOut
    p.quote -= quoteOut
    p.totalShares -= amount
    const held = this.lpShares.get(key)!
    const left = held.get(owner)! - amount
    if (left === 0n) held.delete(owner)
    else held.set(owner, left)
    return [baseOut, quoteOut]
  }

  /** Сколько quote получит покупатель base (с комиссией). */
  quoteSwap(key: string, baseIn: bigint): bigint {
    const p = this.pools.get(key)
    if (!p || p.base === 0n || p.quote === 0n) return 0n
    const feeIn = (baseIn * p.feeBps) / 10_000n
    const effIn = baseIn - feeIn
    return (p.quote * effIn) / (p.base + effIn)
  }

  /** Исполнение свопа. */
  swap(key: string, baseIn: bigint): bigint {
    const p = this.pools.get(key)
    if (!p) throw new LedgerError("no such pool")
    const out = this.quoteSwap(key, baseIn)
    if (out === 0n) throw new LedgerError("swap yields nothing")
    const feeIn = (baseIn * p.feeBps) / 10_000n
    p.base += baseIn
    p.quote -= out
    return out
  }

  pool(key: string): Pool | undefined {
    return this.pools.get(key)
  }

  /** Снимок состояния для подписи консенсуса. */
  stateRoot(): string {
    const parts: string[] = []
    for (const [addr, a] of [...this.accounts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      parts.push(`${addr}:${a.balance}:${a.stake}:${a.nonce}`)
    }
    for (const [addr, c] of [...this.contracts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      const storage = [...c.storage.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1))
      parts.push(`contract:${addr}:${c.code.length}:${c.balance}:${storage.length}`)
      for (const [k, v] of storage) parts.push(`cs:${addr}:${k}:${v}`)
    }
    for (const [key, p] of [...this.pools].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
      parts.push(`pool:${key}:${p.base}:${p.quote}:${p.totalShares}`)
      for (const [owner, shares] of [...(this.lpShares.get(key) ?? new Map())].sort((x, y) =>
        x[0] < y[0] ? -1 : 1,
      )) {
        parts.push(`lp:${key}:${owner}:${shares}`)
      }
    }
    return sha256(parts.join("|"))
  }
}

/** Hex-строка без 0x → массив байтов. */
export function hexToBytes(hex: string): number[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex
  if (clean.length % 2 !== 0) throw new LedgerError("odd hex length")
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 2) {
    const byte = Number.parseInt(clean.slice(i, i + 2), 16)
    if (Number.isNaN(byte)) throw new LedgerError("bad hex")
    out.push(byte)
  }
  return out
}

/** JSON с поддержкой bigint (для меркла и RPC). */
export function stringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v))
}

/** Генезис-распределение: 60% в казну, 40% — пул ранних валидаторов. */
export function genesisAllocations(): Record<string, bigint> {
  return {
    [TREASURY_ADDRESS]: PREMINE_TREASURY,
    [EARLY_VALIDATORS_ADDRESS]: PREMINE_EARLY,
    [FAUCET_ADDRESS]: 100_000_000_000_000n, // 100M LMN для faucet
  }
}

export function createGenesis(ledger: Ledger, allocations: Record<string, bigint>) {
  for (const [addr, amount] of Object.entries(allocations)) {
    const a = ledger.get(addr)
    a.balance += amount
  }
  return ledger
}

export { addressFromPublicKey, sha256, sha256Buf }
