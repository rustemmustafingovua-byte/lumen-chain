/**
 * Lumen — персистентность в SQLite.
 *
 * Хранит:
 *   - блоки (height → JSON)
 *   - аккаунты (address → JSON)
 *   - пулы (key → JSON)
 *   - LP-доли (pool + address → shares)
 *   - контракты (address → JSON)
 *   - мемпул (txs)
 *   - валидаторы (pubkey → JSON)
 */

import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { Block, Tx, Account } from "./chain.js"
import { sha256 } from "./crypto.js"
import type { Pool } from "./ledger.js"

const DB_DIR = join(homedir(), ".lumen")
const DB_PATH = join(DB_DIR, "chain.db")

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

export class Persistence {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        address TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pools (
        key TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS lp_shares (
        pool TEXT,
        owner TEXT,
        shares TEXT NOT NULL,
        PRIMARY KEY (pool, owner)
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contracts (
        address TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mempool (
        hash TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS validators (
        pubkey TEXT PRIMARY KEY,
        data TEXT NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `)
  }

  // ---- blocks ----
  saveBlock(b: Block) {
    this.db
      .prepare("INSERT OR REPLACE INTO blocks (height, data) VALUES (?, ?)")
      .run(b.header.height, JSON.stringify(b, bigintReplacer))
  }

  getBlock(height: number): Block | undefined {
    const row = this.db.prepare("SELECT data FROM blocks WHERE height = ?").get(height) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  getBlocks(from: number, to: number): Block[] {
    const rows = this.db
      .prepare("SELECT data FROM blocks WHERE height >= ? AND height <= ? ORDER BY height ASC")
      .all(from, to) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  get latestBlockHeight(): number {
    const row = this.db.prepare("SELECT MAX(height) as h FROM blocks").get() as { h: number | undefined }
    return row?.h ?? -1
  }

  // ---- accounts ----
  saveAccount(a: Account) {
    this.db
      .prepare("INSERT OR REPLACE INTO accounts (address, data) VALUES (?, ?)")
      .run(a.address, JSON.stringify(a, bigintReplacer))
  }

  getAccount(address: string): Account | undefined {
    const row = this.db.prepare("SELECT data FROM accounts WHERE address = ?").get(address) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  getAllAccounts(): Account[] {
    const rows = this.db.prepare("SELECT data FROM accounts").all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  // ---- pools ----
  savePool(key: string, pool: Pool) {
    this.db.prepare("INSERT OR REPLACE INTO pools (key, data) VALUES (?, ?)").run(key, JSON.stringify(pool, bigintReplacer))
  }

  getPool(key: string): Pool | undefined {
    const row = this.db.prepare("SELECT data FROM pools WHERE key = ?").get(key) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }

  getAllPools(): [string, Pool][] {
    const rows = this.db.prepare("SELECT key, data FROM pools").all() as { key: string; data: string }[]
    return rows.map((r) => [r.key, JSON.parse(r.data)])
  }

  // ---- lp shares ----
  saveLpShares(pool: string, owner: string, shares: bigint) {
    this.db
      .prepare("INSERT OR REPLACE INTO lp_shares (pool, owner, shares) VALUES (?, ?, ?)")
      .run(pool, owner, shares.toString())
  }

  getLpShares(pool: string, owner: string): bigint {
    const row = this.db
      .prepare("SELECT shares FROM lp_shares WHERE pool = ? AND owner = ?")
      .get(pool, owner) as { shares: string } | undefined
    return row ? BigInt(row.shares) : 0n
  }

  // ---- contracts ----
  saveContract(address: string, data: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO contracts (address, data) VALUES (?, ?)").run(address, JSON.stringify(data, bigintReplacer))
  }

  // ---- mempool ----
  saveMempoolTxs(txs: Tx[]) {
    const del = this.db.prepare("DELETE FROM mempool")
    const ins = this.db.prepare("INSERT OR REPLACE INTO mempool (hash, data) VALUES (?, ?)")
    this.db.transaction(() => {
      del.run()
      for (const tx of txs) {
        ins.run(sha256(JSON.stringify(tx, bigintReplacer)), JSON.stringify(tx, bigintReplacer))
      }
    })()
  }

  loadMempool(): Tx[] {
    const rows = this.db.prepare("SELECT data FROM mempool").all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data))
  }

  // ---- validators ----
  saveValidators(validators: Map<string, { publicKey: string; stake: bigint }>) {
    const del = this.db.prepare("DELETE FROM validators")
    const ins = this.db.prepare("INSERT OR REPLACE INTO validators (pubkey, data) VALUES (?, ?)")
    this.db.transaction(() => {
      del.run()
      for (const [pk, v] of validators) {
        ins.run(pk, JSON.stringify(v, bigintReplacer))
      }
    })()
  }

  loadValidators(): Map<string, { publicKey: string; stake: bigint }> {
    const rows = this.db.prepare("SELECT pubkey, data FROM validators").all() as { pubkey: string; data: string }[]
    const m = new Map()
    for (const r of rows) {
      m.set(r.pubkey, JSON.parse(r.data))
    }
    return m
  }

  // ---- meta ----
  setMeta(key: string, value: string) {
    this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, value)
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined
    return row?.value
  }

  close() {
    this.db.close()
  }
}
