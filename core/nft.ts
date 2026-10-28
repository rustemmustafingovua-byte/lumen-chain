/**
 * Lumen — простой NFT-маркетплейс.
 *
 * Хранилище: SQLite (таблицы nfts, nft_listings).
 *
 * Возможности:
 *   - mint   — создать NFT (owner = creator, uri = metadata)
 *   - list   — выставить на продажу
 *   - buy    — купить выставленный NFT
 *
 * CLI:
 *   lumen nft mint <uri>
 *   lumen nft list <id> <price>
 *   lumen nft buy <id>
 */

import Database from "better-sqlite3"
import { mkdirSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { Ledger } from "./ledger.js"

const DB_DIR = join(homedir(), ".lumen")
const DB_PATH = join(DB_DIR, "defi.db")

function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value
}

export type NFT = {
  id: number
  owner: string
  creator: string
  uri: string
  createdAt: number
}

export type NFTListing = {
  id: number
  nftId: number
  seller: string
  price: bigint
  active: boolean
}

export class NFTError extends Error {}

export class NFTMarketplace {
  db: Database.Database

  constructor(path = DB_PATH) {
    if (path !== ":memory:" && !existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })
    this.db = new Database(path)
    this.db.pragma("journal_mode = WAL")
    this.init()
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nfts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner TEXT NOT NULL,
        creator TEXT NOT NULL,
        uri TEXT NOT NULL,
        createdAt INTEGER NOT NULL
      )
    `)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nft_listings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nftId INTEGER NOT NULL UNIQUE,
        seller TEXT NOT NULL,
        price TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )
    `)
  }

  mint(owner: string, uri: string): NFT {
    const res = this.db
      .prepare("INSERT INTO nfts (owner, creator, uri, createdAt) VALUES (?, ?, ?, ?)")
      .run(owner, owner, uri, Date.now())
    return this.get(Number(res.lastInsertRowid))!
  }

  get(id: number): NFT | undefined {
    const row = this.db
      .prepare("SELECT * FROM nfts WHERE id = ?")
      .get(id) as { id: number; owner: string; creator: string; uri: string; createdAt: number } | undefined
    if (!row) return undefined
    return { id: row.id, owner: row.owner, creator: row.creator, uri: row.uri, createdAt: row.createdAt }
  }

  list(nftId: number, seller: string, price: bigint): NFTListing {
    const nft = this.get(nftId)
    if (!nft) throw new NFTError("NFT не найден")
    if (nft.owner !== seller) throw new NFTError("вы не владеете этим NFT")

    // remove existing listing if any
    this.db.prepare("DELETE FROM nft_listings WHERE nftId = ?").run(nftId)

    const res = this.db
      .prepare("INSERT INTO nft_listings (nftId, seller, price, active) VALUES (?, ?, ?, 1)")
      .run(nftId, seller, price.toString())
    return this.getListing(Number(res.lastInsertRowid))!
  }

  cancelListing(nftId: number, owner: string): NFTListing | undefined {
    const listing = this.getListingByNft(nftId)
    if (!listing || listing.seller !== owner) return undefined
    this.db.prepare("UPDATE nft_listings SET active = 0 WHERE nftId = ?").run(nftId)
    return this.getListingByNft(nftId)
  }

  buy(nftId: number, buyer: string, ledger: Ledger): { nft: NFT; listing: NFTListing } | undefined {
    const listing = this.getListingByNft(nftId)
    if (!listing || !listing.active) return undefined

    const nft = this.get(nftId)!
    if (nft.owner === buyer) throw new NFTError("нельзя купить собственный NFT")

    const price = listing.price
    const buyerAcc = ledger.get(buyer)
    if (buyerAcc.balance < price) throw new NFTError("недостаточно LMN")

    // transfer
    buyerAcc.balance -= price
    ledger.get(listing.seller).balance += price
    nft.owner = buyer

    this.db.prepare("UPDATE nfts SET owner = ? WHERE id = ?").run(buyer, nftId)
    this.db.prepare("UPDATE nft_listings SET active = 0 WHERE nftId = ?").run(nftId)

    return { nft, listing }
  }

  getListing(id: number): NFTListing | undefined {
    const row = this.db
      .prepare("SELECT * FROM nft_listings WHERE id = ?")
      .get(id) as { id: number; nftId: number; seller: string; price: string; active: number } | undefined
    if (!row) return undefined
    return {
      id: row.id,
      nftId: row.nftId,
      seller: row.seller,
      price: BigInt(row.price),
      active: row.active === 1,
    }
  }

  getListingByNft(nftId: number): NFTListing | undefined {
    const row = this.db
      .prepare("SELECT * FROM nft_listings WHERE nftId = ?")
      .get(nftId) as { id: number; nftId: number; seller: string; price: string; active: number } | undefined
    if (!row) return undefined
    return {
      id: row.id,
      nftId: row.nftId,
      seller: row.seller,
      price: BigInt(row.price),
      active: row.active === 1,
    }
  }

  listAllListings(activeOnly = true): NFTListing[] {
    const sql = activeOnly ? "SELECT * FROM nft_listings WHERE active = 1" : "SELECT * FROM nft_listings"
    return (this.db.prepare(sql).all() as Array<{ id: number; nftId: number; seller: string; price: string; active: number }>).map(
      (r) => ({
        id: r.id,
        nftId: r.nftId,
        seller: r.seller,
        price: BigInt(r.price),
        active: r.active === 1,
      }),
    )
  }

  close() {
    this.db.close()
  }
}
