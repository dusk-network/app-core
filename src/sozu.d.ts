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
 *
 * // What stDUSK did, from the chain: then it's the rate, and the line says it.
 * const growth = await sozuGrowth({ archive, pool: status.contracts.pool, status, cache });
 * sozuRate(nativeRate, status, growth); // 0.204
 * sozuRateLine({ growth }); // "stDUSK went from 1.2740 to 1.2953 DUSK over the last 30 days, after Sozu's share."
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

/** What one stake or unstake did, as the pool's event says it, and an unstake's stDUSK as the token says it burned. Amounts are lux. */
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
 * What one stDUSK was worth when a stake or an unstake went through, in lux
 * of DUSK, rounded down: the DUSK staked over the stDUSK there was, as the
 * pool's event gave them (`pool` of a `SozuFact`). The rate a stake's or an
 * unstake's details and the export say: "1 stDUSK = 1.840349526 DUSK". Null
 * for a pool of no stDUSK.
 */
export declare function stDuskWorth(pool: { stake: bigint; supply: bigint } | null | undefined): bigint | null;

/**
 * What each stake and unstake that went through did, by its row's hash, from
 * the pool's event in its transaction, and the stDUSK an unstake burned from
 * the token's own transfer in it: a request for each 25, of the account's
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

/** How long `sozuGrowth` keeps what it read in `cache`: an hour, in milliseconds, as Sozu restakes every hour. */
export declare const GROWTH_MAX_AGE_MS: 3600000;

/** What one stDUSK was worth once a restake of the pool's went through: the pool's stake over its stDUSK, both in lux, at its block. */
export type SozuPoint = { height: number; at: number; stake: bigint; supply: bigint };

/**
 * How Sozu's stDUSK grew over a period, from the pool's own records on chain:
 * after a restake about `days` before the latest, and after the latest. Its
 * growth is what a holder earned, Sozu's share already off.
 */
export type SozuGrowth = {
  from: SozuPoint;
  to: SozuPoint;
  /** The days between the two, rounded. */
  days: number;
  /** What that growth comes to in a year of 365.25 days, simply, as a fraction: `sozuRate`'s, given this. */
  rate: number;
};

/**
 * How Sozu's stDUSK grew over the last `days` (30 unless asked), read from
 * the chain: the pool's restakes, its hourly `recycle`, found among the
 * transactions calling it near the tip and near the period's start, and what
 * one stDUSK was worth after each, as the pool's reward event says. Two
 * requests of the archive, or three without the app's `tipHeight`: about
 * 120 kB on mainnet. `pool` is the pool's contract ID, or `status`'s
 * `contracts.pool`; with `status`'s pool figures, the latest restake's must
 * be its rate now, within half a percent. With `cache`, a `Map` of text does,
 * what it read is kept for `maxAgeMs`, an hour unless asked, and two reads at
 * once make one. Null where no restake is found at either end (a pool younger
 * than the period), the figures don't agree, or the archive can't be read:
 * then the rate is worked out as before.
 */
export declare function sozuGrowth(options: {
  archive: Pick<Archive, "query">;
  pool?: string | null;
  status?: (SozuStatusLike & { contracts?: { pool?: string | null } | null }) | null;
  days?: number;
  tipHeight?: number | bigint | null;
  cache?: FactCache;
  maxAgeMs?: number;
  now?: number;
}): Promise<SozuGrowth | null>;

/**
 * What native staking paid over a period, from the chain: what a block paid
 * stakers, every reward of the stake contract's event in it but Dusk's own
 * tenth, on average over blocks read across the period, and what that comes
 * to in a year at the period's pace, shared with what's staked now.
 */
export type NativeRewards = {
  /** The period's first block and the tip read, with their times in milliseconds. */
  from: { height: number; at: number };
  to: { height: number; at: number };
  /** The days between the two, rounded: the period the figure is of. */
  days: number;
  /** What a block paid stakers, in lux, on average over the blocks read. */
  perBlock: bigint;
  /** The blocks read across the period: one in the middle of each sixth of it. */
  blocks: number;
  /** The stake consensus counts now, in lux, as `nativeRateEstimate` counts it: at the app's `tipHeight`, or else at the tip read. */
  staked: bigint;
  /** What a year of such blocks pays, at the period's pace, over `staked`, simply, as a fraction: 0.87 is 87%. */
  rate: number;
};

/**
 * What native staking paid over the last `days` (30 unless asked), measured
 * from the chain: the stake contract's reward event in six blocks across the
 * period, Dusk's own tenth left out, and the period's two ends for its pace;
 * shared with what's staked now, from the node's provisioners. Two requests
 * of the archive, or one with the app's `tipHeight`: about 110 kB on
 * mainnet. With `cache`, a `Map` of text does, what it read is kept for
 * `maxAgeMs`, an hour unless asked, under `network`'s name for an app that
 * keeps one cache for more than one network, and two reads at once make one.
 * Null where it can't be read, or nothing is staked: then the rate is
 * estimated as before (`nativeRateEstimate` of `@dusk-network/networks/rates`).
 * Its `rate` goes where that one did, as `nativeRate`; `days` says over what.
 */
export declare function nativeRewards(options: {
  archive: Pick<Archive, "query">;
  provisioners: ReadonlyArray<{ amount?: unknown; eligibility?: unknown }>;
  tipHeight?: number | bigint | null;
  days?: number;
  network?: unknown;
  cache?: FactCache;
  maxAgeMs?: number;
  now?: number;
}): Promise<NativeRewards | null>;

/**
 * About what Sozu pays a year, as a fraction: with `growth`, how its stDUSK
 * grew, as a year; else native staking's rate as the wallets show it, to the
 * percent, less Sozu's share of rewards, as both wallets work it out. Null
 * without either.
 */
export declare function sozuRate(nativeRate: number | null | undefined, status: SozuStatusLike | null | undefined, growth?: SozuGrowth | null): number | null;

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

/** What `amount` (lux) earns in a year at the present rate, after Sozu's share and the deposit fee. `nativeRate`: `nativeRateEstimate`'s; `growth`: `sozuGrowth`'s, which goes first. */
export declare function sozuYear(input: { amount: bigint | number | string; nativeRate?: number | null; status?: SozuStatusLike | null; growth?: SozuGrowth | null }): SozuYear;

/**
 * One line of what the rate is made of. With `growth`, what stDUSK was worth
 * at each end and over how many days, after Sozu's share: "stDUSK went from
 * 1.2740 to 1.2953 DUSK over the last 30 days, after Sozu's share.", to four
 * decimals, or six where four would read the same. Else whether it compounds,
 * and over what. With `native` (`nativeRewards`), what a block paid stakers
 * over its period and what's staked now: "15.3 DUSK a block to stakers over
 * the last 30 days, 207.3M DUSK staked now: about 23% a year." With
 * `provisioners` and `tipHeight`, the node's own figures, what a block pays
 * stakers as estimated and what's staked; with `nativeRate` alone, the rate
 * across the network. Without Sozu's fee it stops before Sozu's share; null
 * without a rate.
 */
export declare function sozuRateLine(input: {
  growth?: SozuGrowth | null;
  native?: NativeRewards | null;
  nativeRate?: number | null;
  status?: SozuStatusLike | null;
  provisioners?: ReadonlyArray<{ amount?: unknown; eligibility?: unknown }> | null;
  tipHeight?: number | bigint | null;
  locale?: string;
}): string | null;
