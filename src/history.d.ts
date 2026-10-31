/**
 * A public account's history from the Dusk archive, synced by block height,
 * for the Dusk apps. The app owns all I/O: it passes `fetch` (or its own
 * GraphQL caller), the archive's URL, and a small store for the sync state
 * and the entries. Nothing here chooses a storage key or touches browser
 * storage, and nothing is kept at module level, so it runs in an
 * extension's service worker as well as in a page.
 *
 * - The archive lists an account's entries oldest first, a page of 50 at a
 *   time, for the heights asked. A sync covers the chain from the top down
 *   in windows, so the newest entries come first: a day under the last
 *   finalized block, then wider windows while they hold few entries,
 *   narrower ones where a page fills. A block with more than a page is
 *   paged through, across runs if need be.
 * - The heights covered are kept. A run makes a bounded number of
 *   requests and the next one carries on; a later refresh asks only for
 *   what is above the kept heights, reading the last blocks under the
 *   finalized one again, as the archive indexes a block once it is final.
 *   An entry read again is the same entry, by its hash.
 * - A node whose GraphQL has no archive is asked nothing for an hour.
 * - Another chain under the same node (a reset devnet) starts the history
 *   over.
 * - Times, outcomes and fees come from one aliased request per 50 entries,
 *   with the arguments of the calls whose facts are read from them: the
 *   DuskEVM bridge's, and those the app reads through its own hook.
 * - Entries are facts: amounts in lux, directions, kinds, the bridge route
 *   a transfer is on, a Sozu call, what a bridge call did. The words are
 *   the app's.
 *
 * @example
 * ```js
 * import { createArchive, createHistory, historyArchiveUrl } from "@dusk/app-core/history";
 *
 * const archive = createArchive({
 *   url: historyArchiveUrl({ nodeUrl, archiveUrl }), // the node, when the archive is another chain's
 *   fetch,
 *   refusals: { get: getRefusal, put: putRefusal }, // the app's storage, by URL
 * });
 * const history = createHistory({ archive, account, network: chainId, store });
 *
 * await history.sync({ onStep: () => redraw() }); // at most 8 history and 2 details requests
 * const { entries, complete } = await history.read({ limit: 50 });
 * entries[0]; // { hash, blockHeight, direction: "out", kind: "transfer", value: 1_000_000_000n, route, … }
 * ```
 *
 * @module
 */

import type { NetworkRef, Route } from "@dusk-network/networks";

/** Entries one history request gives per direction: the archive's page. */
export declare const PAGE: 50;

/** The first window of a sync, in blocks: about a day of 10-second blocks. */
export declare const FIRST_WINDOW: 8640;

/** Blocks under the last finalized one that a sync doesn't count as covered yet: the archive may not have indexed them. */
export declare const FINALITY_MARGIN: 10;

/** Transactions one details request looks up. */
export declare const DETAILS_BATCH: 50;

/** History requests one sync run makes by default. */
export declare const RUN_REQUESTS: 8;

/** Details requests one sync run makes by default. */
export declare const RUN_DETAIL_REQUESTS: 2;

/** How long a node that answered without the archive is asked nothing: an hour, in milliseconds. */
export declare const NO_ARCHIVE_RETRY_MS: 3600000;

/** The transfer contract, whose events say what moved: the same on every Dusk network. */
export declare const TRANSFER_CONTRACT: string;

/** The stake contract: the same on every Dusk network. */
export declare const STAKE_CONTRACT: string;

/** What an entry did, as `kind` names it. */
export declare const ENTRY_KIND: Readonly<{
  TRANSFER: "transfer";
  SHIELD: "shield";
  UNSHIELD: "unshield";
  CONTRACT_CALL: "contract_call";
  STAKE: "stake";
  UNSTAKE: "unstake";
  WITHDRAW_REWARD: "withdraw_reward";
}>;

/** What an entry did: a transfer, a shield or an unshield, a contract call, or a stake operation. */
export type EntryKind = "transfer" | "shield" | "unshield" | "contract_call" | "stake" | "unstake" | "withdraw_reward";

/** Which way the value went for the account: "self" for a transfer to itself. */
export type Direction = "in" | "out" | "self";

