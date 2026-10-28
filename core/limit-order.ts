/**
 * Lumen — лимитные ордера.
 *
 * Хранилище: SQLite (таблица limit_orders).
 * Сопоставление: при каждом принятом блоке проверяем цены пулов AMM.
 *
 * CLI:
 *   lumen order create <pair> <amount> <price>
 *   lumen order cancel <id>
 */

import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Ledger, type Pool, TREASURY_ADDRESS } from "./ledger.js"

const DB_DIR = join(process.env.LUMEN_DB_DIR ?? homedir(), ".lumen")
const DB_PATH = join(DB_DIR, "defi.db")

export type LimitOrderSide = "buy" | "sell"

export type LimitOrder = {
  id: number
  owner: string
  pair: string
  side: LimitOrderSide
  amount: bigint
  price: bigint // quote per 1e4 base units
  filled: bigint
  status: "open" | "filled" | "cancelled"
  createdAt: number
}

export class LimitOrderError extends Error {}

export class LimitOrderEngine {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (path !== ":memory:" && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS limit_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        pair TEXT NOT NULL,
        side TEXT NOT NULL,
        amount TEXT NOT NULL,
        price TEXT NOT NULL,
        filled TEXT NOT NULL DEFAULT '0',
        status TEXT NOT NULL DEFAULT 'open',
        createdAt INTEGER NOT NULL
      )
    `)
  }

  create(owner: string, pair: string, side: LimitOrderSide, amount: bigint, price: bigint): LimitOrder {
    if (amount <= 0n) throw new LimitOrderError("amount должен быть > 0")
    if (price <= 0n) throw new LimitOrderError("цена должна быть > 0")
    const res = this.db
      .prepare(
        "INSERT INTO limit_orders (owner, pair, side, amount, price, createdAt) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(owner, pair, side, amount.toString(), price.toString(), Date.now())
    return this.get(Number(res.lastInsertRowid))!
  }

  cancel(id: number): LimitOrder | undefined {
    const row = this.db.prepare("SELECT * FROM limit_orders WHERE id = ? AND status = 'open'").get(id) as
      | { id: number; owner: string; pair: string; side: string; amount: string; price: string; filled: string; status: string; createdAt: number }
      | undefined
    if (!row) return undefined
    this.db.prepare("UPDATE limit_orders SET status = 'cancelled' WHERE id = ?").run(id)
    return this.get(id)
  }

  get(id: number): LimitOrder | undefined {
    const row = this.db.prepare("SELECT * FROM limit_orders WHERE id = ?").get(id) as
      | { id: number; owner: string; pair: string; side: string; amount: string; price: string; filled: string; status: string; createdAt: number }
      | undefined
    if (!row) return undefined
    return {
      id: row.id,
      owner: row.owner,
      pair: row.pair,
      side: row.side as LimitOrderSide,
      amount: BigInt(row.amount),
      price: BigInt(row.price),
      filled: BigInt(row.filled),
      status: row.status as LimitOrder["status"],
      createdAt: row.createdAt,
    }
  }

  listOpen(pair?: string): LimitOrder[] {
    let sql = "SELECT * FROM limit_orders WHERE status = 'open'"
    const params: unknown[] = []
    if (pair) {
      sql += " AND pair = ?"
      params.push(pair)
    }
    return (this.db.prepare(sql).all(...params) as Array<{
      id: number
      owner: string
      pair: string
      side: string
      amount: string
      price: string
      filled: string
      status: string
      createdAt: number
    }>).map((r) => ({
      id: r.id,
      owner: r.owner,
      pair: r.pair,
      side: r.side as LimitOrderSide,
      amount: BigInt(r.amount),
      price: BigInt(r.price),
      filled: BigInt(r.filled),
      status: r.status as LimitOrder["status"],
      createdAt: r.createdAt,
    }))
  }

  /**
   * Market price expressed as quote per 1e4 base units.
   * For equal reserves (1M LMN / 1M USDC): price = 1e4.
   */
  marketPrice(pool: Pool): bigint {
    if (pool.base === 0n || pool.quote === 0n) return 0n
    return (pool.quote * 10_000n) / pool.base
  }

  /**
   * Quote cost to buy `baseIn` from this pool (with fee).
   */
  quoteCost(baseIn: bigint, pool: Pool): bigint {
    if (pool.base === 0n) return 0n
    const feeIn = (baseIn * pool.feeBps) / 10_000n
    const effIn = baseIn - feeIn
    return (pool.quote * effIn) / (pool.base + effIn)
  }

  /**
   * Match open orders against current pool prices.
   *
   * Buy: executes if marketPrice <= order price.
   * Sell: executes if marketPrice >= order price.
   */
  match(ledger: Ledger): { executed: LimitOrder[]; skipped: number } {
    const openOrders = this.listOpen()
    const executed: LimitOrder[] = []
    let skipped = 0

    for (const order of openOrders) {
      const pool = ledger.pool(order.pair)
      if (!pool) {
        skipped++
        continue
      }
      const mkt = this.marketPrice(pool)
      const shouldExecute = order.side === "buy" ? mkt <= order.price : mkt >= order.price
      if (!shouldExecute) {
        skipped++
        continue
      }

      const remaining = order.amount - order.filled
      const ownerAcc = ledger.get(order.owner)

      if (order.side === "buy") {
        const cost = this.quoteCost(remaining, pool)
        if (ownerAcc.balance < cost) {
          skipped++
          continue
        }
        ownerAcc.balance -= cost
        ownerAcc.balance += remaining // receive base
        pool.quote += cost
        pool.base -= remaining
      } else {
        const cost = this.quoteCost(remaining, pool)
        if (ownerAcc.balance < remaining) {
          skipped++
          continue
        }
        ownerAcc.balance -= remaining // give base
        ownerAcc.balance += cost // receive quote
        pool.base += remaining
        pool.quote -= cost
      }

      this.db
        .prepare("UPDATE limit_orders SET filled = ?, status = ? WHERE id = ?")
        .run(order.amount.toString(), "filled", order.id)
      executed.push({ ...order, filled: order.amount, status: "filled" })
    }
    return { executed, skipped }
  }

  close() {
    this.db.close()
  }
}
