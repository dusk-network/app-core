import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoArchiveError, createArchive } from "../src/history.js";
import { LEAF_BYTES, createLeafHeightTap, shieldedHistory } from "../src/shielded.js";
import { StaleError } from "./fixtures/helpers.js";
import {
  DUSK,
  FIRST,
  GROWN,
  L492,
  L493,
  L494,
  L495,
  MADE_LEAF_0,
  MADE_LEAF_1,
  NODE,
  SHIELD,
  UNSHIELD,
  blocksNode,
  bytes,
  leafAt,
  memoryStores,
  noteTree,
  phoenix,
  receivedNotes,
  sentNotes,
  treeLeaves,
  valueOf,
} from "./fixtures/shielded.js";

const CHANGED = "The wallet changed while its shielded history was read";

/**
 * A wallet's shielded history on a node: the node's archive and note tree
 * (`leaves`), the stores in memory, and the profile's notes. `read(extra)`
 * reads the history with the options changed by `extra`.
 *
 * @param {{ leaves?: Uint8Array[], notes?: () => any[] }} [options]
 */
function wallet({ leaves = treeLeaves(), notes = receivedNotes } = {}) {
  const node = blocksNode();
  const tree = noteTree(leaves);
  const stores = memoryStores();
  /** @type {any[]} */
  const valued = [];
  const options = {
    archive: node.client,
    isCurrent: () => true,
    notes,
    store: stores.store,
    synced: true,
    tree: tree.tree,
    treeHeights: stores.treeHeights,
    /** @param {any} note */
    valueOf: (note) => {
      valued.push(note);

      return valueOf(note);
    },
  };

  return {
    ...stores,
    node,
    options,
    tree,
    valued,
    /** @param {Partial<import("../src/shielded.js").ShieldedHistoryOptions>} [extra] */
    read: (extra = {}) => shieldedHistory({ ...options, ...extra }),
  };
}

/**
 * The tree's first six leaves, kept as a shielded sync from the first note
 * keeps them, through a tap on its stream.
 */
async function tapped() {
  const tap = createLeafHeightTap();
  const all = Uint8Array.from(FIRST.flatMap((leaf) => [...leaf]));
  const reader = new Response(all).body?.pipeThrough(tap.stream()).getReader();

  while (reader && !(await reader.read()).done);

  return { heights: /** @type {number[]} */ (tap.heights(6)), notes: 6 };
}

/** A sequence of 32-bit numbers, for decoys drawn the same way twice. */
const seq = (n = 7) => () => (n = (n * 1_103_515_245 + 12_345) % 2 ** 32);

