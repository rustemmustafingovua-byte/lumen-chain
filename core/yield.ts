/**
 * Lumen — Yield Aggregator.
 *
 * Автоматически:
 *   - compound staking rewards (compound claimable rewards into stake)
 *   - reinvest LP fees (use accumulated fees to add liquidity)
 *
 * CLI:
 *   lumen yield auto <pool>
 */

import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Ledger, type Pool } from "./ledger.js"

const DB_DIR = join(process.env.LUMEN_DB_DIR ?? homedir(), ".lumen")
const DB_PATH = join(DB_DIR, "defi.db")

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

export type YieldPosition = {
  pool: string
  owner: string
  staked: bigint
  rewardDebt: bigint
  lastCompoundBlock: number
}

export class YieldError extends Error {}

export class YieldAggregator {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (path !== ":memory:" && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS yield_positions (
        pool TEXT NOT NULL,
        owner TEXT NOT NULL,
        staked TEXT NOT NULL DEFAULT '0',
        rewardDebt TEXT NOT NULL DEFAULT '0',
        lastCompoundBlock INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (pool, owner)
      )
    `)
  }

  createPosition(pool: string, owner: string, staked: bigint): YieldPosition {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO yield_positions (pool, owner, staked, rewardDebt, lastCompoundBlock) VALUES (?, ?, ?, ?, ?)",
      )
      .run(pool, owner, staked.toString(), 0n.toString(), 0)
    return this.get(pool, owner)!
  }

  get(pool: string, owner: string): YieldPosition | undefined {
    const row = this.db
      .prepare("SELECT * FROM yield_positions WHERE pool = ? AND owner = ?")
      .get(pool, owner) as
      | { pool: string; owner: string; staked: string; rewardDebt: string; lastCompoundBlock: number }
      | undefined
    if (!row) return undefined
    return {
      pool: row.pool,
      owner: row.owner,
      staked: BigInt(row.staked),
      rewardDebt: BigInt(row.rewardDebt),
      lastCompoundBlock: row.lastCompoundBlock,
    }
  }

  /**
   * Compound rewards: add rewardDebt to staked.
   */
  compound(pool: string, owner: string): YieldPosition | undefined {
    const pos = this.get(pool, owner)
    if (!pos || pos.staked === 0n) return undefined
    const newStaked = pos.staked + pos.rewardDebt
    this.db
      .prepare("UPDATE yield_positions SET staked = ?, rewardDebt = '0' WHERE pool = ? AND owner = ?")
      .run(newStaked.toString(), pool, owner)
    return this.get(pool, owner)
  }

  /**
   * Reinvest LP fees: take rewardDebt and use it to add liquidity in the same pool.
   */
  reinvestLpFees(ledger: Ledger, poolKey: string, owner: string): YieldPosition | undefined {
    const pos = this.get(poolKey, owner)
    if (!pos || pos.staked === 0n || pos.rewardDebt === 0n) return undefined

    const pool = ledger.pool(poolKey)
    if (!pool) return undefined

    const reward = pos.rewardDebt
    // use 50% of rewards to add base liquidity, 50% as quote
    const half = reward / 2n
    const [baseSym, quoteSym] = poolKey.split("/")
    ledger.addLiquidity(baseSym, quoteSym, half, half, owner)

    this.db
      .prepare("UPDATE yield_positions SET rewardDebt = '0' WHERE pool = ? AND owner = ?")
      .run(poolKey, owner)
    return this.get(poolKey, owner)
  }

  /**
   * Auto-compound all staking rewards for a pool across all positions.
   */
  autoCompoundAll(ledger: Ledger, poolKey: string): { compounded: number; skipped: number } {
    const rows = this.db.prepare("SELECT * FROM yield_positions WHERE pool = ? AND staked > 0").all(poolKey) as Array<{
      pool: string
      owner: string
      staked: string
      rewardDebt: string
      lastCompoundBlock: number
    }>
    let compounded = 0
    let skipped = 0
    for (const row of rows) {
      const pos = this.get(poolKey, row.owner)!
      if (pos.rewardDebt > 0n) {
        this.compound(poolKey, row.owner)
        compounded++
      } else {
        skipped++
      }
    }
    return { compounded, skipped }
  }

  close() {
    this.db.close()
  }
}
