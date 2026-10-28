/**
 * Lumen — DCA (Dollar Cost Averaging).
 *
 * Хранилище: SQLite (таблица dca_plans).
 * Покупает base за quote каждые N блоков.
 *
 * CLI:
 *   lumen dca create <pair> <amount> <interval>
 */

import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Ledger, type Pool } from "./ledger.js"

const DB_DIR = join(process.env.LUMEN_DB_DIR ?? homedir(), ".lumen")
const DB_PATH = join(DB_DIR, "defi.db")

export type DCAPlan = {
  id: number
  owner: string
  pair: string
  amount: bigint
  interval: number // blocks
  nextBlock: number
  active: boolean
}

export class DCAError extends Error {}

export class DCAEngine {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (path !== ":memory:" && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dca_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        pair TEXT NOT NULL,
        amount TEXT NOT NULL,
        interval INTEGER NOT NULL,
        nextBlock INTEGER NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )
    `)
  }

  create(owner: string, pair: string, amount: bigint, interval: number, startBlock: number): DCAPlan {
    if (amount <= 0n) throw new DCAError("amount должен быть > 0")
    if (interval <= 0) throw new DCAError("interval должен быть > 0")
    const res = this.db
      .prepare(
        "INSERT INTO dca_plans (owner, pair, amount, interval, nextBlock) VALUES (?, ?, ?, ?, ?)",
      )
      .run(owner, pair, amount.toString(), interval, startBlock)
    return this.get(Number(res.lastInsertRowid))!
  }

  cancel(id: number): boolean {
    const row = this.db.prepare("SELECT * FROM dca_plans WHERE id = ? AND active = 1").get(id) as
      | { id: number }
      | undefined
    if (!row) return false
    this.db.prepare("UPDATE dca_plans SET active = 0 WHERE id = ?").run(id)
    return true
  }

  get(id: number): DCAPlan | undefined {
    const row = this.db.prepare("SELECT * FROM dca_plans WHERE id = ?").get(id) as
      | { id: number; owner: string; pair: string; amount: string; interval: number; nextBlock: number; active: number }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      owner: row.owner,
      pair: row.pair,
      amount: BigInt(row.amount),
      interval: row.interval,
      nextBlock: row.nextBlock,
      active: row.active === 1,
    }
  }

  listActive(owner?: string): DCAPlan[] {
    let sql = "SELECT * FROM dca_plans WHERE active = 1"
    const params: unknown[] = []
    if (owner) {
      sql += " AND owner = ?"
      params.push(owner)
    }
    return (this.db.prepare(sql).all(...params) as Array<{
      id: number
      owner: string
      pair: string
      amount: string
      interval: number
      nextBlock: number
      active: number
    }>).map((r) => ({
      id: r.id,
      owner: r.owner,
      pair: r.pair,
      amount: BigInt(r.amount),
      interval: r.interval,
      nextBlock: r.nextBlock,
      active: r.active === 1,
    }))
  }

  /**
   * Execute DCA purchases at current block.
   */
  executeAtBlock(blockNumber: number, ledger: Ledger): { executed: DCAPlan[]; skipped: number } {
    const active = this.listActive()
    const executed: DCAPlan[] = []
    let skipped = 0

    for (const plan of active) {
      if (blockNumber < plan.nextBlock) {
        skipped++
        continue
      }
      const pool = ledger.pool(plan.pair)
      if (!pool) {
        skipped++
        continue
      }
      const ownerAcc = ledger.get(plan.owner)
      const cost = this.quoteCost(plan.amount, pool)
      if (ownerAcc.balance < cost) {
        skipped++
        continue
      }
      const feeIn = (plan.amount * pool.feeBps) / 10_000n
      const effBase = plan.amount - feeIn
      const receive = (pool.quote * effBase) / (pool.base + effBase)
      ownerAcc.balance -= cost
      ownerAcc.balance += receive
      pool.base += plan.amount
      pool.quote -= receive

      const next = blockNumber + plan.interval
      this.db.prepare("UPDATE dca_plans SET nextBlock = ? WHERE id = ?").run(next, plan.id)
      executed.push({ ...plan, nextBlock: next })
    }
    return { executed, skipped }
  }

  private quoteCost(baseIn: bigint, pool: Pool): bigint {
    if (pool.base === 0n) return 0n
    const feeIn = (baseIn * pool.feeBps) / 10_000n
    const effIn = baseIn - feeIn
    return (pool.quote * effIn) / (pool.base + effIn)
  }

  close() {
    this.db.close()
  }
}
