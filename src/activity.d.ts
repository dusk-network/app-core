/**
 * An account's activity, for the Dusk wallets: one row per transaction,
 * newest first, from its public history (`/history`), its shielded history
 * (`/shielded`) and the wallet's own records of what it sent. Rows are facts,
 * not text: what a transaction did and for whom, the lux it moved and the fee
 * it paid, where it is, and what the bridge, Sozu and the name service say
 * of it. The app keeps its words, its screens and its storage.
 *
 * - A transaction both the chain and the wallet know is the chain's once its
 *   outcome is: its outcome, amount, time and fee are the chain's, and the
 *   wallet's record adds what the chain doesn't say, as the name typed for
 *   the recipient. Until the chain's histories have it, the wallet's record
 *   shows it: pending for 15 minutes at most, then unknown.
 * - The shielded side of a shield or an unshield is the public row's, with
 *   the fee the shielded side paid.
 * - A call to DuskEVM's bridge or Portal says what it did (`bridge`), a
 *   transfer with one of the bridge's accounts which route it is on
 *   (`route`), a call of Sozu's pool whether it staked or unstaked (`sozu`),
 *   and a call of the name service what it was and the name it is for
 *   (`nameCall`), through the app's own hook.
 * - Nothing here keeps state or does any I/O, so it runs in an extension's
 *   service worker as well as in a page.
 *
 * @example
 * ```js
 * import { activityRows, settleSends } from "@dusk/app-core/activity";
 *
 * const { entries, state } = await history.read({ limit: 50 });
 * const rows = activityRows({
 *   public: entries, // `/history`'s read
 *   shielded, // `/shielded`'s entries
 *   pending: sends, // the wallet's own records of what it sent
 *   account,
 *   network: chainId,
 *   state, // sorts the rows not looked up yet by the time their height gives
 * });
 * rows[0]; // { hash, kind: "transfer", category: "sent", direction: "out", value: 1_000_000_000n, status: "executed", … }
 *
 * // The sends the chain's rows now say all of: forget them, and keep the others marked settled.
 * const { drop, keep } = settleSends({ public: entries, shielded, pending: sends });
 * ```
 *
 * @module
 */

import type { NetworkRef, Route } from "@dusk-network/networks";
import type { BridgeFacts, Direction, EntryKind, ReadEntry } from "./history.js";
import type { ShieldedEntry } from "./shielded.js";

/** How long a send the chain's histories don't have yet stays pending, unless the node has it in its queue: 15 minutes, in milliseconds. */
export declare const PENDING_MS: 900000;

/** Where a send is, as the wallet last saw it. */
export type SendStatus = "submitted" | "mempool" | "executed" | "failed" | "removed" | "unknown";

/**
 * A transaction the wallet sent, as it keeps its record. Amounts are lux,
 * as decimal strings or bigints. Every field but `hash` may be missing; the
 * wallet's own fields pass through on the row (`sent`).
 */
export type SentTransaction = {
  hash: string;
  /** What it does, one of `/history`'s kinds; any other is no kind. */
  kind?: string;
  /** Which way the value goes, as the chain will say it; by its kind and `to` when not given. */
  direction?: Direction;
  privacy?: "public" | "shielded";
  /**
   * What it transfers: to `to`, or for a call without `to`, back to the
   * account itself. A call that names neither `to` nor `deposit` pays its
   * contract this amount.
   */
  amount?: string | bigint | null;
  /** What a call pays its contract. */
  deposit?: string | bigint | null;
  to?: string | null;
  /** Who paid it, for one the account received. */
  from?: string | null;
  contractId?: string | null;
  fnName?: string | null;
  memo?: string | null;
  /** The .dusk name the recipient was typed as. */
  toName?: string | null;
  /** What a call to the bridge does, as the wallet sent it. */
  bridge?: BridgeFacts | null;
  /** "submitted" when not given. */
  status?: SendStatus | string;
  error?: string | null;
  feePaid?: string | bigint | null;
  gasLimit?: string | bigint | null;
  gasPrice?: string | bigint | null;
  gasSpent?: string | bigint | null;
  blockHeight?: number | string | null;
  blockHash?: string | null;
  /** Times in milliseconds: its block's as the wallet saw it, when it ran, when it was final, when it was sent. */
  timestamp?: number | null;
  executedAt?: number | null;
  finalizedAt?: number | null;
  submittedAt?: number | null;
  /** The profile that sent it; a record without one shows in every profile. */
  profileIndex?: number | null;
  /** Kept only for what the chain's row lacks (`settleSends`): it shows with that row alone. */
  settled?: boolean;
  [field: string]: unknown;
};

/**
 * What the app's hook reads of a call to a name service, from its contract
 * and its function, and what the app keeps of the call. A reservation and a
 * registration are what a reservation's name is found by.
 */
