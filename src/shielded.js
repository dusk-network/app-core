/* @ts-self-types="./shielded.d.ts" */
/**
 * A profile's shielded history, from the notes its shielded sync keeps and
 * the blocks at their heights, each asked for among other heights that hold
 * notes. The app passes its notes, their values from its keys, the node's
 * note tree, the archive and its stores; nothing here reads keys, chooses a
 * storage key or keeps state outside the calls.
 *
 * @module
 */

import { ENTRY_KIND, STAKE_CONTRACT, TRANSFER_CONTRACT } from "./history.js";

/** @typedef {import("./history.js").Archive} Archive */
/** @typedef {import("./history.js").Direction} Direction */
/** @typedef {import("./history.js").EntryKind} EntryKind */
/** @typedef {import("./shielded.js").LeafHeightTap} LeafHeightTap */
/** @typedef {import("./shielded.js").NoteTree} NoteTree */
/** @typedef {import("./shielded.js").OwnedNote} OwnedNote */
/** @typedef {import("./shielded.js").ShieldedBlock} ShieldedBlock */
/** @typedef {import("./shielded.js").ShieldedEntry} ShieldedEntry */
/** @typedef {import("./shielded.js").ShieldedHistory} ShieldedHistory */
/** @typedef {import("./shielded.js").ShieldedHistoryOptions} ShieldedHistoryOptions */
/** @typedef {import("./shielded.js").ShieldedRecord} ShieldedRecord */
/** @typedef {import("./shielded.js").ShieldedStore} ShieldedStore */
/** @typedef {import("./shielded.js").TreeHeights} TreeHeights */
/** @typedef {import("./shielded.js").TreeHeightsStore} TreeHeightsStore */
/** @typedef {import("./shielded.js").ValuedNote} ValuedNote */

export const LEAF_BYTES = 736;
export const NOTE_BYTES = 728;
export const LEAF_POS_OFFSET = 648;
export const LEAF_HEIGHT_OFFSET = 728;
export const DECOYS_PER_HEIGHT = 4;
export const HEIGHTS_PER_REQUEST = 15;

// The part of a note that an event paying a shielded receiver carries
// (`convert`, `mint`, `withdraw`), where a `phoenix` event lists whole notes.
const RECEIVER_START = 328;
const RECEIVER_END = 392;
// Such an event makes one transparent note, and carries the note's whole
// shielded address with its value right after it; the note holds that
// value in the 8 bytes after its position.
const ADDRESS_END = 648;
const VALUE_START = 656;
const VALUE_END = 664;
const MAKES_NOTE = new Set(["convert", "mint", "withdraw"]);
// A `convert` event: its sender, then where its value went, a shielded
// address (0) or a public account (1).
const CONVERT_BYTES = 544;
const CONVERT_RECEIVER = 208;
// A request for 15 blocks and their events may take a while.
const BLOCKS_TIMEOUT_MS = 30_000;
const MAX_U64 = (1n << 64n) - 1n;
const HASH = /^[0-9a-f]{64}$/;
const HEX = /^(?:[0-9a-f]{2})+$/;
const CHANGED = "The wallet changed while its shielded history was read";

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/** @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * A nullifier as lower-case hex, from its bytes or its hex.
 *
 * @param {Uint8Array | string} value
 */
const hexOf = (value) => (typeof value === "string" ? value.toLowerCase() : hex(value));

/**
 * A u64 from a number or its text: 0n for anything else.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function u64(value) {
  const text = String(value ?? "").trim();

  if (!/^\d+$/.test(text)) return 0n;

  const n = BigInt(text);

  return n <= MAX_U64 ? n : 0n;
}

/**
 * A count of notes as a bigint: 0n for none, or anything that isn't one.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function countOf(value) {
  try {
    const n = BigInt(/** @type {any} */ (value));

    return n > 0n ? n : 0n;
  } catch {
    return 0n;
  }
}

/**
 * A transaction's error as text: "" for none.
 *
 * @param {unknown} err
 */
const errorText = (err) => (err === null || err === undefined ? "" : typeof err === "string" ? err : JSON.stringify(err));

