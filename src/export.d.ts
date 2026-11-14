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
 * - A transfer out to another chain sends what reached the other side, and
 *   its bridge fee is a fee, in `Fee Amount` with the network's, so a tax
 *   tool matches it with what came in there.
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
import type { BridgeNetwork, FactCache, FetchLike, MigrationApproval, MigrationEvm } from "./bridge.js";
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
   * their payout's; with `approvals` or `bridge`, its whole history, as an
   * approval or a revoke in the period can go with a migration before it,
   * and the addresses it bridged to are the person's.
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
   * connected, in any case, beside those the profile's rows say it bridged
   * DUSK to (`bridgedTo` of `/bridge`), which are the person's too: given, a
   * migration's gas is in the file only where one of them sent it, as anyone
   * can migrate to an account, as a customer to a shop's. Without it, and
   * without `bridge`, every migration's is.
   */
  evmAddresses?: Iterable<string>;
  /**
   * The approvals and revokes the person sent on a migration's own chain
   * (`migrationApprovals` of `/bridge`): each that no migration's lines here
   * have (one never used, a revoke, or one whose migration's lines don't say
   * it) is a line of its own, a cost of its gas there, at its own time, in
   * the file of the profile whose rows have the payout of the migration it
   * went with (its `migration`), so each is in one profile's file, once.
   * One of an owner who sent no migration is in the file of the person's
   * profile that bridged DUSK to that owner first, as the archive's memo
   * index lists the transfers out naming it (with `bridge.archive`); where
   * none of their profiles did, as an address only connected, in their first
   * profile's file, by its public account, of `profile` and `profiles`; and
   * without the archive, in that first profile's file too. Where the profile
   * it goes to may not read that owner, as the first profile for an address
   * only another profile's rows know (a deposit to DuskEVM, which the index
   * doesn't list, or a transfer out without the archive) or the app gives
   * only that other, the profile that knows of it says so in
   * `evm.approvalsUnread` ("error"): whose file it is can't be told. One the
   * index says another profile bridged to first is that profile's, which
   * reads it, and needs no word. The same profile, whichever of theirs is
   * exported: give `profiles` all of their others. With none given, this file is their only one, and has every
   * approval and revoke, the profile with a public account or not. With
   * `evmAddresses`, only one sent from one of them.
   */
  approvals?: Iterable<MigrationApproval>;
  /**
   * Where each migration's side on its own chain is read, as both wallets
   * make the file: given, the file reads it itself (`migrationFacts` of
   * `/bridge`, for the payouts from the period's start on) and the
   * approvals and revokes the person's EVM addresses sent
   * (`migrationApprovals`), where `evm` and `approvals` aren't given; the
   * person's EVM addresses are those the rows say they bridged to, and
   * `evmAddresses` beside them. `network` is the bridge's network, as
   * `/bridge` takes it; `cache` keeps what's final of both reads (a `Map`
   * of text does); `approvalOf` gives the approval a migration spent where
   * the app sent it, by the migration's hash, for when the chain's logs no
   * longer say; `archive`, the Dusk archive, is where the memo index says
   * which profile bridged to an owner that never migrated
   * (`bridgeSenders` of `/bridge`), one request for all of them. Nothing is
   * read where the person has no EVM address.
   */
  bridge?: {
    network: BridgeNetwork;
    fetch?: FetchLike;
    rpcUrl?: string;
    cache?: FactCache;
    approvalOf?: (migration: string) => string | null | undefined;
    archive?: Pick<Archive, "query">;
  };
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
  /**
   * The EVM addresses whose gas lines are in the file, in lower case
   * (`booked`), for the app to say whose network fees it has; the
   * migrations from the period's start on whose side on their own chain
   * couldn't be read (`unread`), by their hash and their chain's name, whose
   * fees there aren't in it: an export a little later adds them; and the
   * owners whose approvals and revokes there couldn't all be read
   * (`approvalsUnread`), by their chain's name: "error", none of them, as
   * where the RPC failed, for an export a little later, or whose file it
   * is, as where the archive failed or wasn't given, or the profile they go
   * to may not read them (`approvals`); "beyond" and "unread", none before block
   * `from`, as the reads stop there or the RPC keeps nothing older, so older
   * ones aren't in the file. With `bridge` only: `evm` and `approvals` an app
   * gives say nothing of it.
   */
  evm: {
    booked: string[];
    unread: { hash: string; chain: string }[];
    approvalsUnread: { owner: string; chain: string; state: "error" | "beyond" | "unread"; from: number | null }[];
  };
};

/** The profile's activity in the period, as a file. */
export declare function accountingCsv(options: ExportOptions): Promise<ExportResult>;

/**
 * Rewards that reached the account, in whole lux, toward nothing: what's
 * under a lux is no reward; Sozu's, their deposit fees off, to the nearest
 * lux. And what they were worth in the currency `price` answers in, each at
 * its own time, to 8 decimals: the sum of those whose price is known (null
 * without a `price`), and how many aren't (`unpriced`).
 */
