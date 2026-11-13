/**
 * The gas price both wallets start a transaction from, by one rule: the
 * node's mempool median, as `/on/blocks/gas-price` gives it, never under the
 * network's minimum and never over a ceiling, so a mempool filled at a high
 * price can't raise every default fee. Where the median is over the ceiling,
 * the default is the ceiling, and Review says the network is busy and that
 * the person can raise the price. Gas a person sets, in Settings or on
 * Review, is theirs: this is only the default.
 *
 * @example
 * ```js
 * import { GAS_PRICE_BUSY, defaultGasPrice } from "@dusk/app-core/gas";
 *
 * defaultGasPrice({ median: 1n, minimum: 1n }); // { price: 1n, busy: false, median: 1n, minimum: 1n, ceiling: 5n }
 * defaultGasPrice({ median: "2" }); // { price: 2n, busy: false, … }: the median, as the node gives it
 * defaultGasPrice({ median: 900n }); // { price: 5n, busy: true, median: 900n, minimum: 1n, ceiling: 5n }: Review says GAS_PRICE_BUSY
 * defaultGasPrice({ median: null }); // { price: 1n, busy: false, median: null, … }: until the node answers
 * ```
 *
 * @module
 */

/** The lowest gas price a network takes, in lux, where its settings say none: 1. */
export declare const GAS_PRICE_MINIMUM: 1n;

/** How many times its minimum a network's default gas price goes up to, where its settings say no ceiling: 5. */
export declare const GAS_PRICE_CEILING_TIMES: 5n;

/** "The network is busy. You can raise the gas price for it to go out sooner.": what Review says while `busy`. */
export declare const GAS_PRICE_BUSY: "The network is busy. You can raise the gas price for it to go out sooner.";

/** The default gas price, and what it was worked out from, in lux. */
export type DefaultGasPrice = {
  /** The gas price a transaction starts from: the median, within the minimum and the ceiling. */
  price: bigint;
  /** Whether the median is over the ceiling: the default is the ceiling, and Review says `GAS_PRICE_BUSY` while the price is under the median. */
  busy: boolean;
  /** The node's median, as given; null until it answers, or where it can't. */
  median: bigint | null;
  minimum: bigint;
  ceiling: bigint;
};

/**
 * The default gas price, by the rule both wallets follow: the node's mempool
 * median (`median`, the `median` of what `/on/blocks/gas-price` answers, as
 * a bigint, a safe integer or digits), at least the network's minimum
 * (`minimum`, its settings' lowest gas price, `GAS_PRICE_MINIMUM` where they
 * say none, and never under 1) and at most its ceiling (`ceiling`, from its
 * settings where they have one, else `GAS_PRICE_CEILING_TIMES` its minimum,
 * and never under the minimum). Over the ceiling, the ceiling, and `busy`.
 * Without a median, as until the node answers, the minimum.
 */
export declare function defaultGasPrice(network?: { median?: bigint | number | string | null; minimum?: bigint | number | string | null; ceiling?: bigint | number | string | null }): DefaultGasPrice;
