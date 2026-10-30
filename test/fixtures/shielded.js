// Test helpers for the shielded history: Testnet's recorded note tree and
// blocks (phoenix-testnet.json), a note tree that streams its leaves the way
// the node does, an archive node answering the blocks query from the
// recording, and stores that keep what the wallets keep, in memory.

import { createArchive } from "../../src/history.js";
import { LEAF_BYTES, LEAF_HEIGHT_OFFSET, LEAF_POS_OFFSET, leafInfo } from "../../src/shielded.js";
import { readFixture } from "./helpers.js";

export const phoenix = readFixture("phoenix-testnet.json");
export const NODE = "https://testnet.nodes.dusk.network";
export const DUSK = 1_000_000_000n;

/** @param {string} hex */
export const bytes = (hex) => Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));

/** @param {string} hex */
const leavesOf = (hex) => {
  const all = bytes(hex);

  return Array.from({ length: all.length / LEAF_BYTES }, (_, i) => all.slice(i * LEAF_BYTES, (i + 1) * LEAF_BYTES));
};

// The note tree's first six leaves, and leaves 492 to 495: the unshield at
// 3602438 made 493 and 494, the shield at 3861643 made 495.
export const FIRST = leavesOf(phoenix.firstLeaves);
export const [L492, L493, L494, L495] = leavesOf(phoenix.leaves492);

/**
 * A copy of `leaf` at another position and height, as a made-up leaf of the tree.
 *
 * @param {Uint8Array} leaf
 * @param {number} pos
 * @param {number} height
 */
export function leafAt(leaf, pos, height) {
  const out = leaf.slice();
  const view = new DataView(out.buffer);

  view.setBigUint64(LEAF_POS_OFFSET, BigInt(pos), true);
  view.setBigUint64(LEAF_HEIGHT_OFFSET, BigInt(height), true);

  return out;
}

/** The height between the first leaves and the recorded ones that leaves 6 to 491 are made up at. */
export const GROWN = 300_000;

/**
 * The tree up to leaf 495: its first six leaves, leaves 6 to 491 made up,
 * all at GROWN or, `distinct`, each at a height of its own (hundreds of
 * heights to draw decoys from), and the recorded 492 to 495.
 *
 * @param {{ distinct?: boolean }} [options]
 */
export function treeLeaves({ distinct = false } = {}) {
  const made = Array.from({ length: 486 }, (_, i) => leafAt(FIRST[5], 6 + i, distinct ? GROWN + 6 + i : GROWN));

  return [...FIRST, ...made, L492, L493, L494, L495];
}

// The unshield at 3602438 spent two notes: its phoenix event starts with their nullifiers.
const unshieldEvent = phoenix.blocks.e3602438.json.find((/** @type {any} */ e) => e.topic === "phoenix");

export const NULLIFIERS = [unshieldEvent.data.slice(0, 64), unshieldEvent.data.slice(64, 128)];
export const UNSHIELD = "3b0c1b4bcc517e91bf63525f232689452b6b51e46ccb1a5be4f8a0af73ddac11";
export const SHIELD = phoenix.blocks.e3861643.json.find((/** @type {any} */ e) => e.topic === "convert").origin;
// The transactions that made the tree's first leaves: a shield made leaf 0,
// and a phoenix transaction leaves 1 and 2.
export const MADE_LEAF_0 = phoenix.blocks.e184423.json.find((/** @type {any} */ e) => e.topic === "convert").origin;
export const MADE_LEAF_1 = phoenix.blocks.e226951.json.find((/** @type {any} */ e) => e.topic === "phoenix").origin;

/**
 * The recorded blocks at `heights` (the unshield's and the shield's by
 * default) as fetchShieldedBlocks gives them.
 *
 * @param {number[]} [heights]
 */
export function recordedBlocks(heights = [3602438, 3861643]) {
  /** @type {Record<string, any>} */
  const data = structuredClone(phoenix.blocks);

  return new Map(
    heights.map((h) => [
      h,
      {
        events: data[`e${h}`].json,
        timestamp: data[`b${h}`].header.timestamp * 1000,
        txs: new Map(data[`b${h}`].transactions.map((/** @type {any} */ tx) => [tx.id, tx])),
      },
    ])
  );
}

/** The values the profile's keys give its notes, by their positions. */
export const VALUES = Object.freeze({ 0: 10n * DUSK, 1: DUSK / 2n, 492: 3n * DUSK, 493: DUSK, 494: 12_000_000n, 495: 2n * DUSK });

/** @param {{ leaf: Uint8Array }} note */
export const valueOf = (note) => VALUES[/** @type {keyof typeof VALUES} */ (Number(leafInfo(note.leaf).pos))];

/**
 * A profile that received the unshield's outputs and the shield's note,
 * with nullifiers of its own.
 */
