/**
 * A profile's shielded history, for the Dusk wallets: one entry per
 * transaction that made or spent its notes, worked out from the notes its
 * shielded sync keeps. Shielded transfers are off on Mainnet and Testnet,
 * so the history is final: it is worked out once and kept.
 *
 * - A note's leaf in the note tree holds the height it entered the tree at,
 *   and the block at that height says which transaction made it: a
 *   `phoenix` event lists the nullifiers its transaction spent and the
 *   notes it made, byte for byte as the leaves hold them, and an event
 *   paying a shielded receiver from a public account or a contract makes
 *   one note, and names its address and value. A transaction that spends
 *   notes always makes change for its sender, so the notes' heights hold
 *   every transaction that spent the profile's notes too.
 * - Asking for the blocks at those heights alone would tell the node where
 *   the profile's transactions are, so each one is asked for among four
 *   other heights that hold notes, drawn from the note tree's heights. The
 *   decoys are kept before any block is asked for, and asked among again:
 *   a read that fails partway, or whose history isn't kept, asks for the
 *   same heights next time. Without another height to ask among, or for a
 *   note at a height the tree as read doesn't have, nothing is asked.
 * - The note tree's heights are read once, in one stream of its leaves, and
 *   kept for every profile on the network; a later read takes only the
 *   leaves added since. A shielded sync that streams the tree from its
 *   first note can keep them on the way (`createLeafHeightTap`).
 * - The same notes again read the kept history and ask nothing. Until the
 *   shielded sync has found every note, a read gives what is kept, pending,
 *   and works nothing out.
 * - A history is kept only whole: once each note's block has the event that
 *   made it (a note of the genesis block aside, which no transaction made)
 *   and lists each transaction that spent the profile's notes. Until then,
 *   as while the archive is still indexing a block, a read gives what is
 *   kept, pending, and the next one asks again, among the same decoys.
 * - The app owns the keys and all I/O: it passes its notes, their values
 *   from its keys, the node's note tree, the archive (`createArchive` of
 *   `/history`) and two small stores. Nothing here chooses a storage key or
 *   keeps state outside the calls, so it runs in an extension's service
 *   worker as well as in a page.
 * - Entries are facts: what a transaction did, which way the value went for
 *   the profile's notes, the lux it moved and the fee it paid, its outcome
 *   and its time. The words are the app's.
 *
 * @example
 * ```js
 * import { createArchive } from "@dusk/app-core/history";
 * import { shieldedHistory } from "@dusk/app-core/shielded";
 *
 * const { entries, pending } = await shieldedHistory({
 *   archive: createArchive({ url: nodeUrl, fetch }),
 *   notes: () => syncedNotes(profile), // [{ leaf, nullifier, spent }], as the shielded sync keeps them
 *   valueOf: (note) => noteValue(profile, note), // in lux, from the profile's keys
 *   tree: { size: () => numNotes(), leaves: (from) => leavesFrom(from) }, // the node's note tree
 *   store, // this profile's kept history: get() and put(record)
 *   treeHeights, // the note tree's heights kept for the network: get() and put({ heights, notes })
 *   synced: true, // the shielded sync has found every note
 *   isCurrent: () => profile === currentProfile(),
 * });
 * entries[0]; // { hash, blockHeight, kind: "unshield", direction: "out", value: "9475570898", fee: "12429102", success: true, timestamp, … }
 * ```
 *
 * @module
 */

import type { Archive, Direction, EntryKind } from "./history.js";

/** A leaf of the note tree, as its stream gives it: the note, then the block height it entered the tree at. */
export declare const LEAF_BYTES: 736;

/** A note, as a `phoenix` event lists the notes its transaction made. */
export declare const NOTE_BYTES: 728;

/** Where a leaf holds the note's position in the tree, a u64, little-endian. */
export declare const LEAF_POS_OFFSET: 648;

/** Where a leaf holds the block height the note entered the tree at, a u64, little-endian. */
export declare const LEAF_HEIGHT_OFFSET: 728;

/** Other heights each of the profile's heights is asked for among. */
export declare const DECOYS_PER_HEIGHT: 4;

/** Heights one blocks request asks for. */
export declare const HEIGHTS_PER_REQUEST: 15;

/** One of the profile's notes, as its shielded sync keeps it. */
export type OwnedNote = {
  /** The note tree's leaf: the note, then the height it entered the tree at (`LEAF_BYTES`). */
  leaf: Uint8Array;
  /** The note's nullifier, as bytes or hex. */
  nullifier: Uint8Array | string;
  /** Whether the profile spent it. */
  spent: boolean;
};

/** A note with its value, in lux, as `shieldedEntries` reads it. */
export type ValuedNote = OwnedNote & { value: bigint };

/** One of a block's contract events, as the archive's `contractEvents` gives it. */
export type ContractEvent = {
  /** The contract that emitted it, as hex. */
  source?: string;
  /** The contract that emitted it, where `source` isn't given. */
  target?: string;
  topic: string;
  /** The hash of the transaction it came from. */
  origin: string;
  /** What it carries, as hex. */
  data: unknown;
  reverted?: boolean;
};

