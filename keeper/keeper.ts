/**
 * Lumen Keeper — сам конвертер.
 *
 * Логика простая и строгая:
 *   1. смотрим, сколько USDC (или ETH) пришло в казну;
 *   2. проверяем политику: лимит за сутки, лимит за сделку, минимальная сумма;
 *   3. покупаем LMN через Uniswap V3 — без биржи;
 *   4. зачисляем купленный LMN на адрес в родной сети Lumen;
 *   5. записываем всё в журнал, чтобы состояние можно было восстановить.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import {
  emptyState,
  rollDay,
  type Creditor,
  type KeeperState,
  type SpendPolicy,
  type Swapper,
} from "./types.js"

export { emptyState, rollDay } from "./types.js"
export type { KeeperState, SpendPolicy, Swapper, Creditor } from "./types.js"

export const DEFAULT_POLICY: SpendPolicy = {
  minAmount: 5n * 10n ** 6n, // 5 USDC
  maxPerSwap: 500n * 10n ** 6n, // 500 USDC за раз
  maxPerDay: 2_000n * 10n ** 6n, // 2000 USDC в сутки
  maxPriceImpactBps: 100, // не хуже 1%
}

export const KEEPER_DIR = join(homedir(), ".lumen")
export const KEEPER_STATE = join(KEEPER_DIR, "keeper-state.json")
export const KEEPER_CONFIG = join(KEEPER_DIR, "keeper.json")

export type KeeperConfig = {
  /** Адрес казны в сети Base (куда приходят USDC). */
  treasury: string
  /** Адрес в родной сети Lumen, куда зачисляется LMN. */
  lumenAddress: string
  /** Адрес токена LMN в сети Base. */
  lmn?: string
  /** RPC Base. */
  rpcUrl?: string
  policy?: Partial<SpendPolicy>
  /** Как часто проверять. */
  pollMs?: number
}

