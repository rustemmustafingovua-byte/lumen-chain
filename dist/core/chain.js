/**
 * Lumen — блок, консенсус (PoS) и сеть.
 *
 * Блок: header + транзакции, Merkle-корень, подпись продюсера.
 * Консенсус: stake-weighted, детерминированный выбор по slot + подпись stake-веса.
 * Финальность: блок финализируется, когда накоплен вес >= 2/3 от общего стейка.
 */
import { sha256, sha256Buf, sign, verify } from "./crypto.js";
import { Ledger, TX_FEE, stringify, genesisAllocations, createGenesis } from "./ledger.js";
export const SLOT_MS = 4000;
export const MAX_BLOCK_TXS = 500;
export function merkleRoot(leaves) {
    if (leaves.length === 0)
        return sha256("");
    let level = leaves.map((l) => sha256Buf(l));
    while (level.length > 1) {
        const next = [];
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = level[i + 1] ?? level[i];
            next.push(sha256Buf(Buffer.concat([left, right])));
        }
        level = next;
    }
    return level[0].toString("hex");
}
export function blockHash(b) {
    const h = b.header;
    return sha256([h.height, h.prevHash, h.timestamp, h.proposer, h.merkleRoot, h.txCount, h.slot].join("|"));
}
export class ChainError extends Error {
}
/** Пул транзакций: приоритет по комиссии, лимит на аккаунт. */
export class Mempool {
    txs = [];
    limit = 5000;
    add(tx) {
        if (this.txs.some((t) => t.from === tx.from && t.nonce === tx.nonce))
            throw new ChainError("duplicate nonce in mempool");
        this.txs.push(tx);
        this.txs.sort((a, b) => (b.fee > a.fee ? 1 : b.fee < a.fee ? -1 : 0));
        if (this.txs.length > this.limit)
            this.txs.length = this.limit;
    }
    take(max) {
        const out = this.txs.slice(0, max);
        this.txs = this.txs.slice(max);
        return out;
    }
    get size() {
        return this.txs.length;
    }
}
export class Chain {
    ledger = new Ledger();
    blocks = [];
    mempool = new Mempool();
    /** stake публичных ключей валидаторов */
    validators = new Map();
    /** Высота головы (после генезиса — 0). */
    get height() {
        return Math.max(0, this.blocks.length - 1);
    }
    get head() {
        return this.blocks[this.blocks.length - 1];
    }
    genesis() {
        // фиксированная эмиссия: 60% в казну, 40% — пул ранних валидаторов
        createGenesis(this.ledger, genesisAllocations());
        const b = {
            header: {
                height: 0,
                prevHash: "0".repeat(64),
                timestamp: Date.now(),
                proposer: "genesis",
                merkleRoot: merkleRoot([]),
                txCount: 0,
                slot: 0,
            },
            txs: [],
            signature: "",
            hash: "",
        };
        b.hash = blockHash(b);
        this.blocks.push(b);
    }
    addValidator(publicKey, stake) {
        this.validators.set(publicKey, { publicKey, stake });
    }
    totalStake() {
        let s = 0n;
        for (const v of this.validators.values())
            s += v.stake;
        return s;
    }
    /** Кто продюсирует слот: детерминированно по весу и номеру слота. */
    proposerForSlot(slot) {
        if (!this.validators.size)
            return undefined;
        const entries = [...this.validators.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
        const total = this.totalStake();
        if (total === 0n)
            return entries[0][0];
        const point = BigInt(slot) * total;
        let acc = 0n;
        for (const [pk, v] of entries) {
            acc += v.stake;
            if (point % total < acc)
                return pk;
        }
        return entries[0][0];
    }
    /** Создать блок (продюсер). */
    propose(txs, privateKey, publicKey, slot) {
        const leaves = txs.map((t) => sha256(stringify(t)));
        const b = {
            header: {
                height: this.height + 1,
                prevHash: this.head?.hash ?? "0".repeat(64),
                timestamp: Date.now(),
                proposer: publicKey,
                merkleRoot: merkleRoot(leaves),
                txCount: txs.length,
                slot,
            },
            txs,
            signature: "",
            hash: "",
        };
        b.signature = sign(privateKey, blockHash(b));
        b.hash = blockHash(b);
        return b;
    }
    /** Применить и принять блок. */
    accept(b) {
        if (b.header.height !== this.height + 1)
            throw new ChainError(`bad height ${b.header.height} != ${this.height + 1}`);
        if (b.header.prevHash !== (this.head?.hash ?? "0".repeat(64)))
            throw new ChainError("bad prevHash");
        const v = this.validators.get(b.header.proposer);
        if (!v)
            throw new ChainError("unknown proposer");
        if (!verify(v.publicKey, blockHash(b), b.signature))
            throw new ChainError("bad block signature");
        if (b.hash !== blockHash(b))
            throw new ChainError("bad block hash");
        const leaves = b.txs.map((t) => sha256(stringify(t)));
        if (merkleRoot(leaves) !== b.header.merkleRoot)
            throw new ChainError("bad merkle root");
        for (const tx of b.txs)
            this.ledger.apply(tx);
        this.blocks.push(b);
        return true;
    }
    /** Блок достиг 2/3 веса — финализирован. */
    isFinalized() {
        const total = this.totalStake();
        if (total === 0n)
            return false;
        return this.totalStake() >= (total * 2n) / 3n;
    }
    /** Вознаграждение валидаторам за блок (3% годовых, ~1 блок/5 сек). */
    rewardProposer(publicKey, blockCount) {
        const annual = (this.ledger.totalSupply() * 3n) / 100n;
        const perBlock = annual / BigInt(Math.max(1, (365 * 24 * 3600) / 5));
        this.ledger.reward(publicKey, perBlock * BigInt(blockCount));
    }
}
export { TX_FEE };
