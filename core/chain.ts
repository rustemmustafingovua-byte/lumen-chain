/**
 * Lumen — блок, консенсус (PoS) и сеть.
 *
 * Блок: header + транзакции, Merkle-корень, подпись продюсера.
 * Консенсус: stake-weighted, детерминированный выбор по slot + подпись stake-веса.
 * Финальность: блок финализируется, когда накоплен вес >= 2/3 от общего стейка.
 */
import { sha256, sha256Buf, sign, verify, publicKeyBytes } from "./crypto.js"
import { Persistence } from "./persist.js"
import { Ledger, type Tx, TX_FEE, type Account, stringify, genesisAllocations, createGenesis } from "./ledger.js"

export const SLOT_MS = 4000
export const MAX_BLOCK_TXS = 500
export type ChainOptions = {
  maxBlockSize?: number
  mempoolLimit?: number
  mempoolMaxAgeMs?: number
  pruneInterval?: number
}

/** Фиксированное время генезиса: у всех узлов генезис должен быть идентичен. */
export const GENESIS_TIMESTAMP = 1767225600000 // 2026-01-01T00:00:00Z

export type BlockHeader = {
  height: number
  prevHash: string
  timestamp: number
  proposer: string
  merkleRoot: string
  txCount: number
  slot: number
}

export type Block = {
  header: BlockHeader
  txs: Tx[]
  signature: string
  hash: string
}

export class ChainError extends Error {}

/** Пул транзакций: приоритет по комиссии, лимит на аккаунт. */
export class Mempool {
  txs: Tx[] = []
  limit = 5000
  private maxAgeMs = 5 * 60_000 // 5 минут

  setMaxAge(ms: number) {
    this.maxAgeMs = ms
  }

  add(tx: Tx) {
    if (this.txs.some((t) => t.from === tx.from && t.nonce === tx.nonce))
      throw new ChainError("duplicate nonce in mempool")
    // binary insertion в отсортированный по fee (убыв.) массив
    let lo = 0
    let hi = this.txs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (this.txs[mid].fee >= tx.fee) lo = mid + 1
      else hi = mid
    }
    this.txs.splice(lo, 0, tx)
    if (this.txs.length > this.limit) this.txs.length = this.limit
  }

  evict() {
    const cutoff = Date.now() - this.maxAgeMs
    this.txs = this.txs.filter((tx) => tx.timestamp > cutoff)
  }

  take(max: number): Tx[] {
    const out = this.txs.slice(0, max)
    this.txs = this.txs.slice(max)
    return out
  }

  get size() {
    return this.txs.length
  }
}

export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return sha256("")
  let level = leaves.map((l) => sha256Buf(l))
  while (level.length > 1) {
    const next: Buffer[] = []
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i]
      const right = level[i + 1] ?? level[i]
      next.push(sha256Buf(Buffer.concat([left, right])))
    }
    level = next
  }
  return level[0].toString("hex")
}

export function blockHash(b: Block): string {
  const h = b.header
  return sha256(
    [h.height, h.prevHash, h.timestamp, h.proposer, h.merkleRoot, h.txCount, h.slot].join("|"),
  )
}

export class Chain {
  ledger = new Ledger()
  blocks: Block[] = []
  /** сколько блоков уже прорежировано ( genesis и ранняя история ) */
  prunedHeight = 0
  mempool = new Mempool()
  /** stake публичных ключей валидаторов */
  validators = new Map<string, { publicKey: string; stake: bigint }>()
  persist?: Persistence
  /** конфигурируемый лимит tx в блоке (по умолчанию MAX_BLOCK_TXS) */
  maxBlockSize = MAX_BLOCK_TXS
  /** интервал прореживания в блоках */
  pruneInterval = 200
  /** накопитель для батчинга персистенции */
  private pendingPersist = false

  constructor(opts?: ChainOptions) {
    if (opts?.maxBlockSize) this.maxBlockSize = opts.maxBlockSize
    if (opts?.mempoolLimit) this.mempool.limit = opts.mempoolLimit
    if (opts?.mempoolMaxAgeMs) this.mempool.setMaxAge(opts.mempoolMaxAgeMs)
    if (opts?.pruneInterval) this.pruneInterval = opts.pruneInterval
  }

  /** Высота головы (после генезиса — 0). */
  get height() {
    return this.prunedHeight + Math.max(0, this.blocks.length - 1)
  }

  /**
   * Прореживание истории: оставить последние `keep` блоков.
   *
   * Нужно долгоживущим узлам: без этого память растёт линейно со временем.
   * Высота и state root от этого не меняются — state root считается по
   * счетам, а не по блокам, — поэтому консенсус не нарушается.
   */
  prune(keep = 2000): number {
    if (this.blocks.length <= keep) return 0
    const drop = this.blocks.length - keep
    this.blocks.splice(0, drop)
    this.prunedHeight += drop
    return drop
  }

  get head(): Block | undefined {
    return this.blocks[this.blocks.length - 1]
  }

