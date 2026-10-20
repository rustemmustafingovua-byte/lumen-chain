/**
 * Lumen — JSON-RPC узла и кошелёк.
 */
import { createHash, createPrivateKey, createPublicKey, randomBytes } from "node:crypto"
import { Ledger, TX_FEE, type Tx, stringify } from "./ledger.js"
import { Chain, SLOT_MS } from "./chain.js"
import { addressFromPublicKey, generateKeypair, sha256, sign, type Keypair } from "./crypto.js"

export type RpcHandler = (method: string, params: any[]) => any

export function makeRpc(chain: Chain): RpcHandler {
  return (method, params = []) => {
    switch (method) {
      case "lumen_chainId":
        return "lumen-mainnet"
      case "lumen_blockNumber":
        return chain.height
      case "lumen_getBalance":
        return chain.ledger.balance(params[0]).toString()
      case "lumen_getStake":
        return chain.ledger.get(params[0]).stake.toString()
      case "lumen_getNonce":
        return chain.ledger.get(params[0]).nonce
      case "lumen_getBlock":
        return chain.blocks[params[0]] ?? null
      case "lumen_getHead":
        return chain.head ?? null
      case "lumen_totalSupply":
        return chain.ledger.totalSupply().toString()
      case "lumen_stateRoot":
        return chain.ledger.stateRoot()
      case "lumen_pool":
        return chain.ledger.pool(params[0]) ?? null
      case "lumen_quoteSwap":
        return chain.ledger.quoteSwap(params[0], BigInt(params[1])).toString()
      case "lumen_sendRawTransaction": {
        const tx = JSON.parse(params[0]) as Tx
        chain.mempool.add(tx)
        return "0x" + sha256(stringify(tx)).slice(0, 32)
      }
      case "lumen_pendingCount":
        return chain.mempool.size
      default:
        throw new Error("unknown method: " + method)
    }
  }
}

export type Wallet = {
  address: string
  publicKey: string
  privateKey: string
}

/** Создать кошелёк; опционально с мнемоникой (словарь 2048 BIP39-подобный). */
export function createWallet(mnemonic?: string): Wallet {
  const seed = mnemonic
    ? createHash("sha512").update(mnemonic).digest().subarray(0, 32)
    : randomBytes(32)
  const kp: Keypair = generateKeypair()
  // детерминированный seed -> ключ
  void kp
  // PKCS#8 для ed25519: префикс + 32-байтовый seed; публичный ключ берём из пары
  const der = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed])
  const key = createPrivateKey({ key: der, format: "der", type: "pkcs8" })
  const pub = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(12)
  const publicKeyB64 = pub.toString("base64")
  return {
    address: addressFromPublicKey(publicKeyB64),
    publicKey: publicKeyB64,
    privateKey: der.toString("base64"),
  }
}

/** Собрать транзакцию и подписать. */
export function buildTx(
  wallet: Wallet,
  to: string,
  amount: bigint,
  opts: { fee?: bigint; nonce?: number; data?: string; timestamp?: number } = {},
): Tx {
  const ledger = (opts as any).ledger as Ledger | undefined
  void ledger
  const tx: Tx = {
    from: wallet.address,
    to,
    amount,
    fee: opts.fee ?? TX_FEE,
    nonce: opts.nonce ?? 0,
    data: opts.data,
    timestamp: opts.timestamp ?? Date.now(),
    signature: "",
  }
  const msg = Buffer.from(
    [tx.from, tx.to ?? "", tx.amount.toString(), tx.fee.toString(), tx.nonce, tx.data ?? "", tx.timestamp].join("|"),
  )
  tx.signature = sign(wallet.privateKey, msg)
  return tx
}

export { SLOT_MS, TX_FEE }