/** @param {unknown} height */
const isHeight = (height) => Number.isSafeInteger(height) && /** @type {number} */ (height) >= 0;

const always = () => true;

/**
 * A check that the wallet is still the one a read began with, for between
 * its steps: it throws once `isCurrent` says no.
 *
 * @param {() => boolean} isCurrent
 */
const guardOf = (isCurrent) => () => {
  if (!isCurrent()) throw new Error(CHANGED);
};

/**
 * Whether `a` and `b` hold the same heights.
 *
 * @param {ReadonlyArray<number>} a
 * @param {ReadonlyArray<number>} b
 */
function sameHeights(a, b) {
  const other = new Set(b);

  return new Set(a).size === other.size && a.every((h) => other.has(h));
}

// ---------------------------------------------------------------------------
// The note tree
// ---------------------------------------------------------------------------

/**
 * @param {Uint8Array} leaf
 * @returns {{ height: number, pos: bigint }}
 */
export function leafInfo(leaf) {
  const view = new DataView(leaf.buffer, leaf.byteOffset, leaf.byteLength);

  return {
    height: Number(view.getBigUint64(LEAF_HEIGHT_OFFSET, true)),
    pos: view.getBigUint64(LEAF_POS_OFFSET, true),
  };
}

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
function concat(a, b) {
  const out = new Uint8Array(a.length + b.length);

  out.set(a, 0);
  out.set(b, a.length);

  return out;
}

/**
 * @param {{ from?: bigint | number }} [options]
 * @returns {LeafHeightTap}
 */
export function createLeafHeightTap({ from = 0n } = {}) {
  const start = BigInt(from);
  let rest = new Uint8Array(0);
  let next = start;
  let broken = false;
  /** @type {number[]} */
  const heights = [];

  /** @param {Uint8Array} chunk */
  const take = (chunk) => {
    const bytes = rest.length ? concat(rest, chunk) : chunk;
    let at = 0;

    for (; at + LEAF_BYTES <= bytes.length; at += LEAF_BYTES) {
      const { height, pos } = leafInfo(bytes.subarray(at, at + LEAF_BYTES));

      if (pos !== next) throw new Error("Leaves out of order");

      next += 1n;
      heights.push(height);
    }

    rest = bytes.slice(at);
  };

  return Object.freeze({
    /** @param {bigint | number} total */
    heights(total) {
      const n = Number(total) - Number(start);

      if (broken || !Number.isSafeInteger(n) || n <= 0 || heights.length < n) return null;

      return [...new Set(heights.slice(0, n))];
    },

    stream: () =>
      /** @type {TransformStream<Uint8Array, Uint8Array>} */ (
        new TransformStream({
          /**
           * @param {Uint8Array | ArrayBuffer} chunk
           * @param {TransformStreamDefaultController<Uint8Array | ArrayBuffer>} controller
           */
          transform(chunk, controller) {
            // Whatever it reads, the stream goes on as it came.
            controller.enqueue(chunk);

            if (broken) return;

            try {
              take(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            } catch {
              broken = true;
            }
          },
        })
      ),
  });
}

/**
 * @param {unknown} value
 * @returns {value is ReadableStream<Uint8Array>}
 */
const isStream = (value) =>
  Boolean(value) && typeof (/** @type {any} */ (value).pipeThrough) === "function" && typeof (/** @type {any} */ (value).getReader) === "function";

/**
 * @param {Pick<NoteTree, "leaves">} tree
 * @param {bigint | number} total
 * @param {{ from?: bigint | number, isCurrent?: () => boolean }} [options]
 * @returns {Promise<number[] | null>}
 */
export async function readNoteHeights(tree, total, { from = 0n, isCurrent = always } = {}) {
  const current = guardOf(isCurrent);
  const tap = createLeafHeightTap({ from });

  current();

  /** @type {any} */
  const answer = await tree.leaves(BigInt(from));
  const body = isStream(answer) ? answer : answer?.body;

  if (!isStream(body)) throw new Error("The node sent no note tree");

  const reader = body.pipeThrough(tap.stream()).getReader();

  for (;;) {
    // A wallet that changed reads the rest of the stream no further.
    if (!isCurrent()) {
      await reader.cancel().catch(() => {});
      current();
    }

    const { done } = await reader.read();

    if (done) break;
  }

  return tap.heights(total);
}

/**
 * @param {NoteTree} tree
 * @param {TreeHeightsStore} store
 * @param {{ isCurrent?: () => boolean }} [options]
 * @returns {Promise<number[] | null>}
 */
export async function noteTreeHeights(tree, store, { isCurrent = always } = {}) {
  const current = guardOf(isCurrent);
  /** @type {any} */
  let kept = null;

  try {
    kept = await store.get();
  } catch {
    kept = null;
  }

  current();

  const keptHeights = Array.isArray(kept?.heights) ? /** @type {number[]} */ (kept.heights) : [];
  const have = keptHeights.length && isHeight(kept?.notes) ? BigInt(kept.notes) : 0n;
  const total = countOf(await tree.size());

  current();

  if (!total) return null;
  if (have && total <= have) return keptHeights;

  // The tree keeps growing: only the leaves added since are read.
  const added = await readNoteHeights(tree, total, { from: have, isCurrent });

  current();

  if (!added) return null;

  const heights = have ? [...new Set([...keptHeights, ...added])] : added;

  try {
    await store.put({ heights, notes: Number(total) });
  } catch {
    // Not kept: the tree is read again next time.
  }

  return heights;
}

// ---------------------------------------------------------------------------
// Decoys
// ---------------------------------------------------------------------------

/**
 * An unbiased index below n, from 32 random bits.
 *
 * @param {number} n
 * @param {() => number} random
 */
function randomIndex(n, random) {
  const limit = Math.floor(0x1_0000_0000 / n) * n;

  for (;;) {
    const r = random();

    if (r < limit) return r % n;
  }
}

const cryptoRandom = () => crypto.getRandomValues(new Uint32Array(1))[0];

/**
 * The heights in a random order.
 *
 * @param {ReadonlyArray<number>} list
 * @param {() => number} random
 */
function shuffled(list, random) {
  const heights = [...list];

  for (let i = heights.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, random);

    [heights[i], heights[j]] = [heights[j], heights[i]];
  }

  return heights;
}