describe("a profile's shielded history", () => {
  it("is worked out from its notes once they're all found, their blocks asked for among the tree's other heights, and kept", async () => {
    const w = wallet();
    const first = await w.read();

    assert.equal(first.pending, false);
    assert.deepEqual(
      first.entries.map((e) => [e.blockHeight, e.hash, e.direction, e.value, e.fee]),
      [
        [3861643, SHIELD, "in", String(2n * DUSK), null],
        // The unshield's outputs: received, as the profile spent nothing.
        [3602438, UNSHIELD, "in", "1012000000", null],
      ]
    );
    // Each as its conversion went: the unshield to a public account, whoever's notes it made.
    assert.deepEqual(first.entries.map((e) => e.kind), ["shield", "unshield"]);

    // The note tree was read once, from the first note.
    assert.equal(w.tree.sizes, 1);
    assert.deepEqual(w.tree.reads, [0n]);
    assert.deepEqual(w.kept.heights.notes, 496);

    // The notes' two heights, each among the tree's other heights, in one request.
    const [asked] = w.node.heights();

    assert.equal(w.node.queries.length, 1);
    assert.ok(asked.includes(3602438) && asked.includes(3861643));
    assert.ok(asked.length > 2);
    assert.ok(asked.every((h) => [184423, 226951, 234329, 234369, GROWN, 3577762, 3602438, 3861643].includes(h)));
    assert.deepEqual(w.kept.record.decoys.sort(), asked.filter((h) => h !== 3602438 && h !== 3861643).sort());

    // The same notes again: the kept history, without asking anything.
    assert.deepEqual(await w.read(), first);
    assert.equal(w.node.queries.length, 1);
    assert.equal(w.tree.sizes, 1);
  });

  it("is what the profile's spent notes sent, among all the tree's heights there are, the leaves read since the sync kept its own", async () => {
    // The tree as the shielded sync scanned it from the first note, then grown.
    const w = wallet({ notes: sentNotes });

    w.kept.heights = await tapped();

    const first = await w.read();

    assert.deepEqual(
      first.entries.map((e) => [e.blockHeight, e.kind, e.direction, e.value, e.fee]),
      [
        [3861643, "shield", "in", "2000000000", null],
        [3602438, "unshield", "out", String(10_500_000_000n - 1_012_000_000n - 12_429_102n), "12429102"],
        // The notes it spent, as it received them: from an unshield's outputs, and a shield.
        [226951, "unshield", "in", String(DUSK / 2n), null],
        [184423, "shield", "in", String(10n * DUSK), null],
      ]
    );
    assert.deepEqual(first.entries.slice(2).map((e) => e.hash), [MADE_LEAF_1, MADE_LEAF_0]);
    // All in one request: leaf 492 (3577762) and the made-up ones are among
    // them, the tree as it grew.
    assert.equal(w.node.queries.length, 1);
    assert.deepEqual(
      w.node.heights()[0].sort((a, b) => a - b),
      [184423, 226951, 234329, 234369, GROWN, 3577762, 3602438, 3861643]
    );
    // Only the leaves added since the sync's were read.
    assert.deepEqual(w.tree.reads, [6n]);
    assert.equal(w.kept.heights.notes, 496);

    // Kept: asking again asks the node nothing.
    assert.deepEqual(await w.read(), first);
    assert.equal(w.node.queries.length, 1);
  });

  it("asks nothing for a note at a height the tree as read doesn't have, and reads only the leaves added since once it grew", async () => {
    // Six leaves: the notes' heights aren't among the tree's, so no decoy
    // could be one, and nothing is asked.
    const w = wallet({ leaves: FIRST });

    assert.deepEqual(await w.read(), { entries: [], pending: true });
    assert.deepEqual(w.node.queries, []);

    // The tree grew: its heights are extended with the leaves added since.
    w.tree.leaves = treeLeaves();

    const grown = await w.read();

    assert.equal(grown.entries.length, 2);
    assert.equal(w.node.queries.length, 1);
    assert.deepEqual(w.tree.reads, [0n, 6n]);
    assert.equal(w.kept.heights.notes, 496);
  });

  it("works nothing out before the shielded sync has found every note", async () => {
    const w = wallet();

    assert.deepEqual(await w.read({ synced: false }), { entries: [], pending: true });
    assert.deepEqual(w.tree.reads, []);
    assert.equal(w.tree.sizes, 0);
    assert.deepEqual(w.valued, []);
    assert.deepEqual(w.node.queries, []);
  });

  it("gives what is kept as pending while the notes are found, and nothing for a profile without notes", async () => {
    const w = wallet();
    const { entries } = await w.read();

    // The same notes, kept: while a sync runs, more can come.
    assert.deepEqual(await w.read({ synced: false }), { entries, pending: true });

    // Other notes, while they're found: what is kept, pending.
    assert.deepEqual(await w.read({ notes: () => receivedNotes().slice(1), synced: false }), { entries, pending: true });

    // No notes yet.
    assert.deepEqual(await w.read({ notes: () => [], synced: false }), { entries: [], pending: true });
    assert.deepEqual(await w.read({ notes: () => [] }), { entries: [], pending: false });
    assert.equal(w.node.queries.length, 1);
  });

  it("asks nothing while the tree has no height but the profile's own", async () => {
    // Leaves 0 to 492 made up at the unshield's height: the tree's heights are the notes'.
    const atUnshield = Array.from({ length: 493 }, (_, i) => leafAt(FIRST[5], i, 3_602_438));
    const w = wallet({ leaves: [...atUnshield, L493, L494, L495] });

    assert.deepEqual(await w.read(), { entries: [], pending: true });
    assert.deepEqual(w.node.queries, []);

    // The profile owns every leaf of the six-note tree.
    const own = wallet({ leaves: FIRST, notes: () => FIRST.map((leaf, i) => ({ leaf, nullifier: bytes(String(i + 1).padStart(2, "0").repeat(32)), spent: false })) });

    assert.deepEqual(await own.read({ valueOf: () => 1n }), { entries: [], pending: true });
    assert.deepEqual(own.node.queries, []);
  });

  it("keeps nothing of a read the wallet changed under, and asks nothing more", async () => {
    // While the tree was read.
    let current = true;
    const early = wallet();

    early.tree.tree.size = async () => {
      current = false;

      return 496n;
    };
    await assert.rejects(early.read({ isCurrent: () => current }), { message: CHANGED });
    assert.equal(early.kept.record, null);
    assert.deepEqual(early.node.queries, []);

    // While its blocks were asked for: a lock, another profile, another node, a replaced chain.
    const late = wallet({ notes: sentNotes });
    let still = true;

    late.node.before = () => {
      still = false;
    };
    await assert.rejects(late.read({ isCurrent: () => still }), { message: CHANGED });
    // Nothing it read is kept: only the decoys it was to ask among, kept
    // before it asked, for next time.
    assert.deepEqual(late.kept.record.entries, []);
    assert.ok(late.kept.record.decoys.length > 0);
  });

  it("keeps nothing of a read whose store refuses its history, as one reset since", async () => {
    const w = wallet({ notes: sentNotes });
    const { put } = w.store;

    w.store.put = async (record) => {
      if (record.entries.length) throw new StaleError();

      return put(record);
    };
    await assert.rejects(w.read(), StaleError);
    assert.deepEqual(w.kept.record.entries, []);
  });

  it("reads nothing more of a node without the archive, for an hour: neither the tree nor the notes' values", async () => {
    const w = wallet();
    /** @type {Map<string, number>} */
    const refusals = new Map();
    const archive = createArchive({ fetch: w.node.fetch, refusals: { get: (url) => refusals.get(url) ?? null, put: (url, at) => void refusals.set(url, at) }, url: NODE });

    w.node.archive = false;
    await assert.rejects(w.read({ archive }), NoArchiveError);
    assert.equal(w.node.queries.length, 1);

    const sizes = w.tree.sizes;
    const valued = w.valued.length;

    await assert.rejects(w.read({ archive }), NoArchiveError);
    assert.equal(w.node.queries.length, 1);
    assert.equal(w.tree.sizes, sizes);
    assert.equal(w.valued.length, valued);
  });

  it("goes on when the tree's heights can't be kept, and reads the tree again next time", async () => {
    const w = wallet();

    w.treeHeights.put = async () => {
      throw new Error("The store is full");
    };
    assert.equal((await w.read()).entries.length, 2);
    assert.deepEqual(w.tree.reads, [0n]);

    await w.read({ notes: () => receivedNotes().slice(1) });
    assert.deepEqual(w.tree.reads, [0n, 0n]);
  });

  it("needs its archive, notes, values, tree and stores", async () => {
    const { options } = wallet();

    for (const missing of ["archive", "notes", "valueOf", "tree", "store", "treeHeights"]) {
      await assert.rejects(shieldedHistory({ ...options, [missing]: undefined }), TypeError, missing);
    }
  });
});