export type NameFacts = {
  /** What the call does, in the app's terms: "registration", "reservation", "renewal", "records", "other", … */
  kind: string;
  /** The name it is for: the name a registration registers; null when its call doesn't read as one. */
  name?: string | null;
  /**
   * A reservation's own, or the one a registration is for, as text: a
   * reservation and a registration after it with the same one are for the
   * same name.
   */
  reservation?: string | null;
};

/** What the app read of a proved withdrawal, from DuskEVM's Portal: `claimed` once it is claimed. */
export type WithdrawalRead = { claimed?: boolean; [field: string]: unknown };

/** A deposit's arrival on DuskEVM: the transaction there that paid it, and when, in milliseconds. */
export type DepositArrival = { hash: string; at: number | null };

/** What a row's call to DuskEVM's bridge or Portal did, as `bridge.step` names it. */
export type BridgeStep = "deposit" | "withdrawal" | "proof" | "claim" | "call";

/** What a call to DuskEVM's bridge or Portal did for the account. */
export type ActivityBridge = {
  /**
   * "deposit": DUSK sent to DuskEVM; "withdrawal": DUSK a withdrawal from
   * DuskEVM paid the account; a withdrawal's "proof" or "claim"; or another
   * "call" of the bridge's contracts.
   */
  step: BridgeStep;
  /** The deposit's or the withdrawal's amount, in lux, as its call says; null until its call is read. */
  amount: bigint | null;
  /** The DuskEVM address a deposit pays. */
  to: `0x${string}` | null;
  /** A proof's or a claim's withdrawal hash, lower case: what the Portal keys it by. */
  hash: `0x${string}` | null;
  /** Whom the withdrawal pays on Dusk: an account, or a contract's ID. */
  recipient: string | null;
  /** The withdrawal's nonce, the same in its proof and its claim. */
  nonce: string | null;
  /**
   * For a proof: its withdrawal is claimed, by a claim of this activity that
   * went through, is on its way or is on chain, or as `claims` says.
   */
  claimed: boolean;
  /** For a proof: what the app read of its withdrawal (`claims`). */
  claim: WithdrawalRead | null;
  /** For a deposit that went through to a DuskEVM address: where it arrived there (`arrivals`). */
  arrival: { hash: `0x${string}`; at: number | null } | null;
};

/** Where a row's facts come from. */
export type ActivitySource = "public" | "shielded" | "sent";

/** Where a transaction is. */
export type ActivityStatus = "pending" | "executed" | "failed" | "unknown";

/** Which of the wallets' filters a row is under, beside All. */
export type ActivityCategory = "sent" | "received" | "staking" | "bridge" | "other";

/** One transaction of an account's activity, as facts. Amounts are lux, as bigints. */
export type ActivityRow = {
  /** The transaction's hash, lower case. */
  hash: string;
  /**
   * "public" or "shielded": the chain's history of that side has it, and it
   * is final; "sent": only the wallet's own record has it so far.
   */
  source: ActivitySource;
  /** The wallet's own record of it, as given; null when the wallet didn't send it. */
  sent: SentTransaction | null;
  /** Its public history entry, as given. */
  entry: ReadEntry | null;
  /**
   * The side it was sent from: the wallet's record says; else the shielded
   * one for an unshield the shielded history has; else the side of the
   * chain's history that has it.
   */
  privacy: "public" | "shielded";
  /**
   * What it did: the chain's kind when it names a shield, an unshield or a
   * stake operation; else the kind the wallet sent it as, which the chain
   * may name less closely; else the chain's. A call the account made reads
   * as a contract call once its details came, and a call of the transfer
   * contract's `convert` as a shield; null for a send of a kind there's no
   * name for.
   */
  kind: EntryKind | null;
  /**
   * The filter it is under: native staking and Sozu's are "staking"; a
   * shield, an unshield and a transfer to the account itself, "other";
   * DuskEVM's bridge and the routes to other chains, "bridge"; else "sent"
   * or "received" by its direction ("other" for a send without a kind).
   */
  category: ActivityCategory;
  /** Which way the value went: the chain's, else the send's. A call that sent its value to its own account moved nothing out. */
  direction: Direction;
  /** What it moved for the account, fees aside: the chain's once it went through, until then what the wallet sent. */
  value: bigint;
  /**
   * The fee the account paid: the chain's, from the shielded side when the
   * public one has none; the send's until the chain's details come.
   */
  fee: bigint | null;
  /**
   * "pending": sent, and the chain's histories don't have it yet: for 15
   * minutes at most, unless the node has it in its queue; "executed" or
   * "failed": the chain's outcome, else the one the wallet saw it end with;
   * "unknown": the chain has it and its outcome isn't looked up yet, or the
   * wallet stopped waiting for it.
   */
  status: ActivityStatus;
  /** An unknown send the node dropped from its queue, as the wallet saw it. */
  dropped: boolean;
  /** The chain's outcome; null until its details come, and for a send the chain doesn't have. */
  success: boolean | null;
  error: string | null;
  /** Its time, outcome or fee are still to be looked up. */
  incomplete: boolean;
  /**
   * Who the value went to or came from: an account, a contract's ID, or a
   * shielded address; the account itself for "self". As the chain names it,
   * else as the send does: a call by the contract it pays a deposit, else
   * the account it pays.
   */
  counterparty: string | null;
  /** The counterparty's verified name (`names`). */
  counterpartyName: string | null;
  /** The .dusk name the send's recipient was typed as. */
  toName: string | null;
  /** The contract it called, lower case, without 0x. */
  contractId: string | null;
  fnName: string | null;
  /** The chain's memo, else the one the wallet sent it with. */
  memo: string | null;
  /** The bridge route a transfer with one of the bridge's accounts is on (`routeForAccount`). */
  route: Route | null;
  /** A call of Sozu's pool (`isSozuCall`): whether it staked or unstaked. */
  sozu: "stake" | "unstake" | null;
  /**
   * A call to DuskEVM's bridge or Portal. What came in from an account has
   * none, whatever its transaction called: a gas refund from another
   * account's call to the bridge is a transfer from that account.
   */
  bridge: ActivityBridge | null;
  /**
   * A call of the name service, as the app's hook reads it; a reservation
   * has the name of a registration after it with the same reservation.
   */
  nameCall: { kind: string; name: string | null; reservation: string | null } | null;
  blockHeight: number | null;
  blockHash: string | null;
  /**
   * When it happened, in milliseconds: its block's time, else the wallet's
   * own record of it, else the time another row of the same block has.
   */
  time: number | null;
  submittedAt: number | null;
  /** When its details were read. */
  detailsAt: number | null;
  gasLimit: bigint | null;
  gasPrice: bigint | null;
  /** The chain's, the send's until the chain's details come. */
  gasSpent: bigint | null;
  /** The profile that sent it. */
  profileIndex: number | null;
};

