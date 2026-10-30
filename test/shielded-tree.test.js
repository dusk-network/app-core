import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DECOYS_PER_HEIGHT, LEAF_BYTES, createLeafHeightTap, leafInfo, noteTreeHeights, pickHeights, readNoteHeights } from "../src/shielded.js";
import { FIRST, GROWN, L492, L493, L494, L495, memoryStores, noteTree, treeLeaves } from "./fixtures/shielded.js";

/**
 * The leaves as one stream, in chunks of `cut` bytes that don't line up with them.
 *
 * @param {Uint8Array[]} leaves
 * @param {number} [cut]
 */
function streamOf(leaves, cut = 1000) {
  const all = new Uint8Array(leaves.length * LEAF_BYTES);

  leaves.forEach((leaf, i) => all.set(leaf, i * LEAF_BYTES));

  return new ReadableStream({
    start(controller) {
      for (let at = 0; at < all.length; at += cut) controller.enqueue(all.slice(at, at + cut));
      controller.close();
    },
  });
}

/** @param {ReadableStream<Uint8Array>} readable */
async function drain(readable) {
  /** @type {number[]} */
  const parts = [];
  const reader = readable.getReader();

  for (let r = await reader.read(); !r.done; r = await reader.read()) parts.push(...r.value);

  return Uint8Array.from(parts);
}

describe("the note tree's leaves", () => {
  it("hold a note's position and the height it entered the tree at", () => {
    assert.deepEqual([L492, L493, L494, L495].map(leafInfo), [
      { height: 3577762, pos: 492n },
      { height: 3602438, pos: 493n },
      { height: 3602438, pos: 494n },
      { height: 3861643, pos: 495n },
    ]);
  });

  it("are tapped for their heights on the way, the stream passed on unchanged", async () => {
    const tap = createLeafHeightTap();
    const passed = await drain(streamOf(FIRST).pipeThrough(tap.stream()));

    assert.deepEqual(passed, Uint8Array.from(FIRST.flatMap((leaf) => [...leaf])));
    assert.deepEqual(tap.heights(6), [184423, 226951, 234329, 234369]);
    // Fewer leaves than the tree has: no heights.
    assert.equal(tap.heights(7), null);
  });

  it("give no heights from a stream that doesn't start at the tap's first position, or skips one", async () => {
    const late = createLeafHeightTap();

    await drain(streamOf([L492, L493]).pipeThrough(late.stream()));
    assert.equal(late.heights(2), null);

    const gap = createLeafHeightTap();
    const passed = await drain(streamOf([FIRST[0], FIRST[2]]).pipeThrough(gap.stream()));

    // Passed on all the same.
    assert.equal(passed.length, 2 * LEAF_BYTES);
    assert.equal(gap.heights(2), null);
  });

  it("are read in one stream, from the first or from where the kept ones end", async () => {
    const node = noteTree(FIRST);

    assert.deepEqual(await readNoteHeights(node.tree, 6n), [184423, 226951, 234329, 234369]);
    assert.deepEqual(node.reads, [0n]);

    node.leaves = treeLeaves();
    assert.deepEqual(await readNoteHeights(node.tree, 496n, { from: 492n }), [3577762, 3602438, 3861643]);
    assert.deepEqual(node.reads, [0n, 492n]);

    // A stream that doesn't start there gives nothing.
    const shifted = { leaves: async () => streamOf([L492, L493, L494, L495]) };

    assert.equal(await readNoteHeights(shifted, 497n, { from: 491n }), null);
  });

  it("read from a tree that sends no stream throws", async () => {
    await assert.rejects(readNoteHeights({ leaves: async () => new Response(null) }, 6n), { message: "The node sent no note tree" });
    await assert.rejects(readNoteHeights({ leaves: async () => null }, 6n), { message: "The node sent no note tree" });
  });
});