// The decoys are kept, and read back, before any block is asked for: a read
// that stops anywhere asks among the same heights next time, and one whose
// store can't keep them asks nothing.
describe("the decoys of a shielded history", () => {
  // The sending profile's notes are at four heights: 16 decoys among them.
  const OWN = [184423, 226951, 3602438, 3861643];
  const decoysOf = (/** @type {number[][]} */ asked) => new Set(asked.flat().filter((h) => !OWN.includes(h)));

  it("are asked among again after a block request failed", async () => {
    // Hundreds of heights to draw decoys from: two draws all but never match.
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });
    let fail = true;

    w.node.before = () => {
      if (!fail) return;
      fail = false;
      throw new TypeError("fetch failed");
    };
    await assert.rejects(w.read({ random: seq(1) }), { message: "fetch failed" });

    const first = decoysOf(w.node.heights());

    assert.ok(first.size > 0);
    w.node.queries.length = 0;
    await w.read({ random: seq(2) });

    const again = decoysOf(w.node.heights());

    // Everything asked the first time is asked again: the same decoys.
    assert.deepEqual([...first].filter((h) => !again.has(h)), []);
    assert.equal(again.size, 16);
  });

  it("are asked among again after the history couldn't be kept", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });
    const { put } = w.store;

    // The decoys are kept; the history after the lookups isn't, and the
    // store passes over it, as the wallets' stores do when full.
    w.store.put = async (record) => {
      if (!record.entries.length) await put(record);
    };

    const first = await w.read({ random: seq(1) });

    assert.equal(first.entries.length, 4);

    const asked = decoysOf(w.node.heights());

    assert.equal(asked.size, 16);
    w.node.queries.length = 0;
    await w.read({ random: seq(2) });
    assert.deepEqual(decoysOf(w.node.heights()), asked);
  });

  it("are never drawn again while the kept ones can't be read: nothing is asked then", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });
    let fail = true;

    // Decoys kept, then a block request fails: the history isn't kept yet.
    w.node.before = () => {
      if (!fail) return;
      fail = false;
      throw new TypeError("fetch failed");
    };
    await assert.rejects(w.read({ random: seq(1) }), { message: "fetch failed" });

    const first = decoysOf(w.node.heights());
    const get = w.store.get;

    // One read of the store fails: no new decoys, and no block asked for.
    w.store.get = async () => {
      throw new Error("The store can't be read");
    };
    w.node.queries.length = 0;
    await assert.rejects(w.read({ random: seq(2) }), { message: "The store can't be read" });
    assert.deepEqual(w.node.queries, []);

    // Readable again: the same decoys.
    w.store.get = get;
    await w.read({ random: seq(3) });
    assert.deepEqual([...first].filter((h) => !decoysOf(w.node.heights()).has(h)), []);
  });

  it("are kept before any block is asked for, or nothing is asked", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });

    w.store.put = async () => {
      throw new Error("The store is full");
    };
    await assert.rejects(w.read(), { message: "The store is full" });
    assert.deepEqual(w.node.queries, []);
  });

  it("are read back before any block is asked for: a store that drops them asks nothing", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });

    // A store that says it kept what it didn't.
    w.store.put = async () => {};
    await assert.rejects(w.read(), { message: "The decoys weren't kept, so no block was asked for" });
    assert.deepEqual(w.node.queries, []);
  });

  it("are the same for two reads at once, drawn and kept in one transaction by a store that can", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });
    // Two pages of one profile over one record, as IndexedDB keeps it: each
    // reads it before either keeps decoys, and the second writes only once
    // the first asked for its blocks.
    const kept = { record: /** @type {any} */ (null), reads: 0 };
    const bothRead = Promise.withResolvers();
    const firstAsked = Promise.withResolvers();
    /** @param {boolean} second @returns {import("../src/shielded.js").ShieldedStore} */
    const page = (second) => ({
      get: async () => {
        if ((kept.reads += 1) === 2) bothRead.resolve(undefined);
        await bothRead.promise;

        return structuredClone(kept.record);
      },
      put: async (record) => {
        if (second) await firstAsked.promise;
        kept.record = structuredClone(record);
      },
      update: async (change) => {
        if (second) await firstAsked.promise;
        kept.record = structuredClone(change(structuredClone(kept.record)));

        return structuredClone(kept.record);
      },
    });

    w.node.before = () => firstAsked.resolve(undefined);

    const [one, two] = await Promise.all([w.read({ random: seq(1), store: page(false) }), w.read({ random: seq(2), store: page(true) })]);

    // Both asked among the 16 decoys kept, and nothing else.
    assert.deepEqual(decoysOf(w.node.heights()), new Set(kept.record.decoys));
    assert.equal(kept.record.decoys.length, 16);
    assert.deepEqual([one.pending, two.pending, two.entries], [false, false, one.entries]);
  });

  it("are kept beside the history kept before, which still shows while the new one is worked out", async () => {
    const w = wallet({ leaves: treeLeaves({ distinct: true }) });
    // Drawn from fixed sequences, so the count below doesn't depend on chance.
    const first = await w.read({ random: seq(1) });
    const before = structuredClone(w.kept.record);

    // A note at another height: more decoys, kept with the old history
    // until the new one is.
    /** @type {any} */
    let held = null;

    w.node.before = () => {
      held ??= structuredClone(w.kept.record);
    };
    await w.read({ notes: () => [...receivedNotes(), { leaf: L492, nullifier: new Uint8Array(32).fill(9), spent: false }], random: seq(2) });
    assert.deepEqual({ entries: held.entries, fingerprint: held.fingerprint }, { entries: first.entries, fingerprint: before.fingerprint });
    assert.equal(held.decoys.length, 12);
    assert.deepEqual(before.decoys.filter((/** @type {number} */ h) => !held.decoys.includes(h)), []);
    assert.deepEqual(w.kept.record.decoys, held.decoys);
  });
});

