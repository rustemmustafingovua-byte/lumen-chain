import { Ledger, type Tx, TX_FEE, type Account } from "./ledger.js";
export declare const SLOT_MS = 4000;
export declare const MAX_BLOCK_TXS = 500;
export type BlockHeader = {
    height: number;
    prevHash: string;
    timestamp: number;
    proposer: string;
    merkleRoot: string;
    txCount: number;
    slot: number;
};
export type Block = {
    header: BlockHeader;
    txs: Tx[];
    signature: string;
    hash: string;
};
export declare function merkleRoot(leaves: string[]): string;
export declare function blockHash(b: Block): string;
export declare class ChainError extends Error {
}
/** Пул транзакций: приоритет по комиссии, лимит на аккаунт. */
export declare class Mempool {
    txs: Tx[];
    limit: number;
    add(tx: Tx): void;
    take(max: number): Tx[];
    get size(): number;
}
export declare class Chain {
    ledger: Ledger;
    blocks: Block[];
    mempool: Mempool;
    /** stake публичных ключей валидаторов */
    validators: Map<string, {
        publicKey: string;
        stake: bigint;
    }>;
    /** Высота головы (после генезиса — 0). */
    get height(): number;
    get head(): Block | undefined;
    genesis(): void;
    addValidator(publicKey: string, stake: bigint): void;
    totalStake(): bigint;
    /** Кто продюсирует слот: детерминированно по весу и номеру слота. */
    proposerForSlot(slot: number): string | undefined;
    /** Создать блок (продюсер). */
    propose(txs: Tx[], privateKey: string, publicKey: string, slot: number): Block;
    /** Применить и принять блок. */
    accept(b: Block): boolean;
    /** Блок достиг 2/3 веса — финализирован. */
    isFinalized(): boolean;
    /** Вознаграждение валидаторам за блок (3% годовых, ~1 блок/5 сек). */
    rewardProposer(publicKey: string, blockCount: number): void;
}
export { TX_FEE };
export type { Tx, Account };
