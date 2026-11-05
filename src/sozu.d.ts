/**
 * A person's stake with Sozu, for the Dusk apps: from their activity and the
 * status the apps read of Sozu (`readSozuStatus` of
 * `@dusk-network/networks/sozu`), what they put in, what they took out, what
 * it's worth now and what it earned, what an amount earns in a year at the
 * present rate after Sozu's share and the deposit fee, and a line that says what
 * the rate is made of. Nothing here keeps state.
 *
 * @example
 * ```js
 * import { sozuFacts, sozuPosition, sozuRateLine, sozuYear } from "@dusk/app-core/sozu";
 *
 * const facts = await sozuFacts({ archive, account, rows, cache }); // optional: each stake's own deposit fee and stDUSK
 * sozuPosition({ rows, status, facts, complete });
 * // { putIn: 1050000000000n, takenOut: 0n, worthNow: 1784753386279n, depositFees: 2625000000n, earned: 737378386279n, … }
 *
 * sozuYear({ amount: 1_000_000_000_000n, nativeRate, status });
 * // { rate: 0.204, depositFee: 2500000000n, worth: 997500000000n, rewards: 203490000000n, earned: 200990000000n }
 *
 * sozuRateLine({ nativeRate, status, provisioners, tipHeight });
 * // "15.5 DUSK a block to stakers, 206.9M DUSK staked now: about 24% a year. Less Sozu's 15%: about 20%, and a little over as it restakes rewards every hour."
 * ```
 *
 * @module
 */

import type { ActivityRow } from "./activity.js";
import type { FactCache } from "./bridge.js";
import type { Archive } from "./history.js";

/**
 * What the apps read of Sozu: `readSozuStatus`'s answer, or the same figures
 * with the extension's names (`pool.totalStakeLux`, `pool.tokenTotalSupply`,
 * `position.poolBalanceLux`, `position.stDuskBalanceLux`), amounts as bigints
 * or text. Each may be missing or null, where it wasn't read.
 */
export type SozuStatusLike = {
  pool?: { stake?: bigint | string; supply?: bigint | string; totalStakeLux?: bigint | string; tokenTotalSupply?: bigint | string } | null;
  position?: { balance?: bigint | string | null; stDusk?: bigint | string | null; poolBalanceLux?: bigint | string | null; stDuskBalanceLux?: bigint | string | null } | null;
  fees?: {
    deposit?: { numerator: bigint | number | string; denominator: bigint | number | string } | null;
    reward?: { numerator: bigint | number | string; denominator: bigint | number | string } | null;
  } | null;
};

/** What one stake or unstake did, as the pool's event says it. Amounts are lux. */
export type SozuFact = {
  kind: "stake" | "unstake";
  /** What went in or came out, in DUSK's lux. */
  amount: bigint;
  /** The deposit fee a stake paid; 0 for an unstake. */
  fee: bigint;
  /** The stDUSK it got, or burned. */
  stDusk: bigint;
  /** The pool's rate as its event gives it: DUSK staked over stDUSK there is. */
  pool: { stake: bigint; supply: bigint };
};

/**
 * What each stake and unstake that went through did, by its row's hash, from
 * the pool's event in its transaction: a request for each 25, of the account's
 * own history at their heights. No data driver is needed. With `cache`, a `Map`
 * of text does, each is read once. A transaction the archive doesn't list yet
 * isn't in the map: read it again later.
 */
export declare function sozuFacts(options: {
  archive: Pick<Archive, "query">;
  account: string;
  rows: Iterable<ActivityRow>;
  cache?: FactCache;
}): Promise<Map<string, SozuFact>>;

/** A stake with Sozu, in lux. */
export type SozuPosition = {
  /** DUSK put in, by the stakes that went through, deposit fees included. */
  putIn: bigint;
  /** DUSK taken out, by the unstakes that went through. */
  takenOut: bigint;
  /** What it's worth now, as the pool counts it; null where it wasn't read. */
  worthNow: bigint | null;
  /** The stDUSK held now; null where it wasn't read. */
  stDusk: bigint | null;
  /** Deposit fees paid; null where neither `facts` nor the status says. */
  depositFees: bigint | null;
  /** Whether `depositFees` is what was paid, read from each stake's own event, not what the rate now comes to. */
  feesExact: boolean;
  /**
   * What the stake earned so far, its deposit fees aside: worth now, plus
   * taken out, less put in, plus deposit fees, so the four add up to the lux.
   * Null until the history is whole, or while worth now or the fees aren't known.
   */
  earned: bigint | null;
  /** Stakes and unstakes on their way, which aren't counted yet. */
  waiting: number;
};

/**
 * The position from the account's rows, all of them, as `/activity` gives
 * them, and the status read. `complete`: whether the rows hold all of the
 * account's history (`read()`'s `complete` in `/history`), or `earned` can't be
 * known. It counts what went through Sozu's pool: stDUSK moved from or to another
 * account shows in worth now alone.
 */
export declare function sozuPosition(input?: {
  rows?: Iterable<ActivityRow> | null;
  status?: SozuStatusLike | null;
  facts?: ReadonlyMap<string, SozuFact> | null;
  complete?: boolean;
}): SozuPosition;

/**
 * About what Sozu pays a year, as a fraction: native staking's rate as the
 * wallets show it, to the percent, less Sozu's share of rewards, as both
 * wallets work it out. Null without either.
 */
export declare function sozuRate(nativeRate: number | null | undefined, status: SozuStatusLike | null | undefined): number | null;

/** What an amount does in a year at the present rate, in lux; each is null where its figures weren't read. */
export type SozuYear = {
  /** `sozuRate`. */
  rate: number | null;
  /** The deposit fee, rounded up as the pool rounds it. */
  depositFee: bigint | null;
  /** What's staked once the fee is off. */
  worth: bigint | null;
  /** What that earns in a year at `rate`, after Sozu's share. */
  rewards: bigint | null;
  /** The rewards, less the deposit fee. */
  earned: bigint | null;
};

/** What `amount` (lux) earns in a year at the present rate, after Sozu's share and the deposit fee. `nativeRate`: `nativeRateEstimate`'s. */
export declare function sozuYear(input: { amount: bigint | number | string; nativeRate?: number | null; status?: SozuStatusLike | null }): SozuYear;

/**
 * One line of what the rate is made of, whether it compounds, and over what:
 * it's now's, from one read of the provisioners. With `provisioners` and
 * `tipHeight`, the node's own figures, what a block pays stakers and what's
 * staked; with `nativeRate` alone, the rate across the network. Without Sozu's
 * fee it stops before Sozu's share; null without a rate.
 */
export declare function sozuRateLine(input: {
  nativeRate?: number | null;
  status?: SozuStatusLike | null;
  provisioners?: ReadonlyArray<{ amount?: unknown; eligibility?: unknown }> | null;
  tipHeight?: number | bigint | null;
  locale?: string;
}): string | null;
