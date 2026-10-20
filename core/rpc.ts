/**
 * Lumen — JSON-RPC узла и кошелёк.
 */
import { createHash, randomBytes } from "node:crypto"
import { TX_FEE, type Tx, stringify } from "./ledger.js"
import { Chain, SLOT_MS } from "./chain.js"
import { addressFromPublicKey, keypairFromSeed, sha256, sign } from "./crypto.js"

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
