// The history each transfer's match needs, read for that transfer alone: an
// earlier one never waits on a later one's, and a history longer than one
// call reads is read on from the transfer's scan, which waits till then
// rather than staying unsure for good.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { HISTORY_PAGES, depositArrivals, serviceArrivals } from "../src/bridge.js";
import { BRIDGE, bridgeFinalized, depositEntry, details, fakeChain, moonlight, tokenTransfer, transferTx, withRoutes } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const DUSK = 1_000_000_000n;
const TENTH = 100_000_000n;
// Any valid Dusk account works as a sender.
const SENDER = networks.mainnet.routes.services[0].account;
const OTHER = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";

/** @param {string} byte */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n */
const evmHash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
/** Block n of a chain made at second 1_792_980_000 + n, in milliseconds. */
const second = (/** @type {number} */ n) => (1_792_980_000 + n) * 1000;

/**
 * `count` public transfers, one a block from `height` on, none of them a
 * transfer the bridge pays.
 *
 * @param {number} count @param {number} height
 * @param {{ sender: string, receiver: string, memo?: string, value: bigint | number }} transfer
 */
const busy = (count, height, transfer) => Array.from({ length: count }, (_, i) => moonlight({ ...transfer, hash: (0xb0000 + i).toString(16).padStart(64, "0"), height: height + i }));

/** @param {{ query: string }[]} log */
const historyReads = (log) => log.filter((each) => each.query.includes("moonlightHistory")).length;

