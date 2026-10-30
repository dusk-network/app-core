import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import {
  FINALITY_MARGIN,
  FIRST_WINDOW,
  NO_ARCHIVE_RETRY_MS,
  NoArchiveError,
  PAGE,
  RUN_DETAIL_REQUESTS,
  RUN_REQUESTS,
  createArchive,
  createHistory,
  topGap,
} from "../src/history.js";
import { NAME_CONTRACT, StaleError, fakeArchive, fixture, like, memoryDatabase, nameHook, withCallArgs } from "./fixtures/helpers.js";

// Recorded on Testnet: A called a name contract twice and received two
// transfers; B has years of transfers, contract calls, a shield, stake
// rewards and an unstake.
const [A, B] = Object.keys(fixture.accounts);
const FINALIZED = fixture.head.last_finalized_block[0];
const DUSK = 1_000_000_000n;

/** @param {string} account @param {"out" | "in"} direction @returns {any[]} */
const entriesOf = (account, direction) => fixture.accounts[account][direction === "out" ? "sender" : "receiver"];
/** @param {string} account */
const uniqueHashes = (account) => new Set([...entriesOf(account, "out"), ...entriesOf(account, "in")].map((e) => e.origin));

/** @param {{ query: string }} l */
const kindOf = (l) => (l.query.includes("lastBlockPair") ? "head" : l.query.includes("tx(hash:") ? "details" : "window");

/**
 * An account's history on `node`, kept in `db`.
 *
 * @param {ReturnType<typeof fakeArchive>} node
 * @param {string} account
 * @param {{ db?: ReturnType<typeof memoryDatabase>, callFacts?: any, now?: () => number, refusals?: any }} [options]
 */
function setup(node, account, { db = memoryDatabase(), callFacts, now, refusals } = {}) {
  const store = db.storeFor(`testnet::${account}`);
  const archive = node.archiveClient({ refusals, ...(now ? { now } : {}) });

  return { archive, db, history: createHistory({ account, archive, callFacts, network: 2, store, ...(now ? { now } : {}) }), store };
}

