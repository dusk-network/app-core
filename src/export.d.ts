/**
 * An account's activity as the file an accountant or a crypto tax tool reads:
 * Koinly's universal CSV, the template other tools' follow and explorers and
 * converters write, and the one that holds all an accountant asks for. One file
 * is one profile's view, for a quarter or any dates, named after the profile.
 *
 * - Amounts are exact, with a point and no grouping, and dates are UTC, as
 *   `YYYY-MM-DD HH:mm:ss`, oldest first.
 * - A transfer between the person's own profiles has no tag, so it can't read
 *   as income: it says so in its description and its `Internal Transfer`
 *   column, and in each profile's file it has the same time, amount and hash,
 *   which is what Koinly merges into a transfer.
 * - Rewards claimed are tagged `reward`; a native stake and an unstake `stake`
 *   and `unstake`, the tags Koinly leaves out of its reports, with their fees
 *   on lines of their own, as `cost`, which stay in. So do the fees of what
 *   moved nothing.
 * - A stake with Sozu is a trade of DUSK for stDUSK, and an unstake the other
 *   way, once `facts` says its stDUSK (`sozuFacts` of `/sozu`), with its deposit
 *   fee and what a stDUSK was worth in its description. Until then, it's what
 *   moved under the staking tags.
 * - A token's transfer is what it moved, with its amount, currency and recipient in
 *   the same columns, from the wallet's record of it (`sent.asset` of `/activity`),
 *   with no value in fiat. An allowance is its fee, saying what it allows and to
 *   whom. What the wallet has no record of, such as a transfer sent from another
 *   device, stays what the chain says: a call, and its fee.
 * - The value at the time of payment is the app's: `price` is asked what one
 *   DUSK was worth, and without one those columns stay empty, for the tool to
 *   work out. Every value has 8 decimals, rounded half up, a cent's worth or a
 *   fraction of one.
 * - A memo, with its commas, quotes and line breaks, is in the description and
 *   its own column, with nothing in it that hides or reorders what it says,
 *   and never as a formula: one starting with `=`, `+`, `-` or `@` has a `'` in
 *   front.
 * - Koinly ignores the columns it doesn't know, so `Account Name`, `Account`,
 *   `Counterparty Name`, `Counterparty`, `Internal Transfer` and `Memo` come
 *   after its twelve.
 *
 * @example
 * ```js
 * import { accountingCsv, quarterPeriod } from "@dusk/app-core/export";
 *
 * const { csv, fileName, left } = await accountingCsv({
 *   rows, // `/activity`'s, all of them for the period
 *   profile: { name: "Estudio Sofía", account, address },
 *   profiles, // the wallet's others: [{ name, account, address }]
 *   period: quarterPeriod(2026, 4),
 *   price: ({ at, coin }) => euroPrice(coin, at), // optional, as "0.1234", a number, or null
 *   currency: "EUR",
 *   facts, // optional: `/sozu`'s `sozuFacts`
 * });
 * fileName; // "dusk-estudio-sofia-2026-q4.csv"
 * left; // { pending: 0, notRead: 1, outOfPeriod: 42 }
 * ```
 *
 * @module
 */

import type { ActivityRow } from "./activity.js";
import type { FactCache, MigrationApproval, MigrationEvm } from "./bridge.js";
import type { Archive } from "./history.js";
import type { SozuFact, SozuStatusLike } from "./sozu.js";

/** The file's columns: Koinly's universal twelve, then what it ignores. */
export declare const CSV_COLUMNS: ReadonlyArray<string>;

/** A span of time, `from` included and `to` not, in milliseconds, and how a file's name says it. */
export type ExportPeriod = { from: number; to: number; label: string };

/**
 * A quarter of a year, 1 to 4, on the clock of `timeZone` (the device's, unless
 * given), as a quarter's payments are counted there. A RangeError for anything else.
 */