describe("the note tree's heights", () => {
  it("are read once, kept, and then taken as kept while the tree holds no more", async () => {
    const node = noteTree(FIRST);
    const { kept, treeHeights } = memoryStores();

    assert.deepEqual(await noteTreeHeights(node.tree, treeHeights), [184423, 226951, 234329, 234369]);
    assert.deepEqual(kept.heights, { heights: [184423, 226951, 234329, 234369], notes: 6 });
    assert.deepEqual(await noteTreeHeights(node.tree, treeHeights), [184423, 226951, 234329, 234369]);
    assert.deepEqual(node.reads, [0n]);
    assert.equal(node.sizes, 2);
  });

  it("are extended with only the leaves added since, as the tree grows", async () => {
    const node = noteTree(treeLeaves());
    const { kept, treeHeights } = memoryStores();

    kept.heights = { heights: [184423, 226951, 234329, 234369], notes: 6 };
    assert.deepEqual(await noteTreeHeights(node.tree, treeHeights), [184423, 226951, 234329, 234369, GROWN, 3577762, 3602438, 3861643]);
    assert.deepEqual(node.reads, [6n]);
    assert.equal(kept.heights.notes, 496);
  });

  it("are none while the tree has no leaves or its stream comes short, and are given when they can't be kept", async () => {
    const { kept, treeHeights } = memoryStores();

    assert.equal(await noteTreeHeights(noteTree([]).tree, treeHeights), null);

    const short = noteTree(FIRST);

    short.tree.size = async () => 7n;
    assert.equal(await noteTreeHeights(short.tree, treeHeights), null);
    assert.equal(kept.heights, null);

    const full = { get: () => null, put: () => Promise.reject(new Error("The store is full")) };

    assert.deepEqual(await noteTreeHeights(noteTree(FIRST).tree, full), [184423, 226951, 234329, 234369]);

    const unreadable = { get: () => Promise.reject(new Error("The store is closed")), put: () => {} };

    assert.deepEqual(await noteTreeHeights(noteTree(FIRST).tree, unreadable), [184423, 226951, 234329, 234369]);
  });
});

describe("the heights asked for", () => {
  // A fixed sequence of 32-bit numbers in place of crypto.getRandomValues.
  const seq = () => {
    let n = 7;

    return () => (n = (n * 1_103_515_245 + 12_345) % 2 ** 32);
  };
  const pool = Array.from({ length: 100 }, (_, i) => 1_000 + i);

  it(`are each of the profile's among ${DECOYS_PER_HEIGHT} others from the note tree, shuffled`, () => {
    const real = [1_010, 1_050];
    const { decoys, heights } = pickHeights(pool, real, { random: seq() });

    assert.equal(decoys.length, real.length * DECOYS_PER_HEIGHT);
    assert.equal(new Set(decoys).size, decoys.length);
    for (const d of decoys) assert.ok(pool.includes(d));
    assert.ok(!decoys.includes(1_010));
    assert.deepEqual([...heights].sort(), [...real, ...decoys].sort());
    // Shuffled: the real heights don't lead.
    assert.notDeepEqual(heights.slice(0, 2), real);
  });

  it("are the same decoys again, so a second look shows nothing new", () => {
    const first = pickHeights(pool, [1_010], { random: seq() });
    const again = pickHeights(pool, [1_010], { keep: first.decoys, random: () => 1 });

    assert.deepEqual(new Set(again.heights), new Set(first.heights));
  });

  it("take what a small tree has", () => {
    const { heights } = pickHeights([5, 6, 7], [6], { random: seq() });

    assert.deepEqual([...heights].sort(), [5, 6, 7]);
  });

  it("are drawn by crypto.getRandomValues by default", () => {
    const { decoys } = pickHeights(pool, [1_010]);

    assert.equal(decoys.length, DECOYS_PER_HEIGHT);
  });
});

describe("the note tree's heights for a wallet that changed", () => {
  it("are neither read nor kept once it changed while the tree's size was asked", async () => {
    const node = noteTree(FIRST);
    const { kept, treeHeights } = memoryStores();
    let current = true;
    const { size } = node.tree;

    node.tree.size = async () => {
      current = false;

      return size();
    };
    await assert.rejects(noteTreeHeights(node.tree, treeHeights, { isCurrent: () => current }), {
      message: "The wallet changed while its shielded history was read",
    });
    assert.deepEqual(node.reads, []);
    assert.equal(kept.heights, null);
  });

  it("are read no further once it changed while the leaves came", async () => {
    let current = true;
    let cancelled = false;
    let pulled = 0;
    // The tree's six leaves, one a pull: the wallet changes as the first comes.
    const tree = {
      leaves: async () =>
        new ReadableStream({
          pull(controller) {
            if (pulled === FIRST.length) controller.close();
            else controller.enqueue(FIRST[pulled]);
            pulled += 1;
            current = false;
          },
          cancel() {
            cancelled = true;
          },
        }),
    };

    await assert.rejects(readNoteHeights(tree, 6n, { isCurrent: () => current }), { message: "The wallet changed while its shielded history was read" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(cancelled);
    assert.ok(pulled < FIRST.length, `${pulled} leaves read`);
  });
});
