/**
 * A DuskEVM → Dusk withdrawal's whole life, for the Dusk apps, signing
 * aside: the call that starts it on DuskEVM, finding an account's
 * withdrawals again, where each one is (waiting for a dispute game,
 * provable, proved, claimable from a date, claimed), the game a proof goes
 * against and the proof itself, and the proof's and the claim's calls on
 * Dusk, ready for the app's wallet to sign.
 *
 * - Only DUSK withdrawals on the bridge's route count, as Dusk's L1 bridge
 *   pays them out (`decodeWithdrawal` of `@dusk-network/networks/duskevm`):
 *   from DuskEVM's messenger to Dusk's, relaying DuskEVM's bridge to
 *   Dusk's, paying a Dusk account, or a contract only whole lux at the
 *   address DuskEVM gives it, and no one past a u64 of lux. Any other
 *   message is refused, for its status, its proof and its claim.
 * - A proof goes against a game that covers the withdrawal and has already
 *   resolved for its proposal, where the Portal would take it (the anchor
 *   state registry calls it proper and respected), so its claim date is
 *   exact when it's made; otherwise against the newest game that covers
 *   it and that the Portal takes a proof against. A claim date is worked
 *   out as the Portal checks a claim (`claimFrom`), and a claim is ready
 *   once the Portal takes it, its game has resolved for the defender, and
 *   its date has come: all of it read, never on the Portal's check alone.
 * - A proof or a claim is encoded by the Portal's own data driver, which
 *   the app loads, and read back before it's handed over: its arguments
 *   must say exactly the withdrawal, the game, the output root proof and
 *   the proof's nodes they were built from, as Dusk Wallet reads them, or
 *   nothing is given to sign. It sends no DUSK along, and its gas limit is
 *   50M and the withdrawal's own gas, at least 1M (`withdrawalGasLimit`),
 *   refused over the app's bound.
 * - The app owns all I/O, storage, wallets and words: it passes its own
 *   clients (DuskEVM's RPC as a viem client or a URL and `fetch`, the Dusk
 *   node's URL with its `fetch`, its Multicall for Dusk batcher), the data
 *   drivers it loaded, and its caches. Results are facts; the words are
 *   the app's.
 *
 * @example
 * ```js
 * import { createWithdrawals } from "@dusk/app-core/duskevm-withdrawals";
 *
 * const withdrawals = createWithdrawals({
 *   network: chainId,
 *   nodeUrl,
 *   fetch: createMulticallFetch({ nodeUrl, multicallId }), // the reads one task starts, in one query
 *   drivers: { optimismPortal: () => loadDriver(portalUrl), disputeGameFactory: () => loadDriver(factoryUrl) },
 *   duskEvm: publicClient, // or { url: rpcUrl, fetch }
 * });
 *
 * const status = await withdrawals.status(txHash, { submitter: account });
 * // { stage: "proven_waiting", reason: "game-in-progress", readyAt: 1793589639n, readyAtExact: false, … }
 * const prepared = await withdrawals.prepareProof(txHash, { submitter: account });
 * prepared.claim; // when it can be claimed if proved now: { at, exact, overdue }
 * prepared.call; // { contractId, fnName: "proveWithdrawalTransaction", fnArgs, deposit: 0n, gasLimit: 51_000_000n, … }
 * const claim = await withdrawals.claimCall(txHash, { submitter: account }); // once it's ready
 * ```
 *
 * @module
 */

import type { Account, ContractId, EvmAddress, Network, NetworkRef } from "@dusk-network/networks";
import type { ClaimCall, ClaimDate, DuskTip, ProveCall, WithdrawalFacts } from "@dusk-network/networks/duskevm";

/** How many of the newest games a proof is looked for among, by default. */
export declare const GAME_SEARCH_DEPTH: 64;

/** Games one search for a resolved game reads at once. */
export declare const RESOLVED_PAGE: 32;

/** Pages of games a search for a resolved game reads at most. */
export declare const RESOLVED_PAGES: 3;

/**
 * How long past its clock running out a game's resolver is usually done:
 * an hour, in seconds. A game is old enough to have resolved once both
 * have passed.
 */
export declare const RESOLVER_LAG_SECONDS: 3600;

/** Reads one query holds by default, as Multicall for Dusk's batcher sends them; each game checked takes 4. */
export declare const MAX_BATCH: 32;