export declare function quarterPeriod(year: number, quarter: number, options?: { timeZone?: string }): ExportPeriod;

/**
 * From one day to another, both whole, written "2026-10-01", on the clock of
 * `timeZone` (the device's, unless given). A RangeError for anything else.
 */
export declare function datesPeriod(from: string, to: string, options?: { timeZone?: string }): ExportPeriod;

/** A profile: the name the person gave it (the file's `Account Name`, and its name), and its public account and shielded address. */
export type ExportProfile = { name?: string | null; account?: string | null; address?: string | null };

/** What `accountingCsv` takes. */
export type ExportOptions = {
  /**
   * `/activity`'s rows of the account, all of them for the period; with
   * `evm`, every migration's payout from the period's start on too, as a
   * migration's fees go in the period of their own time, which may be before
   * their payout's.
   */
  rows: Iterable<ActivityRow>;
  /** The profile the file is of. */
  profile: ExportProfile;
  /** The person's other profiles: what moves between them is a transfer, not income. */
  profiles?: ReadonlyArray<ExportProfile>;
  /** The span the file holds; all of the rows, without one. */
  period?: ExportPeriod;
  /**
   * What one DUSK was worth at a time, in `currency`: a decimal text or a
   * number, or null where it isn't known. It's asked once for each time, and
   * a row whose price isn't known, or whose lookup rejects, has those columns
   * empty.
   */
  price?: (at: { coin: "DUSK"; at: number }) => number | string | bigint | null | undefined | Promise<number | string | bigint | null | undefined>;
  /** The fiat currency `price` answers in: "EUR" by default. */
  currency?: string;
  /** What each stake and unstake with Sozu did (`sozuFacts` of `/sozu`). */
  facts?: ReadonlyMap<string, SozuFact>;
  /**
   * Each migration's side on its own chain, by its hash (`migrationFacts` of
   * `/bridge`): a payout's migration has a line of what its own approval and
   * it paid in gas there, each at its own time and hash, of its EVM address;
   * with `evmAddresses`, only one sent from one of them.
   */
  evm?: ReadonlyMap<string, MigrationEvm>;
  /**
   * The EVM addresses the app knows as the person's own, as those it
   * connected, in any case: given, a migration's gas is in the file only where
   * one of them sent it, none for an empty list, as anyone can migrate to an
   * account, as a customer to a shop's. Without it, every migration's is.
   */
  evmAddresses?: Iterable<string>;
  /**
   * The approvals and revokes the person sent on a migration's own chain
   * (`migrationApprovals` of `/bridge`): each that no migration's lines here
   * have (one never used, a revoke, or one whose migration's lines aren't in
   * the file) is a line of its own, a cost of its gas there, at its own time;
   * with `evmAddresses`, only one sent from one of them.
   */
  approvals?: Iterable<MigrationApproval>;
  /**
   * The person's own name for a counterparty, only when they asked for their
   * contact names to be in the file: it goes before a verified `.dusk` name
   * and the name typed for it, a profile's own name aside.
   */
  contactName?: (counterparty: string) => string | null | undefined;
  /** The network's name: the file's name says it, unless it's "mainnet". */
  network?: string;
  /** Starts the file with a UTF-8 BOM, for Excel to read its accents as it opens: without one by default, as Koinly has refused a file's headers over one. */
  bom?: boolean;
};

/** The file, its name, and what was left out of it. */
export type ExportResult = {
  /** The CSV's text, as UTF-8 writes it: a line for the columns, and CRLF after each. */
  csv: string;
  fileName: string;
  /** The lines in it, under the columns. */
  count: number;
  /**
   * The rows left out: on their way (`pending`), without a time or an outcome
   * looked up yet (`notRead`), and outside the period (`outOfPeriod`).
   */
  left: { pending: number; notRead: number; outOfPeriod: number };
  /** The lines whose price `price` didn't say; 0 without a `price`. */
  unpriced: number;
};

