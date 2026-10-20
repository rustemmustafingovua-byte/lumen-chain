import { TX_FEE, type Tx } from "./ledger.js";
import { Chain, SLOT_MS } from "./chain.js";
export type RpcHandler = (method: string, params?: any[]) => any;
export declare function makeRpc(chain: Chain): RpcHandler;
export type Wallet = {
    address: string;
    publicKey: string;
    privateKey: string;
};
/** Создать кошелёк; опционально с мнемоникой (словарь 2048 BIP39-подобный). */
export declare function createWallet(mnemonic?: string): Wallet;
/** Собрать транзакцию и подписать. */
export declare function buildTx(wallet: Wallet, to: string, amount: bigint, opts?: {
    fee?: bigint;
    nonce?: number;
    data?: string;
    timestamp?: number;
}): Tx;
export { SLOT_MS, TX_FEE };