/** The gas limit a proof or a claim is refused over by default: 1,000,000,000, the apps' bound. */
export declare const GAS_LIMIT_UPPER: 1000000000n;

/** The gas a withdrawal's start leaves its message on Dusk: 200,000, as OP Stack bridges use. */
export declare const WITHDRAWAL_MIN_GAS_LIMIT: 200000;

/** DuskEVM blocks one log search asks for at once: 100,000, about 2.3 days. */
export declare const L2_WINDOW: 100000;

/** Log searches one run of `syncWithdrawals` makes, the head's included, by default. */
export declare const L2_RUN_REQUESTS: 8;

/**
 * DuskEVM blocks under the head counted as final where the RPC has no
 * "finalized" block: about an hour. As many under that head again stay
 * open, and the next run reads them again.
 */
export declare const UNFINALIZED_MARGIN: 1800;

/** Pages of an address's transactions `explorerWithdrawals` reads at most, by default. */
export declare const EXPLORER_PAGES: 10;

/** Withdrawals `explorerWithdrawals` gives at most, by default. */
export declare const EXPLORER_ITEMS: 12;

/** `MessagePassed(uint256,address,address,uint256,uint256,bytes,bytes32)`: DuskEVM's message passer recording a withdrawal. */
export declare const MESSAGE_PASSED_TOPIC: "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054";

/** `ETHBridgeInitiated(address,address,uint256,bytes)`: DuskEVM's bridge starting a DUSK withdrawal, from its sender. */
export declare const ETH_BRIDGE_INITIATED_TOPIC: "0x2849b43074093a05396b6f2a937dee8565b15a48a7b3d4bffb732a5017380af5";

/**
 * Where a withdrawal is on Dusk, for the account whose proof counts:
 * waiting for a dispute game to cover it, ready to prove, proved and
 * waiting for its claim date, ready to claim, or claimed.
 */
export type WithdrawalStage = "waiting_for_output" | "ready_to_prove" | "proven_waiting" | "ready_to_finalize" | "finalized";

/** The stages, by name. */
export declare const STAGE: Readonly<{
  WAITING_FOR_OUTPUT: "waiting_for_output";
  READY_TO_PROVE: "ready_to_prove";
  PROVEN_WAITING: "proven_waiting";
  READY_TO_FINALIZE: "ready_to_finalize";
  FINALIZED: "finalized";
}>;

/**
 * Why a withdrawal waits, or must be proved again:
 * - "no-games": no dispute game has been proposed yet;
 * - "no-output": no game the Portal takes a proof against covers it yet (`error` says what couldn't be read while
 *   looking, if anything);
 * - "proof-rejected": the account's proof can't be claimed, as the Portal refuses its game (blacklisted, retired, no
 *   longer respected, or won by the challenger), whatever its own check says: it's ready to prove again against
 *   another game the Portal takes, or waits for one;
 * - "game-unreadable": the proof's game, or whether the Portal still takes it, can't be read now: no date, and nothing
 *   to claim;
 * - "portal-refuses": the claim's date has passed and the Portal still refuses the claim;
 * - "game-in-progress": the proof's game hasn't resolved;
 * - "game-not-final": its game has resolved, and the proof or the game isn't final yet.
 */
export type WaitReason =
  | "no-games"
  | "no-output"
  | "proof-rejected"
  | "game-unreadable"
  | "portal-refuses"
  | "game-in-progress"
  | "game-not-final";

/**
 * Why the package refuses:
 * - "bad-hash": not a DuskEVM transaction hash;
 * - "not-found": DuskEVM has no receipt of it (yet);
 * - "failed": it failed on DuskEVM;
 * - "not-a-withdrawal": it records no DUSK withdrawal on the bridge's route that Dusk's L1 bridge pays out;
 * - "gas": its proof or claim needs more gas than the bound;
 * - "claimed": it's claimed already, so a proof does nothing;
 * - "proven": the account has a proof of it that stands, and another would cost its fee for nothing;
 * - "no-proof": no game covers it yet (`reason`);
 * - "not-ready": it isn't ready to claim for the account (`status`);
 * - "bad-call": the call its driver encoded doesn't read back as what it was built from.
 */
export type WithdrawalErrorCode =
  | "bad-hash"
  | "not-found"
  | "failed"
  | "not-a-withdrawal"
  | "gas"
  | "claimed"
  | "proven"
  | "no-proof"
  | "not-ready"
  | "bad-call";

