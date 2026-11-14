/**
 * The gas price both wallets start a transaction from, by one rule, for
 * every kind of transaction: the network's minimum while what waits in the
 * node's mempool fits in the next block, as every transaction at it then
 * goes in; once more waits than a block takes, the mempool's median, never
 * under the minimum and never over a ceiling, so a mempool filled at a high
 * price can't raise every default fee. Where the median is over the ceiling,
 * the default is the ceiling, and Review says the network is busy and that
 * the person can raise the price. Gas a person sets, in Settings or on
 * Review, is theirs: this is only the default.
 *
 * @example
 * ```js
 * import { GAS_PRICE_BUSY, defaultGasPrice } from "@dusk/app-core/gas";
 *
 * // What waits, as the node's GraphQL lists it: `mempoolTxs { gasPrice gasLimit }`.
 * defaultGasPrice({ mempool: [{ gasPrice: 2, gasLimit: 6000000 }], minimum: 1n });
 * // { price: 1n, busy: false, median: 2n, minimum: 1n, ceiling: 5n }: Sozu's activation waiting alone fits in the next block
 * defaultGasPrice({ mempool: thousandAt3 }); // { price: 3n, busy: false, median: 3n, … }: a block's worth waits
 * defaultGasPrice({ mempool: thousandAt900 }); // { price: 5n, busy: true, median: 900n, … }: Review says GAS_PRICE_BUSY
 * defaultGasPrice({ median: "2" }); // { price: 2n, … }: the median alone, as `/on/blocks/gas-price` gives it, says nothing of how much waits
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

/** The most transactions a block takes, as Rusk's consensus has it: 1,000. */
export declare const BLOCK_TRANSACTIONS: 1000;

/** The gas a block takes, as Rusk's settings have it on mainnet and testnet: 3,000,000,000. */
export declare const BLOCK_GAS: 3000000000n;

/** The default gas price, and what it was worked out from, in lux. */
export type DefaultGasPrice = {
  /** The gas price a transaction starts from: the minimum while what waits fits in a block, else the median, within the minimum and the ceiling. */
  price: bigint;
  /** Whether the median the price follows is over the ceiling: the default is the ceiling, and Review says `GAS_PRICE_BUSY` while the price is under the median. */
  busy: boolean;
  /** The median of what waits in the node's mempool, or the node's own; null until it answers, where it can't, or where nothing waits. */
  median: bigint | null;
  minimum: bigint;
  ceiling: bigint;
};

/**
 * The default gas price, by the rule both wallets follow, from what waits in
 * the node's mempool (`mempool`, each transaction's `gasPrice` and
 * `gasLimit` as `mempoolTxs { gasPrice gasLimit }` of the node's GraphQL
 * lists them, numbers, digits or bigints): the network's minimum (`minimum`,
 * its settings' lowest gas price, `GAS_PRICE_MINIMUM` where they say none,
 * and never under 1) while fewer than `BLOCK_TRANSACTIONS` wait and their gas
 * limits come to less than `BLOCK_GAS`, as the next block takes them all,
 * and one at the minimum too: a price above it buys nothing, as a single
 * transaction's own price would otherwise be everyone's, as Sozu's
 * activation at 2 after each stake was. Once more waits, their median, as
 * the node works it out, at least the minimum and at most the ceiling
 * (`ceiling`, from the network's settings where they have one, else
 * `GAS_PRICE_CEILING_TIMES` its minimum, and never under the minimum). Over
 * the ceiling, the ceiling, and `busy`. Without `mempool`, the node's median
 * alone (`median`, the `median` of what `/on/blocks/gas-price` answers, as a
 * bigint, a safe integer or digits), which says nothing of how much waits:
 * within the minimum and the ceiling, as before. Without either, as until
 * the node answers, the minimum.
 */
export declare function defaultGasPrice(network?: {
  mempool?: ReadonlyArray<{ gasPrice?: bigint | number | string | null; gasLimit?: bigint | number | string | null }> | null;
  median?: bigint | number | string | null;
  minimum?: bigint | number | string | null;
  ceiling?: bigint | number | string | null;
}): DefaultGasPrice;