export type RewardsSum = { lux: bigint; worth: string | null; unpriced: number };

/** A calendar year's staking rewards: as they reached the account, and what Sozu's stDUSK grew while held. */
export type YearRewards = {
  year: number;
  /** Native staking's rewards claimed that year, as the file's `reward` lines. */
  claimed: RewardsSum;
  /**
   * Taken out by unstaking: what the stDUSK Sozu's unstakes that year gave
   * back was worth at their own rates, beyond what it cost on average
   * (average cost, deposit fees included): what it was worth at the rates it
   * was staked at, and the deposit fees those stakes paid. The pool's
   * rounding is aside, as the pool rounds what each stake mints and each
   * unstake pays by a lux or so, and the year's sum is to the nearest lux. A
   * stake and its unstake at one rate lost their deposit fee: a year can take
   * out less than nothing. Null where a stake or an unstake before one of
   * them isn't known (`facts` lacks it, or the history isn't `complete`).
   */
  sozu: RewardsSum | null;
  /**
   * Grown while held: what the stDUSK held that year grew by, as one
   * stDUSK's worth in DUSK rose, from the year's start, or its first stake,
   * to its end, or now, beyond what it cost: on the one cost basis `sozu`
   * has, average cost with the deposit fees included, so each stake's
   * deposit fee is off its year's, at its own moment and price, and what
   * unstaking took out is part of it, a loss too. At each stake and unstake
   * at its own rate, and at each new year at the pool's after its last
   * restake by then, read from the chain (`sozuPointAt` of `/sozu`); now at
   * what the status says it's worth. Each part between two of those is worth
   * what `price` says at its end: a new year's at the year's last moment.
   * Every year's together are what the stake earned so far (`earned` of
   * `sozuPosition`, which leaves the deposit fees out, as Sozu's card shows
   * them on their own), less those fees, but for a lux or so of the pool's
   * rounding in each stake and unstake: what unstaking took out, and what's
   * still held beyond what it cost. A stake all unstaked within a year grew
   * what it took out: at one rate, the loss of its deposit fee in both. Null
   * where a new year's rate can't be read, this year's worth isn't known (no
   * `status`), or a stake or an unstake in it or before isn't known.
   */
  sozuGrown: RewardsSum | null;
  /**
   * The year's newest stakes and unstakes with Sozu, of the last
   * `FACTS_WAIT_MS`, whose facts aren't in `facts` yet, as the archive lists a
   * transaction's events a little after its block: left out until they are,
   * so `sozu` and `sozuGrown` are what they were before them, to show while
   * they're read again (`sozuFacts` of `/sozu`, a little later), rather than
   * that they couldn't be read. 0 for none.
   */
  reading: number;
};

/**
 * What each of a year's rewards is called, in the words both wallets show:
 * "Native staking, claimed" (`claimed`), "Sozu, grown while held"
 * (`sozuGrown`) and "Sozu, taken out by unstaking" (`sozu`).
 */
export declare const REWARD_WORDS: Readonly<{ claimed: "Native staking, claimed"; sozuGrown: "Sozu, grown while held"; sozu: "Sozu, taken out by unstaking" }>;

/**
 * The one line both wallets show under a year's rewards: that taken out by
 * unstaking is part of grown while held, not more on top of it, and how
 * both are counted: average cost, deposit fees included.
 */
export declare const REWARDS_COUNTED: "Taken out by unstaking is part of grown while held: both count stDUSK at its average cost, deposit fees included.";

/**
 * What a year's rewards were worth, a `RewardsSum`'s `worth`, in the words
 * both wallets show in `currency` (the one `price` answered in), in the
 * person's language (`language`, the browser's unless given): "6,43 €";
 * "under 0,01 €" for less than the currency's smallest coin and more than
 * nothing; a loss, as what unstaking took out can be once deposit fees are
 * counted, with the minus sign amounts have, "−52,38 €", or "a loss under
 * 0,01 €" for less than a coin; never 0 for what isn't. "" for no worth, as
 * without a price.
 */
export declare function rewardWorth(worth: string | null | undefined, options: { currency: string; language?: string }): string;

/** How long a stake or an unstake with Sozu is being read, without its facts, before what it did counts as not known: 10 minutes, in milliseconds. */
export declare const FACTS_WAIT_MS: 600000;

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
 * unstake with Sozu went through, or stDUSK was held, oldest first. The
 * newest stakes and unstakes whose facts aren't read yet, of the last
 * `FACTS_WAIT_MS`, are left out until they are (`reading`): what's said
 * meanwhile is what was before them, now's growth up to the first of them,
 * at the pool's rate as the status gives it, as what's held now isn't.
 * Show each year with `REWARD_WORDS` and, under them, `REWARDS_COUNTED`.
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