/** A refusal, by its code, with the withdrawal's status where one was read. */
export declare class WithdrawalError extends Error {
  constructor(
    code: WithdrawalErrorCode,
    message?: string,
    options?: { status?: WithdrawalStatus | null; reason?: WaitReason | null; cause?: unknown }
  );
  readonly code: WithdrawalErrorCode;
  /** The withdrawal's status, for "claimed", "proven" and "not-ready". */
  readonly status: WithdrawalStatus | null;
  /** Why it waits: the status's, or for "no-proof", "no-games" or "no-output". */
  readonly reason: WaitReason | null;
}

/** A withdrawal as DuskEVM's message passer recorded it. */
export type L2Withdrawal = {
  nonce: bigint;
  /** DuskEVM's messenger, with its checksum. */
  sender: EvmAddress;
  /** Dusk's messenger, as DuskEVM names it, with its checksum. */
  target: EvmAddress;
  /** In DuskEVM's 18 decimals. */
  value: bigint;
  /** The gas its own call asks for, which a proof's and a claim's limit add. */
  gasLimit: bigint;
  /** The relayed message, lower-case hex. */
  data: `0x${string}`;
};

/** A DuskEVM transaction's withdrawal: where DuskEVM recorded it, and what it does. */
export type ReceiptWithdrawal = {
  /** The DuskEVM transaction, lower case. */
  transactionHash: `0x${string}`;
  /** Its DuskEVM block: a game must cover it. */
  blockNumber: bigint;
  /** The hash the Portal keys its proofs and its claim by, lower case. */
  withdrawalHash: `0x${string}`;
  withdrawal: L2Withdrawal;
  /** What it pays, whom, from whom: `decodeWithdrawal`'s. */
  facts: WithdrawalFacts;
};

/** Where a withdrawal is, as the chain says, for the account whose proof counts (`proofSubmitter`). */
export type WithdrawalStatus = ReceiptWithdrawal & {
  stage: WithdrawalStage;
  /** Why it waits; null when it doesn't. */
  reason: WaitReason | null;
  /** For "no-output": the last read that failed while a game was looked for. */
  error?: Error;
  /**
   * The Portal's address of the account whose proof the stage is, lower
   * case: the one asked for, else the recipient's own when it's an
   * account; null for neither.
   */
  proofSubmitter: `0x${string}` | null;
  /** How many accounts have proved it. */
  proofSubmitterCount: bigint;
  /** Whether the account's proof can't be claimed and must be made again. */
  proofRejected: boolean;
  /** For "ready_to_prove": another account holds a proof that stands, which this account can't claim with. */
  provenByOther?: boolean;
  /**
   * For "ready_to_prove": the game a proof would go against now, the newest
   * that covers it and that the Portal takes a proof against, else one
   * that has resolved, as `prepareProof` finds it; and the DuskEVM block it
   * covers.
   */
  disputeGameIndex?: bigint;
  proofL2BlockNumber?: bigint;
  /** Once proved: the game the account's proof went against, lower case. */
  disputeGameProxy?: `0x${string}`;
  /** Once proved: when, in seconds of wall-clock time, from the contracts' own clock. */
  provenAt?: bigint;
  /**
   * When it can be claimed, in seconds; null when there's no date (a proof
   * to make again, or a date past while the Portal still refuses). Absent
   * when it couldn't be worked out now, as when the proof's game can't be
   * read: the date known so far stands.
   */
  readyAt?: bigint | null;
  /** Whether `readyAt` is exact: its game has resolved. */
  readyAtExact?: boolean;
  /** Whether its game is more than an hour late to resolve. */
  claimOverdue?: boolean;
};

/**
 * When a proved withdrawal can be claimed (`ClaimDate`), whether it's
 * claimed, whether it can be claimed now (its game read and resolved for
 * the defender, the Portal taking the claim, its date come), and whether
 * its proof must be made again (the Portal refuses its game: blacklisted,
 * retired, no longer respected, or won by the challenger), with no date
 * then. Fits `/activity`'s `claims`.
 */
export type WithdrawalClaim = ClaimDate & { claimed: boolean; ready: boolean; reprove: boolean };

/** How long a withdrawal takes on the network, as the Portal and the games say. */
export type WithdrawalTiming = {
  /** The Portal's proof maturity delay, in seconds. */
  maturitySeconds: number;
  /** The Portal's dispute game finality delay, in seconds. */
  finalitySeconds: number;
  /** How often outputs come: the middle gap between the latest games, in the contracts' seconds; null without two games. */
  outputSeconds: number | null;
};