// Whether the wallet is still the same is asked after every step: reading
// the notes and the kept history, and keeping the decoys, as well as the
// notes' values, the tree and the blocks.
describe("a shielded history the wallet changed under", () => {
  it("gives nothing, kept or not, once the wallet changed while the notes or the kept history were read", async () => {
    const w = wallet();

    await w.read();

    let current = true;
    const { get } = w.store;

    w.store.get = async () => {
      current = false;

      return get();
    };
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });

    current = true;
    await assert.rejects(
      w.read({
        isCurrent: () => current,
        notes: () => {
          current = false;

          return [];
        },
      }),
      { message: CHANGED }
    );
  });

  it("asks for no block once the wallet changed while the decoys were kept", async () => {
    const w = wallet({ notes: sentNotes });
    let current = true;
    const { put } = w.store;

    w.store.put = async (record) => {
      current = false;

      return put(record);
    };
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });
    assert.deepEqual(w.node.queries, []);
  });

  it("works out no more of the notes' values once the wallet changed during one", async () => {
    const w = wallet();
    let current = true;

    await assert.rejects(
      w.read({
        isCurrent: () => current,
        valueOf: (note) => {
          w.valued.push(note);
          current = false;

          return valueOf(note);
        },
      }),
      { message: CHANGED }
    );
    assert.equal(w.valued.length, 1);
  });

  it("reads none of the tree's leaves and keeps none of its heights once the wallet changed while its size was asked", async () => {
    const w = wallet();
    let current = true;
    const { size } = w.tree.tree;

    w.tree.tree.size = async () => {
      current = false;

      return size();
    };
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });
    assert.deepEqual(w.tree.reads, []);
    assert.equal(w.kept.heights, null);
  });

  it("stops reading the tree's leaves, and keeps none of its heights, once the wallet changed while they came", async () => {
    const leaves = treeLeaves();
    const all = Uint8Array.from(leaves.flatMap((leaf) => [...leaf]));
    const w = wallet({ leaves });
    let current = true;
    let pulled = 0;
    let cancelled = false;

    w.tree.tree.leaves = async () =>
      new ReadableStream({
        pull(controller) {
          const at = pulled * LEAF_BYTES;

          pulled += 1;
          if (at >= all.length) controller.close();
          else controller.enqueue(all.slice(at, at + LEAF_BYTES));
          // The wallet changes as the first leaf comes.
          current = false;
        },
        cancel() {
          cancelled = true;
        },
      });
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(cancelled);
    assert.ok(pulled < leaves.length / 10, `${pulled} leaves read`);
    assert.equal(w.kept.heights, null);
  });

  it("asks for no more blocks once the wallet changed during a blocks request", async () => {
    // Four heights of the profile's among 16 decoys: two requests.
    const w = wallet({ leaves: treeLeaves({ distinct: true }), notes: sentNotes });
    let current = true;

    w.node.before = () => {
      current = false;
    };
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });
    assert.equal(w.node.queries.length, 1);
  });

  it("gives nothing once the wallet changed while its history was kept", async () => {
    const w = wallet();
    let current = true;
    const { put } = w.store;

    w.store.put = async (record) => {
      if (record.entries.length) current = false;

      return put(record);
    };
    await assert.rejects(w.read({ isCurrent: () => current }), { message: CHANGED });
  });
});