/** One of a block's transactions: its hash, error and gas. */
export type BlockTransaction = {
  id: string;
  err?: unknown;
  gasSpent?: number | string;
  tx?: { gasPrice?: number | string } | null;
};

/** A block as the shielded history reads it (`fetchShieldedBlocks`). */
export type ShieldedBlock = {
  events: ContractEvent[];
  /** The block's time, in milliseconds; null when the archive gave none. */
  timestamp: number | null;
  /** Its transactions, by hash in lower case. */
  txs: ReadonlyMap<string, BlockTransaction>;
};

/**
 * One transaction of the shielded history, as the profile's notes saw it.
 * Amounts are lux, as decimal strings, so an entry stores as JSON as it is.
 */
export type ShieldedEntry = {
  /** The transaction's hash: 64 lower-case hex digits. */
  hash: string;
  blockHeight: number;
  /**
   * What it did: a transfer, a shield or an unshield, a contract call, or a
   * stake operation. A conversion is a shield or an unshield by where its
   * value went, as its event says, also for a profile that only got its
   * change.
   */
  kind: EntryKind;
  /**
   * Which way the value went for the profile's notes: "in" for what they
   * received, "out" for what left them, "self" when what they spent came
   * back to them, the fee aside.
   */
  direction: Direction;
  /**
   * What reached or left the profile's notes, the fee aside: what a
   * transaction that spent them sent, what one that didn't made. "0" for
   * "self".
   */
  value: string;
  /** The fee it paid from the profile's notes; null when it spent none of them, or its block didn't list it. */
  fee: string | null;
  success: boolean;
  /** Its error, as text; undefined when it went through. */
  error?: string;
  /** Its block's time, in milliseconds; null when the archive gave none. */
  timestamp: number | null;
};

/** A profile's shielded history, as the app keeps it. */
export type ShieldedRecord = {
  /** The notes it was worked out from: their positions, and which were spent. */
  fingerprint: string;
  /** Newest first. */
  entries: ShieldedEntry[];
  /** The other heights its blocks were asked for among, asked among again by the next read. */
  decoys: number[];
};

/**
 * Where one profile's shielded history is kept on one network: the app's
 * own storage, which the app scopes and keys. Each method may return a
 * value or a promise.
 */
export type ShieldedStore = {
  /** The kept history, or null. Reject when it can't be read: the read then asks nothing, rather than draw new decoys. */
  get(): Promise<ShieldedRecord | null> | ShieldedRecord | null;
  /**
   * Keep `record` in place of the one kept. A put that rejects, as one
   * bound to a wallet that has been reset since, rejects the read. A store
   * that can't keep a history for want of room may pass over it: the read
   * gives the history anyway, and the next one works it out again, among
   * the same decoys.
   */
  put(record: ShieldedRecord): Promise<void> | void;
  /**
   * Optional: keep `change(kept)` in place of the record kept now, in one
   * transaction, and give what was kept. With it, the decoys are drawn from
   * those kept and kept at once, so two reads of the profile at once (two
   * pages, a popup and a page) ask among the same decoys; without it, they
   * are put, then read back, and two such reads can still draw their own.
   * It rejects and passes over a history as `put` does.
   */
  update?(change: (kept: ShieldedRecord | null) => ShieldedRecord): Promise<ShieldedRecord | void> | ShieldedRecord | void;
};

/** The note tree's distinct heights, from its first `notes` leaves. */
export type TreeHeights = {
  heights: number[];
  notes: number;
};

/** Where the note tree's heights are kept for one network, shared by its profiles. */
export type TreeHeightsStore = {
  /** The kept heights, or null. A store that can't be read counts as none. */
  get(): Promise<TreeHeights | null> | TreeHeights | null;
  /** Keep them. A put that fails is passed over: the tree is read again next time. */
  put(kept: TreeHeights): Promise<void> | void;
};

/** The note tree's leaves from a position: a stream of their bytes, or an answer whose body is one. */
export type LeafStream = ReadableStream<Uint8Array> | { body: ReadableStream<Uint8Array> | null } | null | undefined;

/**
 * The node's note tree, through the app's own client, as the transfer
 * contract gives it.
 */
export type NoteTree = {
  /** How many leaves it has (`num_notes`). */
  size(): Promise<bigint | number> | bigint | number;
  /** Its leaves from position `from` on, in order (`leaves_from_pos`). */
  leaves(from: bigint): Promise<LeafStream> | LeafStream;
};

/**
 * A pass-through for a stream of the note tree's leaves that notes each
 * leaf's height on the way.
 */
export type LeafHeightTap = {
  /** The transform to pipe the stream through. It passes every chunk on as it came, whatever it reads. */
  stream(): TransformStream<Uint8Array, Uint8Array>;
  /**
   * The distinct heights of the leaves from the tap's first position up to
   * `total` (the tree's size), once all of them passed in order; null
   * before, or when they didn't come in order.
   */
  heights(total: bigint | number): number[] | null;
};

