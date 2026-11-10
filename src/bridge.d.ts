/**
 * The other side of the bridge's routes, as facts, for the Dusk apps:
 * whether a deposit to DuskEVM arrived there, whether a migration from BNB
 * Smart Chain or Ethereum was paid out on Dusk, and whether a transfer out
 * to another chain (Dusk to BNB Smart Chain) arrived there.
 *
 * - Each credit pays one transfer. Equal transfers (the same route,
 *   recipient and payout) are paid in the order they were sent: the oldest
 *   takes the first credit after it. The app passes the transfers it still
 *   waits for, and the credits its others arrived with (`taken`): none of
 *   those pays a waiting one, though an earlier transfer read from the
 *   chain takes its own back, as one given but not looked for does.
 * - A credit counts from 2 minutes before its transfer's block: Dusk's
 *   clock and the other chain's can differ a little. A transfer's time is
 *   its Dusk block's, never the device's clock; one without it yet isn't
 *   looked for.
 * - Where the credits don't say who sent the transfer (DuskEVM's explorer),
 *   or the transfers that could have made them aren't all known, a credit
 *   is a transfer's only when it can't be another's: within 2 minutes
 *   either side of its block, once those minutes are over, and alone there
 *   but for the credits of the other transfers given, a payment that
 *   failed counting too. Otherwise the transfer is unsure.
 * - A migration is paid by a transfer to the account from its route's
 *   payout account, with the migration's transaction hash as the memo, of
 *   exactly its amount. A transfer out arrives with the DUSK token's
 *   `Transfer` from its route's payout address to the address its memo
 *   gives, of what the route's account received less the bridge's fee, as
 *   the transfer's own transaction says. A route without its payout account
 *   or address in the network's file pays out nothing that can be told
 *   apart. Facts that can't be read leave a transfer unsure, never paid.
 * - Results are facts: arrived, with the other side's transaction, its
 *   time, its amount in lux and its block; waiting; or unknown, and why.
 *   The words are the app's.
 * - The app owns all I/O and storage: it passes `fetch`, the URLs (the
 *   network's file's by default), `/history`'s archive for the Dusk side,
 *   and its own caches: the credits it gave other transfers, where the last
 *   search stopped, the chain's block times, and what can't change any
 *   more. Nothing here keeps state outside the calls, so it runs in an
 *   extension's service worker as well as in a page.
 * - A network is a network file, or its chain ID; on a chain there's no
 *   file for, one the app builds from its own settings (`NetworkSettings`),
 *   checked as a file's fields are.
 * - An app that follows deposits on DuskEVM's explorer alone imports
 *   `depositArrivalsFromExplorer` from `/bridge-explorer`, without the RPC
 *   path and `/history`.
 * - `transferLedger` says one transfer's amounts, the same in every app, and
 *   `bridgeStatus` how a route is doing before someone sends.
 *
 * @example
 * ```js
 * import { arrivalsOf, depositArrivals, depositOf } from "@dusk/app-core/bridge";
 *
 * const { arrivals } = await depositArrivals({
 *   network: chainId,
 *   deposits: entries.map((entry) => depositOf(entry, account)).filter(Boolean),
 *   taken: keptArrivals.map((arrival) => arrival.hash), // the DuskEVM transactions other deposits arrived with
 *   fetch,
 * });
 * arrivals.get(hash); // { state: "arrived", hash: "0x029e…", at: 1793080333000, amount: 500000000n, block: 3951755 }
 * arrivalsOf(arrivals); // `/activity`'s `arrivals`: the DuskEVM transaction that paid each deposit, and when
 * ```
 *
 * @module
 */

import type { Account, EvmAddress, Network, NetworkRef, Route } from "@dusk-network/networks";
import type { ActivityRow } from "./activity.js";
import type { Archive, Direction, EntryKind } from "./history.js";

export { depositArrivalsFromExplorer, type ExplorerDepositOptions } from "./bridge-explorer.js";

/**
 * A network an app builds from its own settings, for a chain there's no
 * network file for: its chain ID as the node gives it, and DuskEVM's bridge,
 * RPC (for "rpc") and explorer API (for "explorer"), as a network file has
 * them. Its fields are checked as a file's are: a TypeError for one that
 * isn't (an address that isn't 0x and 40 hex digits, a URL that isn't
 * http(s) or ends with a slash). It has no routes to other chains unless it
 * gives them as a file does: transfers out and migrations on it are
 * `no-route`.
 */
