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
import { dirname, join } from "node:path"
import type { Block, Tx, Account } from "./chain.js"
import { sha256 } from "./crypto.js"
import type { Pool } from "./ledger.js"

/** Directory that holds chain.db. LUMEN_HOME wins so Docker volumes are actually used. */
export function dataDir(): string {
  if (process.env.LUMEN_HOME) return process.env.LUMEN_HOME
  return join(process.env.LUMEN_DB_DIR ?? homedir(), ".lumen")
}

const DB_PATH = join(dataDir(), "chain.db")

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

export class Persistence {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (path !== ":memory:") {
      const dir = dirname(path)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
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
    this.createFarmingPositionsTable()
    this.createGovernanceTables()
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

  getAllLpShares(): { pool: string; address: string; shares: bigint }[] {
    const rows = this.db.prepare("SELECT pool, owner, shares FROM lp_shares").all() as { pool: string; owner: string; shares: string }[]
    return rows.map((r) => ({ pool: r.pool, address: r.owner, shares: BigInt(r.shares) }))
  }

  // ---- contracts ----
  saveContract(address: string, data: unknown) {
    this.db.prepare("INSERT OR REPLACE INTO contracts (address, data) VALUES (?, ?)").run(address, JSON.stringify(data, bigintReplacer))
  }

  getAllContracts(): { address: string; data: string }[] {
    return this.db.prepare("SELECT address, data FROM contracts").all() as { address: string; data: string }[]
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

  // ---- farming positions ----
  createFarmingPositionsTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS farming_positions (
        pool TEXT NOT NULL,
        owner TEXT NOT NULL,
        shares TEXT NOT NULL,
        stakedAt INTEGER NOT NULL,
        claimedAt INTEGER NOT NULL,
        PRIMARY KEY (pool, owner)
      )
    `)
  }

  saveFarmingPosition(pool: string, owner: string, shares: bigint, stakedAt: number, claimedAt: number) {
    this.db.prepare(
      "INSERT OR REPLACE INTO farming_positions (pool, owner, shares, stakedAt, claimedAt) VALUES (?, ?, ?, ?, ?)",
    ).run(pool, owner, shares.toString(), stakedAt, claimedAt)
  }

  getFarmingPosition(pool: string, owner: string): { shares: bigint; stakedAt: number; claimedAt: number } | undefined {
    const row = this.db
      .prepare("SELECT shares, stakedAt, claimedAt FROM farming_positions WHERE pool = ? AND owner = ?")
      .get(pool, owner) as { shares: string; stakedAt: number; claimedAt: number } | undefined
    return row ? { shares: BigInt(row.shares), stakedAt: row.stakedAt, claimedAt: row.claimedAt } : undefined
  }

  getAllFarmingPositions(): { pool: string; owner: string; shares: bigint; stakedAt: number; claimedAt: number }[] {
    const rows = this.db.prepare("SELECT pool, owner, shares, stakedAt, claimedAt FROM farming_positions").all() as {
      pool: string
      owner: string
      shares: string
      stakedAt: number
      claimedAt: number
    }[]
    return rows.map((r) => ({ pool: r.pool, owner: r.owner, shares: BigInt(r.shares), stakedAt: r.stakedAt, claimedAt: r.claimedAt }))
  }

  // ---- governance ----
  createGovernanceTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        creator TEXT NOT NULL,
        yesVotes INTEGER NOT NULL DEFAULT 0,
        noVotes INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active'
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS governance_votes (
        proposalId INTEGER NOT NULL,
        voter TEXT NOT NULL,
        choice TEXT NOT NULL,
        PRIMARY KEY (proposalId, voter)
      )
    `)
  }

  saveProposal(title: string, description: string, createdAt: number, creator: string): number {
    const res = this.db
      .prepare("INSERT INTO governance_proposals (title, description, createdAt, creator) VALUES (?, ?, ?, ?)")
      .run(title, description, createdAt, creator)
    return Number(res.lastInsertRowid)
  }

  getProposal(id: number): { title: string; description: string; createdAt: number; creator: string; yesVotes: number; noVotes: number; status: string } | undefined {
    const row = this.db
      .prepare("SELECT title, description, createdAt, creator, yesVotes, noVotes, status FROM governance_proposals WHERE id = ?")
      .get(id) as
        | { title: string; description: string; createdAt: number; creator: string; yesVotes: number; noVotes: number; status: string }
        | undefined
    return row
  }

  getAllProposals(): { id: number; title: string; description: string; createdAt: number; creator: string; yesVotes: number; noVotes: number; status: string }[] {
    return this.db.prepare("SELECT id, title, description, createdAt, creator, yesVotes, noVotes, status FROM governance_proposals").all() as {
      id: number
      title: string
      description: string
      createdAt: number
      creator: string
      yesVotes: number
      noVotes: number
      status: string
    }[]
  }

  saveVote(proposalId: number, voter: string, choice: string) {
    this.db.prepare("INSERT OR REPLACE INTO governance_votes (proposalId, voter, choice) VALUES (?, ?, ?)").run(proposalId, voter, choice)
  }

  hasVoted(proposalId: number, voter: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM governance_votes WHERE proposalId = ? AND voter = ?")
      .get(proposalId, voter) as { 1: number } | undefined
    return !!row
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
