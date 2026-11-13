/* @ts-self-types="./gas.d.ts" */
/**
 * The gas price both wallets start a transaction from: the node's mempool
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
 * @param {{ median?: unknown, minimum?: unknown, ceiling?: unknown }} [network]
 * @returns {import("./gas.js").DefaultGasPrice}
 */
export function defaultGasPrice({ ceiling, median, minimum } = {}) {
  const given = luxOf(minimum);
  // Never under 1 lux, which no transaction can pay.
  const least = given !== null && given > 1n ? given : GAS_PRICE_MINIMUM;
  const top = luxOf(ceiling) ?? least * GAS_PRICE_CEILING_TIMES;
  const most = top > least ? top : least;
  const asked = luxOf(median);

  if (asked === null) return { busy: false, ceiling: most, median: null, minimum: least, price: least };

  return { busy: asked > most, ceiling: most, median: asked, minimum: least, price: asked < least ? least : asked > most ? most : asked };
}
