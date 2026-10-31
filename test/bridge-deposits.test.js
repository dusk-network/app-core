import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { ETH_BRIDGE_FINALIZED_TOPIC, arrivalsOf, depositArrivals, depositOf } from "../src/bridge.js";
import { activityRows } from "../src/activity.js";
import { fetchTxDetails, historyEntry, parseHistoryEntry } from "../src/history.js";
import { BRIDGE, EXPLORER_API, L2_BRIDGE, bridgeFinalized, call, depositEntry, details, fakeChain, fakeExplorer, hex, moonlight, topicOf } from "./fixtures/bridge.js";
import { fakeArchive, like, readFixture } from "./fixtures/helpers.js";

const recorded = readFixture("duskevm-deposit-history.json");
const arrived = readFixture("duskevm-deposit-arrival.json");

const TO = "0xab84edffd745af9420ac74fec73121fbee9fc86f";
const AT = Date.parse("2026-10-27T05:50:00Z");
/** What a deposit of half a DUSK pays on DuskEVM, in wei. */
const PAID = "500000000000000000";
const HALF = 500_000_000n;
const LATER = AT + 3_600_000;

/** @param {string} byte @returns {string} A Dusk transaction's hash. */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n @returns {string} A DuskEVM transaction's hash. */
const l2 = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

/**
 * A deposit of half a DUSK to TO, in a block of `at`.
 *
 * @param {string} byte
 * @param {number | null} at
 * @param {Record<string, unknown>} [fields]
 * @returns {any}
 */
const deposit = (byte, at, fields = {}) => ({ amount: HALF, at, hash: dusk(byte), to: TO, ...fields });

/**
 * @param {Awaited<ReturnType<typeof depositArrivals>>} result
 * @param {string} byte
 */
const of = (result, byte) => result.arrivals.get(dusk(byte));