/**
 * @param {ReadonlyArray<number>} pool
 * @param {ReadonlyArray<number>} real
 * @param {{ keep?: ReadonlyArray<number>, perHeight?: number, random?: () => number }} [options]
 * @returns {{ decoys: number[], heights: number[] }}
 */
export function pickHeights(pool, real, { keep = [], perHeight = DECOYS_PER_HEIGHT, random = cryptoRandom } = {}) {
  const own = new Set(real);
  const decoys = keep.filter((h) => !own.has(h));
  const taken = new Set(decoys);
  const free = pool.filter((h) => !own.has(h) && !taken.has(h));

  for (let want = own.size * perHeight - decoys.length; want > 0 && free.length; want -= 1) {
    const i = randomIndex(free.length, random);

    decoys.push(free[i]);
    free[i] = free[free.length - 1];
    free.pop();
  }

  return { decoys, heights: shuffled([...own, ...decoys], random) };
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

/**
 * One request's GraphQL: each height's contract events, block time and
 * transactions' gas.
 *
 * @param {ReadonlyArray<number>} heights
 */
const blocksQuery = (heights) =>
  `query { ${heights
    .map(
      (h) =>
        `e${h}: contractEvents(height: ${h}) { json } b${h}: block(height: ${h}) { header { timestamp } transactions { id err gasSpent tx { gasPrice } } }`
    )
    .join(" ")} }`;

/**
 * One block of an answer.
 *
 * @param {any} data
 * @param {number} h
 * @returns {ShieldedBlock}
 */
function blockOf(data, h) {
  const block = data?.[`b${h}`];
  const seconds = Number(block?.header?.timestamp);
  const events = data?.[`e${h}`]?.json;
  const transactions = Array.isArray(block?.transactions) ? block.transactions : [];

  return {
    events: Array.isArray(events) ? events : [],
    timestamp: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
    txs: new Map(transactions.map((/** @type {any} */ tx) => [String(tx?.id ?? "").toLowerCase(), tx])),
  };
}

/**
 * @param {Archive} archive
 * @param {ReadonlyArray<number>} heights
 * @param {{ isCurrent?: () => boolean }} [options]
 * @returns {Promise<Map<number, ShieldedBlock>>}
 */
export async function fetchShieldedBlocks(archive, heights, { isCurrent = always } = {}) {
  const current = guardOf(isCurrent);
  const list = [...new Set(heights.filter(isHeight))];

  await archive.assertArchive();

  /** @type {Map<number, ShieldedBlock>} */
  const out = new Map();

  for (let i = 0; i < list.length; i += HEIGHTS_PER_REQUEST) {
    const batch = list.slice(i, i + HEIGHTS_PER_REQUEST);

    current();

    const data = await archive.query(blocksQuery(batch), { timeoutMs: BLOCKS_TIMEOUT_MS });

    for (const h of batch) out.set(h, blockOf(data, h));
  }

  return out;
}

// ---------------------------------------------------------------------------
// Entries
// ---------------------------------------------------------------------------

/**
 * What one transaction did to the profile's notes, and what its `convert`
 * event says it was.
 *
 * @typedef {{ hash: string, height: number, made: bigint, spent: bigint, topics: Set<string>, conversion: EntryKind | null }} Tally
 *
 * @typedef {{ matched: boolean, part: string, tail: string, value: bigint, whole: string }} MadeNote
 */

/**
 * Whether `needle` (hex) is in `hay` (hex) at a whole byte.
 *
 * @param {string} hay
 * @param {string} needle
 */
function hexHas(hay, needle) {
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
    if (at % 2 === 0) return true;
  }

  return false;
}

