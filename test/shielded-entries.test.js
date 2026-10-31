import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NoArchiveError, STAKE_CONTRACT, TRANSFER_CONTRACT, createArchive } from "../src/history.js";
import { HEIGHTS_PER_REQUEST, NOTE_BYTES, fetchShieldedBlocks, shieldedEntries } from "../src/shielded.js";
import { DUSK, FIRST, L492, L493, L494, L495, NODE, NULLIFIERS, SHIELD, UNSHIELD, blocksNode, leafAt, phoenix, recordedBlocks } from "./fixtures/shielded.js";

/** @param {Uint8Array} bytes */
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
/** @param {number} n */
const hash = (n) => n.toString(16).padStart(2, "0").repeat(32);

describe("the blocks at the notes' heights", () => {
  it(`are asked for ${HEIGHTS_PER_REQUEST} heights a request, each with its events, time and gas`, async () => {
    const node = blocksNode();
    const heights = [3602438, 3861643, ...Array.from({ length: 18 }, (_, i) => 3_000_000 + i)];
    const blocks = await fetchShieldedBlocks(node.client, heights);

    assert.deepEqual(node.heights(), [heights.slice(0, HEIGHTS_PER_REQUEST), heights.slice(HEIGHTS_PER_REQUEST)]);
    assert.ok(
      node.queries[0].includes(
        "e3602438: contractEvents(height: 3602438) { json } b3602438: block(height: 3602438) { header { timestamp } transactions { id err gasSpent tx { gasPrice } } }"
      )
    );
    assert.equal(blocks.get(3602438)?.timestamp, 1_782_131_528_000);
    assert.deepEqual(blocks.get(3602438)?.events.map((e) => e.topic), ["convert", "phoenix", "reward"]);
    assert.equal(blocks.get(3602438)?.txs.get(UNSHIELD)?.gasSpent, 12_429_102);
    assert.deepEqual(blocks.get(3_000_000)?.events, []);
    assert.equal(blocks.size, 20);
  });

  it("are asked with time to answer, and only for whole heights, each once", async () => {
    /** @type {{ text: string, options: any }[]} */
    const asked = [];
    const archive = {
      assertArchive: async () => {},
      /** @param {string} text @param {any} options */
      query: async (text, options) => {
        asked.push({ options, text });

        return {};
      },
      url: NODE,
    };
    const blocks = await fetchShieldedBlocks(archive, [5, 5, -1, 1.5, Number.NaN, 7]);

    assert.equal(asked.length, 1);
    assert.deepEqual(asked[0].options, { timeoutMs: 30_000 });
    assert.deepEqual([...asked[0].text.matchAll(/b(\d+): block/g)].map(([, h]) => Number(h)), [5, 7]);
    // A block the archive gave nothing for has no events, time or transactions.
    assert.deepEqual(blocks.get(5), { events: [], timestamp: null, txs: new Map() });
  });

  it("are asked nothing of a node without the archive, for an hour", async () => {
    const node = blocksNode();
    /** @type {Map<string, number>} */
    const refusals = new Map();
    const archive = createArchive({ fetch: node.fetch, refusals: { get: (url) => refusals.get(url) ?? null, put: (url, at) => void refusals.set(url, at) }, url: NODE });

    node.archive = false;
    await assert.rejects(fetchShieldedBlocks(archive, [3602438]), NoArchiveError);
    assert.equal(node.queries.length, 1);
    await assert.rejects(fetchShieldedBlocks(archive, [3602438]), NoArchiveError);
    assert.equal(node.queries.length, 1);
  });
});