export type NetworkSettings = {
  chainId: number;
  /** DuskEVM, or null where it has none: then no deposit is followed. */
  duskEvm?: {
    rpcUrl?: string;
    blockscoutApiUrl?: string;
    predeploys: { l2StandardBridge: string };
    /**
     * DuskEVM's contracts on Dusk, by their names in a network file: with
     * the bridge's and the Portal's (`l1_standard_bridge`,
     * `optimism_portal`), a deposit's sender's history is read on "rpc".
     */
    contracts?: Record<string, { contractId: string; evmAddress?: string }>;
  } | null;
  routes?: Network["routes"];
};

/** The network a read takes: a network file, its chain ID, or one built from an app's settings. */
export type BridgeNetwork = NetworkRef | NetworkSettings;

/** The app's cache of what can't change any more, as text: a Map does. */
export type FactCache = { get(key: string): string | null | undefined; set(key: string, value: string): unknown };

/** How long before its transfer's block a credit still counts: Dusk's clock and the other chain's can differ. 2 minutes, in milliseconds. */
export declare const CLOCK_SLACK_MS: 120000;

/**
 * How long either side of its block a transfer's credit must come, where
 * the credits can't otherwise be told apart: 2 minutes, in milliseconds.
 */
export declare const CREDIT_WINDOW_MS: 120000;

/** How long a transfer is waited for by default before it is unknown: 7 days, in milliseconds. */
export declare const WAIT_MS: 604800000;

/** Pages of an address's incoming calls on DuskEVM's explorer read at most, by default. */
export declare const EXPLORER_PAGES: 5;

/**
 * Blocks a search's first log search asks for at once: each one after asks
 * for twice as many as one the RPC answered whole, up to 100,000, and fewer
 * where the RPC asks for it. The width is kept in the search's `scan`.
 */
export declare const LOG_WINDOW: 5000;

/** Log searches one call makes for a group of equal transfers, by default: one more where the search ahead takes them all while its blocks are read again. */
export declare const LOG_WINDOWS: 8;

/** Equal deposits sent within this of each other are paid in their order: 2 hours, in milliseconds. */
export declare const DEPOSIT_HORIZON_MS: 7200000;

/** Equal transfers out sent within this of each other are paid in their order, or 4 times the route's usual time: 12 hours, in milliseconds. */
export declare const SERVICE_HORIZON_MS: 43200000;

/** Pages of its account's history one call reads for a transfer's earlier equal ones; a longer history is read on in the next call, from its `scan`. */
export declare const HISTORY_PAGES: 4;

/** `Transfer(address,address,uint256)`: the DUSK token's transfer that pays a transfer out. */
export declare const TRANSFER_TOPIC: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** `ETHBridgeFinalized(address,address,uint256,bytes)`: DuskEVM's bridge paying a deposit, from the depositor's DuskEVM address. */
export declare const ETH_BRIDGE_FINALIZED_TOPIC: "0x31b2166ff604fc5672ea5df08a78081d2bc6d746cadce880747f3643d819e83d";

/**
 * How far a transfer's own history is read: what it was read for (`of`),
 * all of it from `lo` up to the transfer's block once `lo` is set, the
 * range read next (`next`: its first block, its last and the page it
 * carries on from), and the transfers found in it that could be equal to
 * it, each with what it paid, in lux (`value`).
 */
export type HistoryScan = {
  of: string;
  lo: number | null;
  next: { from: number; to: number; page: number } | null;
  found: ReadonlyArray<{ hash: string; height: number; value: string }>;
};

/**
 * Where a search stopped: the block the next one starts at, the time of the
 * transfer it began from, the logs it searched for (`search`), and the
 * credits it found before (`seen`), which the next one counts again. A
 * search for other logs, as for another sender or amount, starts afresh.
 * The block it began at (`start`), and its passes over the blocks it read
 * before (`recheck`): where the one under way is (`from`, null between
 * two), when the next one begins (`at`), how many are done, as each credit
 * seen has the passes done before it was found (`pass`), when the search
 * first reached the head (`since`), in milliseconds (and the width of the
 * windows they were read in, as an earlier version kept it: `size`). The
 * width of the next search's windows (`size`), and the narrowest the RPC
 * refused (`refused`): it stays narrower than that.
 * With the archive, how far the transfer's own history is read
 * (`history`): a history longer than one call reads is read on from there,
 * before any search. Kept by the app with the credits it was made with,
 * and passed back as it is.
 */
export type Scan = {
  from?: string;
  basis?: number;
  search?: string;
  seen?: ReadonlyArray<{ hash: string; block: string; at: number; sender: string | null; pass?: number }>;
  start?: string;
  recheck?: { from: string | null; at: number; passes: number; since: number; size?: number };
  size?: number;
  refused?: number;
  history?: HistoryScan;
};

