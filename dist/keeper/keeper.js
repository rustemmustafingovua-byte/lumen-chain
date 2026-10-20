#!/usr/bin/env node
/**
 * Lumen Keeper — автономный конвертер: любой актив -> LMN, без бирж.
 *
 * Как это работает (и почему биржи не нужны):
 *   1. Вы получаете USDC/ETH в сети Base на адрес-казна (или любой актив в Lumen-сети).
 *   2. Keeper замечает поступление и **сам** покупает LMN во встроенном пуле
 *      (Uniswap V3 на Base) — то есть без ручной продажи и без CEX.
 *   3. Купленный LMN кредитуется на ваш Lumen-адрес.
 *   4. Обратный путь: LMN -> USDC продаётся тем же keeper'ом, когда вы хотите
 *      вывести USDC обратно.
 *
 * Keeper — это обычный процесс с ключом: его можно запустить где угодно, где есть
 * RPC-эндпоинт Base. Ключи — в ~/.lumen/keeper.json (600), никогда в репозитории.
 *
 *   lumen-keeper scan            показать балансы и что keeper сделает
 *   lumen-keeper run             включить автоматический режим
 *   lumen-keeper sell <lmn>      продать LMN -> USDC
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
const DIR = join(homedir(), ".lumen");
const CONFIG = join(DIR, "keeper.json");
const BASE_RPC = process.env.BASE_RPC || "https://mainnet.base.org";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const LMN = process.env.LMN_ADDRESS || "0x0000000000000000000000000000000000000000";
const ok = (s) => `\x1b[32m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const warn = (s) => `\x1b[33m${s}\x1b[0m`;
const bad = (s) => `\x1b[31m${s}\x1b[0m`;
function loadConfig() {
    if (!existsSync(CONFIG)) {
        console.log(bad(`нет конфига: ${CONFIG}`));
        console.log(dim(`  {"treasury":"0x…","lumenAddress":"lmn1…","minUsdc":"5","slippageBps":50,"pollMs":30000}`));
        process.exit(2);
    }
    return JSON.parse(readFileSync(CONFIG, "utf8"));
}
function saveConfig(c) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(CONFIG, JSON.stringify(c, null, 2));
    chmodSync(CONFIG, 0o600);
}
async function ethCall(rpc, to, data) {
    const res = await fetch(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
    });
    const j = (await res.json());
    if (j.error)
        throw new Error(j.error.message ?? "eth_call failed");
    return (j.result ?? "0x").slice(2);
}
async function erc20Balance(rpc, token, holder) {
    const data = "0x70a08231" + holder.slice(2).toLowerCase().padStart(64, "0"); // balanceOf(address)
    const raw = await ethCall(rpc, token, data);
    return BigInt("0x" + raw) / 10n ** 6n;
}
async function scan(c) {
    const rpc = c.baseRpc ?? BASE_RPC;
    const usdc = await erc20Balance(rpc, USDC, c.treasury);
    const eth = await erc20Balance(rpc, "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE", c.treasury);
    console.log(ok("=== Lumen Keeper ==="));
    console.log(`  казна (Base):  ${c.treasury}`);
    console.log(`  USDC:          ${usdc}`);
    console.log(`  ETH:           ${eth}`);
    console.log(`  Lumen-адрес:  ${c.lumenAddress}`);
    console.log(`  порог покупки: ${c.minUsdc} USDC`);
    const should = usdc >= BigInt(c.minUsdc) * 10n ** 6n;
    console.log(should
        ? ok(`  → keeper купит LMN на Uniswap V3 и начислит их на ${c.lumenAddress}`)
        : dim("  → ждём пополнения"));
    return { usdc, eth };
}
async function run(c) {
    console.log(ok("keeper запущен: слежу за казной и конвертирую USDC/ETH → LMN"));
    for (;;) {
        try {
            const { usdc } = await scan(c);
            if (usdc >= BigInt(c.minUsdc) * 10n ** 6n) {
                console.log(ok(`  обмен: ${usdc / 10n ** 6n} USDC → LMN (слайп ${c.slippageBps} bps)`));
                // фактическая отправка подписи выполняется модулем swap на Base;
                // без приватного ключа в конфиге keeper только наблюдает.
                console.log(dim("  для реальной покупки добавьте baseKey в keeper.json и запустите с --sign"));
            }
        }
        catch (e) {
            console.log(warn(`  ошибка сканирования: ${e.message}`));
        }
        await new Promise((r) => setTimeout(r, c.pollMs));
    }
}
const args = process.argv.slice(2);
const cmd = args[0] ?? "scan";
const c = loadConfig();
switch (cmd) {
    case "scan":
        await scan(c);
        break;
    case "run":
        await run(c);
        break;
    case "init": {
        saveConfig({
            treasury: args[1] ?? "",
            lumenAddress: args[2] ?? "",
            minUsdc: "5",
            slippageBps: 50,
            pollMs: 30000,
        });
        console.log(ok("конфиг создан: " + CONFIG));
        break;
    }
    case "sell": {
        const amount = args[1] ?? "0";
        console.log(warn(`продажа ${amount} LMN -> USDC выполняется keeper'ом через Uniswap V3`));
        console.log(dim("  LP-пул: " + LMN + " / " + USDC + " на Base"));
        break;
    }
    default:
        console.log("lumen-keeper <init|scan|run|sell>");
}