/**
 * What a `convert` event did: a shield, into a note, or an unshield, to a
 * public account; null for an event of another shape.
 *
 * @param {string} data - its data, as lower-case hex
 * @returns {EntryKind | null}
 */
function conversionOf(data) {
  const tag = data.length === 2 * CONVERT_BYTES ? data.slice(2 * CONVERT_RECEIVER, 2 * CONVERT_RECEIVER + 2) : "";

  return tag === "00" ? ENTRY_KIND.SHIELD : tag === "01" ? ENTRY_KIND.UNSHIELD : null;
}

/**
 * Adds one transfer contract event to its transaction's tally. A `phoenix`
 * event names the nullifiers its transaction spent and the notes it made
 * (change and the fee's refund among them), whole; an event paying a
 * shielded receiver from a public account or a contract made one note, and
 * is kept in `makers` until every whole note of the block is matched.
 *
 * @param {Tally} tally
 * @param {any} event
 * @param {MadeNote[]} made - the profile's notes at this height
 * @param {{ nullifier: string, value: bigint }[]} spent - the profile's spent notes
 * @param {{ tally: Tally, data: string }[]} makers
 */
function addTransferEvent(tally, event, made, spent, makers) {
  const data = String(event.data).toLowerCase();
  const topic = String(event.topic);

  tally.topics.add(topic);

  if (topic === "convert") tally.conversion ??= conversionOf(data);
  if (MAKES_NOTE.has(topic)) makers.push({ data, tally });
  if (topic !== "phoenix") return;

  for (const n of spent) if (hexHas(data, n.nullifier)) tally.spent += n.value;

  for (const n of made) {
    if (!n.matched && hexHas(data, n.whole)) {
      tally.made += n.value;
      n.matched = true;
    }
  }
}

/**
 * Gives each event that made one note the note it made: first the one
 * whose shielded address and value it carries, then one whose address it
 * names, so two notes to the same address in one block go to an event
 * each.
 *
 * @param {{ tally: Tally, data: string }[]} makers
 * @param {MadeNote[]} made
 */