/** One archive entry as an account sees it (`parseHistoryEntry`). */
export type HistoryEntry = {
  /** The transaction's hash: 64 lower-case hex digits. */
  hash: string;
  blockHeight: number;
  direction: Direction;
  kind: EntryKind;
  /**
   * Who the value went to or came from: an account, a contract ID (lower
   * case), or a shielded address for a shield. The account itself for
   * "self"; null when no one is named.
   */
  counterparty: string | null;
  /**
   * What left or reached the account, in lux, fees aside. A gas refund the
   * transaction paid to another account than its sender is what left the
   * sender, beside its fee, and what reached that account (`refund`).
   */
  value: bigint;
  /**
   * Of `value`, the unspent gas the transaction paid to another account
   * than its sender, in lux; left out when there's none. An entry an
   * earlier version kept has none, whatever its value holds.
   */
  refund?: bigint;
  /** The memo as text, or as 0x hex when it isn't text; "" for none. */
  memo: string;
  /**
   * True when `memo` is bytes that aren't text, given as 0x hex, so a memo
   * typed as 0x text isn't taken for them; left out otherwise. An entry an
   * earlier version kept has none.
   */
  memoBinary?: boolean;
  /** Whether the account paid the fee. */
  payer: boolean;
};

/**
 * What a call to DuskEVM's bridge or Portal did, read by
 * `@dusk-network/networks/duskevm`'s `decodeBridgeCall`: a deposit's amount
 * and the DuskEVM address it pays; a withdrawal's proof or claim, its
 * amount, its hash (which the Portal keys it by), whom it pays on Dusk (an
 * account, or a contract's ID) and its nonce, the same in its proof and its
 * claim. Amounts in lux, as decimal strings.
 */
export type BridgeFacts =
  | { kind: "deposit"; amount: string; to: `0x${string}` }
  | { kind: "prove" | "claim"; amount: string; hash: `0x${string}`; recipient: string | null; withdrawal: string };

/** A transaction's time, outcome, fee and call, from its details request (`fetchTxDetails`). */
export type EntryDetails = {
  /** The block's time, in milliseconds; null when the archive gave none. */
  timestamp: number | null;
  success: boolean;
  /** The transaction's error, as text; undefined when it went through. */
  error?: string;
  /** Lux amounts and gas, as decimal strings: the fee is `gasSpent × gasPrice`. */
  gasSpent: string;
  gasPrice: string;
  gasLimit: string;
  fee: string;
  blockHash?: string;
  fnName?: string;
  contractId?: string;
  /** When the details were read, in milliseconds. */
  detailsAt: number;
  /**
   * What a call to DuskEVM's bridge or Portal did, read from its arguments:
   * null when it doesn't decode as one of the bridge's calls, or the call
   * the entry was asked about turned out to be another contract's.
   * Undefined until read, and for every other call.
   */
  bridge?: BridgeFacts | null;
};

/**
 * An entry as the app's store keeps it: amounts as decimal strings, so it
 * stores as JSON, with its details once read, and any fields the app keeps
 * beside them (as its hook's facts).
 */
export type KeptEntry = Omit<HistoryEntry, "value" | "refund"> &
  Partial<EntryDetails> & {
    value: string;
    refund?: string;
    [field: string]: unknown;
  };

/**
 * A kept entry as the app reads it (`historyEntry`): amounts as bigints,
 * and what the network's rules say of it.
 */
export type ReadEntry = HistoryEntry &
  Partial<Omit<EntryDetails, "timestamp" | "success" | "fee">> & {
    timestamp: number | null;
    /** Null until its details are read. */
    success: boolean | null;
    /** The fee, in lux, for an entry the account paid for; null for one it received, or before its details. */
    fee: bigint | null;
    /** The bridge route a transfer with one of the bridge's accounts is on (`routeForAccount`), or null. */
    route: Route | null;
    /** Whether the call is a stake or an unstake with Sozu (`isSozuCall`). */
    sozu: boolean;
    [field: string]: unknown;
  };