describe("deposits to DuskEVM, on its RPC with the sender's history", () => {
  const FROM = evmAddressOf(SENDER);
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 5_000, sender: SENDER, to: RECIPIENT, ...fields });
  /** @param {string | number} n @param {number} block */
  const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: evmHash(n), to: RECIPIENT, wei: TENTH * DUSK });
  const asDeposit = (/** @type {number} */ seconds) => details(seconds, { deposit: { amountLux: TENTH, to: RECIPIENT } });

  it("an earlier one settles on its own history, whatever a later equal one's holds; the later one reads on from its scan (#34)", async () => {
    // The earlier deposit, 201 other transfers of its sender's, then the later one, an hour after.
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [
            depositEntry({ hash: dusk("d1"), height: 10_000, sender: SENDER, value: TENTH }),
            ...busy(201, 10_001, { receiver: OTHER, sender: SENDER, value: 1 }),
            depositEntry({ hash: dusk("d2"), height: 10_360, sender: SENDER, value: TENTH }),
          ],
        },
      },
      details: { [dusk("d1")]: asDeposit(1_792_980_100), [dusk("d2")]: asDeposit(1_792_983_700) },
      finalized: 20_000,
    });
    // The earlier one's credit, before the later one was sent.
    const chain = fakeChain({ head: 5_000, logs: [credit(1, 1_900)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: 2, now: second(5_000), via: /** @type {const} */ ("rpc") };
    const d1 = sent("d1", second(100), { height: 10_000 });
    const d2 = sent("d2", second(3_700), { height: 10_360 });
    const first = await depositArrivals({ ...options, deposits: [d1, d2] });
    const later = /** @type {any} */ (first.arrivals.get(dusk("d2")));

    like(first.arrivals.get(dusk("d1")), { hash: evmHash(1), state: "arrived" });
    // Its own hours hold more than one call reads: it waits, with where its reading stopped.
    like(later, { state: "waiting" });
    assert.ok(later.scan);
    assert.ok(historyReads(node.log) <= 2 * HISTORY_PAGES);

    // Read on from there; its own credit came meanwhile.
    chain.logs.push(credit(2, 4_000));

    const next = await depositArrivals({ ...options, deposits: [{ ...d2, scan: later.scan }], taken: [evmHash(1)] });

    like(next.arrivals.get(dusk("d2")), { hash: evmHash(2), state: "arrived" });
  });

  it("waits while the archive hasn't read its block yet, and then counts an equal one sent just before it", async () => {
    // An equal deposit from another device five blocks before it; only that one's credit so far.
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("e1"), height: 5_000, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("d1"), height: 5_005, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("e1")]: asDeposit(1_792_980_100), [dusk("d1")]: asDeposit(1_792_980_150) },
      // Neither block read into the archive yet.
      finalized: 4_999,
    });
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 300)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: 2, now: second(2_000), via: /** @type {const} */ ("rpc") };
    const d1 = sent("d1", second(150), { height: 5_005 });
    const first = /** @type {any} */ ((await depositArrivals({ ...options, deposits: [d1] })).arrivals.get(dusk("d1")));

    like(first, { state: "waiting" });

    // Read now: the credit there is the earlier one's.
    node.finalized = 10_000;
    like((await depositArrivals({ ...options, deposits: [{ ...d1, scan: first.scan }] })).arrivals.get(dusk("d1")), { state: "waiting" });
  });

  it("tells an earlier deposit the app gave apart by its own facts, where its call can't be read", async () => {
    // An earlier deposit of twice as much to the same address, whose call the archive doesn't give.
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("d1"), height: 5_000, sender: SENDER, value: 2n * TENTH }), depositEntry({ hash: dusk("d2"), height: 5_005, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d2")]: asDeposit(1_792_980_150) },
      finalized: 10_000,
    });
    const chain = fakeChain({ head: 2_000, logs: [bridgeFinalized({ block: 300, from: FROM, hash: evmHash(1), to: RECIPIENT, wei: 2n * TENTH * DUSK }), credit(2, 310)] });
    const { arrivals } = await depositArrivals({
      archive: node.archiveClient(),
      deposits: [sent("d1", second(100), { amount: 2n * TENTH, height: 5_000 }), sent("d2", second(150), { height: 5_005 })],
      fetch: chain.fetch,
      network: 2,
      now: second(2_000),
      via: "rpc",
    });

    like(arrivals.get(dusk("d1")), { hash: evmHash(1), state: "arrived" });
    like(arrivals.get(dusk("d2")), { hash: evmHash(2), state: "arrived" });
  });

  it("counts an earlier equal deposit the app gave, still read on, before a later one, where its call's arguments can't be read", async () => {
    // The earlier one's hours hold 201 other transfers under it, the later one's, 50 minutes on, don't.
    const unreadable = details(1_792_980_100, { deposit: { amountLux: TENTH, to: RECIPIENT } });

    delete unreadable.tx.callData.data;
    assert.equal(unreadable.tx.callData.contractId, BRIDGE);

    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [
            ...busy(201, 7_840, { receiver: OTHER, sender: SENDER, value: 1 }),
            depositEntry({ hash: dusk("d1"), height: 10_000, sender: SENDER, value: TENTH }),
            depositEntry({ hash: dusk("d2"), height: 10_300, sender: SENDER, value: TENTH }),
          ],
        },
      },
      details: { [dusk("d1")]: unreadable, [dusk("d2")]: asDeposit(1_792_983_100) },
      finalized: 20_000,
    });
    // One credit so far, after both were sent: the earlier one's.
    const chain = fakeChain({ head: 5_000, logs: [credit(1, 3_200)] });
    const { arrivals } = await depositArrivals({
      archive: node.archiveClient(),
      deposits: [sent("d1", second(100), { height: 10_000 }), sent("d2", second(3_100), { height: 10_300 })],
      fetch: chain.fetch,
      network: 2,
      now: second(5_000),
      via: "rpc",
    });

    like(arrivals.get(dusk("d1")), { state: "waiting" });
    assert.notEqual(arrivals.get(dusk("d2"))?.state, "arrived");
  });

  it("keeps how far its history is read when DuskEVM's RPC fails, and reads none of it again", async () => {
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [...busy(201, 9_000, { receiver: OTHER, sender: SENDER, value: 1 }), depositEntry({ hash: dusk("d1"), height: 10_000, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d1")]: asDeposit(1_792_980_100) },
      finalized: 20_000,
    });
    const chain = fakeChain({ head: 5_000, logs: [credit(1, 300)] });
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const options = { archive: node.archiveClient(), network: 2, now: second(5_000), via: /** @type {const} */ ("rpc") };
    const d1 = sent("d1", second(100), { height: 10_000 });
    const first = /** @type {any} */ ((await depositArrivals({ ...options, deposits: [d1], fetch: down })).arrivals.get(dusk("d1")));

    like(first, { state: "waiting" });

    const failed = /** @type {any} */ ((await depositArrivals({ ...options, deposits: [{ ...d1, scan: first.scan }], fetch: down })).arrivals.get(dusk("d1")));

    like(failed, { reason: "error", state: "unknown" });
    assert.equal(failed.scan?.history?.next, null);

    const reads = historyReads(node.log);
    const next = await depositArrivals({ ...options, deposits: [{ ...d1, scan: failed.scan }], fetch: chain.fetch });

    like(next.arrivals.get(dusk("d1")), { hash: evmHash(1), state: "arrived" });
    assert.equal(historyReads(node.log), reads);
  });

  it("reads further down while a run of equal deposits reaches the bottom of what it read: the run's first takes the first credit", async () => {
    // Five equal deposits 100 minutes apart, from another device: the last one's own hours hold the four before it but the first.
    const heights = [10_000, 10_600, 11_200, 11_800, 12_400];
    const node = fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: heights.map((height, i) => depositEntry({ hash: dusk(`d${i}`), height, sender: SENDER, value: TENTH })) } },
      details: Object.fromEntries(heights.map((height, i) => [dusk(`d${i}`), asDeposit(1_792_980_100 + (height - 10_000) * 10)])),
      finalized: 20_000,
    });
    // The bridge paid all five at once, after the last was sent.
    const chain = fakeChain({ head: 30_000, logs: [0, 1, 2, 3, 4].map((n) => credit(n, 24_200 + n)) });
    const { arrivals } = await depositArrivals({
      archive: node.archiveClient(),
      deposits: [sent("d4", second(24_100), { height: 12_400 })],
      fetch: chain.fetch,
      network: 2,
      now: second(30_000),
      via: "rpc",
    });

    like(arrivals.get(dusk("d4")), { hash: evmHash(4), state: "arrived" });
  });
});