/** The game a proof goes against, and the proof. */
export type OutputProof = {
  /** The game's index in the factory. */
  disputeGameIndex: bigint;
  /** The game's address, lower case. */
  disputeGameProxy: `0x${string}`;
  /** The DuskEVM block the game's output is of. */
  l2BlockNumber: bigint;
  /** The output's root, the game's root claim. */
  outputRoot: `0x${string}`;
  outputRootProof: {
    version: `0x${string}`;
    stateRoot: `0x${string}`;
    messagePasserStorageRoot: `0x${string}`;
    latestBlockhash: `0x${string}`;
  };
  /** The message passer's storage proof of the withdrawal, its nodes as RLP. */
  withdrawalProof: `0x${string}`[];
};

/** A proof's or a claim's call on Dusk, for the app's wallet to sign. */
export type PortalCall = {
  /** The network's Portal. */
  contractId: ContractId;
  fnName: "proveWithdrawalTransaction" | "finalizeWithdrawalTransaction";
  /** The arguments, as the Portal's data driver encoded `args`. */
  fnArgs: Uint8Array;
  /** The driver's input, as JSON takes it: bytes as arrays of numbers. */
  args: unknown;
  /** DUSK sent along: none. */
  deposit: 0n;
  /** 50M and the withdrawal's own gas, at least 1M. */
  gasLimit: bigint;
  /** What the call does, as `decodeBridgeCall` reads its `fnArgs`: what Dusk Wallet shows. */
  decoded: ProveCall | ClaimCall;
};

/**
 * A proof, ready to sign: the withdrawal, the game and its proof, when it
 * can be claimed if proved now (null when that can't be read), and the
 * call. `at` is when it was prepared: the app decides how long it sends it
 * as is.
 */
export type PreparedProof = {
  at: number;
  receipt: ReceiptWithdrawal;
  proof: OutputProof;
  claim: ClaimDate | null;
  call: PortalCall;
};

/** A data driver, as the app loaded it: JSON in, rkyv out, and back. */
export type DataDriver = {
  encodeInputFn(fnName: string, json: string): Uint8Array;
  decodeOutputFn(fnName: string, bytes: Uint8Array): unknown;
};

/** A driver, a promise of one, or what loads one, once, and again after it failed. */
export type DriverSource = DataDriver | PromiseLike<DataDriver> | (() => DataDriver | PromiseLike<DataDriver>);

/** DuskEVM's JSON-RPC: a viem client (its `request`), or a URL and the `fetch` to post to it. */
export type DuskEvmClient = { request(args: { method: string; params?: unknown }): Promise<unknown> } | { url: string; fetch?: typeof fetch };

/** The app's cache of what a deployment doesn't change, as text: a Map does. */
export type FactCache = { get(key: string): string | null | undefined; set(key: string, value: string): unknown };

/** What `createWithdrawals` takes. */
export type WithdrawalsOptions = {
  /** The network, or its chain ID: its file names the Portal, the factory, the registry and the bridge's route. */
  network: NetworkRef;
  /** The Dusk node the Portal and the games are read on. */
  nodeUrl: string;
  /** The `fetch` the reads go through: the app's Multicall for Dusk batcher sends those one task starts in one query. */
  fetch?: typeof fetch;
  /** The Portal's and the dispute game factory's data drivers, as the network's file names and pins them. */
  drivers: { optimismPortal: DriverSource; disputeGameFactory: DriverSource };
  /** DuskEVM's RPC; the network file's, by `fetch`, by default. */
  duskEvm?: DuskEvmClient;
  /** Dusk's latest block, which contract times count from; read from the node by default. */
  latestBlock?: () => Promise<DuskTip>;
  /** Reads one query holds: 32 by default. */
  maxBatch?: number;
  /** How many of the newest games a proof is looked for among: 64 by default, and for anything but a positive whole number. */
  gameSearchDepth?: number | bigint;
  /**
   * Where the deployment's fixed facts are kept: each game's hub, each game
   * type's hub, each hub's clock limit, and each withdrawal's receipt once
   * its DuskEVM block is final.
   */
  cache?: FactCache;
  /** The clock, in milliseconds. */
  now?: () => number;
};