/** An account's sync state: the heights covered, the head, and where the next run carries on. */
export type HistoryState = {
  account: string;
  /** Disjoint `[lo, hi]` ranges of heights whose entries are all kept, highest first. */
  covered: number[][];
  /** A block with more than a page of the account's entries, and the page to read there next. */
  crowded?: { height: number; page: number } | null;
  /** The last finalized block when the head was last read. */
  finalized: number;
  /** The chain's genesis hash: another one starts the history over. */
  genesis: string;
  /** When the head was last read, in milliseconds. */
  headAt: number;
  /** The height the history covers down from: `finalized - FINALITY_MARGIN`. */
  target: number;
  updatedAt: number;
  /** The next window, in blocks. */
  window: number;
  [field: string]: unknown;
};

/**
 * A store's check before a write, called with the state kept now, in the
 * write's own transaction: when it throws, the store writes nothing, and
 * may reject.
 */
export type StoreCheck = (kept: HistoryState | null) => void;

/**
 * Where one account's history is kept on one network: the app's own
 * storage, which the app scopes and keys. Each method may return a value or
 * a promise.
 */
export type HistoryStore = {
  /** The account's sync state, or null before its first sync. */
  getState(): Promise<HistoryState | null> | HistoryState | null;
  /**
   * Keep one sync step, in one transaction: `entries`, by hash (an entry
   * kept already keeps the fields these don't carry, as its details), and
   * the state `update` makes from the one kept now, so two pages syncing
   * the same account keep each other's coverage. When `update` throws, as
   * for a step of a run another run overtook, nothing of the step is kept;
   * the store may reject with its own error, as IndexedDB aborts the
   * transaction, and the run rejects with a StaleHistoryError. Gives the
   * state kept.
   */
  commit(
    entries: KeptEntry[],
    update: (kept: HistoryState | null) => HistoryState
  ): Promise<HistoryState | void> | HistoryState | void;
  /**
   * Add details to kept entries, by hash; entries that aren't kept are left
   * alone. A store that calls `check` first, in the same transaction, keeps
   * no details on a history another run started over since.
   */
  patch(details: Map<string, EntryDetails & Record<string, unknown>>, check?: StoreCheck): Promise<void> | void;
  /** Kept entries, newest first: at most `limit`, below the height `before` when it's given. */
  list(options: { limit: number; before?: number }): Promise<KeptEntry[]> | KeptEntry[];
  /**
   * Forget what is kept of the old chain: the node is on another one now. A
   * store that calls `check` first, in the same transaction, forgets
   * nothing once another run started the history over on the new chain,
   * and keeps what that run read.
   */
  clear(check?: StoreCheck): Promise<void> | void;
};

/** When nodes last answered without the archive: the app's storage, by URL. */
export type RefusalStore = {
  /** When `url` last answered without the archive, in milliseconds, or null. */
  get(url: string): Promise<number | null> | number | null;
  /** Note that `url` answered without the archive at `at`. */
  put(url: string, at: number): Promise<void> | void;
};

/**
 * The app's own GraphQL caller: it sends `text` (`query { … }`, as the
 * node's `/on/graphql/query` takes it), gives the answer's `data`, and
 * throws with the node's message when the answer has errors.
 */
export type GraphqlCaller = (text: string) => Promise<any>;