describe("transfers out to another chain, with the route's account's history", () => {
  const PAYOUT = `0x${"77".repeat(20)}`;
  const ROUTE = networks.testnet.routes.services[0];
  const net = withRoutes(networks.testnet, { services: { "dusk-to-ethereum": { payoutAddress: PAYOUT } } });
  const TOKEN = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
  /** @param {string} n @param {number} block */
  const paid = (n, block) => tokenTransfer({ block, from: PAYOUT, hash: evmHash(n), to: RECIPIENT, token: TOKEN, wei: DUSK * DUSK });
  // Others' transfers to the route's account, for another address.
  const others = { memo: `0x${"12".repeat(20)}`, receiver: ROUTE.account, sender: OTHER, value: 2n * DUSK };

  /**
   * The route's account's history: `listed` as it received them, and the
   * transactions of `sent`, two DUSK each to RECIPIENT.
   *
   * @param {any[]} listed
   * @param {{ byte: string, height: number, seconds: number }[]} sent
   */
  function archiveOf(listed, sent) {
    return fakeArchive({
      accounts: { [ROUTE.account]: { receiver: listed, sender: [] } },
      details: {},
      finalized: 400_000,
      transactions: Object.fromEntries(
        sent.map(({ byte, height, seconds }) => [dusk(byte), transferTx({ height, memo: RECIPIENT, receiver: ROUTE.account, seconds, sender: SENDER, value: 2n * DUSK })])
      ),
    });
  }

  /** @param {string} byte @param {number} height */
  const received = (byte, height) => moonlight({ hash: dusk(byte), height, memo: RECIPIENT, receiver: ROUTE.account, sender: SENDER, value: 2n * DUSK });

  it("an old transfer and a recent one each read only their own hours of a busy account's history (#34)", async () => {
    // The old one, 201 others' transfers some days later, and a recent equal one.
    const node = archiveOf(
      [received("e1", 1_000), ...busy(201, 15_000, others), received("e2", 30_000)],
      [
        { byte: "e1", height: 1_000, seconds: 1_792_980_100 },
        { byte: "e2", height: 30_000, seconds: 1_793_270_100 },
      ]
    );
    const chain = fakeChain({ head: 300_000, logs: [paid("0a", 1_500), paid("0b", 290_600)] });
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      maxWindows: 100,
      network: net,
      now: second(300_000),
      transfers: [
        { hash: dusk("e1"), route: ROUTE.id },
        { hash: dusk("e2"), route: ROUTE.id },
      ],
      waitMs: Infinity,
    });

    like(arrivals.get(dusk("e1")), { hash: evmHash("0a"), state: "arrived" });
    like(arrivals.get(dusk("e2")), { hash: evmHash("0b"), state: "arrived" });

    // An earlier transfer of the old one's hours that can't be read leaves the old one unsure, and the recent one as it was.
    const unread = archiveOf(
      [received("ee", 900), received("e1", 1_000), ...busy(201, 15_000, others), received("e2", 30_000)],
      [
        { byte: "e1", height: 1_000, seconds: 1_792_980_100 },
        { byte: "e2", height: 30_000, seconds: 1_793_270_100 },
      ]
    );
    const after = await serviceArrivals({
      archive: unread.archiveClient(),
      fetch: chain.fetch,
      maxWindows: 100,
      network: net,
      now: second(300_000),
      transfers: [
        { hash: dusk("e1"), route: ROUTE.id },
        { hash: dusk("e2"), route: ROUTE.id },
      ],
      waitMs: Infinity,
    });

    like(after.arrivals.get(dusk("e1")), { reason: "unsure", state: "unknown" });
    like(after.arrivals.get(dusk("e2")), { hash: evmHash("0b"), state: "arrived" });
  });

  it("an earlier transfer that can't be read but paid too little to pay out as much under the route's fee leaves it as it is", async () => {
    // One and a half DUSK naming the same address, just before: one DUSK's fee leaves less than the payout.
    const node = archiveOf(
      [moonlight({ hash: dusk("ef"), height: 900, memo: RECIPIENT, receiver: ROUTE.account, sender: SENDER, value: (3n * DUSK) / 2n }), received("e1", 1_000)],
      [{ byte: "e1", height: 1_000, seconds: 1_792_980_100 }]
    );
    const chain = fakeChain({ head: 300_000, logs: [paid("0a", 1_500)] });
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(300_000),
      transfers: [{ hash: dusk("e1"), route: ROUTE.id }],
      waitMs: Infinity,
    });

    like(arrivals.get(dusk("e1")), { hash: evmHash("0a"), state: "arrived" });
  });

  it("a recent one searched with an old equal one is searched from its own block once the old one arrived", async () => {
    const node = archiveOf(
      [received("e1", 1_000), ...busy(201, 15_000, others), received("e2", 30_000)],
      [
        { byte: "e1", height: 1_000, seconds: 1_792_980_100 },
        { byte: "e2", height: 30_000, seconds: 1_793_270_100 },
      ]
    );
    const chain = fakeChain({ head: 300_000, logs: [paid("0a", 1_500), paid("0b", 290_600)] });
    // Two windows a call: not as far as the recent one's payout.
    const options = { archive: node.archiveClient(), fetch: chain.fetch, maxWindows: 2, network: net, now: second(300_000), waitMs: Infinity };
    const first = await serviceArrivals({
      ...options,
      transfers: [
        { hash: dusk("e1"), route: ROUTE.id },
        { hash: dusk("e2"), route: ROUTE.id },
      ],
    });
    const recent = /** @type {any} */ (first.arrivals.get(dusk("e2")));

    like(first.arrivals.get(dusk("e1")), { hash: evmHash("0a"), state: "arrived" });
    // Their one search went from the old one's block as far as one call goes.
    like(recent, { reason: "searching", state: "unknown" });

    // The old one's arrival kept, the recent one asked alone: none of its payouts is before its own block.
    const next = await serviceArrivals({ ...options, taken: [evmHash("0a")], transfers: [{ hash: dusk("e2"), route: ROUTE.id, scan: recent.scan }] });

    like(next.arrivals.get(dusk("e2")), { hash: evmHash("0b"), state: "arrived" });
  });

  it("an earlier one settles on its own hours; a later one whose hours hold more than one call reads waits, and reads on from its scan (#34)", async () => {
    // An earlier transfer, 250 others' transfers, then a later equal one.
    const node = archiveOf(
      [received("e1", 19_000), ...busy(250, 20_000, others), received("e2", 25_000)],
      [
        { byte: "e1", height: 19_000, seconds: 1_793_070_000 },
        { byte: "e2", height: 25_000, seconds: 1_793_130_000 },
      ]
    );
    // The earlier one's payout, before the later one was sent.
    const chain = fakeChain({ head: 160_000, logs: [paid("0a", 90_500)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, maxWindows: 20, network: net, now: second(160_000) };
    const first = await serviceArrivals({
      ...options,
      transfers: [
        { hash: dusk("e1"), route: ROUTE.id },
        { hash: dusk("e2"), route: ROUTE.id },
      ],
    });
    const later = /** @type {any} */ (first.arrivals.get(dusk("e2")));

    like(first.arrivals.get(dusk("e1")), { hash: evmHash("0a"), state: "arrived" });
    like(later, { state: "waiting" });
    assert.ok(later.scan);
    assert.ok(historyReads(node.log) <= 2 * HISTORY_PAGES);

    // Read on from there; its own payout came meanwhile.
    chain.logs.push(paid("0b", 150_500));

    const next = await serviceArrivals({ ...options, taken: [evmHash("0a")], transfers: [{ hash: dusk("e2"), route: ROUTE.id, scan: later.scan }] });

    like(next.arrivals.get(dusk("e2")), { hash: evmHash("0b"), state: "arrived" });
  });
});
