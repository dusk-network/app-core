/* @ts-self-types="./gas.d.ts" */
/**
 * The gas price both wallets start a transaction from: the network's
 * minimum while what waits in the node's mempool fits in the next block, as
 * then every transaction at it goes in; once more waits, the mempool's
 * median, up to a ceiling, so a mempool filled at a high price can't raise
 * every default fee. Above it, the ceiling, and Review says the network is
 * busy.
 *
 * @module
 */

/** The lowest gas price a network takes, in lux, where its settings say none: 1. */
export const GAS_PRICE_MINIMUM = 1n;

/** How many times its minimum a network's default gas price goes up to, where its settings say no ceiling: 5. */
export const GAS_PRICE_CEILING_TIMES = 5n;

/** What Review says while the network asks more than the default gas price pays. */
export const GAS_PRICE_BUSY = "The network is busy. You can raise the gas price for it to go out sooner.";

/** The most transactions a block takes, as Rusk's consensus has it: 1,000. */
export const BLOCK_TRANSACTIONS = 1000;

/** The gas a block takes, as Rusk's settings have it on mainnet and testnet: 3,000,000,000. */
export const BLOCK_GAS = 3_000_000_000n;

/**
 * A whole number of lux as given, or null for what isn't one.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
function luxOf(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) return BigInt(value.trim());

  return null;
}

/**
 * A whole number a node's answer gives, however large, or null for what isn't one.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
function wholeOf(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;

  return luxOf(value);
}

/**
 * What waits in a node's mempool: how many transactions, the gas they may
 * use, and the median of their gas prices, as the node's own `gas-price`
 * works it out: the middle one, or the two middle ones' mean, rounded down.
 *
 * @param {Iterable<unknown>} mempool
 */
function waiting(mempool) {
  /** @type {bigint[]} */
  const prices = [];
  let count = 0;
  let gas = 0n;

  for (const tx of mempool) {
    const { gasLimit, gasPrice } = /** @type {{ gasLimit?: unknown, gasPrice?: unknown }} */ (tx ?? {});
    const price = wholeOf(gasPrice);

    count += 1;
    gas += wholeOf(gasLimit) ?? 0n;
    if (price !== null) prices.push(price);
  }

  prices.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const mid = Math.floor(prices.length / 2);
  const median = prices.length === 0 ? null : prices.length % 2 ? prices[mid] : (prices[mid - 1] + prices[mid]) / 2n;

  return { count, gas, median };
}

/**
 * @param {{ mempool?: unknown, median?: unknown, minimum?: unknown, ceiling?: unknown }} [network]
 * @returns {import("./gas.js").DefaultGasPrice}
 */
export function defaultGasPrice({ ceiling, mempool, median, minimum } = {}) {
  const given = luxOf(minimum);
  // Never under 1 lux, which no transaction can pay.
  const least = given !== null && given > 1n ? given : GAS_PRICE_MINIMUM;
  const top = luxOf(ceiling) ?? least * GAS_PRICE_CEILING_TIMES;
  const most = top > least ? top : least;

  if (Array.isArray(mempool)) {
    const queue = waiting(mempool);

    // What waits fits in the next block, which takes every transaction at the minimum too: a price above it buys
    // nothing, as with Sozu's own activation at 2 waiting alone after each stake.
    if (queue.count < BLOCK_TRANSACTIONS && queue.gas < BLOCK_GAS) return { busy: false, ceiling: most, median: queue.median, minimum: least, price: least };

    return priced(queue.median, least, most);
  }

  return priced(luxOf(median), least, most);
}

/**
 * The median, within the minimum and the ceiling; the minimum without one.
 *
 * @param {bigint | null} asked
 * @param {bigint} least
 * @param {bigint} most
 * @returns {import("./gas.js").DefaultGasPrice}
 */
function priced(asked, least, most) {
  if (asked === null) return { busy: false, ceiling: most, median: null, minimum: least, price: least };

  return { busy: asked > most, ceiling: most, median: asked, minimum: least, price: asked < least ? least : asked > most ? most : asked };
}