/** What `shieldedHistory` takes. */
export type ShieldedHistoryOptions = {
  /** The archive the blocks are read from: a node that answered without one is asked nothing for an hour, its tree included. */
  archive: Archive;
  /** The profile's notes, unspent and spent, as its shielded sync keeps them. */
  notes: () => Promise<Iterable<OwnedNote>> | Iterable<OwnedNote>;
  /** A note's value, in lux, from the profile's keys. */
  valueOf: (note: OwnedNote) => Promise<bigint> | bigint;
  tree: NoteTree;
  /** Where this profile's history is kept. */
  store: ShieldedStore;
  /** Where the note tree's heights are kept. */
  treeHeights: TreeHeightsStore;
  /** Whether the shielded sync has found every note: until then, nothing is worked out. */
  synced: boolean;
  /**
   * Whether the wallet, the profile and the node are still the ones the
   * read began with. It's asked between every two steps, before each
   * request and write, while the tree's leaves come, and once more after
   * the history is kept; once it says no, the read asks and keeps nothing
   * more and rejects.
   */
  isCurrent?: () => boolean;
  /** 32 random bits for drawing the decoys: `crypto.getRandomValues` by default. */
  random?: () => number;
};

/** A read of the shielded history. */
export type ShieldedHistory = {
  /** Newest first. */
  entries: ShieldedEntry[];
  /**
   * Whether it may not be all of it yet: the notes are still being found,
   * the tree can't be read, there's no other height to ask among, or the
   * archive doesn't have all the notes' blocks yet. Read again later.
   */
  pending: boolean;
};

/** A leaf's position in the note tree and the block height its note entered it at. */
export declare function leafInfo(leaf: Uint8Array): { height: number; pos: bigint };

/**
 * A pass-through for a stream of the note tree's leaves from position
 * `from` (0 by default), as the shielded sync downloads it from its first
 * note, that notes the tree's heights on the way: kept, they spare the
 * history its own read of the tree.
 */
export declare function createLeafHeightTap(options?: { from?: bigint | number }): LeafHeightTap;

/**
 * The distinct heights of the note tree's leaves from position `from` (0 by
 * default) up to `total`, from one stream of them; null when the stream
 * didn't give them all, in order. Throws when the tree gives no stream, and
 * once `isCurrent` says no, asking nothing or reading the stream no further.
 */
export declare function readNoteHeights(
  tree: Pick<NoteTree, "leaves">,
  total: bigint | number,
  options?: { from?: bigint | number; isCurrent?: () => boolean }
): Promise<number[] | null>;

/**
 * The note tree's heights: those kept, extended with the leaves added since
 * (the tree keeps growing), or read once from the whole tree, and kept.
 * Null while the tree can't be read. Throws once `isCurrent` says no, asking
 * the tree nothing more and keeping nothing.
 */
export declare function noteTreeHeights(
  tree: NoteTree,
  store: TreeHeightsStore,
  options?: { isCurrent?: () => boolean }
): Promise<number[] | null>;

/**
 * The heights to ask for: the profile's own (`real`), each among
 * `perHeight` others (4 by default) drawn from `pool`, the tree's heights,
 * shuffled; as many as there are when the pool has fewer. `keep` gives the
 * decoys an earlier read drew, asked among again so a second look shows
 * the node nothing new.
 */
export declare function pickHeights(
  pool: ReadonlyArray<number>,
  real: ReadonlyArray<number>,
  options?: { keep?: ReadonlyArray<number>; perHeight?: number; random?: () => number }
): { decoys: number[]; heights: number[] };

/**
 * The blocks at `heights`, 15 a request, in their order, with their contract
 * events, times and transactions' gas; heights that aren't whole numbers of
 * 0 or more are left out. A node that answered without the archive is asked
 * nothing for an hour (`Archive.assertArchive`). Throws once `isCurrent`
 * says no, sending no further request.
 */
export declare function fetchShieldedBlocks(
  archive: Archive,
  heights: ReadonlyArray<number>,
  options?: { isCurrent?: () => boolean }
): Promise<Map<number, ShieldedBlock>>;

/**
 * The profile's shielded history from its notes and the blocks at their
 * heights: one entry per transaction that made or spent them, newest
 * first. A transaction that spent the profile's notes sent what they held,
 * less what came back to them (change, the fee's refund) and the fee; one
 * that only made notes is what they received. A note no event of its block
 * names is left out, and reverted events don't count; two notes a block
 * made for one address go to a transaction each, by their values.
 */
export declare function shieldedEntries(input: {
  notes: ReadonlyArray<ValuedNote>;
  blocks: ReadonlyMap<number, ShieldedBlock>;
}): ShieldedEntry[];

/**
 * A profile's shielded history: the kept one while its notes are the same,
 * else worked out once the shielded sync has found every note, asking for
 * the blocks at the notes' heights among decoys, and kept once it's whole.
 * A profile without notes reads nothing. Rejects when the wallet changed
 * meanwhile (`isCurrent`), when the decoys can't be kept, as the archive,
 * the tree or the store does, and with a TypeError for a missing option.
 * The app runs one read at a time per profile.
 */
export declare function shieldedHistory(options: ShieldedHistoryOptions): Promise<ShieldedHistory>;