  async restoreFromPersistence(path?: string) {
    if (!path && !this.persist) return false
    const p = this.persist ?? new Persistence(path)
    this.persist = p
    const latest = p.latestBlockHeight
    if (latest < 0) return false
    const blocks = p.getBlocks(0, latest + 1)
    if (blocks.length === 0) return false
    this.blocks = []
    this.prunedHeight = 0
    this.ledger = new Ledger()
    this.mempool = new Mempool()
    this.validators = p.loadValidators()
    for (const b of blocks) {
      for (const tx of b.txs) this.ledger.apply(tx)
      this.blocks.push(b)
    }
    this.mempool.txs = p.loadMempool()
    // restore full ledger state that persistState saved
    for (const a of p.getAllAccounts()) this.ledger.accounts.set(a.address, a)
    for (const [key, pool] of p.getAllPools()) this.ledger.pools.set(key, pool)
    for (const ls of p.getAllLpShares()) {
      const map = this.ledger.lpShares.get(ls.pool) ?? new Map()
      map.set(ls.address, ls.shares)
      this.ledger.lpShares.set(ls.pool, map)
    }
    for (const row of p.getAllContracts()) {
      this.ledger.contracts.set(row.address, JSON.parse(row.data))
    }
    return true
  }

  persistState() {
    if (!this.persist) return
    for (const b of this.blocks) this.persist.saveBlock(b)
    for (const [addr, a] of this.ledger.accounts) this.persist.saveAccount(a)
    for (const [k, pool] of this.ledger.pools) this.persist.savePool(k, pool)
    for (const [pool, owners] of this.ledger.lpShares) {
      for (const [owner, shares] of owners) {
        this.persist.saveLpShares(pool, owner, shares)
      }
    }
    for (const [addr, c] of this.ledger.contracts) this.persist.saveContract(addr, c)
    this.persist.saveMempoolTxs(this.mempool.txs)
    this.persist.saveValidators(this.validators)
  }

  genesis() {
    // фиксированная эмиссия: 60% в казну, 40% — пул ранних валидаторов
    createGenesis(this.ledger, genesisAllocations())
    const b: Block = {
      header: {
        height: 0,
        prevHash: "0".repeat(64),
        timestamp: GENESIS_TIMESTAMP,
        proposer: "genesis",
        merkleRoot: merkleRoot([]),
        txCount: 0,
        slot: 0,
      },
      txs: [],
      signature: "",
      hash: "",
    }
    b.hash = blockHash(b)
    this.blocks.push(b)
  }

  addValidator(publicKey: string, stake: bigint) {
    this.validators.set(publicKey, { publicKey, stake })
  }

  totalStake(): bigint {
    let s = 0n
    for (const v of this.validators.values()) s += v.stake
    return s
  }

  /** Кто продюсирует слот: детерминированно по весу и номеру слота. */
  proposerForSlot(slot: number): string | undefined {
    if (!this.validators.size) return undefined
    const entries = [...this.validators.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))
    const total = this.totalStake()
    if (total === 0n) return entries[0][0]
    const point = BigInt(slot) * total
    let acc = 0n
    for (const [pk, v] of entries) {
      acc += v.stake
      if (point % total < acc) return pk
    }
    return entries[0][0]
  }

  /** Создать блок (продюсер). */
  propose(txs: Tx[], privateKey: string, publicKey: string, slot: number): Block {
    const leaves = txs.map((t) => sha256(stringify(t)))
    const b: Block = {
      header: {
        height: this.height + 1,
        prevHash: this.head?.hash ?? "0".repeat(64),
        timestamp: Date.now(),
        proposer: publicKey,
        merkleRoot: merkleRoot(leaves),
        txCount: txs.length,
        slot,
      },
      txs,
      signature: "",
      hash: "",
    }
    b.signature = sign(privateKey, blockHash(b))
    b.hash = blockHash(b)
    return b
  }

  /** Применить и принять блок. */
  accept(b: Block): boolean {
    if (b.header.height !== this.height + 1)
      throw new ChainError(`bad height ${b.header.height} != ${this.height + 1}`)
    if (b.header.prevHash !== (this.head?.hash ?? "0".repeat(64))) throw new ChainError("bad prevHash")
    const v = this.validators.get(b.header.proposer)
    if (!v) throw new ChainError("unknown proposer")
    if (!verify(v.publicKey, blockHash(b), b.signature)) throw new ChainError("bad block signature")
    if (b.hash !== blockHash(b)) throw new ChainError("bad block hash")
    const leaves = b.txs.map((t) => sha256(stringify(t)))
    if (merkleRoot(leaves) !== b.header.merkleRoot) throw new ChainError("bad merkle root")
    for (const tx of b.txs) this.ledger.apply(tx)
    this.blocks.push(b)
    if (!this.pendingPersist) this.persistState()
    return true
  }

  /** Принять батч блоков с единой персистенцией. */
  acceptBatch(blocks: Block[]): boolean[] {
    this.pendingPersist = true
    const out: boolean[] = []
    try {
      for (const b of blocks) out.push(this.accept(b))
    } finally {
      this.pendingPersist = false
      this.persistState()
    }
    return out
  }

  /** Блок достиг 2/3 веса — финализирован. */
  isFinalized(): boolean {
    const total = this.totalStake()
    if (total === 0n) return false
    return this.totalStake() >= (total * 2n) / 3n
  }

  /** Вознаграждение валидатору за блок — из комиссий, не из эмиссии. */
  rewardProposer(publicKey: string) {
    const reward = this.ledger.proposerRewards ?? 0n
    this.ledger.proposerRewards = 0n
    if (reward > 0n) this.ledger.reward(publicKey, reward)
  }
}

export { TX_FEE }
export type { Tx, Account }