describe("a deposit's arrival, on DuskEVM's explorer", () => {
  it("is the L2 bridge's payment of its amount to its recipient after it, one payment for each deposit, oldest first", async () => {
    const explorer = fakeExplorer([
      [
        call(l2(14), "2026-10-27T05:51:40.000000Z"),
        // From someone else: not the bridge's payment.
        call(l2(11), "2026-10-27T05:51:00Z", { from: `0x${"99".repeat(20)}` }),
        call(l2(13), "2026-10-27T05:50:40.000000Z"),
        // Before both: another deposit's.
        call(l2(10), "2026-10-27T05:40:00Z"),
      ],
    ]);
    const result = await depositArrivals({
      deposits: [deposit("a2", AT + 60_000), deposit("a1", AT)],
      fetch: explorer.fetch,
      network: 2,
      now: LATER,
    });

    // When it arrived: the payment's time on DuskEVM.
    assert.deepEqual(of(result, "a1"), { amount: HALF, at: Date.parse("2026-10-27T05:50:40Z"), block: 1, hash: l2(13), state: "arrived" });
    like(of(result, "a2"), { hash: l2(14), state: "arrived" });
    // The recipient's calls, asked once for both.
    assert.deepEqual(explorer.urls, [`${EXPLORER_API}/addresses/${TO}/internal-transactions?filter=to`]);
    assert.equal(result.requests, 1);
    // In the order given.
    assert.deepEqual([...result.arrivals.keys()], [dusk("a2"), dusk("a1")]);
  });

  it("isn't there without a payment of its amount after it that no other deposit has", async () => {
    const result = await depositArrivals({
      deposits: [deposit("a1", AT)],
      fetch: fakeExplorer([
        [
          call(l2(14), "2026-10-27T05:50:30Z", { value: "400000000000000000" }),
          // Another deposit's, as the app keeps it.
          call(l2(13), "2026-10-27T05:50:13Z"),
        ],
      ]).fetch,
      network: 2,
      now: LATER,
      taken: [l2(13).toUpperCase().replace("0X", "0x")],
    });

    like(of(result, "a1"), { reason: "late", state: "unknown" });
  });

  it("reads its recipient's calls a page at a time, back past its oldest deposit on its way, which then takes its own payment", async () => {
    const explorer = fakeExplorer(
      [
        [call(l2(22), "2026-10-27T06:01:00Z"), call(l2(30), "2026-10-27T05:59:00Z", { value: "7" })],
        [
          call(l2(21), "2026-10-27T05:51:00Z"),
          // Before the oldest deposit: no page further back is read.
          call(l2(20), "2026-10-27T05:40:00Z"),
        ],
        [call(l2(19), "2026-10-27T05:30:00Z")],
      ],
      { more: true, next: (page) => ({ block_number: 99 - page, filter: "to", index: page + 1, items_count: 50 }) }
    );
    const result = await depositArrivals({ deposits: [deposit("a1", AT), deposit("a2", AT + 600_000)], fetch: explorer.fetch, network: 2, now: LATER });

    like(of(result, "a1"), { hash: l2(21), state: "arrived" });
    like(of(result, "a2"), { hash: l2(22), state: "arrived" });
    assert.deepEqual(explorer.urls, [
      `${EXPLORER_API}/addresses/${TO}/internal-transactions?filter=to`,
      `${EXPLORER_API}/addresses/${TO}/internal-transactions?filter=to&block_number=99&index=1&items_count=50`,
    ]);
  });

  it("reads the pages the explorer's next_page_params name, back to the oldest deposit, so same-amount deposits each get their own", async () => {
    const NOW = Date.parse("2026-10-28T12:00:00Z");
    const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();
    const explorer = fakeExplorer(
      [[call(l2(2), ago(240_000))], [call(l2(1), ago(3_540_000))], [call(l2(3), ago(7_200_000))], [call(l2(4), ago(9_000_000))]],
      { next: (page) => ({ page: page + 1, items_count: 50 }) }
    );
    const result = await depositArrivals({
      deposits: [deposit("b", NOW - 300_000), deposit("a", NOW - 3_600_000)],
      fetch: explorer.fetch,
      network: 2,
      now: NOW,
    });

    like(of(result, "a"), { hash: l2(1), state: "arrived" });
    like(of(result, "b"), { hash: l2(2), state: "arrived" });
    assert.deepEqual(
      explorer.urls.map((url) => new URL(url).search),
      ["?filter=to", "?filter=to&page=1&items_count=50", "?filter=to&page=2&items_count=50"]
    );
  });

  it("isn't found when its recipient's calls go back further than five pages", async () => {
    const explorer = fakeExplorer(
      ["06:05", "06:04", "06:03", "06:02", "06:01"].map((time, page) => [call(l2(page + 1), `2026-10-27T${time}:00Z`)]),
      { more: true }
    );
    const result = await depositArrivals({ deposits: [deposit("a1", AT)], fetch: explorer.fetch, network: 2, now: LATER });

    like(of(result, "a1"), { reason: "beyond", state: "unknown" });
    assert.equal(explorer.urls.length, 5);

    // Five pages of later calls, one a payment of the same amount for another deposit; the deposit's own beyond them.
    const NOW = Date.parse("2026-10-28T12:00:00Z");
    const pages = [
      ...Array.from({ length: 5 }, (_, i) => [call(l2(i + 2), new Date(NOW - 60_000 * (i + 1)).toISOString(), i === 2 ? {} : { value: "1" })]),
      [call(l2(1), new Date(NOW - 3_540_000).toISOString())],
    ];
    const deep = fakeExplorer(pages, { next: (page) => ({ items_count: 50, page: page + 1 }) });

    like(of(await depositArrivals({ deposits: [deposit("a", NOW - 3_600_000)], fetch: deep.fetch, network: 2, now: NOW }), "a"), { reason: "beyond", state: "unknown" });
    assert.equal(deep.urls.length, 5);
  });

  it("is timed by its Dusk block, never the device's clock: a payment before its block, past the clock slack, isn't its", async () => {
    const explorer = fakeExplorer([
      [
        call(l2(15), "2026-10-27T05:51:00Z", { value: "400000000000000000" }),
        call(l2(13), "2026-10-27T05:50:30Z"),
        // Before its block: someone else's deposit of the same amount.
        call(l2(14), "2026-10-27T05:40:00Z", { value: "400000000000000000" }),
      ],
    ]);
    const result = await depositArrivals({
      deposits: [deposit("a1", AT), deposit("a2", AT, { amount: 400_000_000n })],
      fetch: explorer.fetch,
      network: 2,
      now: LATER,
    });

    like(of(result, "a1"), { hash: l2(13), state: "arrived" });
    like(of(result, "a2"), { amount: 400_000_000n, hash: l2(15), state: "arrived" });
  });

  it("isn't looked for until its Dusk block's time is known, and takes no payment from one whose time is", async () => {
    const explorer = fakeExplorer([[call(l2(13), "2026-10-27T05:51:00Z")]]);
    const alone = await depositArrivals({ deposits: [deposit("a1", null)], fetch: explorer.fetch, network: 2, now: LATER });

    assert.deepEqual(of(alone, "a1"), { state: "waiting" });
    assert.equal(explorer.urls.length, 0);

    const both = await depositArrivals({ deposits: [deposit("a1", null), deposit("a2", AT)], fetch: explorer.fetch, network: 2, now: LATER });

    assert.deepEqual(of(both, "a1"), { state: "waiting" });
    like(of(both, "a2"), { hash: l2(13), state: "arrived" });
  });

  it("asks once a recipient, for deposits of every amount, and keeps a payment once it arrived", async () => {
    const NOW = Date.parse("2026-10-28T12:00:00Z");
    const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString().replace("Z", "000Z");
    const explorer = fakeExplorer([
      [
        // Newest first: another sender's, another amount, then the two deposits' payments, and one from before them.
        call(l2(5), ago(60_000), { from: `0x${"11".repeat(20)}` }),
        call(l2(4), ago(60_000), { value: "1" }),
        call(l2(2), ago(100_000), { to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F" }),
        call(l2(6), ago(150_000), { value: "100000000000000000" }),
        call(l2(1), ago(3_600_000)),
      ],
    ]);
    const result = await depositArrivals({
      deposits: [deposit("a", NOW - 180_000), deposit("b", NOW - 200_000, { amount: 100_000_000n })],
      fetch: explorer.fetch,
      network: 2,
      now: NOW,
    });

    like(of(result, "a"), { at: NOW - 100_000, hash: l2(2), state: "arrived" });
    like(of(result, "b"), { amount: 100_000_000n, hash: l2(6), state: "arrived" });
    assert.equal(explorer.urls.length, 1);

    // A payment to another address than the deposit's isn't its own.
    const elsewhere = fakeExplorer([[call(l2(2), ago(100_000), { to: `0x${"22".repeat(20)}` })]]);

    like(of(await depositArrivals({ deposits: [deposit("a", NOW - 180_000)], fetch: elsewhere.fetch, network: 2, now: NOW }), "a"), { reason: "late", state: "unknown" });
  });

  it("gives deposits of the same amount to the same recipient one payment each, in order, and waits for the one still on its way", async () => {
    const NOW = Date.parse("2026-10-28T12:00:00Z");
    const ago = (/** @type {number} */ ms) => new Date(NOW - ms).toISOString();
    const deposits = [deposit("c", NOW - 120_000), deposit("a", NOW - 600_000), deposit("b", NOW - 300_000)];
    const first = await depositArrivals({
      deposits,
      fetch: fakeExplorer([[call(l2(2), ago(200_000)), call(l2(1), ago(500_000))]]).fetch,
      network: 2,
      now: NOW,
    });

    assert.deepEqual(
      ["a", "b", "c"].map((byte) => /** @type {any} */ (of(first, byte)).hash ?? null),
      [l2(1), l2(2), null]
    );

    // Its payment, later: only the third is asked for, the others' payments kept, and it gets the new one.
    const later = await depositArrivals({
      deposits: [deposit("c", NOW - 120_000)],
      fetch: fakeExplorer([[call(l2(3), ago(10_000)), call(l2(2), ago(200_000)), call(l2(1), ago(500_000))]]).fetch,
      network: 2,
      now: NOW,
      taken: [l2(1), l2(2)],
    });

    like(of(later, "c"), { hash: l2(3), state: "arrived" });
  });

  it("finds nothing when the explorer fails", async () => {
    const result = await depositArrivals({ deposits: [deposit("a", AT)], fetch: fakeExplorer([], { status: 502 }).fetch, network: 2, now: LATER });

    like(of(result, "a"), { reason: "error", state: "unknown" });
    assert.match(/** @type {any} */ (of(result, "a")).error, /HTTP 502/);
  });

  it("is waited for this week only, to a DuskEVM address, on a network with DuskEVM", async () => {
    const explorer = fakeExplorer([[call(l2(1), "2026-10-27T05:50:30Z")]]);
    const old = await depositArrivals({ deposits: [deposit("a", AT)], fetch: explorer.fetch, network: 2, now: AT + 8 * 24 * 3_600_000 });

    like(of(old, "a"), { reason: "expired", state: "unknown" });
    // Mainnet has no DuskEVM: nothing to wait for.
    const mainnet = await depositArrivals({ deposits: [deposit("a", AT)], fetch: explorer.fetch, network: 1, now: LATER });

    like(of(mainnet, "a"), { reason: "no-route", state: "unknown" });
    assert.equal(explorer.urls.length, 0);
    assert.equal(mainnet.requests, 0);

    for (const bad of [{ to: undefined }, { amount: "0" }, { amount: -1 }, { hash: "nope" }, { sender: "nope" }]) {
      await assert.rejects(depositArrivals({ deposits: [deposit("a", AT, bad)], network: 2 }), TypeError);
    }
    await assert.rejects(depositArrivals({ deposits: [], network: 99 }), TypeError);
    await assert.rejects(depositArrivals({ deposits: [], network: 2, via: /** @type {any} */ ("adapter") }), RangeError);
  });

  // A 0.5 DUSK deposit, in a block of 06:39:09 UTC, as the explorer's own tests have it.
  describe("seen alone, as the explorer sees one", () => {
    const recipient = "0x5A3d8e1B7c2f4A6b9e0D1C3f5A7b9C2D4e6F8a01";
    const ARRIVAL = "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b";
    const at = Date.parse("2024-04-16T06:39:09Z");
    const lone = { amount: 500_000_000, at, hash: dusk("d2"), to: recipient };
    // The explorer looks for a deposit however old it is.
    const forGood = { network: 2, waitMs: Infinity };
    /** @param {number} n */
    const hash = (n) => `0x${String(n).repeat(64)}`;
    /** @param {any[]} items @param {object | null} [next] */
    const explorer = (items, next = null) => {
      /** @type {string[]} */
      const urls = [];
      /** @type {any[]} */
      const inits = [];

      return {
        fetch: async (/** @type {string} */ url, /** @type {any} */ init) => {
          urls.push(url);
          inits.push(init);

          return Response.json({ items, next_page_params: next });
        },
        inits,
        urls,
      };
    };

    it("is the L2 bridge's payment of its amount after its block, found with one request", async () => {
      const view = explorer(
        [
          // Another deposit's, later.
          call(hash(1), "2024-04-16T06:52:00.000000Z"),
          call(ARRIVAL, "2024-04-16T06:39:45.000000Z"),
          call(hash(2), "2024-04-16T06:39:40.000000Z", { from: "0x5a3d8e1b7c2f4a6b9e0d1c3f5a7b9c2d4e6f8a02" }),
          call(hash(3), "2024-04-16T06:39:35.000000Z", { value: "100000000000000000" }),
          // From before the deposit.
          call(hash(5), "2024-04-16T06:30:00.000000Z"),
        ],
        { block_number: 1, index: 0, items_count: 50 }
      );
      const result = await depositArrivals({ deposits: [lone], fetch: view.fetch, ...forGood });

      like(result.arrivals.get(dusk("d2")), { hash: ARRIVAL, state: "arrived" });
      assert.deepEqual(view.urls, [`https://explorer.testnet.evm.dusk.network/api/v2/addresses/${recipient.toLowerCase()}/internal-transactions?filter=to`]);
      assert.equal(view.inits[0].headers.accept, "application/json");
    });

    it("is none on a first page that doesn't reach back to it, when that page is all it reads, nor when the explorer can't say", async () => {
      const newer = [call(ARRIVAL, "2024-04-16T06:39:45.000000Z")];
      const one = await depositArrivals({ deposits: [lone], fetch: explorer(newer, { block_number: 1, index: 0, items_count: 50 }).fetch, maxPages: 1, ...forGood });

      like(one.arrivals.get(dusk("d2")), { reason: "beyond", state: "unknown" });
      // The last page reaches back to the start.
      like((await depositArrivals({ deposits: [lone], fetch: explorer(newer).fetch, maxPages: 1, ...forGood })).arrivals.get(dusk("d2")), { hash: ARRIVAL, state: "arrived" });
      like(
        (await depositArrivals({ deposits: [lone], fetch: async () => new Response("", { status: 502 }), ...forGood })).arrivals.get(dusk("d2")),
        { reason: "error", state: "unknown" }
      );
    });

    it("is unsure when another payment of its amount near its block could be its own", async () => {
      // D1 paid the same address the same amount 2½ minutes before this deposit, D2: DuskEVM paid D1 (p1) within two minutes of D2's block.
      const d1 = { ...lone, at: Date.parse("2024-04-16T06:36:39Z"), hash: dusk("d1") };
      const p1 = call(hash(1), "2024-04-16T06:37:15.000000Z");
      const p2 = call(ARRIVAL, "2024-04-16T06:39:45.000000Z");

      like((await depositArrivals({ deposits: [lone], fetch: explorer([p2, p1]).fetch, ...forGood })).arrivals.get(dusk("d2")), { reason: "unsure", state: "unknown" });
      // Near D1's block, p1 is alone.
      like((await depositArrivals({ deposits: [d1], fetch: explorer([p2, p1]).fetch, ...forGood })).arrivals.get(dusk("d1")), { hash: hash(1), state: "arrived" });
      // A payment of the amount that failed could be this deposit's too.
      const failed = call(hash(4), "2024-04-16T06:39:30.000000Z", { success: false });

      like((await depositArrivals({ deposits: [lone], fetch: explorer([p2, failed]).fetch, ...forGood })).arrivals.get(dusk("d2")), { reason: "unsure", state: "unknown" });
    });

    it("asks nothing until two minutes after its block: its own payment may yet come", async () => {
      // An earlier deposit's payment, while this one's is on its way.
      const view = explorer([call(hash(1), "2024-04-16T06:39:20.000000Z")]);
      const result = await depositArrivals({ deposits: [lone], fetch: view.fetch, ...forGood, now: at + 60_000 });

      assert.deepEqual(result.arrivals.get(dusk("d2")), { state: "waiting" });
      assert.equal(view.urls.length, 0);
    });
  });

  it("is the recorded testnet deposit's payment, as DuskEVM's explorer lists it", async () => {
    const node = fakeArchive({ details: recorded.details, url: recorded.nodeUrl });
    const entry = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(recorded.account, recorded.entry));
    const read = await fetchTxDetails(node.archiveClient(), [entry.hash], { args: new Set([entry.hash]), network: 2 });
    const found = depositOf({ ...entry, ...read.get(entry.hash), value: entry.value }, recorded.account);

    like(found, { amount: HALF, at: 1_793_080_299_000, hash: entry.hash, sender: recorded.account, to: recorded.recipient });

    /** @type {string[]} */
    const urls = [];
    const result = await depositArrivals({
      deposits: [/** @type {any} */ (found)],
      fetch: async (url) => {
        urls.push(url);

        return Response.json(arrived.explorer.body);
      },
      network: 2,
      now: Date.parse("2026-10-30T12:00:00Z"),
    });

    assert.deepEqual(urls, [arrived.explorer.url]);
    assert.deepEqual(result.arrivals.get(entry.hash), {
      amount: HALF,
      at: Date.parse("2026-10-27T05:52:13Z"),
      block: 3_951_755,
      hash: "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b",
      state: "arrived",
    });
  });
});

describe("a deposit's arrival, on DuskEVM's RPC", () => {
  // Any valid Dusk account works as the sender.
  const SENDER = networks.mainnet.routes.services[0].account;
  const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
  const FROM = evmAddressOf(SENDER);
  const TENTH = 100_000_000n;
  const WEI = TENTH * 1_000_000_000n;
  /** Block n of the chain's, made at second 1_792_980_000 + n. */
  const second = (/** @type {number} */ n) => (1_792_980_000 + n) * 1000;
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 5_000, sender: SENDER, to: RECIPIENT, ...fields });
  /** @param {string | number} n @param {number} block */
  const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: l2(n), to: RECIPIENT, wei: WEI });
  /**
   * The archive, its sender's history listing `deposits`, as it does once
   * their blocks are final, with their calls.
   *
   * @param {...any} deposits
   */
  const listing = (...deposits) =>
    fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: [...deposits].sort((a, b) => a.height - b.height).map((d) => depositEntry({ hash: d.hash, height: d.height, sender: SENDER, value: d.amount })) } },
      details: Object.fromEntries(deposits.map((d) => [d.hash, details(Math.floor(d.at / 1000), { deposit: { amountLux: d.amount, to: RECIPIENT } })])),
      finalized: 10_000,
    }).archiveClient();

  it("is DuskEVM's bridge paying it from its sender's DuskEVM address, once the event is there", async () => {
    const chain = fakeChain({ head: 2_000 });
    const deposit = sent("ab", second(999), { height: 10 });
    const options = { archive: listing(deposit), deposits: [deposit], fetch: chain.fetch, network: 2, now: second(2_000), via: /** @type {const} */ ("rpc") };
    const waiting = await depositArrivals(options);

    like(waiting.arrivals.get(dusk("ab")), { state: "waiting" });

    const [asked] = chain.calls.filter((c) => c.method === "eth_getLogs");

    assert.equal(asked.params[0].address, L2_BRIDGE.toLowerCase());
    assert.deepEqual(asked.params[0].topics, [ETH_BRIDGE_FINALIZED_TOPIC, topicOf(FROM), topicOf(RECIPIENT)]);
    assert.equal(asked.url, networks.testnet.duskEvm?.rpcUrl);

    chain.logs.push(credit(34, 1_900));

    assert.deepEqual((await depositArrivals(options)).arrivals.get(dusk("ab")), { amount: TENTH, at: second(1_900), block: 1_900, hash: l2(34), state: "arrived" });
  });

  it("gives two equal deposits one credit between them", async () => {
    const chain = fakeChain({ head: 2_000, logs: [credit(34, 1_900)] });
    const both = await depositArrivals({
      archive: listing(sent("ef", second(200)), sent("ab", second(100))),
      deposits: [sent("ef", second(200)), sent("ab", second(100))],
      fetch: chain.fetch,
      network: 2,
      now: second(2_000),
      via: "rpc",
    });

    like(both.arrivals.get(dusk("ab")), { hash: l2(34), state: "arrived" });
    like(both.arrivals.get(dusk("ef")), { state: "waiting" });

    // The first one's credit kept, the second asked alone.
    const alone = await depositArrivals({
      archive: listing(sent("ef", second(200)), sent("ab", second(100))),
      deposits: [sent("ef", second(200))],
      fetch: chain.fetch,
      network: 2,
      now: second(2_000),
      taken: [l2(34)],
      via: "rpc",
    });

    like(alone.arrivals.get(dusk("ef")), { state: "waiting" });
  });

  it("leaves the earlier equal deposit's credit to it, on a device that only knows the later one: the sender's history says which came first", async () => {
    const earlier = dusk("ef");
    // The earlier one paid its unspent gas to another account: its sender paid more than the bridge took.
    const history = (/** @type {any[]} */ others) => ({
      [SENDER]: {
        receiver: [],
        sender: [...others, depositEntry({ hash: earlier, height: 4_990, refundTo: networks.testnet.routes.services[0].account, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("ab"), height: 5_000, sender: SENDER, value: TENTH })],
      },
    });
    // Deposits of another amount, a page and more of them.
    const others = Array.from({ length: 58 }, (_, i) => depositEntry({ hash: i.toString(16).padStart(64, "f"), height: 4_000 + i, sender: SENDER, value: 5 }));
    const calls = {
      [dusk("ab")]: details(1_792_980_200, { deposit: { amountLux: TENTH, to: RECIPIENT } }),
      [earlier]: details(1_792_980_100, { deposit: { amountLux: TENTH, to: RECIPIENT } }),
    };
    const node = fakeArchive({ accounts: history(others), details: calls, finalized: 10_000 });
    const chain = fakeChain({ head: 2_000, logs: [credit(34, 1_900)] });
    const options = { archive: node.archiveClient(), deposits: [sent("ab", second(200))], fetch: chain.fetch, network: 2, now: second(2_000), via: /** @type {const} */ ("rpc") };

    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { state: "waiting" });
    // The sender's history, a few hours up to this deposit, read a page at a time.
    assert.match(node.historyQueries()[0].query, new RegExp(`moonlightHistory\\(sender: "${SENDER}", fromBlock: 2840, toBlock: 5000, maxCount: 50\\)`));
    // Only the deposits of at least its amount are read further.
    assert.deepEqual(
      node.detailQueries().flatMap((l) => [...l.query.matchAll(/tx\(hash: "([0-9a-f]{64})"\)/g)].map((m) => m[1])),
      [earlier]
    );

    chain.logs.push(credit(35, 1_950));
    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { hash: l2(35), state: "arrived" });

    // A history longer than one call reads: the deposit waits, and the next call reads on from its scan.
    const long = fakeArchive({
      accounts: history(Array.from({ length: 201 }, (_, i) => moonlight({ hash: i.toString(16).padStart(64, "0"), height: 3_000 + i, receiver: networks.testnet.routes.services[0].account, sender: SENDER, value: TENTH }))),
      details: calls,
      finalized: 10_000,
    });
    const stopped = /** @type {any} */ ((await depositArrivals({ ...options, archive: long.archiveClient() })).arrivals.get(dusk("ab")));

    like(stopped, { state: "waiting" });
    like((await depositArrivals({ ...options, archive: long.archiveClient(), deposits: [sent("ab", second(200), { scan: stopped.scan })] })).arrivals.get(dusk("ab")), { hash: l2(35), state: "arrived" });
  });

  it("isn't paid by a credit from before it was sent here: the head the app read before sending bounds the search", async () => {
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 1_500), credit(2, 1_800)] });
    const result = await depositArrivals({
      archive: listing(sent("ab", second(999), { height: 10 })),
      deposits: [sent("ab", second(999), { height: 10, notBefore: "1700" })],
      fetch: chain.fetch,
      network: 2,
      now: second(2_000),
      via: "rpc",
    });

    like(result.arrivals.get(dusk("ab")), { hash: l2(2), state: "arrived" });
    assert.deepEqual(chain.ranges(), [[1_700n, 2_000n]]);
  });

  it("carries on from where its last search stopped, and says how far it got", async () => {
    // A credit 30,000 blocks after the deposit: more than two windows.
    const chain = fakeChain({ head: 40_000, logs: [credit(9, 32_000)] });
    const options = { archive: listing(sent("ab", second(2_000), { height: 10 })), fetch: chain.fetch, maxWindows: 2, network: 2, now: second(40_000), via: /** @type {const} */ ("rpc") };
    const first = await depositArrivals({ ...options, deposits: [sent("ab", second(2_000), { height: 10 })] });
    const stopped = /** @type {any} */ (first.arrivals.get(dusk("ab")));

    like(stopped, { reason: "searching", state: "unknown" });
    assert.equal(stopped.scan.basis, second(2_000));

    /** @type {any} */
    let result = first.arrivals.get(dusk("ab"));

    for (let i = 0; i < 5 && result.state !== "arrived"; i += 1) {
      result = (await depositArrivals({ ...options, deposits: [sent("ab", second(2_000), { height: 10, scan: result.scan })] })).arrivals.get(dusk("ab"));
    }

    like(result, { hash: l2(9), state: "arrived" });
    // Each search went on from the last one's end.
    const ranges = chain.ranges();

    for (let i = 1; i < ranges.length; i += 1) assert.equal(ranges[i][0], ranges[i - 1][1] + 1n);
  });

  it("without the sender's history, is its credit only alone in its window, read no further than the window", async () => {
    // A head far past the deposit: a search to it would take many windows.
    const chain = fakeChain({ head: 40_000, logs: [credit(1, 1_060)] });
    const options = { deposits: [sent("ab", second(1_000), { height: null })], fetch: chain.fetch, network: 2, now: second(40_000), via: /** @type {const} */ ("rpc") };

    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { hash: l2(1), state: "arrived" });
    assert.equal(chain.ranges().length, 1);

    // Another credit of its amount in its window: it could be another deposit's.
    chain.logs.push(credit(2, 1_090));
    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { reason: "unsure", state: "unknown" });
  });

  it("is the recorded testnet deposit's credit, its time from the log itself", async () => {
    /** @type {string[]} */
    const methods = [];
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
      const { method, params } = JSON.parse(init.body);

      methods.push(method);
      assert.equal(url, arrived.rpc.url);

      if (method === "eth_blockNumber") return Response.json({ id: 1, jsonrpc: "2.0", result: "0x3c4c90" });

      assert.deepEqual(params[0].topics, arrived.rpc.filter.topics);

      return Response.json({ id: 1, jsonrpc: "2.0", result: arrived.rpc.logs });
    };
    const result = await depositArrivals({
      deposits: [{ amount: HALF, at: 1_793_080_299_000, hash: recorded.entry.origin, notBefore: "0x3c4c86", sender: recorded.account, to: recorded.recipient }],
      fetch,
      network: 2,
      now: Date.parse("2026-10-30T12:00:00Z"),
      via: "rpc",
    });

    assert.deepEqual(result.arrivals.get(recorded.entry.origin), {
      amount: HALF,
      at: Date.parse("2026-10-27T05:52:13Z"),
      block: 3_951_755,
      hash: "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b",
      state: "arrived",
    });
    // Without the archive its window had to close, as on the explorer; no block was read for its time.
    assert.deepEqual(methods, ["eth_blockNumber", "eth_getLogs"]);
  });

  it("checks each log: from the L2 bridge, with the topics and the amount asked, its data laid out as the event's", async () => {
    const good = credit(1, 1_900);
    const chain = fakeChain({
      head: 2_000,
      logs: [
        { ...good, hash: l2(2), topics: [ETH_BRIDGE_FINALIZED_TOPIC, topicOf(FROM)] },
        { ...good, data: `${good.data}00`, hash: l2(3) },
        { ...good, data: good.data.replace(/0{62}40/, `${"0".repeat(62)}60`), hash: l2(4) },
      ],
    });
    // An RPC that answers more than it was asked.
    const loose = async (/** @type {string} */ url, /** @type {any} */ init) => {
      const body = JSON.parse(init.body);

      if (body.method !== "eth_getLogs") return chain.fetch(url, init);

      const logs = chain.logs.map((log) => ({ address: log.address, blockNumber: hex(log.block), data: log.data, topics: log.topics, transactionHash: log.hash }));

      return Response.json({ id: 1, jsonrpc: "2.0", result: [...logs, { ...logs[0], address: `0x${"42".repeat(20)}`, transactionHash: l2(5) }, { ...logs[0], removed: true, transactionHash: l2(6) }] });
    };
    const options = { archive: listing(sent("ab", second(999), { height: 10 })), deposits: [sent("ab", second(999), { height: 10 })], fetch: loose, network: 2, now: second(2_000), via: /** @type {const} */ ("rpc") };

    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { state: "waiting" });

    chain.logs.push(good);
    like((await depositArrivals(options)).arrivals.get(dusk("ab")), { hash: l2(1), state: "arrived" });
  });
});

