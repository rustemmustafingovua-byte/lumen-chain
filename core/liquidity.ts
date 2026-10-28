/**
 * Lumen — Liquidity Manager
 *
 * CLI:
 *   lumen liquidity list                  — список пулов
 *   lumen liquidity add <pool> <base> <quote>  — добавить ликвидность
 *   lumen liquidity remove <pool> <shares>     — снять ликвидность
 *   lumen liquidity position <pool> <addr>     — позиция в пуле
 *   lumen liquidity apy <pool>                 — расчет APY
 */

import { Ledger } from "./ledger.js"

export class LiquidityError extends Error {}

export interface PoolInfo {
  key: string
  baseSymbol: string
  quoteSymbol: string
  baseReserve: bigint
  quoteReserve: bigint
  totalShares: bigint
  feeBps: number
  apy: number
  tvlUsd: number
  volume24h: number
}

export class LiquidityManager {
  ledger: Ledger

  constructor(ledger: Ledger) {
    this.ledger = ledger
  }

  listPools(): PoolInfo[] {
    const pools: PoolInfo[] = []
    for (const [key, pool] of this.ledger.pools) {
      const [base, quote] = key.split("-")
      pools.push({
        key,
        baseSymbol: base,
        quoteSymbol: quote,
        baseReserve: pool.base,
        quoteReserve: pool.quote,
        totalShares: pool.totalShares,
        feeBps: pool.feeBps,
        apy: this.calculateApy(key),
        tvlUsd: this.estimateTvlUsd(key),
        volume24h: this.estimateVolume(key),
      })
    }
    return pools
  }

  addLiquidity(poolKey: string, base: bigint, quote: bigint, owner: string): bigint {
    if (base <= 0n || quote <= 0n) throw new LiquidityError("Amounts must be positive")
    return this.ledger.addLiquidity(
      poolKey.split("-")[0],
      poolKey.split("-")[1],
      base,
      quote,
      owner
    )
  }

  removeLiquidity(poolKey: string, owner: string, shares?: bigint): [bigint, bigint] {
    return this.ledger.removeLiquidity(poolKey, owner, shares)
  }

  getPosition(poolKey: string, owner: string): { shares: bigint; baseReserve: bigint; quoteReserve: bigint; valueUsd: number } {
    const shares = this.ledger.sharesOf(poolKey, owner)
    const pool = this.ledger.pools.get(poolKey)
    if (!pool || shares === 0n) {
      return { shares: 0n, baseReserve: 0n, quoteReserve: 0n, valueUsd: 0 }
    }
    return {
      shares,
      baseReserve: pool.base,
      quoteReserve: pool.quote,
      valueUsd: this.estimatePositionValue(poolKey, shares),
    }
  }

  calculateApy(poolKey: string): number {
    const pool = this.ledger.pools.get(poolKey)
    if (!pool || pool.totalShares === 0n) return 0
    // Simplified APY calculation based on fee generation
    const tvl = this.estimateTvlUsd(poolKey)
    if (tvl === 0) return 0
    const dailyFees = this.estimateVolume(poolKey) * (pool.feeBps / 10000)
    const annualFees = dailyFees * 365
    return (annualFees / tvl) * 100
  }

  estimateTvlUsd(poolKey: string): number {
    // Simplified: assume 1 LMN = $1, 1 USDC = $1, 1 ETH = $2000
    const prices: Record<string, number> = {
      LMN: 1,
      USDC: 1,
      USDT: 1,
      ETH: 2000,
      BTC: 40000,
    }
    const pool = this.ledger.pools.get(poolKey)
    if (!pool) return 0
    const [base, quote] = poolKey.split("-")
    return Number(pool.base) / 1e18 * (prices[base] || 1) + Number(pool.quote) / 1e18 * (prices[quote] || 1)
  }

  estimateVolume(poolKey: string): number {
    // Simplified: use 1% of TVL as daily volume estimate
    return this.estimateTvlUsd(poolKey) * 0.01
  }

  estimatePositionValue(poolKey: string, shares: bigint): number {
    const pool = this.ledger.pools.get(poolKey)
    if (!pool || pool.totalShares === 0n) return 0
    const shareFraction = Number(shares) / Number(pool.totalShares)
    return this.estimateTvlUsd(poolKey) * shareFraction
  }
}