// A note's height holds the transaction that made it: until the archive has
// that event, and the block lists each transaction that spent the profile's
// notes, the history isn't whole, and isn't kept as the notes' history.
describe("a shielded history whose blocks the archive doesn't all have yet", () => {
  it("is pending, its decoys kept, until the archive has the events that made each note, and kept once it has", async () => {
    for (const unindexed of [null, { json: [] }]) {
      const w = wallet({ notes: sentNotes });

      // The shield's block, as an archive still indexing it answers.
      w.node.blocks.e3861643 = unindexed;
      assert.deepEqual(await w.read(), { entries: [], pending: true });
      assert.deepEqual({ entries: w.kept.record.entries, fingerprint: w.kept.record.fingerprint }, { entries: [], fingerprint: "" });

      const asked = new Set(w.node.heights().flat());

      // The archive has it now: the same heights again, and the history kept.
      w.node.blocks.e3861643 = structuredClone(phoenix.blocks.e3861643);
      w.node.queries.length = 0;

      const whole = await w.read();

      assert.equal(whole.pending, false);
      assert.equal(whole.entries.length, 4);
      assert.deepEqual(new Set(w.node.heights().flat()), asked);

      w.node.queries.length = 0;
      assert.deepEqual(await w.read(), whole);
      assert.equal(w.node.queries.length, 0);
    }
  });

  it("shows what was kept, pending, while a note's block holds no event that made it", async () => {
    const w = wallet();
    const first = await w.read();
    const kept = structuredClone(w.kept.record);

    // A new note at 3577762, whose block has events, none of them the one that made it.
    w.node.blocks.e3577762 = { json: w.node.blocks.e3602438.json.filter((/** @type {any} */ e) => e.topic === "reward") };
    assert.deepEqual(await w.read({ notes: () => [...receivedNotes(), { leaf: L492, nullifier: new Uint8Array(32).fill(9), spent: false }] }), {
      entries: first.entries,
      pending: true,
    });
    assert.deepEqual({ entries: w.kept.record.entries, fingerprint: w.kept.record.fingerprint }, { entries: kept.entries, fingerprint: kept.fingerprint });
  });

  it("is pending while a transaction that spent the profile's notes isn't listed in its block, its fee unknown", async () => {
    const w = wallet({ notes: sentNotes });

    w.node.blocks.b3602438 = { ...w.node.blocks.b3602438, transactions: [] };
    assert.deepEqual(await w.read(), { entries: [], pending: true });
    assert.equal(w.kept.record.fingerprint, "");
  });

  it("needs no event for a note the genesis block holds: no transaction made it", async () => {
    const genesis = leafAt(FIRST[0], 0, 0);
    const w = wallet({ leaves: [genesis, ...treeLeaves().slice(1)], notes: () => [{ leaf: genesis, nullifier: new Uint8Array(32).fill(7), spent: false }, ...receivedNotes()] });
    const read = await w.read();

    assert.equal(read.pending, false);
    assert.deepEqual(read.entries.map((e) => e.hash), [SHIELD, UNSHIELD]);
  });
});

describe("the note tree's heights kept by a shielded sync", () => {
  it("spare the history its own read of the tree", async () => {
    const leaves = treeLeaves();
    const tap = createLeafHeightTap();
    const all = new Uint8Array(leaves.length * LEAF_BYTES);

    leaves.forEach((leaf, i) => all.set(leaf, i * LEAF_BYTES));

    const reader = new Response(all).body?.pipeThrough(tap.stream()).getReader();

    while (reader && !(await reader.read()).done);

    const w = wallet({ leaves });

    w.kept.heights = { heights: tap.heights(leaves.length), notes: leaves.length };
    assert.equal((await w.read()).entries.length, 2);
    assert.deepEqual(w.tree.reads, []);
  });
});
