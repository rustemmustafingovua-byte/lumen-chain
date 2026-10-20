/**
 * Lumen — реестр состояния: счета, транзакции, стейкинг и встроенный AMM.
 *
 * Модель — счета (account-based) с utxo-подобной простотой:
 *   - стоимость транзакции зависит от размера (EIP-1559-подобный fee market)
 *   - consensus: PoS, валидаторы получают 3% годовых от общего supply
 *   - AMM: постоянное произведение (x*y=k), комиссия 0.3%
 */
import { sha256, sha256Buf, addressFromPublicKey } from "./crypto.js";
export declare const GENESIS_SUPPLY = 1000000000000000n;
export declare const TX_FEE = 1000n;
export declare const MIN_STAKE: bigint;
export declare const AMM_FEE_BPS = 30n;
export declare const PREMINE: bigint;
/** Казна сети: 60% премайна (ликвидность AMM, награды, гранты). */
export declare const TREASURY_ADDRESS: string;
/** Пул ранних валидаторов: 40% премайна, выплачивается 1:1 к застейканному. */
export declare const EARLY_VALIDATORS_ADDRESS: string;
export declare const PREMINE_TREASURY: bigint;
export declare const PREMINE_EARLY: bigint;
export type Account = {
    address: string;
    balance: bigint;
    stake: bigint;
    publicKey?: string;
    nonce: number;
};
export type Tx = {
    from: string;
    to?: string;
    amount: bigint;
    fee: bigint;
    nonce: number;
    data?: string;
    timestamp: number;
    signature: string;
};
export type Pool = {
    base: bigint;
    quote: bigint;
    feeBps: bigint;
};
export declare class LedgerError extends Error {
}
export declare class Ledger {
    accounts: Map<string, Account>;
    pools: Map<string, Pool>;
    /** null means "native LMN" */
    poolKey(baseSymbol: string, quoteSymbol: string): string;
    get(address: string): Account;
    balance(address: string): bigint;
    totalSupply(): bigint;
    /** Применить транзакцию. Возвращает true, если принята. */
    apply(tx: Tx): boolean;
    /** Начисление вознаграждения валидатору (PoS). */
    reward(address: string, amount: bigint): void;
    /** Сообщение, которое подписывает отправитель. */
    txMessage(tx: Tx): Buffer;
    addLiquidity(baseSymbol: string, quoteSymbol: string, base: bigint, quote: bigint): void;
    /** Сколько quote получит покупатель base (с комиссией). */
    quoteSwap(key: string, baseIn: bigint): bigint;
    /** Исполнение свопа. */
    swap(key: string, baseIn: bigint): bigint;
    pool(key: string): Pool | undefined;
    /** Снимок состояния для подписи консенсуса. */
    stateRoot(): string;
}
/** JSON с поддержкой bigint (для меркла и RPC). */
export declare function stringify(value: unknown): string;
/** Генезис-распределение: 60% в казну, 40% — пул ранних валидаторов. */
export declare function genesisAllocations(): Record<string, bigint>;
export declare function createGenesis(ledger: Ledger, allocations: Record<string, bigint>): Ledger;
export { addressFromPublicKey, sha256, sha256Buf };