/**
 * Why a transfer's credit is unknown:
 * - "unsure": a credit could be another transfer's;
 * - "late": its window closed without a credit, and one coming later can't be told apart;
 * - "beyond": the explorer's pages don't reach back to it;
 * - "searching": the search used its windows before it read all it needs; it carries on from `scan`;
 * - "expired": sent longer ago than it's waited for;
 * - "no-route": the network has no such route, or the route's payout account or address isn't known;
 * - "no-payout": a transfer out pays nothing out, as the chain shows it (`problem`);
 * - "error": a read failed (`error`).
 */
export type UnknownReason = "unsure" | "late" | "beyond" | "searching" | "expired" | "no-route" | "no-payout" | "error";

/**
 * Why a transfer out pays nothing out, as the chain shows it: it "failed"
 * on Dusk, went "elsewhere" than the route's account, paid it no more than
 * the bridge's fee ("under-fee"), or has a memo that isn't an address as
 * the route's bridge reads it ("no-address").
 */
export type NoPayout = "failed" | "elsewhere" | "under-fee" | "no-address";

/**
 * What became of a transfer on the other side: "arrived", with the
 * transaction there that paid it (an EVM transaction's hash, lower case, or
 * a Dusk one's for a migration's payout), its block's time in milliseconds
 * (null for a payout whose details aren't read yet), the lux it paid and its
 * block; "waiting" for it; or "unknown", and why. `scan` is where the next
 * search starts.
 */
export type Arrival =
  | { state: "arrived"; hash: string; at: number | null; amount: bigint; block: number | null }
  | { state: "waiting"; scan?: Scan }
  | { state: "unknown"; reason: UnknownReason; error?: string; problem?: NoPayout; scan?: Scan };

/**
 * A `fetch`, as these reads use it: a GET of the explorer's JSON, a POST of
 * JSON-RPC or to a node, and the answer's status and text; for a contract's
 * reply, its bytes. Global `fetch` does.
 */
