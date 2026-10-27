/**
 * Lumen — JSON-RPC узла и кошелёк.
 */
import { createHash, randomBytes } from "node:crypto"
import { TX_FEE, type Tx, stringify } from "./ledger.js"
import { Chain, SLOT_MS } from "./chain.js"
import { addressFromPublicKey, keypairFromSeed, sha256, sign } from "./crypto.js"

export type RpcHandler = (method: string, params?: any[]) => any

export function makeRpc(chain: Chain): RpcHandler {
  const ALLOWED = new Set([
    "lumen_chainId",
    "lumen_blockNumber",
    "lumen_getBalance",
    "lumen_getStake",
    "lumen_getNonce",
    "lumen_getBlock",
    "lumen_getHead",
    "lumen_totalSupply",
    "lumen_stateRoot",
    "lumen_pool",
    "lumen_quoteSwap",
    "lumen_sendRawTransaction",
    "lumen_contracts",
    "lumen_contract",
    "lumen_pendingCount",
  ])
  return (method, params = []) => {
    if (!ALLOWED.has(method)) throw new Error("unknown method: " + method)
    // sanitize string params
    for (let i = 0; i < params.length; i++) {
      if (typeof params[i] === "string" && params[i].length > 256) {
        throw new Error(`param[${i}] too long: ${params[i].length} > 256`)
      }
    }
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
      case "lumen_contracts": {
        const out: Record<string, unknown> = {}
        for (const [addr, c] of chain.ledger.contracts) {
          out[addr] = {
            codeSize: c.code.length,
            balance: c.balance.toString(),
            storage: Object.fromEntries([...c.storage.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
          }
        }
        return out
      }
      case "lumen_contract": {
        const addr = String(params[0])
        const c = chain.ledger.contracts.get(addr)
        if (!c) return null
        return {
          address: addr,
          codeSize: c.code.length,
          balance: c.balance.toString(),
          storage: Object.fromEntries([...c.storage.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))),
        }
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
  // детерминированный seed -> ed25519: публичный ключ выводится из seed
  const kp = keypairFromSeed(seed)
  return {
    address: addressFromPublicKey(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  }
}

/** Собрать транзакцию и подписать. */
export function buildTx(
  wallet: Wallet,
  to: string,
  amount: bigint,
  opts: { fee?: bigint; nonce?: number; data?: string; timestamp?: number } = {},
): Tx {
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