/** A `fetch`, as the archive's requests use it: a POST of the query's text, and the answer's status and text. */
export type FetchLike = (
  input: string,
  init: { method: "POST"; headers: Record<string, string>; body: string; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What `createArchive` takes. */
export type ArchiveOptions = {
  /** The archive's base URL, a path under it kept; with `query`, only the name refusals are kept under. */
  url: string;
  /** The `fetch` to send requests with; `globalThis.fetch` when not given. */
  fetch?: FetchLike;
  /** The app's GraphQL caller, in place of `fetch`. */
  query?: GraphqlCaller;
  /** Where refusals are kept; this archive alone remembers them when not given. */
  refusals?: RefusalStore;
  /** How long a request may take, in milliseconds: 8,000 by default. */
  timeoutMs?: number;
  /** The clock, in milliseconds. */
  now?: () => number;
};

/** The archive's GraphQL. */
export type Archive = {
  readonly url: string;
  /**
   * One request: the answer's data, its integers past 2^53 as strings. A
   * node without the archive's fields throws a NoArchiveError, and its
   * refusal is kept; any other error in the answer throws its message.
   */
  query(text: string, options?: { timeoutMs?: number }): Promise<any>;
  /** Throws a NoArchiveError, without a request, while the node's refusal is under an hour old. */
  assertArchive(): Promise<void>;
};

/** A node that answered without the archive, or that is left alone for having done so. */
export declare class NoArchiveError extends Error {
  constructor(url: string, message?: string);
  /** The node's URL. */
  readonly url: string;
}

/**
 * A sync run another one overtook: it started the history over on another
 * chain, or the history was cleared, since the run began. Nothing more of
 * the run is kept; the history is the other run's.
 */
export declare class StaleHistoryError extends Error {
  constructor();
}

/**
 * The archive to read a network's history from: `archiveUrl`, or the node
 * when that's another chain's, by their chain IDs (settings that kept one
 * network's archive beside another's node). `chainIdOf` is the app's
 * knowledge of a URL's chain; by default, the network whose file lists it.
 * A chain that isn't known isn't another.
 */
export declare function historyArchiveUrl(urls: {
  nodeUrl?: string;
  archiveUrl?: string;
  chainIdOf?: (url: string) => number | null | undefined;
}): string;

/**
 * The archive's GraphQL at `url`, by `fetch` or the app's own caller. A
 * request answered 429, 502, 503 or 504 is sent again, twice at most: a
 * quarter second, then half a second later. Throws a TypeError for a URL
 * that isn't http(s) when there's no caller.
 */
export declare function createArchive(options: ArchiveOptions): Archive;

/**
 * One archive entry as `account` sees it, from the transfer and stake
 * contracts' events; reverted events don't count. Null for an entry of
 * another shape.
 */
export declare function parseHistoryEntry(account: string, raw: unknown): HistoryEntry | null;

/**
 * A kept entry as the app reads it: its amounts as bigints, its fee only
 * where the account paid it, and what the network's rules say of it: the
 * bridge route a transfer is on, and whether a call is Sozu's, on the
 * network's own pool or one in `pools`. Fields the store keeps beside the
 * entry's pass through. Without a network, there's no route and no Sozu.
 */
export declare function historyEntry(
  row: KeptEntry,
  options?: { network?: NetworkRef | null; pools?: Iterable<string> }
): ReadEntry;

/** `covered` with `[lo, hi]` added, touching and overlapping ranges joined, highest first. */
export declare function addCoverage(covered: number[][], lo: number, hi: number): number[][];

/** The highest range of `[0, target]` that `covered` misses, or null. */
export declare function topGap(covered: number[][], target: number): [number, number] | null;

/**
 * The lowest height a history shows entries down to: the bottom of the
 * range that reaches `target`, or of the highest range while the top is
 * still being filled; null before anything is covered. Below it, newer
 * entries may be missing.
 */
export declare function shownDownTo(covered: number[][], target: number): number | null;

/** What `historyRange` reads. */
export type RangeOptions = {
  account: string;
  /** The lowest height, 0 by default. */
  from?: number;
  /** The highest height; open when not given. */
  to?: number;
  /** "out" for what the account sent, "in" for what it received, "both" by default. */
  direction?: "in" | "out" | "both";
  /** The most pages to read, 1 by default. */
  pages?: number;
  /** The first page to read, 1 by default: a read of the same range carries on where an earlier one stopped. */
  page?: number;
};

/**
 * An account's entries between two heights, a page at a time, oldest
 * first, each once: `complete` once a page came back short. Throws a
 * RangeError for any other direction.
 */
export declare function historyRange(
  archive: Archive,
  options: RangeOptions
): Promise<{ entries: HistoryEntry[]; complete: boolean; requests: number }>;

/** Facts an app reads from some contracts' calls, from their arguments, and keeps with the entries. */
export type CallFacts = {
  /**
   * Whether a kept entry's call is one the app reads and what it reads of
   * it isn't kept yet. It's given the entry as the store keeps it, amounts
   * as decimal strings, also when the app passes the entries it read to
   * `needsDetails` or `fillDetails`. Before its details, an entry names its
   * contract only as `counterparty`, when it paid that contract a deposit.
   */
  wants(entry: KeptEntry): boolean;
  /**
   * What the app reads from a call, as fields to keep with the entry's
   * details. It's given every call whose arguments were asked, a bridge
   * call's too: nothing (or `{}`) for one the app doesn't read. What it
   * gives must make `wants` false, or the call is asked again next time.
   */
  read(
    call: { contractId: string; fnName: string; args: string | null },
    account: string
  ): Record<string, unknown> | null | undefined;
};

/** What `fetchTxDetails` takes beside the hashes. */
export type DetailsOptions = {
  /** The node's network, for the bridge's calls. */
  network?: NetworkRef | null;
  /** The account the history is of, which `callFacts` reads the calls for. */
  account?: string;
  /** The hashes whose call arguments are asked for, and read. */
  args?: ReadonlySet<string>;
  callFacts?: CallFacts;
  /** The clock, for `detailsAt`. */
  now?: () => number;
};

/**
 * Times, outcomes, fees and calls of up to 50 transactions, in one aliased
 * request, by hash, for those the archive has. For the hashes in `args`,
 * the call's arguments too: what a call to DuskEVM's bridge did, and the
 * fields `callFacts` reads. Other hashes, and those that aren't 64
 * lower-case hex digits, are left out.
 */
export declare function fetchTxDetails(
  archive: Archive,
  hashes: ReadonlyArray<string>,
  options?: DetailsOptions
): Promise<Map<string, EntryDetails & Record<string, unknown>>>;

/** A public transaction's nonce, as a decimal string; null for a shielded one, or one the archive doesn't have. */
export declare function fetchTxNonce(archive: Archive, hash: string): Promise<string | null>;

/** What `createHistory` takes. */
export type HistoryOptions = {
  archive: Archive;
  /** The public account, base58; a TypeError for anything that isn't a Dusk account. */
  account: string;
  store: HistoryStore;
  /** The node's network, or its chain ID: none for a node of a network there's no file for. */
  network?: NetworkRef | null;
  /** The app's hook for the calls it reads, as a name service's. */
  callFacts?: CallFacts;
  /** The clock, in milliseconds. */
  now?: () => number;
};

/** What a sync run takes. */
export type SyncOptions = {
  /**
   * History requests this run makes, the head's included: 8 by default, 2
   * at least, as a run with only the head could never read under it.
   */
  maxRequests?: number;
  /** Details requests it makes: 2 by default, the first with the first entries it finds. */
  maxDetailRequests?: number;
  /** Hears each step kept, and each details batch. */
  onStep?: (state: HistoryState) => void;
};

/** One account's history on one network. */
export type History = {
  readonly account: string;
  /**
   * One sync run: the newest heights first, then older ones, within its
   * budgets. Each step is kept as it lands, so a run that stops anywhere is
   * carried on by the next. A run whose head names another chain than the
   * history kept starts it over, on what is left of its budget. A details
   * request that fails ends the run's details, not the run: it resolves
   * with `detailsError`, and the next run asks for them again. Rejects as
   * the store does, as after a wallet reset; as a history request does;
   * with a NoArchiveError for a node without the archive; with a
   * StaleHistoryError once another run overtook it; and with a RangeError,
   * before any request, for fewer than 2 history requests.
   */
  sync(options?: SyncOptions): Promise<{ state: HistoryState; requests: number; added: number; detailsError?: Error }>;
  /** Details for kept entries that need them, as those shown before a sync gave them any: one request per 50. */
  fillDetails(entries: ReadonlyArray<KeptEntry | ReadEntry>, options?: { onStep?: () => void }): Promise<void>;
  /**
   * Whether an entry's details are still to read: it has none, a call to
   * DuskEVM's bridge wasn't read yet, a proof or a claim was read without
   * its hash or whom it pays, or `callFacts` wants it.
   */
  needsDetails(entry: KeptEntry | ReadEntry): boolean;
  /**
   * The kept history, newest first, without asking the archive: `limit`
   * entries (200 by default) below the height `before`, and the rest of the
   * last one's block when `limit` cuts through it, so reading on below that
   * block's height skips none; only the entries down to `coveredTo`, as
   * below it newer ones may be missing. `coveredTo` is the bottom of the
   * covered heights that reach the target, or of the highest ones while
   * the top is still being read; `complete` says every height from the
   * target down is covered.
   */
  read(options?: { limit?: number; before?: number; pools?: Iterable<string> }): Promise<{
    entries: ReadEntry[];
    state: HistoryState | null;
    coveredTo: number | null;
    complete: boolean;
  }>;
};

/** One account's history, synced from `archive` into the app's `store`. */
export declare function createHistory(options: HistoryOptions): History;
