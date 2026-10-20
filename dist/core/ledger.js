/**
 * Lumen — реестр состояния: счета, транзакции, стейкинг и встроенный AMM.
 *
 * Модель — счета (account-based) с utxo-подобной простотой:
 *   - стоимость транзакции зависит от размера (EIP-1559-подобный fee market)
 *   - consensus: PoS, валидаторы получают 3% годовых от общего supply
 *   - AMM: постоянное произведение (x*y=k), комиссия 0.3%
 */
import { sha256, sha256Buf, addressFromPublicKey, keypairFromSeed, verify } from "./crypto.js";
export const GENESIS_SUPPLY = 1000000000000000n; // 1e9 LMN, 6 знаков
export const TX_FEE = 1000n; // базовая комиссия
export const MIN_STAKE = 10000n * 1000000n; // 10 000 LMN
export const AMM_FEE_BPS = 30n; // 0.30%
export const PREMINE = GENESIS_SUPPLY / 2n; // половина в генезис-распределение
/** Казна сети: 60% премайна (ликвидность AMM, награды, гранты). */
export const TREASURY_ADDRESS = addressFromPublicKey(keypairFromSeed(Buffer.from(sha256("lumen/genesis/treasury"), "hex")).publicKey);
/** Пул ранних валидаторов: 40% премайна, выплачивается 1:1 к застейканному. */
export const EARLY_VALIDATORS_ADDRESS = addressFromPublicKey(keypairFromSeed(Buffer.from(sha256("lumen/genesis/early-validators"), "hex")).publicKey);
export const PREMINE_TREASURY = (GENESIS_SUPPLY * 60n) / 100n;
export const PREMINE_EARLY = GENESIS_SUPPLY - PREMINE_TREASURY;
export class LedgerError extends Error {
}
export class Ledger {
    accounts = new Map();
    pools = new Map();
    /** null means "native LMN" */
    poolKey(baseSymbol, quoteSymbol) {
        return `${baseSymbol}/${quoteSymbol}`;
    }
    get(address) {
        let a = this.accounts.get(address);
        if (!a) {
            a = { address, balance: 0n, stake: 0n, nonce: 0 };
            this.accounts.set(address, a);
        }
        return a;
    }
    balance(address) {
        return this.accounts.get(address)?.balance ?? 0n;
    }
    totalSupply() {
        let t = 0n;
        for (const a of this.accounts.values())
            t += a.balance + a.stake;
        return t;
    }
    /** Применить транзакцию. Возвращает true, если принята. */
    apply(tx) {
        const from = this.get(tx.from);
        if (from.publicKey) {
            const msg = this.txMessage(tx);
            if (!verify(from.publicKey, msg, tx.signature))
                throw new LedgerError("bad signature");
        }
        if (tx.nonce !== from.nonce)
            throw new LedgerError(`bad nonce: expected ${from.nonce}, got ${tx.nonce}`);
        const total = tx.amount + tx.fee;
        if (from.balance < total)
            throw new LedgerError("insufficient balance");
        from.balance -= total;
        from.nonce += 1;
        if (tx.data?.startsWith("stake:")) {
            from.stake += tx.amount;
            // ранние валидаторы получают 1:1 к застейканному из пула премайна
            const pool = this.get(EARLY_VALIDATORS_ADDRESS);
            const bonus = tx.amount < pool.balance ? tx.amount : pool.balance;
            if (bonus > 0n) {
                pool.balance -= bonus;
                from.balance += bonus;
            }
        }
        else if (tx.data?.startsWith("unstake:")) {
            if (from.stake < tx.amount)
                throw new LedgerError("not enough stake");
            from.stake -= tx.amount;
            from.balance += tx.amount;
        }
        else if (tx.to) {
            this.get(tx.to).balance += tx.amount;
        }
        return true;
    }
    /** Начисление вознаграждения валидатору (PoS). */
    reward(address, amount) {
        this.get(address).balance += amount;
    }
    /** Сообщение, которое подписывает отправитель. */
    txMessage(tx) {
        return Buffer.from([
            tx.from,
            tx.to ?? "",
            tx.amount.toString(),
            tx.fee.toString(),
            tx.nonce,
            tx.data ?? "",
            tx.timestamp,
        ].join("|"));
    }
    // --- AMM (constant product) -----------------------------------------------
    addLiquidity(baseSymbol, quoteSymbol, base, quote) {
        const key = this.poolKey(baseSymbol, quoteSymbol);
        const p = this.pools.get(key) ?? { base: 0n, quote: 0n, feeBps: AMM_FEE_BPS };
        p.base += base;
        p.quote += quote;
        this.pools.set(key, p);
    }
    /** Сколько quote получит покупатель base (с комиссией). */
    quoteSwap(key, baseIn) {
        const p = this.pools.get(key);
        if (!p || p.base === 0n || p.quote === 0n)
            return 0n;
        const feeIn = (baseIn * p.feeBps) / 10000n;
        const effIn = baseIn - feeIn;
        return (p.quote * effIn) / (p.base + effIn);
    }
    /** Исполнение свопа. */
    swap(key, baseIn) {
        const p = this.pools.get(key);
        if (!p)
            throw new LedgerError("no such pool");
        const out = this.quoteSwap(key, baseIn);
        if (out === 0n)
            throw new LedgerError("swap yields nothing");
        const feeIn = (baseIn * p.feeBps) / 10000n;
        p.base += baseIn;
        p.quote -= out;
        return out;
    }
    pool(key) {
        return this.pools.get(key);
    }
    /** Снимок состояния для подписи консенсуса. */
    stateRoot() {
        const parts = [];
        for (const [addr, a] of [...this.accounts].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
            parts.push(`${addr}:${a.balance}:${a.stake}:${a.nonce}`);
        }
        return sha256(parts.join("|"));
    }
}
/** JSON с поддержкой bigint (для меркла и RPC). */
export function stringify(value) {
    return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}
/** Генезис-распределение: 60% в казну, 40% — пул ранних валидаторов. */
export function genesisAllocations() {
    return {
        [TREASURY_ADDRESS]: PREMINE_TREASURY,
        [EARLY_VALIDATORS_ADDRESS]: PREMINE_EARLY,
    };
}
export function createGenesis(ledger, allocations) {
    for (const [addr, amount] of Object.entries(allocations)) {
        const a = ledger.get(addr);
        a.balance += amount;
    }
    return ledger;
}
export { addressFromPublicKey, sha256, sha256Buf };