describe("a sync run", () => {
  it("syncs an account from the newest window down, widening while it is sparse", async () => {
    const node = fakeArchive({ details: withCallArgs(fixture.details) });
    const { history, store } = setup(node, A, { callFacts: nameHook() });
    const result = await history.sync();
    const target = FINALIZED - FINALITY_MARGIN;
    const windows = node.historyQueries().map((l) => [...l.query.matchAll(/fromBlock: (\d+), toBlock: (\d+)/g)][0].slice(1).map(Number));

    // A day, then each window 8 times wider while it held few entries.
    assert.deepEqual(windows, [
      [target - 8_639, target],
      [target - 8_640 - 69_119, target - 8_640],
      [target - 77_760 - 552_959, target - 77_760],
      [0, target - 630_720],
    ]);
    // The head, four windows, the details of the four entries found, at once,
    // and the arguments of the call without a deposit once its contract is known.
    assert.deepEqual(node.log.map(kindOf), ["head", "window", "window", "details", "window", "window", "details"]);
    assert.deepEqual(result.state.covered, [[0, target]]);
    assert.equal(result.requests, 5);
    assert.equal(result.added, 4);
    assert.equal(store.rows().length, 4);

    const read = await history.read();

    assert.equal(read.complete, true);
    assert.deepEqual(
      read.entries.map((e) => [e.blockHeight, e.direction, e.kind, e.value]),
      [
        [4658012, "out", "contract_call", 100n * DUSK],
        [4658000, "out", "contract_call", 0n],
        [4657992, "in", "transfer", 1000n * DUSK],
        [4655845, "in", "transfer", 1100n * DUSK],
      ]
    );

    const [second, first] = read.entries;

    like(second, { contractId: NAME_CONTRACT, fee: 2_897_558n, fnName: "register", success: true, timestamp: 1_792_687_511_000 });
    like(first, { fee: 1_959_593n, fnName: "commit", success: true });
    // A fee is the sender's: none on what the account received.
    assert.equal(read.entries[2].fee, null);
  });

  it("reads every entry's details in the first request when no call's arguments are read", async () => {
    const node = fakeArchive();
    const { history } = setup(node, A);

    await history.sync();

    assert.deepEqual(node.log.map(kindOf), ["head", "window", "window", "details", "window", "window"]);
    assert.doesNotMatch(node.detailQueries()[0].query, /\bdata\b/);
  });

  it("narrows a window whose page fills, and keeps every entry over the runs that follow", async () => {
    const node = fakeArchive();
    const { history, store } = setup(node, B);
    const all = uniqueHashes(B);

    for (let run = 0; run < 6; run++) {
      const before = node.log.length;

      await history.sync();

      const queries = node.log.slice(before);

      assert.ok(queries.filter((l) => !l.query.includes("tx(hash:")).length <= RUN_REQUESTS);
      assert.ok(queries.filter((l) => l.query.includes("tx(hash:")).length <= RUN_DETAIL_REQUESTS);

      // Whatever is shown is everything at those heights: no gap above the lowest.
      const read = await history.read({ limit: 1_000 });
      const truth = [...all].filter((h) => {
        const e = [...entriesOf(B, "out"), ...entriesOf(B, "in")].find((x) => x.origin === h);

        return e.block_height >= Number(read.coveredTo);
      });

      assert.deepEqual(new Set(read.entries.map((e) => e.hash)), new Set(truth));
      if (read.complete) break;
    }

    // Some window filled its page of 50.
    assert.ok(node.historyQueries().some((l) => (l.data.out?.json?.length ?? 0) === PAGE));

    const rows = store.rows();

    assert.equal(rows.length, all.size);
    assert.deepEqual(new Set(rows.map((r) => r.hash)), all);

    const read = await history.read({ limit: 1_000 });

    assert.equal(read.complete, true);
    // Heights in order, newest first.
    assert.deepEqual(
      read.entries.map((e) => e.blockHeight),
      [...read.entries.map((e) => e.blockHeight)].sort((x, y) => y - x)
    );
  });

  it("asks only above the heights it kept on a refresh", async () => {
    const node = fakeArchive({ details: withCallArgs(fixture.details), finalized: 4_656_000 });
    const { history } = setup(node, A, { callFacts: nameHook() });

    await history.sync();
    assert.deepEqual((await history.read()).entries.map((e) => e.blockHeight), [4655845]);

    node.finalized = FINALIZED;

    const before = node.log.length;
    const result = await history.sync();
    const refresh = node.log.slice(before);

    // One request has the head and everything above the kept heights; one
    // more has the new entries' details, and a last one the arguments of the
    // call without a deposit, once its contract is known.
    assert.equal(refresh.length, 3);
    assert.match(refresh[0].query, /pair: lastBlockPair \{ json \}/);
    assert.ok(
      refresh[0].query.includes(`moonlightHistory(sender: "${A}", fromBlock: ${4_656_000 - FINALITY_MARGIN + 1}, maxCount: 50)`)
    );
    assert.doesNotMatch(refresh[0].query, /toBlock/);
    assert.equal(refresh[1].query.match(/tx\(hash:/g)?.length, 3);
    assert.equal(refresh[2].query.match(/tx\(hash:/g)?.length, 1);
    assert.deepEqual(result.state.covered, [[0, FINALIZED - FINALITY_MARGIN]]);
    assert.deepEqual((await history.read()).entries.map((e) => e.blockHeight), [4658012, 4658000, 4657992, 4655845]);
  });

  it("reads entries in the finality margin again without keeping them twice", async () => {
    // 4658012 is above the first refresh's target and read again by the next.
    const node = fakeArchive({ finalized: 4_658_000 });
    const { history, store } = setup(node, A);

    await history.sync();
    node.finalized = 4_658_020;
    await history.sync();
    node.finalized = FINALIZED;

    const before = node.detailQueries().length;

    await history.sync();

    const twice = node.historyQueries().filter((l) => l.data.out?.json?.some((/** @type {any} */ e) => e.block_height === 4658012));

    assert.equal(twice.length, 2);

    const rows = store.rows();

    assert.equal(rows.filter((r) => r.blockHeight === 4658012).length, 1);
    assert.equal(rows.length, 4);
    // Its details stayed with it: none looked up again.
    assert.equal(node.detailQueries().length, before);
    like(rows.find((r) => r.blockHeight === 4658012), { fnName: "register" });
  });

  it("stops at its request budget and carries on in the next run", async () => {
    const node = fakeArchive();
    const { history, store } = setup(node, A);

    await history.sync({ maxDetailRequests: 0, maxRequests: 2 });
    assert.equal(node.log.length, 2);

    let read = await history.read();

    assert.equal(read.complete, false);

    await history.sync({ maxRequests: 3 });
    read = await history.read();
    assert.equal(read.entries.length, 4);
    assert.equal(store.rows().length, 4);
  });

  it("hears each step it keeps", async () => {
    const node = fakeArchive();
    const { history } = setup(node, A);
    /** @type {number[][][]} */
    const steps = [];

    await history.sync({ onStep: (state) => steps.push(state.covered) });

    // The head, four windows, and the details batch.
    assert.equal(steps.length, 6);
    assert.deepEqual(steps[0], []);
    assert.deepEqual(steps.at(-1), [[0, FINALIZED - FINALITY_MARGIN]]);
  });

  it("starts over when the node's chain is another one, and asks the store to forget the old one", async () => {
    const node = fakeArchive();
    const { db, history, store } = setup(node, A);

    await history.sync();
    node.genesis = "ff".repeat(32);
    node.finalized = 4_656_000;

    const result = await history.sync();

    assert.equal(db.db.clears, 1);
    assert.deepEqual(store.rows().map((r) => r.blockHeight), [4655845]);
    assert.equal(result.state.genesis, "ff".repeat(32));
  });

  it("starts over once only: a store that still keeps the old chain's history is refused", async () => {
    const node = fakeArchive();
    const { history, store } = setup(node, A);

    await history.sync();
    store.clear = async () => {};
    node.genesis = "ff".repeat(32);

    const asked = node.log.length;

    await assert.rejects(history.sync(), { message: "The store still keeps another chain's history" });
    // The head, read once, which the restart reuses: nothing more.
    assert.equal(node.log.length, asked + 1);
  });

  it("keeps each step's coverage with what another page covered meanwhile", async () => {
    const node = fakeArchive();
    const db = memoryDatabase();
    const { history } = setup(node, A, { db });
    let once = false;

    // Another page keeps a range while this run reads its first window.
    node.before = async (query) => {
      if (once || !query.includes("toBlock")) return;
      once = true;

      const kept = db.db.states.get(`testnet::${A}`);

      db.db.states.set(`testnet::${A}`, { ...kept, covered: [...kept.covered, [10, 20]] });
    };

    const target = FINALIZED - FINALITY_MARGIN;

    await history.sync({ maxRequests: 2 });
    assert.deepEqual(db.db.states.get(`testnet::${A}`).covered, [[target - 8_639, target], [10, 20]]);
  });
});

describe("a history's completeness", () => {
  it("comes once every height from the target down is covered, not when a run stops under a crowded top", async () => {
    // 120 transfers from B at height 100, on a chain finalized at 110.
    const template = entriesOf(B, "out").find((e) => e.events.length === 1);
    const crowd = Array.from({ length: 120 }, (_, i) => ({ ...template, block_height: 100, origin: (5_000 + i).toString(16).padStart(64, "0") }));
    const node = fakeArchive({ accounts: { [B]: { receiver: [], sender: crowd } }, finalized: 110 });
    const { history, store } = setup(node, B);

    await history.sync({ maxDetailRequests: 0, maxRequests: 2 });
    assert.deepEqual((await store.getState())?.covered, [[0, 99]]);

    const partial = await history.read({ limit: 1_000 });

    assert.deepEqual([partial.complete, partial.entries.length], [false, 50]);

    for (let run = 0; run < 6 && !(await history.read({ limit: 1_000 })).complete; run++) {
      await history.sync({ maxDetailRequests: 0, maxRequests: 2 });
    }

    const done = await history.read({ limit: 1_000 });

    assert.deepEqual([done.complete, done.entries.length, done.coveredTo], [true, 120, 0]);
  });
});

describe("a run's budget", () => {
  it("is kept when the run starts over on another chain: the head it read serves the new one", async () => {
    const node = fakeArchive();
    const { history } = setup(node, A);

    await history.sync();
    node.genesis = "ff".repeat(32);
    node.finalized = 4_656_000;

    const asked = node.log.length;
    const result = await history.sync({ maxDetailRequests: 0, maxRequests: 2 });

    assert.equal(node.log.length - asked, 2);
    assert.equal(result.requests, 2);
    // After the one head, a window under the new chain's target.
    assert.match(node.log[asked + 1].query, /fromBlock: 4647351, toBlock: 4655990, maxCount: 50\)/);
    assert.equal(result.state.genesis, "ff".repeat(32));
  });

  it("refuses one that could never read under the head, and two read further each run", async () => {
    const node = fakeArchive();
    const { history, store } = setup(node, A);

    for (const maxRequests of [1, 0, -3, Number.NaN]) {
      await assert.rejects(history.sync({ maxRequests }), { message: /2 history requests or more/, name: "RangeError" });
    }

    assert.equal(node.log.length, 0);

    // The head and one window a run, from an empty store: each run covers more.
    let span = 0;

    for (let run = 0; run < 10 && !(await history.read()).complete; run++) {
      await history.sync({ maxDetailRequests: 0, maxRequests: 2 });

      const covered = (await store.getState())?.covered ?? [];
      const now = covered.reduce((sum, [lo, hi]) => sum + hi - lo + 1, 0);

      assert.ok(now > span, `run ${run} covered more`);
      span = now;
    }

    assert.equal((await history.read()).complete, true);
  });
});

describe("reading a kept history page by page", () => {
  // Derived: 450 transfers from B in one block, and 10 below it.
  const H = 4_600_000;
  const template = entriesOf(B, "out").find((e) => e.events.length === 1);
  /** @param {number} i @param {number} height */
  const copy = (i, height) => ({ ...template, block_height: height, origin: i.toString(16).padStart(64, "0") });
  const sender = [...Array.from({ length: 10 }, (_, i) => copy(1_000 + i, H - 10 + i)), ...Array.from({ length: 450 }, (_, i) => copy(i, H))];

  it("reads on below the last entry's height without skipping any of a block a page cuts through", async () => {
    const node = fakeArchive({ accounts: { [B]: { receiver: [], sender } }, finalized: H + 20 });
    const { history } = setup(node, B);

    for (let run = 0; run < 8 && !(await history.read({ limit: 1_000 })).complete; run++) await history.sync({ maxDetailRequests: 0 });

    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {number[]} */
    const pages = [];
    /** @type {number | undefined} */
    let before;

    for (let page = 0; page < 10; page++) {
      const { entries } = await history.read({ before, limit: 200 });

      if (!entries.length) break;

      pages.push(entries.length);
      for (const entry of entries) seen.add(entry.hash);
      before = entries.at(-1)?.blockHeight;
    }

    assert.equal(seen.size, 460);
    // The first page ends with the whole block its limit cut through.
    assert.deepEqual(pages, [450, 10]);
    // A limit that ends where a block does gives just that many.
    assert.equal((await history.read({ before: H, limit: 4 })).entries.length, 4);
  });
});

describe("createHistory", () => {
  it("takes a Dusk account, checked as a key, not just its alphabet", () => {
    const node = fakeArchive();
    const store = memoryDatabase().storeFor("x");
    const archive = node.archiveClient();

    // Base58 of the right length, one character off: not a key.
    const typo = `${A.slice(0, -1)}${A.endsWith("1") ? "2" : "1"}`;

    assert.throws(() => createHistory({ account: typo, archive, store }), { message: "Not a Dusk public account", name: "TypeError" });
    assert.throws(() => createHistory({ account: "", archive, store }), TypeError);
    assert.throws(() => createHistory({ account: A, archive, store: /** @type {any} */ (null) }), { message: "A store is required" });
    assert.throws(() => createHistory({ account: A, archive: /** @type {any} */ ({}), store }), { message: "An archive is required" });
    assert.equal(createHistory({ account: A, archive, store }).account, A);
  });
});

describe("two syncs of one history", () => {
  const KEY = `testnet::${A}`;
  const NEW_GENESIS = "ee".repeat(32);

  /**
   * A fetch on `node` whose first answer to a query matching `pattern` is
   * read at once, and given only once `held` resolves.
   *
   * @param {ReturnType<typeof fakeArchive>} node
   * @param {RegExp} pattern
   */
  function late(node, pattern) {
    const held = Promise.withResolvers();
    const reached = Promise.withResolvers();
    let first = true;
    /** @param {string} url @param {{ body: string }} init */
    const fetch = async (url, init) => {
      const answer = await node.fetch(url, init);

      if (first && pattern.test(String(init.body))) {
        first = false;
        reached.resolve(undefined);
        await held.promise;
      }

      return answer;
    };

    return { fetch, held, reached };
  }

  /** @param {ReturnType<typeof memoryDatabase>} db @param {any} fetch */
  const historyOn = (db, fetch) =>
    createHistory({ account: A, archive: createArchive({ fetch, url: fixture.nodeUrl }), network: 2, store: db.storeFor(KEY) });

  it("keeps nothing an old chain's window brings after another sync started the history over on the new chain", async () => {
    const db = memoryDatabase();
    const oldChain = fakeArchive();
    // The same node, reset meanwhile: another genesis, and none of A's entries yet.
    const newChain = fakeArchive({ accounts: {}, finalized: 1_000, genesis: NEW_GENESIS });

    // A first run on the old chain leaves older heights to read.
    await historyOn(db, oldChain.fetch).sync({ maxDetailRequests: 0, maxRequests: 2 });

    const slow = late(oldChain, /toBlock/);
    const run = historyOn(db, slow.fetch).sync({ maxDetailRequests: 0 });

    await slow.reached.promise;
    // Meanwhile, another sync finds the new chain, and starts the history over.
    await historyOn(db, newChain.fetch).sync();
    slow.held.resolve(undefined);

    await assert.rejects(run, { name: "StaleHistoryError" });

    const kept = await db.storeFor(KEY).getState();

    assert.deepEqual([kept?.genesis, kept?.covered], [NEW_GENESIS, [[0, 990]]]);
    assert.deepEqual(db.storeFor(KEY).rows(), []);
  });

  it("keeps nothing an old chain's details bring after another sync kept the new chain's entries", async () => {
    const db = memoryDatabase();
    const oldChain = fakeArchive();
    // Reset, the same transactions again, their details not given yet.
    const newChain = fakeArchive({ details: {}, genesis: NEW_GENESIS });
    const slow = late(oldChain, /tx\(hash:/);
    const run = historyOn(db, slow.fetch).sync();

    await slow.reached.promise;
    await historyOn(db, newChain.fetch).sync();
    slow.held.resolve(undefined);

    await assert.rejects(run, { name: "StaleHistoryError" });
    assert.equal(db.storeFor(KEY).rows().length, 4);
    assert.ok(db.storeFor(KEY).rows().every((row) => row.detailsAt === undefined));
  });

  it("says so whatever the store rejects a refused step with, or when it goes on regardless", async () => {
    for (const store of ["aborts", "swallows"]) {
      const db = memoryDatabase();
      const node = fakeArchive();

      await historyOn(db, node.fetch).sync({ maxDetailRequests: 0, maxRequests: 2 });

      const slow = late(node, /toBlock/);
      const kept = db.storeFor(KEY);
      const inner = kept.commit.bind(kept);

      // As IndexedDB aborts a transaction whose handler threw, with its own error;
      // or a store that catches the throw and keeps nothing.
      kept.commit = async (entries, update) => {
        try {
          return await inner(entries, update);
        } catch (error) {
          if (store === "aborts") throw new DOMException(String(error), "AbortError");

          return null;
        }
      };

      const run = createHistory({ account: A, archive: createArchive({ fetch: slow.fetch, url: fixture.nodeUrl }), network: 2, store: kept }).sync({ maxDetailRequests: 0 });

      await slow.reached.promise;
      await db.storeFor(KEY).clear();
      slow.held.resolve(undefined);
      await assert.rejects(run, { name: "StaleHistoryError" }, store);
    }
  });

  it("keeps nothing more of a run once its history was cleared under it", async () => {
    const db = memoryDatabase();
    const node = fakeArchive();

    await historyOn(db, node.fetch).sync({ maxDetailRequests: 0, maxRequests: 2 });

    const slow = late(node, /toBlock/);
    const run = historyOn(db, slow.fetch).sync({ maxDetailRequests: 0 });

    await slow.reached.promise;
    await db.storeFor(KEY).clear();
    slow.held.resolve(undefined);

    await assert.rejects(run, { name: "StaleHistoryError" });
    assert.equal(await db.storeFor(KEY).getState(), null);
    assert.deepEqual(db.storeFor(KEY).rows(), []);
  });
});

describe("a wallet reset during a sync", () => {
  it("keeps nothing the sync reads after it", async () => {
    const node = fakeArchive();
    const { db, history, store } = setup(node, A);
    const held = Promise.withResolvers();
    const atWindow = Promise.withResolvers();

    node.before = async (query) => {
      if (query.includes("toBlock")) {
        atWindow.resolve(undefined);
        await held.promise;
      }
    };

    const run = history.sync();

    await atWindow.promise;
    db.reset();
    held.resolve(undefined);

    await assert.rejects(run, StaleError);
    assert.deepEqual(store.rows(), []);
    assert.equal(await store.getState(), null);
  });

  it("keeps nothing when the node's chain changed too", async () => {
    const node = fakeArchive();
    const { db, history, store } = setup(node, A);

    await history.sync();

    // The next run's first request waits; the wallet is reset meanwhile, and
    // the node answers for another chain.
    const held = Promise.withResolvers();
    const reached = Promise.withResolvers();

    node.before = async () => {
      reached.resolve(undefined);
      await held.promise;
    };

    const run = history.sync();

    await reached.promise;
    db.reset();
    node.before = null;
    node.genesis = "ff".repeat(32);
    held.resolve(undefined);

    await assert.rejects(run, StaleError);
    assert.deepEqual(store.rows(), []);
    assert.equal(await store.getState(), null);
  });
});

describe("a block with more than a page of the account's entries", () => {
  // Derived: 450 transfers from B in one block, each a copy of one recorded
  // entry with its own hash, more than one run's requests can page through.
  const H = 4_600_000;
  const template = entriesOf(B, "out").find((e) => e.events.length === 1);
  const crowded = Array.from({ length: 450 }, (_, i) => ({ ...template, block_height: H, origin: i.toString(16).padStart(64, "0") }));

  it("carries on paging it where the last run stopped", async () => {
    const node = fakeArchive({ accounts: { [B]: { receiver: [], sender: crowded } }, finalized: H + 20 });
    const { history, store } = setup(node, B);

    for (let run = 0; run < 4; run++) await history.sync();

    assert.equal(store.rows().length, 450);
    assert.equal((await history.read({ limit: 1_000 })).complete, true);

    // No page of the block was read twice: each run carried on where the last stopped.
    const pages = node.historyQueries().map((l) => l.query.match(/pageCount: (\d+)/)?.[1]).filter(Boolean);

    assert.ok(pages.length > 0);
    assert.equal(new Set(pages).size, pages.length);
  });

  it("keeps each of its pages as it lands, so one that fails loses none before it", async () => {
    const node = fakeArchive({ accounts: { [B]: { receiver: [], sender: crowded } }, finalized: H + 20 });
    const { history, store } = setup(node, B);
    let failed = false;

    // The block's third page fails, once.
    node.before = async (query) => {
      if (!failed && /pageCount: 3\b/.test(query)) {
        failed = true;
        throw new TypeError("fetch failed");
      }
    };

    await assert.rejects(history.sync({ maxDetailRequests: 0 }), { message: "fetch failed" });
    // Its first two pages are kept, and where the next one starts.
    assert.equal(store.rows().length, 2 * PAGE);
    assert.deepEqual((await store.getState())?.crowded, { height: H, page: 3 });

    // The next run carries on from the third page.
    const asked = node.historyQueries().length;

    await history.sync({ maxDetailRequests: 0 });
    assert.match(node.historyQueries()[asked + 1].query, /fromBlock: 4600000, toBlock: 4600000, maxCount: 50, pageCount: 3\)/);

    for (let run = 0; run < 4; run++) await history.sync({ maxDetailRequests: 0 });

    assert.equal(store.rows().length, 450);
    assert.equal((await history.read({ limit: 1_000 })).complete, true);
  });
});

describe("a node without the archive", () => {
  it("is asked nothing for an hour after its first refusal, then again", async () => {
    const node = fakeArchive();
    let now = 1_000_000_000;
    const { history } = setup(node, A, { now: () => now });

    node.archive = false;
    await assert.rejects(history.sync(), NoArchiveError);
    // The head, then the first window it refused.
    assert.equal(node.log.length, 2);
    await assert.rejects(history.sync(), NoArchiveError);
    assert.equal(node.log.length, 2);
    // Nothing kept to show.
    assert.deepEqual((await history.read()).entries, []);

    // An hour on, it is asked again: now with the archive.
    now += NO_ARCHIVE_RETRY_MS;
    node.archive = true;
    await history.sync();
    assert.equal((await history.read()).entries.length, 4);
  });

  it("is left alone by the next history on it too, through the app's refusals", async () => {
    const node = fakeArchive();
    /** @type {Map<string, number>} */
    const kept = new Map();
    const refusals = { get: (/** @type {string} */ url) => kept.get(url) ?? null, put: (/** @type {string} */ url, /** @type {number} */ at) => void kept.set(url, at) };

    node.archive = false;
    await assert.rejects(setup(node, A, { refusals }).history.sync(), NoArchiveError);
    assert.deepEqual([...kept.keys()], [fixture.nodeUrl]);

    const asked = node.log.length;

    await assert.rejects(setup(node, B, { refusals }).history.sync(), NoArchiveError);
    assert.equal(node.log.length, asked);
  });
});

// The bridge site's cases, through the app's own GraphQL caller.
describe("a sync through the app's GraphQL caller", () => {
  const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
  const OTHER = networks.mainnet.routes.services[0].account;
  const SERVICE = networks.testnet.routes.services[0].account;
  const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
  const TRANSFER = `01${"0".repeat(62)}`;
  const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
  /** @param {string} text */
  const hex = (text) => Buffer.from(text).toString("hex");
  /** @param {number} n */
  const h = (n) => n.toString(16).padStart(64, "0");

  // Shaped like the archive's own answers (testnet, 26 Oct).
  /** @param {number} n @param {number} height */
  const deposit = (n, height) => ({
    block_height: height,
    events: [
      { data: { receiver: BRIDGE, sender: ACCOUNT, value: "100000000" }, reverted: false, target: TRANSFER, topic: "deposit" },
      { data: `${"0".repeat(48)}016345785d8a0000e0ffffff00000000975729af8e43f9d690d24da68d9e92d2e8273174${EVM.slice(2)}`, reverted: false, target: BRIDGE, topic: "eth_bridge_initiated" },
      { data: { gas_spent: "1986599", memo: "", receiver: null, sender: ACCOUNT, value: "0" }, reverted: false, target: TRANSFER, topic: "moonlight" },
    ],
    origin: h(n),
  });
  /** @param {number} n @param {number} height */
  const service = (n, height) => ({
    block_height: height,
    events: [{ data: { memo: hex("0xeE1b68ED496712cda857ada41d326d357049E51C"), receiver: SERVICE, sender: ACCOUNT, value: "50000000000" }, reverted: false, target: TRANSFER, topic: "moonlight" }],
    origin: h(n),
  });
  /** @param {number} n @param {number} height */
  const plain = (n, height) => ({
    block_height: height,
    events: [{ data: { memo: hex("rent"), receiver: OTHER, sender: ACCOUNT, value: "5" }, reverted: false, target: TRANSFER, topic: "moonlight" }],
    origin: h(n),
  });
  // What the bridge site keeps of a history: its deposits, its transfers to
  // the bridge's account, and the payouts whose memo names a transaction.
  /** @param {any} e */
  const bridgeOnes = (e) =>
    (e.counterparty === BRIDGE && e.direction === "out") ||
    (e.counterparty === SERVICE && e.direction === "out") ||
    (e.direction === "in" && /^0x[0-9a-f]{64}$/i.test(e.memo));

  /**
   * The bridge site's archive stub: no genesis, a page of 50 at most, and
   * pages when `paged`.
   *
   * @param {any[]} entries
   * @param {number} finalized
   * @param {{ paged?: boolean }} [options]
   */
  function stub(entries, finalized, { paged = false } = {}) {
    /** @type {string[]} */
    const calls = [];
    /** @param {string} selection */
    const query = async (selection) => {
      calls.push(selection);

      /** @type {Record<string, any>} */
      const data = {};

      if (selection.includes("lastBlockPair")) data.pair = { json: { last_finalized_block: [finalized, "x"] } };

      for (const [alias, direction] of [["out", "sender"], ["in", "receiver"]]) {
        const match = new RegExp(`${alias}: moonlightHistory\\(${direction}: "[^"]+", fromBlock: (\\d+)(?:, toBlock: (\\d+))?, maxCount: 50(?:, pageCount: (\\d+))?`, "u").exec(selection);

        if (!match) continue;

        const [from, to, pageAt] = [Number(match[1]), match[2] === undefined ? Infinity : Number(match[2]), paged ? Number(match[3] ?? 1) : 1];
        const list = entries.filter((entry) => {
          const ours = entry.events.some((/** @type {any} */ event) => event.data?.[direction] === ACCOUNT);

          return ours && entry.block_height >= from && entry.block_height <= to;
        });
        const pageOf = list.slice((pageAt - 1) * 50, pageAt * 50);

        data[alias] = pageOf.length ? { json: pageOf } : null;
      }

      return data;
    };

    return { archive: createArchive({ query, url: "https://testnet.nodes.dusk.network" }), calls };
  }

  /** @param {ReturnType<typeof stub>["archive"]} archive @param {any} store */
  const historyOn = (archive, store) => createHistory({ account: ACCOUNT, archive, network: 2, store });

  it("reads the newest blocks first, widens, and carries on later", async () => {
    const tip = 4_687_950;
    const entries = [deposit(1, tip - 100), service(2, tip - 20_000), plain(3, tip - 30_000), deposit(4, 1_000)];
    const db = memoryDatabase();
    const store = db.storeFor("testnet:dusk:account");
    const node = stub(entries, tip);
    const first = await historyOn(node.archive, store).sync({ maxDetailRequests: 0, maxRequests: 3 });

    assert.equal(first.requests, 3);
    // The head, then a day, then eight days: both recent transfers, not yet the old one.
    assert.deepEqual(store.rows().filter(bridgeOnes).map((e) => e.hash).sort(), [h(1), h(2)]);
    assert.deepEqual(first.state.covered, [[tip - 10 - FIRST_WINDOW * 9 + 1, tip - 10]]);
    assert.match(node.calls[1], /out: moonlightHistory\(sender: "[^"]+", fromBlock: \d+, toBlock: \d+, maxCount: 50\) \{ json \} in: moonlightHistory\(receiver:/u);

    // A later visit reads what's new above, then carries on down, finding each transfer once.
    entries.push(service(5, tip + 50));

    const node2 = stub(entries, tip + 100);
    const second = await historyOn(node2.archive, store).sync({ maxDetailRequests: 0, maxRequests: 6 });

    assert.match(node2.calls[0], /lastBlockPair/u);
    assert.equal(topGap(second.state.covered, second.state.target), null);
    assert.deepEqual(store.rows().filter(bridgeOnes).map((e) => e.hash).sort(), [h(1), h(2), h(4), h(5)]);
    assert.equal(store.rows().length, 5);
  });

  it("reads a block with more than a page to its last page, across runs", async () => {
    const tip = 4_687_950;
    const crowd = 4_687_000;
    // 120 deposits in one block, one above it: pages of 50, in order.
    const entries = [...Array.from({ length: 120 }, (_, n) => deposit(100 + n, crowd)), deposit(1, crowd + 300)];
    const node = stub(entries, tip, { paged: true });
    const db = memoryDatabase();
    const store = db.storeFor("testnet:dusk:account");
    const history = historyOn(node.archive, store);
    /** @type {any} */
    let state = null;

    for (let run = 0; run < 12 && !(state && topGap(state.covered, state.target) === null); run += 1) {
      ({ state } = await history.sync({ maxDetailRequests: 0, maxRequests: 2 }));

      // The block counts as read only once its last page is.
      const blockCovered = state.covered.some((/** @type {number[]} */ [lo, hi]) => lo <= crowd && crowd <= hi);

      if (state.crowded) assert.equal(blockCovered, false);
      if (blockCovered) assert.equal(store.rows().length, 121);
    }

    assert.equal(store.rows().length, 121);
    assert.equal(state.crowded, null);
    assert.ok(node.calls.some((selection) => /fromBlock: 4687000, toBlock: 4687000, maxCount: 50, pageCount: 3\)/u.test(selection)));

    // A gap of that one block: its first page fills, then the rest, page by page.
    const lone = memoryDatabase();
    const loneStore = lone.storeFor("testnet:dusk:account");

    lone.seed("testnet:dusk:account", { covered: [[crowd + 1, tip - 10], [0, crowd - 1]], crowded: null, entries: {}, target: tip - 10, window: 1 });

    const loneHistory = historyOn(node.archive, loneStore);

    for (let run = 0; run < 6 && topGap((await loneStore.getState())?.covered ?? [], tip - 10) !== null; run += 1) {
      await loneHistory.sync({ maxDetailRequests: 0, maxRequests: 2 });
    }

    assert.equal(loneStore.rows().length, 120);
    // What the site kept beside the state stays.
    assert.deepEqual((await loneStore.getState())?.entries, {});
  });

  it("reads the genesis of a history kept without it, and starts over once it changes", async () => {
    const tip = 4_687_950;
    const db = memoryDatabase();
    const store = db.storeFor("testnet:dusk:account");
    const node = fakeArchive({ accounts: { [ACCOUNT]: { receiver: [], sender: [deposit(1, tip - 100)] } }, finalized: tip });

    // As the site kept it: no genesis.
    db.seed("testnet:dusk:account", { covered: [[0, tip - 1_000]], crowded: null, entries: {}, target: tip - 1_000, window: FIRST_WINDOW });

    const history = createHistory({ account: ACCOUNT, archive: node.archiveClient(), network: 2, store });

    assert.equal((await history.sync()).state.genesis, fixture.head.genesis);
    assert.equal(db.db.clears, 0);

    node.genesis = "ee".repeat(32);
    await history.sync();
    assert.equal(db.db.clears, 1);
  });
});

describe("entries read twice in one answer", () => {
  it("are kept once: an entry the account sent to itself is in both directions' lists", async () => {
    const self = entriesOf(B, "out").find((e) => e.block_height === 2517146);
    const node = fakeArchive({ accounts: { [B]: { receiver: [self], sender: [self] } }, finalized: 2_517_200 });
    const { history, store } = setup(node, B);
    /** @type {any[][]} */
    const committed = [];
    const commit = store.commit.bind(store);

    store.commit = async (entries, update) => {
      committed.push(entries);

      return commit(entries, update);
    };

    const result = await history.sync();

    assert.equal(node.historyQueries()[0].data.out.json.length, 1);
    assert.equal(node.historyQueries()[0].data.in.json.length, 1);
    assert.deepEqual(committed.map((entries) => entries.length).filter(Boolean), [1]);
    assert.equal(result.added, 1);
    like(store.rows()[0], { direction: "self", value: String(DUSK) });
  });
});
