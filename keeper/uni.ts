/**
 * Lumen Keeper — обмен через Uniswap V3 на Base.
 *
 * Покупка LMN идёт по пути USDC → WETH → LMN, продажа — обратным путём.
 * Никакой биржи: контракты Uniswap и есть рынок.
 *
 * Адреса взяты из официального SDK Uniswap (sdks/sdk-core/src/addresses.ts),
 * а не «по памяти»: так они не устареют молча.
 *
 *   USDC        0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
 *   WETH        0x4200000000000000000000000000000000000006
 *   SwapRouter02 0x2626664c2603336E57B271c5C0b26F421741e481
 *   QuoterV2    0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  encodeFunctionData,
  decodeAbiParameters,
  erc20Abi,
  type Address,
  type Hex,
} from "viem"
import { base } from "viem/chains"
import type { SwapQuote, Swapper } from "./types.js"

export const USDC_BASE: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
export const WETH_BASE: Address = "0x4200000000000000000000000000000000000006"
export const SWAP_ROUTER_V3_BASE: Address = "0x2626664c2603336E57B271c5C0b26F421741e481"
export const QUOTER_V2_BASE: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a"
export const UNISWAP_V3_FACTORY_BASE: Address = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD"

const EXACT_INPUT_SINGLE = "exactInputSingle"
const QUOTE_EXACT_INPUT_SINGLE = "quoteExactInputSingle"

const exactInputSingleAbi = [
  {
    name: EXACT_INPUT_SINGLE,
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const

const quoteExactInputSingleAbi = [
  {
    name: QUOTE_EXACT_INPUT_SINGLE,
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const

const factoryAbi = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const

/** Минимальный интерфейс читателя — чтобы можно было подставить мок в тестах. */
export type Reader = {
  // any здесь — чтобы можно было подставить и viem-клиент, и мок в тестах
  readContract(args: any): Promise<any>
  /** Сырой JSON-RPC (нужен для eth_call в QuoterV2). */
  request(args: any): Promise<any>
}

/** Один шаг обмена: токен → токен, fee-тир пула. */
export type Hop = { tokenIn: Address; tokenOut: Address; fee: number }

/**
 * Путь обмена: список шагов.
 *
 * Используем последовательные exactInputSingle, а не один multi-hop path:
 * в multi-hop адреса токенов в path должны чередоваться по возрастанию,
 * иначе маршрутизатор откатывает вызов. Шаги по одному — проще и надёжнее.
 */
export function hopsFor(lmn: Address, direction: "buy" | "sell", fees: number[] = [500, 3000]): Hop[] {
  return direction === "buy"
    ? [
        { tokenIn: USDC_BASE, tokenOut: WETH_BASE, fee: fees[0] },
        { tokenIn: WETH_BASE, tokenOut: lmn, fee: fees[1] },
      ]
    : [
        { tokenIn: lmn, tokenOut: WETH_BASE, fee: fees[1] },
        { tokenIn: WETH_BASE, tokenOut: USDC_BASE, fee: fees[0] },
      ]
}

export type UniV3Options = {
  /** Адрес токена LMN в сети Base. */
  lmn: Address
  /** Адрес владельца казны (получает swap). */
  treasury: Address
  /** Приватный ключ казны (для отправки транзакций). */
  privateKey?: `0x${string}`
  /** Fee-тиры пулов для шагов. */
  fees?: number[]
  rpcUrl?: string
  /** Клиент для тестов (можно подсунуть мок). */
  client?: Reader
}

/** Обмен через Uniswap V3: покупка LMN за USDC и продажа LMN за USDC. */
export class UniV3Swapper implements Swapper {
  readonly symbol: string
  private readonly opts: UniV3Options
  private readonly publicClient: Reader
  private readonly walletClient?: ReturnType<typeof createWalletClient>
  private readonly fees: number[]

  constructor(opts: UniV3Options, direction: "buy" | "sell" = "buy") {
    this.opts = opts
    this.symbol = direction === "buy" ? "USDC" : "LMN"
    const client = createPublicClient({ chain: base, transport: http(opts.rpcUrl) })
    this.publicClient = opts.client ?? (client as unknown as Reader)
    if (opts.privateKey) {
      this.walletClient = createWalletClient({
        account: opts.privateKey,
        chain: base,
        transport: http(opts.rpcUrl),
      })
    }
    this.fees = opts.fees ?? [500, 3000]
  }

  private get hops(): Hop[] {
    return hopsFor(this.opts.lmn, this.symbol === "USDC" ? "buy" : "sell", this.fees)
  }

