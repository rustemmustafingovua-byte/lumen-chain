/**
 * Lumen Keeper — типы.
 *
 * Keeper — это процесс, который сам превращает любые пришедшие активы в LMN.
 * Он не биржа и не кастоди: обычная программа с ключом, которую может запустить
 * кто угодно со своим казначейством.
 */
/** Политика расходов: сколько и куда можно потратить. */
export type SpendPolicy = {
  /** Минимум, при котором keeper начинает покупать (в единицах актива). */
  minAmount: bigint
  /** Максимум за одну покупку. */
  maxPerSwap: bigint
  /** Максимум за сутки. */
  maxPerDay: bigint
  /** Максимум одной цены: если курс хуже — не покупаем. */
  maxPriceImpactBps?: number
  /** Разрешённые получатели (адреса). Пусто — любой. */
  allowedPayees?: string[]
}

/** Абстракция обмена: keeper не знает, где именно торгует. */
export type SwapQuote = {
  /** Сколько входного актива получим на выходе. */
  amountOut: bigint
  /** Курс: amountOut / amountIn (в единицах 1e18). */
  price: bigint
  /** Оценка проскальзывания в базисных пунктах. */
  priceImpactBps: number
}

export interface Swapper {
  /** Оценить обмен без его совершения. */
  quote(amountIn: bigint): Promise<SwapQuote>
  /** Совершить обмен. Возвращает хеш транзакции. */
  swap(amountIn: bigint, minAmountOut: bigint): Promise<string>
  /** Символ входного актива. */
  readonly symbol: string
}

/** Куда keeper кладёт купленный LMN: адрес в родной сети Lumen. */
export type Creditor = {
  /** Зачислить LMN на адрес в сети Lumen. Возвращает хеш транзакции. */
  credit(address: string, amount: bigint, memo: string): Promise<string | null>
}

export type KeeperState = {
  /** Сколько уже потратили сегодня. */
  spentToday: bigint
  /** День, к которому относится spentToday. */
  day: string
  /** История покупок. */
  history: { at: number; amountIn: bigint; amountOut: bigint; tx?: string }[]
}

export const emptyState = (): KeeperState => ({
  spentToday: 0n,
  day: new Date().toISOString().slice(0, 10),
  history: [],
})

/** Сбросить дневной лимит, если наступил новый день. */
export function rollDay(state: KeeperState, now = new Date()): KeeperState {
  const day = now.toISOString().slice(0, 10)
  if (state.day === day) return state
  return { ...state, day, spentToday: 0n }
}
