/**
 * Lumen Keeper — кошелёк и подпись транзакций LMN.
 */

import { readFileSync, writeFileSync, existsSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { sha256, keypairFromSeed, sign } from "../core/crypto.js"

export const KEEPER_KEY_PATH = join(homedir(), ".lumen", "keeper.key.json")

export type KeeperWallet = {
  address: string
  publicKey: string
  privateKey: string
}

export function loadOrCreateKeeperWallet(path = KEEPER_KEY_PATH): KeeperWallet {
  if (existsSync(path)) {
    const raw = JSON.parse(readFileSync(path, "utf8")) as KeeperWallet
    return raw
  }
  // Генерация из deterministic seed (mnemonic можно добавить позже)
  const seed = sha256("lumen/keeper/" + Date.now().toString())
  const kp = keypairFromSeed(Buffer.from(seed, "hex"))
  const wallet: KeeperWallet = {
    address: kp.publicKey.slice(0, 40),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  }
  const dir = join(path, "..")
  if (!existsSync(dir)) {
    import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }))
  }
  writeFileSync(path, JSON.stringify(wallet, null, 2))
  chmodSync(path, 0o600)
  return wallet
}

export function signLumenTx(wallet: KeeperWallet, to: string, amount: bigint, nonce: number, data = ""): string {
  const msg = JSON.stringify({ from: wallet.address, to, amount: amount.toString(), nonce, data, ts: Date.now() })
  const sig = sign(wallet.privateKey, msg)
  return JSON.stringify({
    from: wallet.address,
    to,
    amount: amount.toString(),
    fee: "1000",
    nonce,
    data,
    publicKey: wallet.publicKey,
    signature: sig,
  })
}