  /** Котировка одного шага через QuoterV2 (eth_call, без транзакции). */
  private async quoteHop(hop: Hop, amountIn: bigint): Promise<bigint> {
    const data = encodeFunctionData({
      abi: quoteExactInputSingleAbi,
      functionName: QUOTE_EXACT_INPUT_SINGLE,
      args: [
        {
          tokenIn: hop.tokenIn,
          tokenOut: hop.tokenOut,
          amountIn,
          fee: hop.fee as any,
          sqrtPriceLimitX96: 0n,
        },
      ],
    })
    const raw = (await this.publicClient.request({
      method: "eth_call",
      params: [{ to: QUOTER_V2_BASE, data }, "latest"],
    })) as Hex
    const [amountOut] = decodeAbiParameters(
      [
        { type: "uint256" },
        { type: "uint160" },
        { type: "uint32" },
        { type: "uint256" },
      ],
      raw,
    )
    return amountOut
  }

  /** Оценка обмена целиком: пересчитываем по шагам. */
  async quote(amountIn: bigint): Promise<SwapQuote> {
    let amount = amountIn
    for (const hop of this.hops) {
      amount = await this.quoteHop(hop, amount)
    }
    return {
      amountOut: amount,
      price: amountIn > 0n ? (amount * 10n ** 18n) / amountIn : 0n,
      priceImpactBps: 0,
    }
  }

  /** Совершить обмен: последовательные exactInputSingle по шагам. */
  async swap(amountIn: bigint, minAmountOut: bigint): Promise<string> {
    if (!this.walletClient) throw new Error("нужен privateKey для отправки транзакции")
    const hops = this.hops
    let amount = amountIn
    let lastHash = ""
    for (let i = 0; i < hops.length; i++) {
      const hop = hops[i]
      const isLast = i === hops.length - 1
      const data = encodeFunctionData({
        abi: exactInputSingleAbi,
        functionName: EXACT_INPUT_SINGLE,
        args: [
          {
            tokenIn: hop.tokenIn,
            tokenOut: hop.tokenOut,
            fee: hop.fee as any,
            recipient: this.opts.treasury,
            amountIn: amount,
            amountOutMinimum: isLast ? minAmountOut : 0n,
            sqrtPriceLimitX96: 0n,
          },
        ],
      })
      const hash = await this.walletClient.sendTransaction({
        to: SWAP_ROUTER_V3_BASE,
        data,
        chain: base,
        account: this.opts.privateKey,
        kzg: undefined,
      } as any)
      lastHash = hash
      amount = await this.quoteHop(hop, amount)
    }
    return lastHash
  }
}

/** Адрес пула Uniswap V3 для пары токенов и fee-тира. */
export async function getPool(
  client: Reader,
  tokenA: Address,
  tokenB: Address,
  fee: number,
): Promise<Address | null> {
  try {
    const pool = (await client.readContract({
      address: UNISWAP_V3_FACTORY_BASE,
      abi: factoryAbi,
      functionName: "getPool",
      args: [tokenA, tokenB, fee as unknown as number],
    })) as Address
    return pool === "0x0000000000000000000000000000000000000000" ? null : pool
  } catch {
    return null
  }
}

/**
 * Проверка маршрута на живой сети: котировка реального пула.
 * Ничего не покупает — только читает цену через QuoterV2.
 */
export async function checkRoute(
  client: Reader,
  amountIn: bigint,
  hop: { tokenIn: Address; tokenOut: Address; fee: number } = {
    tokenIn: USDC_BASE,
    tokenOut: WETH_BASE,
    fee: 500,
  },
): Promise<{ amountOut: bigint; path: string }> {
  const data = encodeFunctionData({
    abi: quoteExactInputSingleAbi,
    functionName: QUOTE_EXACT_INPUT_SINGLE,
    args: [
      {
        tokenIn: hop.tokenIn,
        tokenOut: hop.tokenOut,
        amountIn,
        fee: hop.fee as unknown as number,
        sqrtPriceLimitX96: 0n,
      },
    ],
  })
  const raw = (await client.request({
    method: "eth_call",
    params: [{ to: QUOTER_V2_BASE, data }, "latest"],
  })) as Hex
  const [amountOut] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "uint160" }, { type: "uint32" }, { type: "uint256" }],
    raw,
  )
  return { amountOut, path: `${hop.tokenIn}/${hop.fee}/${hop.tokenOut}` }
}

/** Баланс ERC-20 на адресе. */
export async function tokenBalance(client: Reader, token: Address, holder: Address): Promise<bigint> {
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [holder],
  })) as bigint
}