export function loadConfig(path = KEEPER_CONFIG): KeeperConfig {
  if (!existsSync(path)) {
    throw new Error(
      `нет конфига ${path}. Создай его: {"treasury":"0x…","lumenAddress":"lmn1…","lmn":"0x…"}`,
    )
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as KeeperConfig
  return { ...raw, policy: { ...DEFAULT_POLICY, ...(raw.policy ?? {}) } }
}

export function saveConfig(cfg: KeeperConfig, path = KEEPER_CONFIG) {
  mkdirSync(dirnameSafe(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      cfg,
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  )
  chmodSync(path, 0o600)
}

export function loadState(path = KEEPER_STATE): KeeperState {
  if (!existsSync(path)) return emptyState()
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as KeeperState
    return { ...emptyState(), ...raw, spentToday: BigInt(raw.spentToday ?? 0) }
  } catch {
    return emptyState()
  }
}

export function saveState(state: KeeperState, path = KEEPER_STATE) {
  mkdirSync(dirnameSafe(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      { ...state, spentToday: state.spentToday.toString() },
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    ),
  )
  chmodSync(path, 0o600)
}

function dirnameSafe(p: string) {
  const i = p.lastIndexOf("/")
  return i > 0 ? p.slice(0, i) : p
}

export type KeeperDeps = {
  swapper: Swapper
  creditor?: Creditor
  policy?: SpendPolicy
  state?: KeeperState
  now?: () => Date
  log?: (msg: string) => void
}

export type KeeperDecision =
  | { action: "buy"; amountIn: bigint; quote: { amountOut: bigint; price: bigint } }
  | { action: "skip"; reason: string }

/**
 * Решение: покупать сейчас или ждать.
 * Вынесено отдельно, чтобы правила можно было тестировать без сети.
 */
export function decide(
  balance: bigint,
  policy: SpendPolicy,
  state: KeeperState,
  quote?: { amountOut: bigint; price: bigint; priceImpactBps?: number },
): KeeperDecision {
  if (balance <= 0n) return { action: "skip", reason: "в казне пусто" }
  if (balance < policy.minAmount)
    return { action: "skip", reason: `ниже порога (${balance} < ${policy.minAmount})` }
  if (state.spentToday >= policy.maxPerDay)
    return { action: "skip", reason: "исчерпан дневной лимит" }
  if (policy.allowedPayees && policy.allowedPayees.length === 0)
    return { action: "skip", reason: "список получателей пуст" }

  let amount = balance
  const room = policy.maxPerDay - state.spentToday
  if (amount > room) amount = room
  if (amount > policy.maxPerSwap) amount = policy.maxPerSwap
  if (amount < policy.minAmount) return { action: "skip", reason: "не хватает места под лимитом" }

  if (quote) {
    if (policy.maxPriceImpactBps !== undefined && (quote.priceImpactBps ?? 0) > policy.maxPriceImpactBps) {
      return { action: "skip", reason: `проскальзывание ${quote.priceImpactBps} bps выше лимита` }
    }
  }
  return { action: "buy", amountIn: amount, quote: quote ?? { amountOut: 0n, price: 0n } }
}

/** Один цикл keeper'а: проверка → покупка → зачисление → журнал. */
export async function tick(
  deps: KeeperDeps,
  balance: bigint,
  target: string,
): Promise<{ action: string; detail?: string; tx?: string }> {
  const log = deps.log ?? (() => {})
  const policy = deps.policy ?? DEFAULT_POLICY
  const state = rollDay(deps.state ?? loadState(), (deps.now ?? (() => new Date()))())

  const quote = await deps.swapper.quote(balance).catch(() => undefined)
  const decision = decide(balance, policy, state, quote)
  if (decision.action === "skip") {
    log(`keeper: ждём — ${decision.reason}`)
    return { action: "skip", detail: decision.reason }
  }

  const amountIn = decision.amountIn
  const quoteOut = quote?.amountOut ?? 0n
  // запас 2% против проскальзывания между оценкой и исполнением
  const minOut = (quoteOut * 98n) / 100n
  const tx = await deps.swapper.swap(amountIn, minOut)
  log(`keeper: куплено ${amountIn} → ${quoteOut} (tx ${tx.slice(0, 10)}…)`)

  let creditTx: string | undefined
  if (deps.creditor && quoteOut > 0n) {
    creditTx = (await deps.creditor.credit(target, quoteOut, `keeper:${amountIn}`)) ?? undefined
    log(`keeper: зачислено ${quoteOut} LMN на ${target.slice(0, 10)}…`)
  }

  const next: KeeperState = {
    ...state,
    spentToday: state.spentToday + amountIn,
    history: [...state.history, { at: Date.now(), amountIn, amountOut: quoteOut, tx }].slice(-200),
  }
  saveState(next, KEEPER_STATE)
  return { action: "buy", detail: `${amountIn} → ${quoteOut}`, tx }
}

/** Продажа LMN обратно в USDC. */
export async function sell(
  deps: KeeperDeps,
  amountIn: bigint,
): Promise<{ action: string; tx?: string; detail?: string }> {
  const log = deps.log ?? (() => {})
  const policy = deps.policy ?? DEFAULT_POLICY
  const state = rollDay(deps.state ?? loadState(), (deps.now ?? (() => new Date()))())
  if (amountIn < policy.minAmount) return { action: "skip", detail: "ниже порога" }
  if (state.spentToday + amountIn > policy.maxPerDay)
    return { action: "skip", detail: "превышен дневной лимит" }
  const quote = await deps.swapper.quote(amountIn).catch(() => undefined)
  const minOut = quote ? (quote.amountOut * 98n) / 100n : 0n
  const tx = await deps.swapper.swap(amountIn, minOut)
  log(`keeper: продано ${amountIn} → ${quote?.amountOut ?? 0n} (tx ${tx.slice(0, 10)}…)`)
  const next: KeeperState = {
    ...state,
    spentToday: state.spentToday + amountIn,
    history: [...state.history, { at: Date.now(), amountIn, amountOut: quote?.amountOut ?? 0n, tx }].slice(-200),
  }
  saveState(next, KEEPER_STATE)
  return { action: "sell", tx, detail: `${amountIn} → ${quote?.amountOut ?? 0n}` }
}
