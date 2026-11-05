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
 * - The value at the time of payment is the app's: `price` is asked what one
 *   DUSK was worth, and without one those columns stay empty, for the tool to
 *   work out.
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
import type { SozuFact } from "./sozu.js";

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

/** A profile: the name the person gave it, and its public account and shielded address. */
export type ExportProfile = { name?: string | null; account?: string | null; address?: string | null };

/** What `accountingCsv` takes. */
export type ExportOptions = {
  /** `/activity`'s rows of the account, all of them for the period. */
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
  /** The person's own name for a counterparty, only when they asked for their contact names to be in the file. */
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