export const receivedNotes = () => [L493, L494, L495].map((leaf, i) => ({ leaf, nullifier: new Uint8Array(32).fill(i + 1), spent: false }));

/**
 * The profile that made the unshield: the two notes it spent (the tree's
 * first two leaves, which it received first), its two outputs, and the
 * shield's note.
 */
export const sentNotes = () => [
  { leaf: FIRST[0], nullifier: bytes(NULLIFIERS[0]), spent: true },
  { leaf: FIRST[1], nullifier: bytes(NULLIFIERS[1]), spent: true },
  { leaf: L493, nullifier: bytes("aa".repeat(32)), spent: false },
  { leaf: L494, nullifier: bytes("bb".repeat(32)), spent: false },
  { leaf: L495, nullifier: bytes("cc".repeat(32)), spent: false },
];

/**
 * A node holding a note tree of `leaves`: `tree` streams them from the
 * position asked, as an answer whose body is the stream, in chunks that
 * don't line up with them. Change `leaves` as a test goes; `reads` keeps
 * each position asked, `sizes` counts the times its size was asked.
 *
 * @param {Uint8Array[]} leaves
 */
export function noteTree(leaves) {
  const node = {
    leaves,
    /** @type {bigint[]} */
    reads: [],
    sizes: 0,
  };
  /** @type {import("../../src/shielded.js").NoteTree} */
  const tree = {
    size: async () => {
      node.sizes += 1;

      return BigInt(node.leaves.length);
    },
    leaves: async (from) => {
      node.reads.push(from);

      const all = Uint8Array.from(node.leaves.slice(Number(from)).flatMap((leaf) => [...leaf]));

      return new Response(
        new ReadableStream({
          start(controller) {
            for (let at = 0; at < all.length; at += 1000) controller.enqueue(all.slice(at, at + 1000));
            controller.close();
          },
        })
      );
    },
  };

  return Object.assign(node, { tree });
}

/**
 * An archive node answering the blocks query from `blocks`, the recording's
 * by alias (`e<height>` the events, `b<height>` the block), which a test may
 * change, as to an archive that hasn't indexed a block yet; other heights
 * hold no events. `before` is awaited with each query before its answer,
 * and may throw, as a request that fails; `archive` false makes it a node
 * without the archive. `queries` keeps each query, and `heights()` the
 * heights each asked for.
 */
export function blocksNode() {
  const node = {
    archive: true,
    /** @type {((query: string) => Promise<void> | void) | null} */
    before: null,
    /** @type {Record<string, any>} */
    blocks: structuredClone(phoenix.blocks),
    /** @type {string[]} */
    queries: [],
    heights: () => node.queries.map((q) => [...q.matchAll(/b(\d+): block\(/g)].map(([, h]) => Number(h))),
    /**
     * @param {string} _url
     * @param {{ body: string }} init
     */
    fetch: async (_url, init) => {
      const query = String(init.body);

      node.queries.push(query);
      await node.before?.(query);

      if (!node.archive) {
        const errors = [{ message: 'Unknown field "contractEvents" on type "Query".' }];

        return { ok: true, status: 200, text: async () => JSON.stringify({ data: null, errors }) };
      }

      /** @type {Record<string, any>} */
      const data = {};
      /** @param {string} alias @param {any} none */
      const answer = (alias, none) => (Object.hasOwn(node.blocks, alias) ? node.blocks[alias] : none);

      for (const [, h] of query.matchAll(/b(\d+): block\(/g)) {
        data[`e${h}`] = answer(`e${h}`, { json: [] });
        data[`b${h}`] = answer(`b${h}`, { header: { timestamp: 1_780_000_000 }, transactions: [] });
      }

      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    },
  };

  return Object.assign(node, { client: createArchive({ fetch: node.fetch, url: NODE }) });
}

/**
 * The two stores a wallet keeps, in memory: one profile's shielded history
 * (`record`) and the tree's heights (`heights`), each as stored, read and
 * written as copies; `puts` keeps each record put.
 */
export function memoryStores() {
  const kept = {
    /** @type {any} */
    heights: null,
    /** @type {any[]} */
    puts: [],
    /** @type {any} */
    record: null,
  };

  return {
    kept,
    /** @type {import("../../src/shielded.js").ShieldedStore} */
    store: {
      get: async () => structuredClone(kept.record),
      put: async (record) => {
        kept.puts.push(structuredClone(record));
        kept.record = structuredClone(record);
      },
    },
    /** @type {import("../../src/shielded.js").TreeHeightsStore} */
    treeHeights: {
      get: async () => structuredClone(kept.heights),
      put: async (heights) => {
        kept.heights = structuredClone(heights);
      },
    },
  };
}