function matchMakers(makers, made) {
  /** @type {Set<{ tally: Tally, data: string }>} */
  const done = new Set();

  for (const key of /** @type {const} */ (["tail", "part"])) {
    for (const maker of makers) {
      const note = done.has(maker) ? undefined : made.find((n) => !n.matched && hexHas(maker.data, n[key]));

      if (!note) continue;

      maker.tally.made += note.value;
      note.matched = true;
      done.add(maker);
    }
  }
}

/**
 * @param {Tally} t
 * @returns {EntryKind}
 */
function kindOf(t) {
  if (t.topics.has("stake:stake")) return ENTRY_KIND.STAKE;
  if (t.topics.has("stake:unstake")) return ENTRY_KIND.UNSTAKE;
  if (t.topics.has("stake:withdraw")) return ENTRY_KIND.WITHDRAW_REWARD;
  if (t.topics.has("convert")) return t.conversion ?? (t.spent > 0n ? ENTRY_KIND.UNSHIELD : ENTRY_KIND.SHIELD);

  return t.topics.has("deposit") ? ENTRY_KIND.CONTRACT_CALL : ENTRY_KIND.TRANSFER;
}

/**
 * One transaction's entry: what its notes moved for the profile, the fee
 * when the profile's notes paid it, its outcome and its block's time.
 *
 * @param {Tally} t
 * @param {ShieldedBlock | undefined} block
 * @returns {ShieldedEntry}
 */
function entryOf(t, block) {
  const info = block?.txs?.get(t.hash);
  // A transaction that spent the profile's notes paid its fee from them.
  const fee = t.spent > 0n && info ? u64(info.gasSpent) * u64(info.tx?.gasPrice) : null;
  const net = t.made - t.spent + (fee ?? 0n);
  const err = errorText(info?.err);

  return {
    blockHeight: t.height,
    direction: net > 0n ? "in" : net < 0n ? "out" : "self",
    ...(err ? { error: err } : {}),
    fee: fee === null ? null : fee.toString(),
    hash: t.hash,
    kind: kindOf(t),
    success: !err,
    timestamp: block?.timestamp ?? null,
    value: (net < 0n ? -net : net).toString(),
  };
}

/**
 * What the blocks say of the profile's notes: each transaction's tally, and
 * how many of the notes no event of their block made. The genesis block's
 * notes count as made: no transaction made them.
 *
 * @param {ReadonlyArray<ValuedNote>} notes
 * @param {ReadonlyMap<number, ShieldedBlock>} blocks
 * @returns {{ tallies: Tally[], unnamed: number }}
 */
function tallyNotes(notes, blocks) {
  /** @type {Map<string, Tally>} */
  const txs = new Map();
  let unnamed = 0;
  const spent = notes
    .filter((n) => n.spent)
    .map((n) => ({ nullifier: hexOf(n.nullifier), value: BigInt(n.value) }))
    .filter((n) => HEX.test(n.nullifier));
  /** @type {Map<number, ValuedNote[]>} */
  const byHeight = new Map();

  for (const note of notes) {
    const { height } = leafInfo(note.leaf);
    const list = byHeight.get(height) ?? [];

    list.push(note);
    byHeight.set(height, list);
  }

  /**
   * @param {string} hash
   * @param {number} height
   */
  const tallyOf = (hash, height) => {
    const known = txs.get(hash);

    if (known) return known;

    /** @type {Tally} */
    const tally = { conversion: null, hash, height, made: 0n, spent: 0n, topics: new Set() };

    txs.set(hash, tally);

    return tally;
  };

  for (const [height, own] of byHeight) {
    const block = blocks.get(height);
    const events = (Array.isArray(block?.events) ? block.events : []).filter(
      (/** @type {any} */ e) => e && !e.reverted && typeof e.data === "string" && HASH.test(String(e.origin ?? "").toLowerCase())
    );
    /** @type {MadeNote[]} */
    const made = own.map((n) => ({
      matched: false,
      part: hex(n.leaf.subarray(RECEIVER_START, RECEIVER_END)),
      tail: hex(n.leaf.subarray(RECEIVER_START, ADDRESS_END)) + hex(n.leaf.subarray(VALUE_START, VALUE_END)),
      value: BigInt(n.value),
      whole: hex(n.leaf.subarray(0, NOTE_BYTES)),
    }));
    /** @type {{ tally: Tally, data: string }[]} */
    const makers = [];

    for (const event of /** @type {any[]} */ (events)) {
      const source = String(event.source ?? event.target ?? "").toLowerCase();
      const hash = String(event.origin).toLowerCase();

      if (source === STAKE_CONTRACT) tallyOf(hash, height).topics.add(`stake:${event.topic}`);
      else if (source === TRANSFER_CONTRACT) addTransferEvent(tallyOf(hash, height), event, made, spent, makers);
    }

    matchMakers(makers, made);

    if (height > 0) unnamed += made.filter((n) => !n.matched).length;
  }

  return { tallies: [...txs.values()].filter((t) => t.spent || t.made), unnamed };
}