/** A network's withdrawals, read on its Dusk node and DuskEVM. */
export type Withdrawals = {
  readonly network: Network;
  /**
   * A DuskEVM transaction's withdrawal, from its receipt; refuses as
   * `parseWithdrawalReceipt` does. The receipt is read after DuskEVM's
   * finalized block, which the receipts read at the same time share, and
   * kept in `cache` once its block is at or under that one: a final
   * receipt is read once. One that isn't final yet, or isn't a
   * withdrawal's, is read again each time.
   */
  receipt(txHash: string): Promise<ReceiptWithdrawal>;
  /**
   * Where a withdrawal is, for `submitter` (a Dusk account, or its
   * Portal address), or else its recipient's account. `proofGame`, the game
   * the last check found the proof against, puts that game's reads in the
   * same query as the Portal's.
   */
  status(txHash: string, options?: { submitter?: string | null; proofGame?: string | null }): Promise<WithdrawalStatus>;
  /**
   * When the withdrawals `submitter` proved can be claimed, by their hashes
   * (lower case keys): claimed, ready, a date, none, or to prove again.
   * Each one's record and the Portal's check go in one query, their games
   * in the next.
   */
  claims(hashes: ReadonlyArray<string>, options: { submitter: string }): Promise<Map<string, WithdrawalClaim>>;
  /** How long a withdrawal takes: the Portal's delays with the game count in one query, then the latest games. */
  timing(): Promise<WithdrawalTiming>;
  /**
   * The proof `submitter` signs: against a resolved game where one covers
   * the withdrawal, else the newest that covers it that the Portal takes a
   * proof against. Refused ("claimed",
   * "proven", "gas", "no-proof", "not-a-withdrawal") where it would do
   * nothing or can't be made.
   */
  prepareProof(txHash: string, options: { submitter: string; gasLimitUpper?: bigint | number }): Promise<PreparedProof>;
  /** The claim `submitter` signs, once its status is ready to claim; refused ("not-ready", "gas") before. */
  claimCall(
    txHash: string,
    options: { submitter: string; gasLimitUpper?: bigint | number; proofGame?: string | null }
  ): Promise<PortalCall>;
};

/** A network's withdrawals: the reads go through the app's clients, and nothing is kept outside the object. */
export declare function createWithdrawals(options: WithdrawalsOptions): Withdrawals;

/**
 * The withdrawal a DuskEVM receipt records: its message passer's
 * `MessagePassed`, whose hash must be its own, on the network's bridge
 * route, as Dusk's L1 bridge pays it out. Throws a WithdrawalError:
 * "not-found" without a receipt, "failed" for a reverted one,
 * "not-a-withdrawal" for anything else.
 */
export declare function parseWithdrawalReceipt(network: NetworkRef, receipt: unknown): ReceiptWithdrawal;

/** What `withdrawalCall` takes. */
export type WithdrawalCallInput = {
  /** What it moves, in DuskEVM's 18 decimals: whole lux, more than 0, at most a u64 of lux. */
  amountWei: bigint | number | string;
  /** The Dusk account it pays. */
  to: Account;
  /** The DuskEVM address that sends it, which its message names as its recipient address. */
  sender: string;
  /** The gas it leaves its message on Dusk: `WITHDRAWAL_MIN_GAS_LIMIT` by default. */
  minGasLimit?: number | bigint;
};

/**
 * A DUSK withdrawal's start on DuskEVM, for the app's EVM wallet to send:
 * DuskEVM's bridge's `bridgeETHTo`, the Dusk account in its extra data,
 * the amount as its value. Throws a RangeError for an amount that isn't
 * whole lux, is 0, or is past a u64 of lux, and a TypeError for a
 * recipient that isn't a Dusk account or a sender that isn't an address.
 */
export declare function withdrawalCall(
  network: NetworkRef,
  withdrawal: WithdrawalCallInput
): { to: EvmAddress; data: `0x${string}`; value: bigint };

/** A withdrawal found in DuskEVM's bridge's logs. */
export type FoundWithdrawal = {
  /** Its DuskEVM transaction, lower case. */
  hash: `0x${string}`;
  blockNumber: number;
  /** What it moves, in DuskEVM's 18 decimals, as text. */
  amountWei: string;
  /** Whom it pays on Dusk, as its extra data says: an account, a contract's ID, or null for neither. */
  destination: string | null;
};