export type FetchLike = (
  input: string,
  init: { method: "GET" | "POST"; headers: Record<string, string>; body?: string | ArrayBuffer; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string>; arrayBuffer?(): Promise<ArrayBuffer> }>;

/** The app's cache of a chain's block times, in milliseconds, by number, as a `Map` is. */
export type BlockTimes = {
  get(block: number): number | undefined;
  set(block: number, at: number): unknown;
};

/** A deposit to DuskEVM that went through on Dusk (`depositOf`). Amounts in lux. */
export type Deposit = {
  /** Its Dusk transaction's hash. */
  hash: string;
  amount: bigint | number | string;
  /** The DuskEVM address it pays. */
  to: string;
  /** Its Dusk block's time, in milliseconds; null until the node gave it: it isn't looked for until then. */
  at: number | null;
  /** The Dusk account that sent it: on the RPC, its credit is found by that account's DuskEVM address. */
  sender?: string | null;
  /** Its Dusk block's height: where the sender's history is read back from. */
  height?: number | null;
  /** A DuskEVM block its credit can't be before: the head the app read before sending it. */
  notBefore?: bigint | number | string | null;
  /** Where the last search for it stopped, as its result gave it. */
  scan?: Scan | null;
};

/** What `depositArrivals` takes. */
export type DepositArrivalOptions = {
  /** The Dusk network, its chain ID, or one built from the app's settings: its DuskEVM, and its URLs. */
  network: BridgeNetwork;
  /** The deposits waited for: each once, by hash. */
  deposits: Iterable<Deposit>;
  /**
   * Where the credits are read: "explorer", the recipients' incoming calls
   * on DuskEVM's explorer (its Blockscout API), the default; or "rpc",
   * DuskEVM's bridge events on its RPC, by the sender's DuskEVM address.
   */
  via?: "explorer" | "rpc";
  /** The `fetch` to send requests with; `globalThis.fetch` when not given. */
  fetch?: FetchLike;
  /** DuskEVM's explorer API; the network's by default. */
  explorerUrl?: string;
  /** DuskEVM's RPC; the network's by default. */
  rpcUrl?: string;
  /**
   * `/history`'s archive, for "rpc": each sender's equal deposits in the
   * hours before its own are read from its history, those given but not
   * looked for too, and paid first. Each deposit reads its own hours, once
   * the archive lists it there, `HISTORY_PAGES` pages a call: a deposit
   * whose history is read on in the next call waits, with its `scan`.
   * Without it, while it can't be read, on a network that doesn't name
   * DuskEVM's bridge and Portal on Dusk, or for a deposit without its sender
   * and height, its credit is a deposit's only as where they can't be told
   * apart; a deposit is an `error` only when DuskEVM's RPC can't be read
   * either.
   */
  archive?: Archive;
  /**
   * DuskEVM transactions the app's other deposits arrived with: pass those
   * deposits through these alone, not among `deposits`. No deposit looked
   * for takes them; one read from a sender's history may, as its own.
   */
  taken?: Iterable<string>;
  /** DuskEVM's block times the app keeps, for "rpc". */
  blockTimes?: BlockTimes;
  /**
   * Where the calls of the deposits a sender's history lists are kept, for
   * "rpc" with the archive: each is kept once its block is final and its
   * answer says all a match reads of it (that it failed, that it's another
   * call than a deposit, or a deposit's amount and DuskEVM address), and
   * isn't asked for again. One whose arguments come cut short is asked for
   * again.
   */
  cache?: FactCache;
  /** The clock, in milliseconds. */
  now?: number;
  /** How long a deposit is waited for; `WAIT_MS` by default. */
  waitMs?: number;
  /** `CREDIT_WINDOW_MS` by default. */
  windowMs?: number;
  /** `EXPLORER_PAGES` by default. */
  maxPages?: number;
  /** `LOG_WINDOWS` by default. */
  maxWindows?: number;
  /** How long one request may take, in milliseconds: 8,000 by default. */
  timeoutMs?: number;
};

/**
 * Where each deposit arrived on DuskEVM, by its Dusk transaction's hash
 * (lower case), in the order given, and the requests it took. Each credit
 * pays one deposit, in the order they were sent.
 *
 * On the explorer, the recipient's incoming calls are read once for all its
 * deposits, newest first, back past the oldest one waited for, at most
 * `maxPages` pages; none is asked while every deposit's window is still
 * open. On the RPC, a group of equal deposits from one sender is searched
 * from about when the first was sent, `maxWindows` windows at most (one more
 * where the search ahead takes them all while its blocks are read again).
 * A network without DuskEVM asks nothing. Throws a TypeError for a deposit
 * that isn't one, for a network that isn't one, and for one without the URL
 * the reads go to where none is given.
 */
export declare function depositArrivals(options: DepositArrivalOptions): Promise<{ arrivals: Map<string, Arrival>; requests: number }>;

/**
 * A transfer out to another chain on a service route, sent to the route's
 * account on Dusk (`serviceTransferOf`). What it paid that account, the
 * address its memo gives, and its block's height and time are read from
 * the chain.
 */
export type ServiceTransfer = {
  /** Its Dusk transaction's hash. */
  hash: string;
  /** Its route's ID, as "dusk-to-bsc". */
  route: string;
  /** The bridge's fee, in lux; the route's by default. */
  fee?: bigint | number | string | null;
  /** A block of the other chain its payout can't be before: the head the app read before sending it. */
  notBefore?: bigint | number | string | null;
  scan?: Scan | null;
};

/** What `serviceArrivals` takes. */
export type ServiceArrivalOptions = {
  network: BridgeNetwork;
  transfers: Iterable<ServiceTransfer>;
  /** `/history`'s archive: each transfer, and the route's account's history, which lists the equal ones paid before. */
  archive: Archive;
  fetch?: FetchLike;
  /** The other chain's RPC; the route's by default. */
  rpcUrl?: string;
  /** Transactions on the other chain that paid the app's other transfers, which aren't among `transfers`. */
  taken?: Iterable<string>;
  /**
   * The block times the app keeps for each chain, by its chain ID: or one
   * cache, for a network whose service routes are all on one chain (it
   * isn't used for any other).
   */
  blockTimes?: BlockTimes | ((chainId: number) => BlockTimes | undefined);
  now?: number;
  waitMs?: number;
  maxWindows?: number;
  timeoutMs?: number;
};

/**
 * Where each transfer out arrived on its chain, by its Dusk transaction's
 * hash, in the order given, and the requests it took: the DUSK token's
 * `Transfer` from the route's payout address to the address the memo gives,
 * of what the route's account received less the fee. Each transfer is read
 * from the chain, in one request: one the archive doesn't have yet is
 * waiting, and one that pays nothing out is `no-payout`. The transfers the
 * route's account received in the hours before that named the same address,
 * in any case, and pay out the same are paid first: its history lists them,
 * and their own transactions say what each received (one given but not
 * looked for pays out what its own fee leaves). One that can't be read
 * leaves the order unclear: unsure. Each transfer reads its own hours of
 * that history, once the archive lists it there, `HISTORY_PAGES` pages a
 * call: one whose history is read on in the next call waits, with its
 * `scan`. Throws a TypeError without an archive, and for a network that
 * isn't one.
 */
export declare function serviceArrivals(options: ServiceArrivalOptions): Promise<{ arrivals: Map<string, Arrival>; requests: number }>;

/** A migration into Dusk, as its chain shows it. */
export type Migration = {
  /** Its transaction's hash on its chain. */
  hash: string;
  /** Its route's ID, as "bsc-to-dusk". */
  route: string;
  /** The DUSK it migrates, in lux. */
  amount: bigint | number | string;
  /** When it was sent, in milliseconds: it's waited for `waitMs` from then. */
  at?: number | null;
};

/** A payout of a migration, as the account's history has it (`migrationPayoutOf`). */
export type MigrationPayout = {
  /** The migration's transaction hash, from the memo, lower case. */
  hash: `0x${string}`;
  /**
   * Its route's ID; null where its payer pays out more than one route's
   * migrations, as one account set for both chains does: its transfer
   * doesn't say which.
   */
  route: string | null;
  /** The Dusk account that paid it: its route's payout account. */
  payer: string;
  /** What it paid, in lux: a gas refund paid to the account with it aside. */
  amount: bigint;
  /** The payout's Dusk transaction. */
  payout: string;
  /** Its block's time, in milliseconds; null before its details are read. */
  at: number | null;
  /** Its block's height. */
  block: number;
};

/** What `migrationPayouts` takes: the account's entries, or the archive and the account. */
export type MigrationPayoutOptions = {
  network: BridgeNetwork;
  migrations: Iterable<Migration>;
  /** The account's public history, as `/history` reads or keeps it. */
  entries?: Iterable<HistoryLike>;
  /** Without `entries`: the archive's memo index is asked for each migration's payout, in one request. */
  archive?: Archive;
  /** The account the migrations pay, which the archive is read for. */
  account?: string;
  /** Payouts other migrations have. */
  taken?: Iterable<string>;
  now?: number;
  waitMs?: number;
};

/**
 * Each migration's payout on Dusk, by the migration's hash (lower case), in
 * the order given; with `entries`, the payouts there of migrations not given
 * (`unlisted`: sent from another device, or before); and the requests it
 * took. Each payout pays one migration, of the route it was given with:
 * from that route's payout account, even where that account pays out
 * another route's too. A payout of the migration of another amount leaves
 * it unsure, not waiting: the value of an entry an earlier version kept
 * holds any gas refund paid to the account (`refund` tells it apart now);
 * the memo index gives each payout's own.
 */
export declare function migrationPayouts(
  options: MigrationPayoutOptions
): Promise<{ payouts: Map<string, Arrival>; unlisted: MigrationPayout[]; requests: number }>;

/** An entry of an account's public history, as `/history` reads or keeps it: amounts as bigints or decimal strings. */
export type HistoryLike = {
  hash: string;
  blockHeight: number;
  direction: Direction;
  kind: EntryKind;
  counterparty: string | null;
  value: bigint | string;
  /** Of `value`, a gas refund paid to another account than the sender. */
  refund?: bigint | string | null;
  memo: string;
  /** True when `memo` is bytes that aren't text, given as 0x hex: no address or hash is read from it. */
  memoBinary?: boolean;
  payer: boolean;
  timestamp?: number | null;
  success?: boolean | null;
  bridge?: { kind: string; amount?: string; to?: string } | null;
  [field: string]: unknown;
};

/**
 * A deposit to DuskEVM the account sent, from its entry, once its details
 * read its call: its amount and DuskEVM address, its block's time and
 * height, and `account` as its sender. Null for any other entry, and for one
 * that failed.
 */
export declare function depositOf(entry: HistoryLike, account?: Account): (Deposit & { amount: bigint; to: EvmAddress }) | null;

/** A transfer to a service route's account, and why it pays nothing out, if it doesn't. */
export type ServiceTransferFacts = {
  hash: string;
  route: string;
  /** What left the account: the transfer, and any gas refund it paid another account, which the entry doesn't tell apart. */
  sent: bigint;
  /** What the route's account received: known only where no gas was left to refund; null otherwise. */
  amount: bigint | null;
  fee: bigint;
  /** The address its memo gives, exactly as the bridge reads it; null when it isn't one, or the memo isn't text. */
  to: string | null;
  at: number | null;
  height: number | null;
  /** "failed" on Dusk; "under-fee": no more than the fee left the account; "no-address": a memo that isn't an address; null when none is known. */
  problem: "failed" | "under-fee" | "no-address" | null;
};

/**
 * A transfer the account sent to a service route's account, as its entry
 * says it; null for any other entry. The memo is read as the route's bridge
 * reads it: 0x and 40 hex digits, any case, nothing around them, as text. A
 * memo of bytes that aren't text (`memoBinary`) gives no address.
 */
export declare function serviceTransferOf(entry: HistoryLike, network: BridgeNetwork): ServiceTransferFacts | null;

/**
 * A payout of a migration, from its entry: a transfer the account received
 * from a migration route's payout account, with a transaction hash as the
 * memo as text, of its value less any gas `refund` paid to the account with
 * it. Its route is null where that account pays out more than one route.
 * Null for any other entry, a memo of bytes that aren't text included, and
 * on a route without its payout account.
 */
export declare function migrationPayoutOf(entry: HistoryLike, network: BridgeNetwork): MigrationPayout | null;

/**
 * The deposits that arrived, as `/activity`'s `arrivals` takes them: by the
 * deposit's hash, the DuskEVM transaction that paid it and when.
 */
export declare function arrivalsOf(arrivals: ReadonlyMap<string, Arrival>): Map<string, { hash: string; at: number | null }>;

/**
 * One amount of a transfer: `amount` in units of `decimals` decimals, of
 * `coin`, as a row writes it (`text`: short, by `formatAmount`'s rule of
 * `/amounts`) and as its detail writes it (`exact`).
 */
export type LedgerLine = {
  key: "sent" | "bridgeFee" | "networkFee" | "received" | "gas";
  amount: bigint;
  decimals: number;
  /** "DUSK", "BEP20 DUSK", "ERC20 DUSK", or the gas coin, "ETH" or "BNB". */
  coin: string;
  text: string;
  exact: string;
  /** Worked out from what was sent: what will arrive, not yet what did. */
  expected: boolean;
  /** A migration's gas, read by `migrationFacts`: what it's for, the approval it spent and the migration, or the migration alone. */
  parts?: ReadonlyArray<"approval" | "migration">;
};

/**
 * One transfer in amounts, the same in every app: each is null where it isn't
 * known, and a route without such a fee has none. `lines` are those known, in
 * their order: sent, bridge fee, network fee, received, gas.
 */
export type TransferLedger = {
  route: string | null;
  kind: Route["kind"];
  /** It failed on Dusk: nothing moved, and its fee stands alone. */
  failed: boolean;
  /** What arrived is known: `received` isn't worked out. */
  arrived: boolean;
  sent: LedgerLine | null;
  /** The bridge's own fee, taken from what's sent. */
  bridgeFee: LedgerLine | null;
  /** What the transfer's transactions on Dusk paid, the proof's and the claim's together for a withdrawal. */
  networkFee: LedgerLine | null;
  received: LedgerLine | null;
  /** What it paid in the other chain's coin, for its own gas. */
  gas: LedgerLine | null;
  lines: LedgerLine[];
};

/** What `transferLedger` takes: a row of `/activity`, what the app keeps of the transfer, or both. What's given goes before what the row says. */
export type LedgerInput = {
  /** The transfer's row of `/activity`: a transfer with a route's account, or a call of DuskEVM's bridge or Portal. */
  row?: ActivityRow | null;
  /** The route: as the network's file gives it (a row's `route`), or its ID with `network`. */
  route?: Route | string | { id: string } | null;
  network?: BridgeNetwork | null;
  /** What was sent, in lux. */
  sent?: bigint | number | string | null;
  /** What the bridge took, in lux: the route's fee, unless given. */
  bridgeFee?: bigint | number | string | null;
  /** What it paid on Dusk, in lux: a withdrawal's proof and claim, as a list. */
  networkFee?: bigint | number | string | null | ReadonlyArray<bigint | number | string | null | undefined>;
  /** What arrived, in lux, where the app has it; else `arrival`, or worked out. */
  received?: bigint | number | string | null;
  /** What `/bridge` found of it on the other side. */
  arrival?: Arrival | null;
  /** The gas it paid on the other chain, in wei: `gasUsed` × `effectiveGasPrice` of its receipt. */
  gasWei?: bigint | number | string | null;
  /** A migration's side on its own chain, as `migrationFacts` read it: its gas, with the approval it spent, and what it sent. `gasWei` goes first. */
  evm?: MigrationEvm | null;
  /** It failed on Dusk: the row's status says, unless given. */
  failed?: boolean;
  /** Whose separators the amounts are written in; `amountLocale()`'s by default. */
  locale?: string;
};

/**
 * A transfer's ledger, for all three apps to show the same numbers: a row shows
 * a line's `text`, its detail `exact`. Null for a row that's no bridge transfer.
 */
export declare function transferLedger(input?: LedgerInput): TransferLedger | null;

/** An ERC-20 token's `Approval(owner, spender, value)` topic. */
export declare const APPROVAL_TOPIC: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";

/**
 * A migration's side on its own chain, BNB Smart Chain or Ethereum: what it
 * sent and paid there, and the approval it spent. Amounts in that chain's
 * smallest unit (wei), but what it sent, which is in lux.
 */
export type MigrationEvm = {
  /** The migration's transaction there, in lower case. */
  hash: string;
  route: string;
  /**
   * "mined": it went through; "failed": it's in a block but failed, its gas
   * paid; "pending": the RPC has no receipt of it yet; "not-migration": it's
   * no call of the route's contract; "error": the RPC couldn't be read (`error`).
   */
  state: "mined" | "failed" | "pending" | "not-migration" | "error";
  /** The EVM address that sent it, in lower case. */
  from: string | null;
  block: number | null;
  /** Its block's time, in milliseconds. */
  at: number | null;
  /** What it sent of the token, in lux. */
  lux: bigint | null;
  /** What it paid in gas: `gasUsed` × `effectiveGasPrice`. */
  gasWei: bigint | null;
  /** The approval it spent: its transaction, block, time and gas. */
  approval: { hash: string; block: number; at: number | null; gasWei: bigint | null } | null;
  /**
   * "found": the approval it spent, its own; "earlier": the approval it spent,
   * which an earlier migration spent from first, and whose fee is that one's;
   * "uncertain": the approval it spent, with a transfer to the contract
   * between them that a token writing no `Approval` as it's spent doesn't say
   * drew on it or not, so its fee isn't counted; "beyond": none in the blocks
   * read back, over 75,000 at most (an hour on BSC at 5,000, up to about 15
   * hours); "unread": the RPC no longer gives logs that far back, or refuses them; "none": not
   * looked for, as for a migration that failed, which spent none.
   */
  approvalState: "found" | "earlier" | "uncertain" | "beyond" | "unread" | "none";
  /** What the migration and its own approval paid in gas together, to the wei: the migration's alone while the approval's receipt can't be read. */
  totalWei: bigint | null;
  /** The chain's coin, "BNB" or "ETH". */
  coin: string;
  error?: string;
};

/**
 * Each migration's side on its own chain, by its hash: its receipt, the
 * approval it spent and that approval's receipt, from its route's RPC (the
 * network's, or `rpcUrl`). The approval is the owner's latest of the route's
 * contract on its token before the migration, wherever and whenever it was
 * signed, read back from the migration's block a window of blocks at a time.
 * `approval` is one the app has the hash of: where the logs can't say (too far
 * back, or no longer given), it counts as this migration's only when the
 * owner sent it right before the migration, by their nonce, so no other
 * approval or migration came between.
 * `route` is the migration's route ID, which a network of one migration route
 * needn't give. A few requests each: what's final is kept in `cache` (a `Map`
 * of text does) and not read again.
 */
export declare function migrationFacts(options: {
  network: BridgeNetwork;
  migrations: Iterable<{ hash: string; route?: string | null; approval?: string | null }>;
  fetch?: FetchLike;
  rpcUrl?: string;
  cache?: FactCache;
  timeoutMs?: number;
}): Promise<Map<string, MigrationEvm>>;

/** The migrations `/activity`'s rows were paid for: each payout on Dusk a migration's route paid, with the migration's hash, which is its memo, its route and the payout's hash. */
export declare function migrationsOf(rows: Iterable<ActivityRow>): { hash: string; route: string; payout: string }[];

/**
 * An approval of a migration's contract on its token, or its revoke, that
 * an owner sent on the route's own chain, and what it paid there. Amounts in
 * that chain's smallest unit (wei).
 */
export type MigrationApproval = {
  /** Its transaction there, in lower case. */
  hash: string;
  route: string;
  /** The chain's name, "BSC test chain", its coin, "ETH" or "BNB", and that coin's decimals. */
  chain: string;
  coin: string;
  decimals: number;
  /** The route's contract, and the owner that sent it, in lower case. */
  contract: string;
  owner: string;
  block: number;
  /** Its block's time, in milliseconds. */
  at: number | null;
  /** What it lets the contract take of the token; 0 for a revoke. */
  allowance: bigint;
  /** What it paid in gas: `gasUsed` × `effectiveGasPrice`. */
  gasWei: bigint | null;
  /**
   * "spent": a migration drew on it before the owner's next approval, and its
   * gas is that migration's (`migrationFacts`'s approval); "unused": the
   * owner's next approval or revoke came first; "open": none of those since;
   * "uncertain": a transfer to the contract came between whose transaction
   * can't be read, so whether a migration drew on it isn't known; "revoke":
   * it took the approval away. A migration's draw is a transfer to the
   * contract the token writes an Approval beside, or, for a token that
   * writes none, one in a transaction sent to the contract or with an event
   * of its own: the owner's own transfer to the contract draws on nothing.
   */
  state: "spent" | "unused" | "open" | "uncertain" | "revoke";
};

/**
 * How far back an owner's approvals of a route were read: from block `from`
 * to the head (`to`). "read": back to the chain's start; "beyond": the
 * windows read stop at `from`; "unread": the RPC keeps no logs before
 * `from`; "error": it couldn't be read (`error`).
 */
export type ApprovalsRead = {
  route: string;
  owner: string;
  from: number | null;
  to: number | null;
  state: "read" | "beyond" | "unread" | "error";
  error?: string;
};

/**
 * The approvals and revokes the `owners` (the EVM addresses the app knows as
 * the person's own) sent for each migration route's contract on its token,
 * oldest first, with what each paid in gas there: found among the token's
 * Approval logs between them, read back from the head, 5,000 blocks first and
 * twice as many each window after, 8 windows at most, an Approval in a
 * migration's transaction aside. One another address sent for an owner, as a
 * permit, paid nothing of theirs and isn't there. A few requests each: what's
 * final is kept in `cache` (a `Map` of text does) and not read again.
 * `accountingCsv` of `/export` books each that no migration's lines have
 * (`approvals`), so an unused approval and a revoke cost what they did too.
 */
export declare function migrationApprovals(options: {
  network: BridgeNetwork;
  owners: Iterable<string>;
  fetch?: FetchLike;
  rpcUrl?: string;
  cache?: FactCache;
  timeoutMs?: number;
}): Promise<{ approvals: MigrationApproval[]; reads: ApprovalsRead[] }>;

/** How long `bridgeStatus` keeps what it read: 10 minutes, in milliseconds. */
export declare const STATUS_MAX_AGE_MS: 600000;

/**
 * How a route is doing, as far as the chains say.
 *
 * What can't be known cheaply isn't here: how many transfers wait to be paid
 * takes matching each transfer in to its payout, as `serviceArrivals` does for
 * one person's; and a DuskEVM withdrawal's last claim, which no read finds
 * without paging all the bridge's events.
 */
export type BridgeStatus = {
  route: string;
  /** The network's file offers the route. */
  running: boolean;
  /**
   * "stopped": the route isn't running. "late": a transfer in went past twice
   * the route's usual time (a day, where it has none) with no payout since.
   * "yes": a payout came in the last week, or four times the usual time.
   * "quiet": none did, and nothing says one is due. "on-claim": a DuskEVM
   * withdrawal pays when its owner claims it, so no one is waited for.
   * "unknown": the reads failed.
   */
  paying: "yes" | "quiet" | "late" | "stopped" | "on-claim" | "unknown";
  /** The newest payout found: the transaction that paid it, its time in milliseconds, the lux it paid, its block. */
  lastPayout: { hash: string; at: number | null; amount: bigint; block: number | null } | null;
  /** With no payout found: how far back it was looked for, in milliseconds. A later read looks further, up to 30 days. */
  readSince: number | null;
  /** The newest transfer in with no payout since, on a route that's paid from a transfer in: its time. */
  waitingSince: number | null;
  /** What it can pay, in lux, where a balance says: the payout account's on Dusk, or the bridge's for a withdrawal. */
  canPay: bigint | null;
  /**
   * What limits a payout: "balance", `canPay`; or "mints": what's paid is minted
   * as it's paid, by DuskEVM for a deposit and by BSC's payout address, which
   * holds none between payouts, so no balance says how much it can pay.
   */
  limit: "balance" | "mints";
  /** What the address that pays holds of its chain's coin for gas, where it pays with its own. */
  gas: { wei: bigint; coin: string } | null;
  /** When it was read, in milliseconds. */
  readAt: number;
  /** The requests this call made: 0 when it's what was kept. */
  requests: number;
  /** Why a part couldn't be read; "" when all were. */
  error: string;
};

/** What `bridgeStatus` takes. */
export type BridgeStatusOptions = {
  network: BridgeNetwork;
  /** The route's ID, as "dusk-to-bsc". */
  route: string;
  /** Where the read is kept: a `Map` of text does, or the app's own store. Without one, each call reads. */
  cache?: FactCache;
  /** `STATUS_MAX_AGE_MS` by default. */
  maxAgeMs?: number;
  fetch?: FetchLike;
  /** `/history`'s archive of Dusk: made from `nodeUrl` and `fetch` when not given. */
  archive?: Archive;
  /** The Dusk node; the network's by default. */
  nodeUrl?: string;
  /** The other chain's RPC; the route's by default. */
  rpcUrl?: string;
  now?: number;
  timeoutMs?: number;
};

/**
 * How a route is doing before someone sends. One read when the page opens: what
 * it read is kept in `cache` for `maxAgeMs`, reads the same time make one, and a
 * later read asks only for the blocks since. It's a few small requests: on Dusk
 * the head and the account's newest, and on the other chain at most 8 log searches
 * and the head. A part that can't be read leaves the rest, with `error`, and isn't
 * kept. A route that isn't running asks nothing. Throws a TypeError for a route the
 * network doesn't have.
 */
export declare function bridgeStatus(options: BridgeStatusOptions): Promise<BridgeStatus>;