describe("the shielded history's entries", () => {
  // The profile's notes: two spent by the unshield, its two outputs, the
  // shield's note, and one whose block wasn't asked for.
  const notes = () => [
    { leaf: FIRST[0], nullifier: NULLIFIERS[0], spent: true, value: 10n * DUSK },
    { leaf: FIRST[1], nullifier: NULLIFIERS[1], spent: true, value: DUSK / 2n },
    { leaf: L493, nullifier: "aa".repeat(32), spent: false, value: DUSK },
    { leaf: L494, nullifier: "bb".repeat(32), spent: false, value: 12_000_000n },
    { leaf: L495, nullifier: "cc".repeat(32), spent: false, value: 2n * DUSK },
    { leaf: L492, nullifier: "dd".repeat(32), spent: false, value: 3n * DUSK },
  ];

  it("read a transaction that spent the profile's notes as what left them, less change and fee", () => {
    assert.deepEqual(shieldedEntries({ blocks: recordedBlocks(), notes: notes() }), [
      {
        blockHeight: 3861643,
        direction: "in",
        fee: null,
        hash: SHIELD,
        kind: "shield",
        success: true,
        timestamp: 1_784_723_688_000,
        value: "2000000000",
      },
      {
        blockHeight: 3602438,
        direction: "out",
        fee: "12429102",
        hash: UNSHIELD,
        kind: "unshield",
        success: true,
        timestamp: 1_782_131_528_000,
        // 10.5 DUSK spent, 1.012 back as change, 0.012429102 the fee.
        value: String(10_500_000_000n - 1_012_000_000n - 12_429_102n),
      },
    ]);
  });

  it("read a transaction that only made the profile's notes as received, an unshield as its conversion says", () => {
    // The same unshield, seen by a profile that only got its outputs.
    const [shield, unshield] = shieldedEntries({ blocks: recordedBlocks(), notes: notes().filter((n) => !n.spent) });

    assert.deepEqual(
      { direction: unshield.direction, fee: unshield.fee, hash: unshield.hash, kind: unshield.kind, value: unshield.value },
      { direction: "in", fee: null, hash: UNSHIELD, kind: "unshield", value: "1012000000" }
    );
    assert.equal(shield.kind, "shield");
  });

  it("give each of two notes one block made for the same shielded address to its own transaction", () => {
    // Made up from the shield at 3861643: two shields at 500 to its note's
    // address, of 2 and 3 DUSK, the second listed first.
    const H = 500;
    const recorded = phoenix.blocks.e3861643.json.find((/** @type {any} */ e) => e.topic === "convert").data;
    /** @param {bigint} value */
    const u64 = (value) => {
      const out = new Uint8Array(8);

      new DataView(out.buffer).setBigUint64(0, value, true);

      return out;
    };
    // A note made in the open holds its value after its position.
    /** @param {number} pos @param {bigint} value */
    const noteOf = (pos, value) => {
      const leaf = leafAt(L495, pos, H);

      leaf.set(u64(value), 656);

      return { leaf, nullifier: pos.toString(16).padStart(64, "0"), spent: false, value };
    };
    /** @param {string} origin @param {bigint} value */
    const shieldOf = (origin, value) => ({ data: recorded.slice(0, -16) + hex(u64(value)), origin, source: TRANSFER_CONTRACT, topic: "convert" });
    /** @param {bigint} first @param {bigint} second */
    const blocksOf = (first, second) =>
      new Map([[H, { events: [shieldOf(hash(0xb2), second), shieldOf(hash(0xb1), first)], timestamp: 1_000, txs: new Map() }]]);
    /** @param {any[]} entries */
    const amounts = (entries) => entries.map((e) => [e.hash.slice(0, 2), e.kind, e.direction, e.value]);

    assert.deepEqual(amounts(shieldedEntries({ blocks: blocksOf(2n * DUSK, 3n * DUSK), notes: [noteOf(600, 2n * DUSK), noteOf(601, 3n * DUSK)] })), [
      ["b1", "shield", "in", String(2n * DUSK)],
      ["b2", "shield", "in", String(3n * DUSK)],
    ]);
    // Of the same value, either note is either one's.
    assert.deepEqual(amounts(shieldedEntries({ blocks: blocksOf(2n * DUSK, 2n * DUSK), notes: [noteOf(600, 2n * DUSK), noteOf(601, 2n * DUSK)] })), [
      ["b1", "shield", "in", String(2n * DUSK)],
      ["b2", "shield", "in", String(2n * DUSK)],
    ]);
  });

  it("find nothing of the profile's in other heights' blocks, and leave reverted events out", () => {
    const blocks = recordedBlocks();

    assert.deepEqual(shieldedEntries({ blocks, notes: [{ leaf: L492, nullifier: "ee".repeat(32), spent: false, value: DUSK }] }), []);

    for (const e of blocks.get(3602438)?.events ?? []) e.reverted = true;
    assert.deepEqual(shieldedEntries({ blocks, notes: notes() }).map((e) => e.hash), [SHIELD]);
  });

  it("take nullifiers as bytes or hex, in either case", () => {
    const byBytes = notes().map((n) => ({ ...n, nullifier: Uint8Array.from(n.nullifier.match(/../g) ?? [], (b) => parseInt(b, 16)) }));
    const upper = notes().map((n) => ({ ...n, nullifier: n.nullifier.toUpperCase() }));
    const expected = shieldedEntries({ blocks: recordedBlocks(), notes: notes() });

    assert.deepEqual(shieldedEntries({ blocks: recordedBlocks(), notes: byBytes }), expected);
    assert.deepEqual(shieldedEntries({ blocks: recordedBlocks(), notes: upper }), expected);
    // A nullifier that isn't one matches nothing.
    assert.deepEqual(shieldedEntries({ blocks: recordedBlocks(), notes: notes().map((n) => ({ ...n, nullifier: "" })) })[1]?.direction, "in");
  });

  // Made-up blocks: a note the profile spent at 100, and the note each
  // transaction made at 200 for it.
  const SPENT = leafAt(FIRST[0], 0, 100);
  const MADE = leafAt(FIRST[1], 1, 200);
  const NULLIFIER = "ab".repeat(32);
  /**
   * A block at 200 holding one transaction, `a1…`: its phoenix event spends
   * the note at 100 and makes the one at 200, beside `others`.
   *
   * @param {{ others?: any[], err?: unknown, gasSpent?: number, spends?: boolean }} [options]
   */
  const blockWith = ({ others = [], err = null, gasSpent = 1_000_000, spends = true } = {}) => {
    const hash = "a1".repeat(32);
    const phoenix = { data: `${spends ? NULLIFIER : "cd".repeat(32)}${hex(MADE.subarray(0, NOTE_BYTES))}`, origin: hash, source: TRANSFER_CONTRACT, topic: "phoenix" };

    return new Map([
      [200, { events: [phoenix, ...others.map((e) => ({ origin: hash, ...e }))], timestamp: 1_000, txs: new Map([[hash, { err, gasSpent, id: hash, tx: { gasPrice: 1 } }]]) }],
    ]);
  };
  /** @param {bigint} spent @param {bigint} made */
  const notesOf = (spent, made) => [
    { leaf: SPENT, nullifier: NULLIFIER, spent: true, value: spent },
    { leaf: MADE, nullifier: "ef".repeat(32), spent: false, value: made },
  ];

  it("name what a transaction did by its events: a stake operation, a contract call or a transfer", () => {
    /** @param {any[]} others */
    const kindWith = (others) => shieldedEntries({ blocks: blockWith({ others }), notes: notesOf(5n * DUSK, DUSK) })[0]?.kind;
    const stake = (/** @type {string} */ topic) => ({ data: "00", source: STAKE_CONTRACT, topic });

    assert.equal(kindWith([stake("stake")]), "stake");
    assert.equal(kindWith([stake("unstake")]), "unstake");
    assert.equal(kindWith([stake("withdraw")]), "withdraw_reward");
    assert.equal(kindWith([{ data: "00", source: TRANSFER_CONTRACT, topic: "deposit" }]), "contract_call");
    assert.equal(kindWith([]), "transfer");
    // An event of another contract says nothing.
    assert.equal(kindWith([{ data: "00", source: "03".padEnd(64, "0"), topic: "deposit" }]), "transfer");
  });

  it("read a transfer to the profile itself as what came back to its notes, its fee apart", () => {
    // 5 DUSK spent, 5 DUSK less the fee back: nothing moved but the fee.
    const [self] = shieldedEntries({ blocks: blockWith(), notes: notesOf(5n * DUSK, 5n * DUSK - 1_000_000n) });

    assert.deepEqual(
      { direction: self.direction, fee: self.fee, kind: self.kind, value: self.value },
      { direction: "self", fee: "1000000", kind: "transfer", value: "0" }
    );
  });

  it("say a transaction that failed failed, with its error", () => {
    const [failed] = shieldedEntries({ blocks: blockWith({ err: { Panic: "out of gas" } }), notes: notesOf(5n * DUSK, 4n * DUSK) });

    assert.deepEqual(
      { error: failed.error, fee: failed.fee, success: failed.success },
      { error: '{"Panic":"out of gas"}', fee: "1000000", success: false }
    );

    const [ok] = shieldedEntries({ blocks: blockWith(), notes: notesOf(5n * DUSK, 4n * DUSK) });

    assert.equal(ok.success, true);
    assert.ok(!("error" in ok));
  });

  it("give no fee to a transaction its block doesn't list, nor to one that spent none of the profile's notes", () => {
    const blocks = blockWith({ spends: false });

    assert.equal(shieldedEntries({ blocks, notes: notesOf(5n * DUSK, DUSK) })[0]?.fee, null);

    const unlisted = blockWith();
    const block = unlisted.get(200);

    if (block) block.txs = new Map();

    const [entry] = shieldedEntries({ blocks: unlisted, notes: notesOf(5n * DUSK, DUSK) });

    assert.deepEqual({ fee: entry.fee, success: entry.success, value: entry.value }, { fee: null, success: true, value: String(4n * DUSK) });
  });
});

describe("the blocks for a wallet that changed", () => {
  it("are asked for no further once it changed during a request", async () => {
    const node = blocksNode();
    let current = true;

    node.before = () => {
      current = false;
    };
    await assert.rejects(
      fetchShieldedBlocks(node.client, Array.from({ length: 20 }, (_, i) => 3_000_000 + i), { isCurrent: () => current }),
      { message: "The wallet changed while its shielded history was read" }
    );
    assert.equal(node.queries.length, 1);
  });
});