/**
 * @param {ReadonlyArray<Tally>} tallies
 * @param {ReadonlyMap<number, ShieldedBlock>} blocks
 * @returns {ShieldedEntry[]}
 */
const entriesOf = (tallies, blocks) =>
  tallies.map((t) => entryOf(t, blocks.get(t.height))).sort((a, b) => b.blockHeight - a.blockHeight || (a.hash < b.hash ? -1 : 1));

/**
 * @param {{ notes: ReadonlyArray<ValuedNote>, blocks: ReadonlyMap<number, ShieldedBlock> }} input
 * @returns {ShieldedEntry[]}
 */
export function shieldedEntries({ notes, blocks }) {
  return entriesOf(tallyNotes(notes, blocks).tallies, blocks);
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

/**
 * The notes a history was worked out from: their positions, and which were
 * spent. The same notes need no new lookups.
 *
 * @param {ReadonlyArray<OwnedNote>} notes
 */
const fingerprintOf = (notes) =>
  notes
    .map((n) => `${leafInfo(n.leaf).pos}${n.spent ? "s" : ""}`)
    .sort()
    .join(",");

/**
 * A kept history, as far as it reads as one; null for none.
 *
 * @param {unknown} kept
 * @returns {ShieldedRecord | null}
 */
function recordOf(kept) {
  if (!kept || typeof kept !== "object") return null;

  const { decoys, entries, fingerprint } = /** @type {any} */ (kept);

  return {
    decoys: Array.isArray(decoys) ? decoys.filter(isHeight) : [],
    entries: Array.isArray(entries) ? entries : [],
    fingerprint: typeof fingerprint === "string" ? fingerprint : "",
  };
}

/**
 * The kept history; null for none. A store that can't be read rejects:
 * taking it for none would draw new decoys for the same notes, and a node
 * could compare the two sets.
 *
 * @param {ShieldedStore} store
 * @returns {Promise<ShieldedRecord | null>}
 */
const keptRecord = async (store) => recordOf(await store.get());

/**
 * `decoys`, with those of `more` it lacks after them: kept decoys only grow.
 *
 * @param {ReadonlyArray<number>} decoys
 * @param {ReadonlyArray<number>} more
 */
const grown = (decoys, more) => [...decoys, ...more.filter((h) => !decoys.includes(h))];

/**
 * @param {ShieldedHistoryOptions} options
 * @returns {Promise<ShieldedHistory>}
 */
export async function shieldedHistory({ archive, notes, valueOf, tree, store, treeHeights, synced = false, isCurrent = () => true, random }) {
  if (!archive || typeof archive.query !== "function" || typeof archive.assertArchive !== "function") {
    throw new TypeError("An archive is required");
  }
  if (typeof notes !== "function" || typeof valueOf !== "function") throw new TypeError("The notes and their values are required");
  if (typeof tree?.size !== "function" || typeof tree?.leaves !== "function") throw new TypeError("The note tree is required");
  if (typeof store?.get !== "function" || typeof store?.put !== "function") throw new TypeError("A store is required");
  if (typeof treeHeights?.get !== "function" || typeof treeHeights?.put !== "function") {
    throw new TypeError("A store for the note tree's heights is required");
  }

  // Asked after each step: once the wallet, profile or node changed, the
  // read keeps nothing more and asks nothing more.
  const current = guardOf(isCurrent);
  const owned = Array.from(await notes());

  current();

  if (!owned.length) return { entries: [], pending: !synced };

  const fingerprint = fingerprintOf(owned);
  const kept = await keptRecord(store);

  current();

  if (kept && kept.fingerprint === fingerprint) return { entries: kept.entries, pending: !synced };

  // Notes still being found aren't the history yet: what is kept shows,
  // pending, and is worked out again once they are all found.
  const unfinished = { entries: kept?.entries ?? [], pending: true };

  if (!synced) return unfinished;

  // A node without the archive reads no note tree either.
  await archive.assertArchive();

  /** @type {ValuedNote[]} */
  const valued = [];

  for (const note of owned) {
    valued.push({ leaf: note.leaf, nullifier: hexOf(note.nullifier), spent: Boolean(note.spent), value: BigInt(await valueOf(note)) });
    current();
  }

  const pool = await noteTreeHeights(tree, treeHeights, { isCurrent });

  current();

  const real = [...new Set(valued.map((n) => leafInfo(n.leaf).height))];
  const inTree = new Set(pool ?? []);

  // Not for a height the tree as read doesn't have: no decoy could be one.
  if (!pool || real.some((h) => !inTree.has(h))) return unfinished;

  let { decoys, heights } = pickHeights(pool, real, { keep: kept?.decoys ?? [], random });

  // Without another height to ask among, asking would name the profile's own.
  if (!decoys.length) return unfinished;

  // The decoys are kept before any block is asked for, beside what was kept
  // before: a read that fails partway asks among the same ones next time,
  // so no two requests differ in their decoys alone. They are read back:
  // nothing is asked unless they are kept. A store with `update` draws and
  // keeps them in one transaction, from the decoys kept then: two reads at
  // once ask among the same ones, the first kept.
  if (!sameHeights(decoys, kept?.decoys ?? [])) {
    /** @type {ShieldedRecord | null} */
    let drawn = null;

    if (typeof store.update === "function") {
      const back = recordOf(
        await store.update((now) => {
          const record = recordOf(now);
          const more = pickHeights(pool, real, { keep: record?.decoys ?? [], random }).decoys;

          return (drawn = { decoys: more, entries: record?.entries ?? [], fingerprint: record?.fingerprint ?? "" });
        })
      ) ?? (await keptRecord(store));

      if (!back || !drawn || !sameHeights(back.decoys, /** @type {ShieldedRecord} */ (drawn).decoys)) {
        throw new Error("The decoys weren't kept, so no block was asked for");
      }

      decoys = back.decoys;
      heights = shuffled([...real, ...decoys], random ?? cryptoRandom);
    } else {
      await store.put({ decoys, entries: kept?.entries ?? [], fingerprint: kept?.fingerprint ?? "" });

      const back = await keptRecord(store);

      if (!back || !sameHeights(back.decoys, decoys)) throw new Error("The decoys weren't kept, so no block was asked for");
    }

    current();
  }

  const blocks = await fetchShieldedBlocks(archive, heights, { isCurrent });

  current();

  // Kept only whole: once each note's block has the event that made it, and
  // lists each transaction that spent the profile's notes, its fee. An
  // archive still indexing a block isn't there yet: what is kept shows,
  // pending, and the next read asks again, among the same decoys.
  const { tallies, unnamed } = tallyNotes(valued, blocks);

  if (unnamed || tallies.some((t) => t.spent > 0n && !blocks.get(t.height)?.txs.has(t.hash))) return unfinished;

  const entries = entriesOf(tallies, blocks);

  // Kept over the decoys kept now, which only grow.
  if (typeof store.update === "function") {
    await store.update((now) => ({ decoys: grown(recordOf(now)?.decoys ?? [], decoys), entries, fingerprint }));
  } else {
    await store.put({ decoys, entries, fingerprint });
  }

  // A wallet that changed while its history was kept gets none of it.
  current();

  return { entries, pending: false };
}