/** Where `syncWithdrawals` got to, kept by the app and passed back as it is. */
export type WithdrawalScan = {
  /**
   * The final blocks covered, as ranges, highest first: where the RPC has no
   * finalized block, up to `UNFINALIZED_MARGIN` blocks under `target`.
   */
  covered: number[][];
  /** What was found, by hash. */
  entries: Record<string, FoundWithdrawal>;
  /** The final head the last run read under. */
  target: number | null;
  /** The blocks one search asks for. */
  window: number;
  /**
   * Its passes over the final blocks, read again once they're all covered:
   * the highest block the one under way reads next, downwards (`from`, null
   * between two), when the next one begins (`at`), and when the blocks were
   * first all covered (`since`), in milliseconds.
   */
  recheck?: { from: number | null; at: number; since: number };
  updatedAt?: number;
};

/**
 * One run over an address's withdrawals, from the bridge's own event
 * (`ETHBridgeInitiated`, by its sender), the newest final blocks first, a
 * window at a time, narrower where the RPC asks for it, within
 * `maxRequests`, the head's requests among them. Only final blocks count as
 * covered: those above can still be reorged away. Each run reads the
 * newest 50,000 final blocks, the new ones first, in as many windows as they
 * take though in half its requests at most (while older blocks are still to
 * be read, only once the final head has moved), and carries on below; under
 * a final head lower than the last run's, what was covered and found above
 * it is dropped, and read again. Where the RPC has no finalized block, the
 * final head is the latest less `UNFINALIZED_MARGIN`, and as many blocks
 * under it stay open: the next run reads them again, so a deeper reorg
 * there is found. Once all the final blocks are
 * covered, they're read again from the newest down, a pass at a time with
 * the requests a run has left: the first an hour later, each after as long
 * again as it has been since. A withdrawal is found once: one read again
 * isn't found again.
 */
export declare function syncWithdrawals(options: {
  /** The DuskEVM address that sent them. */
  address: string;
  duskEvm: DuskEvmClient;
  /** The network, for its bridge on DuskEVM; or the bridge's address. */
  network?: NetworkRef;
  bridge?: string;
  state?: WithdrawalScan | null;
  maxRequests?: number;
  now?: () => number;
}): Promise<{ found: FoundWithdrawal[]; requests: number; state: WithdrawalScan }>;

/** A withdrawal as DuskEVM's explorer lists it. */
export type ExplorerWithdrawal = {
  /** Its DuskEVM transaction, lower case. */
  hash: `0x${string}`;
  /** Who sent it, lower case. */
  from: `0x${string}` | null;
  /** Its DuskEVM block, as text; null where the list doesn't say. */
  blockNumber: string | null;
  /** In DuskEVM's 18 decimals, as text. */
  amountWei: string | null;
  /** Whom it pays on Dusk, as its call says: an account, a contract's ID, or null. */
  destination: string | null;
  /** When it was sent, ISO; null where the explorer doesn't say. */
  timestamp: string | null;
  /** The explorer's own word for where it is ("Ready to prove"); see `explorerStage`. */
  explorerStatus: string | null;
  /** Its claim's transaction, where the explorer knows it. */
  l1TransactionHash: `0x${string}` | null;
};

/**
 * An address's withdrawals, from DuskEVM's explorer: its own calls to the
 * bridge's `bridgeETHTo` that didn't fail, newest first, up to `maxItems`,
 * each with what the explorer says of it.
 */
export declare function explorerWithdrawals(options: {
  network: NetworkRef;
  address: string;
  fetch?: typeof fetch;
  /** The explorer's API: the network file's by default. */
  url?: string;
  maxPages?: number;
  maxItems?: number;
}): Promise<ExplorerWithdrawal[]>;

/**
 * The DuskEVM transactions of withdrawals known by their nonces, as their
 * proofs and claims on Dusk carry them, from the explorer's list of all
 * withdrawals: newest first, never past the oldest asked for, by nonce as
 * decimal text. However a withdrawal was sent, the list has it.
 */
export declare function withdrawalsByNonce(options: {
  network: NetworkRef;
  nonces: ReadonlyArray<bigint>;
  fetch?: typeof fetch;
  url?: string;
  maxPages?: number;
}): Promise<Map<string, ExplorerWithdrawal>>;

/** The stage the explorer's word for a withdrawal stands for; null for one it doesn't have yet. */
export declare function explorerStage(status: string | null | undefined): WithdrawalStage | null;