describe("a deposit, from the history", () => {
  const account = recorded.account;
  /** @param {Record<string, unknown>} fields @returns {any} */
  const row = (fields) => ({
    blockHeight: 4_700_000,
    bridge: { amount: "100000000", kind: "deposit", to: "0xB0E834d62CA3f5cF0F82619c8515c673818f8C6b" },
    counterparty: BRIDGE,
    direction: "out",
    hash: dusk("51"),
    kind: "contract_call",
    memo: "",
    payer: true,
    success: true,
    timestamp: Date.parse("2026-10-26T04:49:20Z"),
    value: "100000000",
    ...fields,
  });

  it("is followed as one sent from here: the DuskEVM address its call names, timed by its block", () => {
    assert.deepEqual(depositOf(row({}), account), {
      amount: 100_000_000n,
      at: Date.parse("2026-10-26T04:49:20Z"),
      hash: dusk("51"),
      height: 4_700_000,
      sender: account,
      to: "0xB0E834d62CA3f5cF0F82619c8515c673818f8C6b",
    });
    // Before its details: no time yet, so it isn't looked for.
    like(depositOf(row({ success: null, timestamp: null }), account), { at: null });
  });

  it("isn't one that failed on Dusk, that another account sent, or another call", () => {
    for (const fields of [
      { success: false },
      { payer: false },
      { bridge: null },
      { bridge: { hash: `0x${"8e".repeat(32)}`, kind: "claim" } },
      { bridge: { amount: "0", kind: "deposit", to: "0xB0E834d62CA3f5cF0F82619c8515c673818f8C6b" } },
    ]) {
      assert.equal(depositOf(row(fields), account), null);
    }
  });

  it("arrived, is where /activity's row of the deposit says it arrived", async () => {
    const node = fakeArchive({ details: recorded.details, url: recorded.nodeUrl });
    const parsed = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(recorded.account, recorded.entry));
    const read = await fetchTxDetails(node.archiveClient(), [parsed.hash], { args: new Set([parsed.hash]), network: 2 });
    // The entry as `/history` reads it.
    const entry = historyEntry({ ...parsed, ...read.get(parsed.hash), value: parsed.value.toString() }, { network: 2 });
    const { arrivals } = await depositArrivals({
      deposits: [/** @type {any} */ (depositOf(entry, recorded.account))],
      fetch: async () => Response.json(arrived.explorer.body),
      network: 2,
      now: Date.parse("2026-10-30T12:00:00Z"),
    });
    const [row] = activityRows({ account: recorded.account, arrivals: arrivalsOf(arrivals), network: 2, public: [entry] });

    like(row.bridge, { step: "deposit", to: recorded.recipient });
    assert.deepEqual(row.bridge?.arrival, { at: Date.parse("2026-10-27T05:52:13Z"), hash: "0x029e2c6ebfe60452800c97eaa2ac36f40039812679c9cee414ea6a8b1877d61b" });
  });

  it("arrived, as /activity's arrivals take it", () => {
    const arrivals = arrivalsOf(
      new Map(
        /** @type {[string, import("../src/bridge.js").Arrival][]} */ ([
          [dusk("a1"), { amount: HALF, at: 1, block: 2, hash: l2(1), state: "arrived" }],
          [dusk("a2"), { state: "waiting" }],
          [dusk("a3"), { reason: "unsure", state: "unknown" }],
        ])
      )
    );

    assert.deepEqual([...arrivals], [[dusk("a1"), { at: 1, hash: l2(1) }]]);
  });
});
