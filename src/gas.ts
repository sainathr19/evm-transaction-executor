import type { Address, Hex, PublicClient } from 'viem'
import type { GasConfig } from './config/types'
import type { Fees } from './types'

/** What the node says fees are right now, before our multiplier and cap. */
export type MarketFees = { type: 'eip1559'; baseFee: bigint; tip: bigint } | { type: 'legacy'; gasPrice: bigint }

export type GasRequest = { sender: Address; to: Address; value: bigint; data: Hex }

// Wei math stays in bigint: percentages and multipliers become basis points (ADR 0007).
const BPS = 10_000n

/** estimate × (100 + bufferPercent) / 100, rounded up. */
export function applyGasBuffer(estimate: bigint, bufferPercent: number): bigint {
  return mulDivUp(estimate, BPS + bps(bufferPercent), BPS)
}

/**
 * Fees for a new transaction (ADR 0007): maxFeePerGas = min(baseFee × multiplier + tip, cap).
 * Returns 'above_cap' when base fee + tip already exceeds the cap, since the transaction
 * couldn't be mined right now.
 */
export function priceFees(market: MarketFees, gas: GasConfig): Fees | 'above_cap' {
  const cap = gas.maxFeePerGasWei
  if (market.type === 'legacy') {
    return market.gasPrice > cap ? 'above_cap' : { type: 'legacy', gasPrice: market.gasPrice }
  }
  const tip = max(market.tip, gas.minPriorityFeeWei)
  if (market.baseFee + tip > cap) return 'above_cap'
  const withHeadroom = mulDivUp(market.baseFee, bps(gas.baseFeeMultiplier * 100), BPS) + tip
  return { type: 'eip1559', maxFeePerGas: min(withHeadroom, cap), maxPriorityFeePerGas: tip }
}

/**
 * Fees for a replacement (ADR 0008): every fee field raised by bumpPercent, rounded up so the raise
 * is never below it, or set to the current market fee where that is higher. `market` is the
 * output of priceFees, or null when it was above the cap. Returns 'above_cap' when the bump would
 * exceed the cap.
 */
export function bumpFees(previous: Fees, market: Fees | null, gas: GasConfig): Fees | 'above_cap' {
  const factor = BPS + bps(gas.bumpPercent)
  const raise = (fee: bigint, marketFee: bigint | undefined) => max(mulDivUp(fee, factor, BPS), marketFee ?? 0n)

  const bumped: Fees =
    previous.type === 'legacy'
      ? {
          type: 'legacy',
          gasPrice: raise(previous.gasPrice, market?.type === 'legacy' ? market.gasPrice : undefined),
        }
      : {
          type: 'eip1559',
          maxFeePerGas: raise(previous.maxFeePerGas, market?.type === 'eip1559' ? market.maxFeePerGas : undefined),
          maxPriorityFeePerGas: raise(
            previous.maxPriorityFeePerGas,
            market?.type === 'eip1559' ? market.maxPriorityFeePerGas : undefined,
          ),
        }

  const ceiling = bumped.type === 'legacy' ? bumped.gasPrice : bumped.maxFeePerGas
  return ceiling > gas.maxFeePerGasWei ? 'above_cap' : bumped
}

export async function readMarketFees(client: PublicClient, type: GasConfig['type']): Promise<MarketFees> {
  if (type === 'legacy') return { type: 'legacy', gasPrice: await client.getGasPrice() }

  const [block, tip] = await Promise.all([
    client.getBlock({ blockTag: 'latest' }),
    client.estimateMaxPriorityFeePerGas(),
  ])
  if (block.baseFeePerGas === null) {
    throw new Error(`chain ${client.chain?.id} has no base fee: set gas.type to 'legacy' in its config file`)
  }
  return { type: 'eip1559', baseFee: block.baseFeePerGas, tip }
}

export async function estimateGasLimit(client: PublicClient, tx: GasRequest, bufferPercent: number): Promise<bigint> {
  const estimate = await client.estimateGas({ account: tx.sender, to: tx.to, value: tx.value, data: tx.data })
  return applyGasBuffer(estimate, bufferPercent)
}

/** A percentage in basis points: 12.5 → 1250. */
function bps(percent: number): bigint {
  return BigInt(Math.round(percent * 100))
}

function mulDivUp(value: bigint, numerator: bigint, denominator: bigint): bigint {
  return (value * numerator + denominator - 1n) / denominator
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b
}

function min(a: bigint, b: bigint): bigint {
  return a < b ? a : b
}