/** What `activityRows` takes. Every list may be empty, or missing. */
export type ActivityInput = {
  /** The account's public history, as `/history`'s `read()` gives it. */
  public?: ReadonlyArray<ReadEntry> | null;
  /** Its shielded history, as `/shielded` gives it. */
  shielded?: ReadonlyArray<ShieldedEntry> | null;
  /** The wallet's own records of what it sent, settled ones included. */
  pending?: ReadonlyArray<SentTransaction> | null;
  /** The public account whose activity it is: a send to it is to itself. */
  account?: string | null;
  /** The profile's shielded address: a send to it is to itself too. */
  address?: string | null;
  /** The profile shown: another profile's sends are left out. */
  profileIndex?: number | null;
  /** The node's network, or its chain ID: none for a node of a network there's no file for. */
  network?: NetworkRef | null;
  /** The pools Sozu's hub named, beside the network's own. */
  pools?: Iterable<string> | null;
  /** Counterparties' verified names: null for one checked without a name. */
  names?: ReadonlyMap<string, string | null>;
  /**
   * The app's hook for the name service's calls: what a call is, from its
   * contract and its function (`""` before its details), and what the app
   * keeps of it, on the entry or the send (`kept`); null for another
   * contract's call. It's asked for each contract call.
   */
  nameCall?: (
    call: { contractId: string; fnName: string },
    kept: ReadEntry | SentTransaction
  ) => NameFacts | null | undefined;
  /** What the app read of proved withdrawals, by their withdrawal hash, lower case. */
  claims?: ReadonlyMap<string, WithdrawalRead>;
  /** Deposits that arrived on DuskEVM, by the deposit's transaction hash. */
  arrivals?: ReadonlyMap<string, DepositArrival>;
  /**
   * The public history's head when it was last read (`read()`'s `state`):
   * a row without a time sorts by the time its height gives, a block every
   * 10 seconds.
   */
  state?: { finalized: number; headAt: number } | null;
  /** The clock, in milliseconds, for sends that waited too long. */
  now?: number;
};

/**
 * The account's rows, one per transaction, newest first: by time, else by
 * the time its height gives, then by height, then by hash. A send of
 * another profile is left out, and a settled one shows with the chain's row
 * alone.
 */
export declare function activityRows(input?: ActivityInput): ActivityRow[];

/** What `settleSends` takes. */
export type SettleInput = {
  public?: ReadonlyArray<ReadEntry> | null;
  shielded?: ReadonlyArray<ShieldedEntry> | null;
  pending?: ReadonlyArray<SentTransaction> | null;
  /**
   * Whether a send adds to the chain's row what the chain doesn't say: by
   * default, the name typed for its recipient, or a shielded send's
   * recipient or memo, which the shielded history doesn't have. A failed
   * send that tried to move an amount is kept too, whatever this says.
   */
  keeps?: (sent: SentTransaction) => boolean;
};

/**
 * The sends the chain's histories now have the outcome of, once: `drop`,
 * the hashes of those its rows say all of, for the app to forget; `keep`,
 * the others, marked settled, for the app to keep for what they add. Sends
 * settled before, those the chain has no outcome of yet, and those `keeps`
 * throws for are in neither.
 */
export declare function settleSends(input?: SettleInput): { keep: SentTransaction[]; drop: string[] };
