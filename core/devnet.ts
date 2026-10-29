/**
 * Local devnet parameters.
 *
 * The validator key is derived from a public seed. It is not a secret.
 * USDC here is an internal accounting unit so the built-in pool can be
 * swapped against without a bridge or an external chain.
 */
import { addressFromPublicKey, keypairFromSeed, sha256, sign } from "./crypto.js"
import {
  FAUCET_ADDRESS,
  Ledger,
  LedgerError,
  MIN_STAKE,
  TREASURY_ADDRESS,
  TX_FEE,
  type Tx,
} from "./ledger.js"

export const DEVNET_CHAIN_ID = "lumen-devnet"
export const DEVNET_VALIDATOR_SEED = "lumen/devnet/validator/v1"
export const DEVNET_POOL = "LMN/USDC"

/** 10,000,000 LMN of treasury inventory, moved into the pool. */
export const DEVNET_LIQUIDITY_LMN = 10_000_000n * 1_000_000n
/** Matching quote reserve. Created as internal USDC units, not bridged USDC. */
export const DEVNET_LIQUIDITY_USDC = 10_000_000n * 1_000_000n
/** 1,000,000 LMN moved from the faucet to the devnet validator. */
export const DEVNET_VALIDATOR_GRANT = 1_000_000n * 1_000_000n
/** Internal USDC so a buy can be tested before any sell. */
export const DEVNET_VALIDATOR_USDC = 100_000n * 1_000_000n

export type DevWallet = {
  address: string
  publicKey: string
  privateKey: string
}

export function devnetWallet(): DevWallet {
  const seed = Buffer.from(sha256(DEVNET_VALIDATOR_SEED), "hex")
  const kp = keypairFromSeed(seed)
  return {
    address: addressFromPublicKey(kp.publicKey),
    publicKey: kp.publicKey,
    privateKey: kp.privateKey,
  }
}

/**
 * Move genesis LMN into a validator account and an LMN/USDC pool.
 * Call this only while building genesis, before the genesis block is sealed.
 */
export function seedDevnet(ledger: Ledger): { publicKey: string; stake: bigint; address: string } {
  const w = devnetWallet()
  const faucet = ledger.get(FAUCET_ADDRESS)
  if (faucet.balance < DEVNET_VALIDATOR_GRANT) throw new LedgerError("faucet cannot fund devnet validator")
  faucet.balance -= DEVNET_VALIDATOR_GRANT
  const acct = ledger.get(w.address)
  acct.balance += DEVNET_VALIDATOR_GRANT
  acct.publicKey = w.publicKey
  if (acct.balance < MIN_STAKE) throw new LedgerError("devnet grant below minimum stake")
  acct.balance -= MIN_STAKE
  acct.stake = MIN_STAKE

  const treasury = ledger.get(TREASURY_ADDRESS)
  if (treasury.balance < DEVNET_LIQUIDITY_LMN) throw new LedgerError("treasury cannot seed devnet pool")
  treasury.balance -= DEVNET_LIQUIDITY_LMN
  ledger.addLiquidity("LMN", "USDC", DEVNET_LIQUIDITY_LMN, DEVNET_LIQUIDITY_USDC, TREASURY_ADDRESS)
  ledger.creditAsset(w.address, "USDC", DEVNET_VALIDATOR_USDC)
  return { publicKey: w.publicKey, stake: acct.stake, address: w.address }
}

type TxSink = {
  ledger: Ledger
  mempool: { txs: Tx[]; add(tx: Tx): void }
}

function nextNonce(host: TxSink, address: string): number {
  let n = host.ledger.get(address).nonce
  for (const tx of host.mempool.txs) {
    if (tx.from === address && tx.nonce >= n) n = tx.nonce + 1
  }
  return n
}

function signTx(wallet: DevWallet, tx: Tx): Tx {
  const msg = Buffer.from(
    [tx.from, tx.to ?? "", tx.amount.toString(), tx.fee.toString(), tx.nonce, tx.data ?? "", tx.timestamp].join("|"),
  )
  tx.signature = sign(wallet.privateKey, msg)
  return tx
}

export function queueStake(host: TxSink, wallet: DevWallet, amount: bigint): Tx {
  if (amount < MIN_STAKE) throw new LedgerError(`stake below minimum ${MIN_STAKE}`)
  const acct = host.ledger.get(wallet.address)
  const nonce = nextNonce(host, wallet.address)
  if (acct.balance < amount + TX_FEE) throw new LedgerError("insufficient balance")
  const tx = signTx(wallet, {
    from: wallet.address,
    to: undefined,
    amount,
    fee: TX_FEE,
    nonce,
    data: "stake:",
    timestamp: Date.now(),
    signature: "",
  })
  host.mempool.add(tx)
  return tx
}

export function queueSwap(host: TxSink, wallet: DevWallet, direction: "sell" | "buy", amount: bigint): Tx {
  if (amount <= 0n) throw new LedgerError("swap amount must be positive")
  const acct = host.ledger.get(wallet.address)
  const nonce = nextNonce(host, wallet.address)
  if (direction === "sell") {
    if (acct.balance < amount + TX_FEE) throw new LedgerError("insufficient balance")
    if (host.ledger.quoteSwap(DEVNET_POOL, amount) === 0n) throw new LedgerError("swap yields nothing")
    const tx = signTx(wallet, {
      from: wallet.address,
      to: undefined,
      amount,
      fee: TX_FEE,
      nonce,
      data: `swap:${DEVNET_POOL}`,
      timestamp: Date.now(),
      signature: "",
    })
    host.mempool.add(tx)
    return tx
  }
  if (host.ledger.assetBalance(wallet.address, "USDC") < amount) throw new LedgerError("insufficient USDC")
  if (acct.balance < TX_FEE) throw new LedgerError("insufficient balance for fee")
  if (host.ledger.quoteBuy(DEVNET_POOL, amount) === 0n) throw new LedgerError("swap yields nothing")
  const tx = signTx(wallet, {
    from: wallet.address,
    to: undefined,
    amount: 0n,
    fee: TX_FEE,
    nonce,
    data: `swap-buy:${DEVNET_POOL}:${amount}`,
    timestamp: Date.now(),
    signature: "",
  })
  host.mempool.add(tx)
  return tx
}
