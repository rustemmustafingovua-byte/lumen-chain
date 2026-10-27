/**
 * Утилиты ожидания для тестов.
 */
import { Chain } from "../../core/chain.js"

/**
 * Ждать, пока условие не станет истинным или не истечёт таймаут.
 */
export async function waitFor(
  predicate: () => boolean,
  opts: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 5000, intervalMs = 50, label = "" } = opts
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      const msg = label ? `timeout: ${label}` : "timeout: условие не выполнено"
      throw new Error(`${msg} за ${timeoutMs}ms`)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/**
 * Ждать, пока высота цепочки не достигнет target.
 */
export function waitForHeight(
  getter: () => number,
  target: number,
  opts: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 5000, label = `height=${target}` } = opts
  return waitFor(() => getter() >= target, { timeoutMs, label })
}