/** The profile's activity in the period, as a file. */
export declare function accountingCsv(options: ExportOptions): Promise<ExportResult>;

/**
 * Rewards that reached the account, in whole lux, toward nothing: what's
 * under a lux is no reward. And what they were worth in the currency `price`
 * answers in, each at its own time, to 8 decimals: the sum of those whose
 * price is known (null without a `price`), and how many aren't (`unpriced`).
 */
export type RewardsSum = { lux: bigint; worth: string | null; unpriced: number };

/** A calendar year's staking rewards: as they reached the account, and what Sozu's stDUSK grew while held. */
export type YearRewards = {
  year: number;
  /** Native staking's rewards claimed that year, as the file's `reward` lines. */
  claimed: RewardsSum;
  /**
   * Taken out by unstaking: what the stDUSK Sozu's unstakes that year gave
   * back was worth at their own rates, beyond what it cost at the rates it
   * was staked at, on average: deposit fees and the pool's rounding aside, as
   * the pool rounds what each stake mints and each unstake pays by a lux or
   * so. A stake and its unstake at one rate took out nothing. Null where a
   * stake or an unstake before one of them isn't known (`facts` lacks it, or
   * the history isn't `complete`).
   */
  sozu: RewardsSum | null;
  /**
   * Grown while held: what the stDUSK held that year grew by, as one
   * stDUSK's worth in DUSK rose, from the year's start, or its first stake,
   * to its end, or now: at each stake and unstake at its own rate, and at
   * each new year at the pool's after its last restake by then, read from
   * the chain (`sozuPointAt` of `/sozu`); now at what the status says it's
   * worth. Each part between two of those is worth what `price` says at its
   * end: a new year's at the year's last moment. Every year's together are
   * what the stake earned so far (`earned` of `sozuPosition`), but for a lux
   * or so of the pool's rounding in each stake and unstake, and a stake all
   * unstaked within a year grew what it took out. Null where a new year's
   * rate can't be read, this year's worth isn't known (no `status`), or a
   * stake or an unstake in it or before isn't known.
   */
  sozuGrown: RewardsSum | null;
};

/**
 * Staking rewards by calendar year, on the clock of `timeZone` (the
 * device's, unless given), from what the file has: the rewards native
 * staking claimed and what Sozu's unstakes took out, as they reached the
 * account, and what Sozu's stDUSK grew while held, each worth what `price`
 * says at its own time. `rows` are `/activity`'s, all of them, with `facts`
 * (`sozuFacts` of `/sozu`); `complete` is `read()`'s, without which Sozu's
 * are null. What it grew needs `status`, Sozu's as read now, for what it's
 * worth now and the pool, and `archive` for the rate at each new year
 * something was held across: a few requests each, kept in `cache` for good.
 * The rows don't say the order within a block: a stake there counts before
 * an unstake, so an unstake never comes before the stake that minted what it
 * gives back. A year is there where a reward was claimed, a stake or an
 * unstake with Sozu went through, or stDUSK was held, oldest first.
 */
export declare function rewardsByYear(options: {
  rows: Iterable<ActivityRow>;
  facts?: ReadonlyMap<string, SozuFact>;
  price?: ExportOptions["price"];
  timeZone?: string;
  complete?: boolean;
  /** Sozu's status as read now (`readSozuStatus` of `@dusk-network/networks/sozu`, or the extension's): what the stDUSK held is worth now, and the pool (`contracts.pool`), else the one the rows called. */
  status?: (SozuStatusLike & { contracts?: { pool?: string | null } | null }) | null;
  /** The archive the rate at each new year is read from. */
  archive?: Pick<Archive, "query">;
  /** A `Map` of text does: each new year's rate, once read. */
  cache?: FactCache;
  /** The clock, in milliseconds: when what's held is worth what the status says. */
  now?: number;
}): Promise<YearRewards[]>;
