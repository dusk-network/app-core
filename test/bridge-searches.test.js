// An RPC search reads each block more than once: an answer without its log
// doesn't move the search past a credit for good (#38), nor give an earlier
// transfer a later equal one's credit. The RPC here leaves a third of the
// answers without their logs, at random, over many seeds: every credit is
// still found, and found for its own transfer.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { depositArrivals, serviceArrivals } from "../src/bridge.js";
import { bridgeFinalized, depositEntry, details, emptying, fakeChain, moonlight, tokenTransfer, transferTx } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const DUSK = 1_000_000_000n;
const TENTH = 100_000_000n;
const SENDER = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);
// Fewer for deposits: each call checks their senders' accounts, which takes a while.
const DEPOSIT_SEEDS = SEEDS.slice(0, 20);
const TO_BSC = /** @type {any} */ (routes(networks.mainnet).find((route) => route.id === "dusk-to-bsc"));

/** @param {string} byte */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n */
const evmHash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

/**
 * Calls `ask` as an app does while its transfers wait: once a step, the head
 * `step` blocks on each time, with the scans the last call gave and the
 * credits the others arrived with, until every one arrived or `calls`
 * calls. The arrivals, and the calls they took.
 *
 * @param {{ head: bigint }} chain
 * @param {(waiting: { hash: string, scan: any }[], taken: string[]) => Promise<{ arrivals: Map<string, any> }>} ask
 * @param {{ hashes: string[], calls: number, step: bigint }} options
 */
async function follow(chain, ask, { calls, hashes, step }) {
  /** @type {Map<string, any>} */
  const scans = new Map();
  /** @type {Map<string, any>} */
  const arrived = new Map();
  let made = 0;

  while (made < calls && arrived.size < hashes.length) {
    const waiting = hashes.filter((hash) => !arrived.has(hash)).map((hash) => ({ hash, scan: scans.get(hash) }));
    const { arrivals } = await ask(
      waiting,
      [...arrived.values()].map((arrival) => arrival.hash)
    );

    made += 1;

    for (const [hash, arrival] of arrivals) {
      if (arrival.state === "arrived") arrived.set(hash, arrival);
      else if (arrival.scan) scans.set(hash, arrival.scan);
    }

    chain.head += step;
  }

  return { arrived, made, scans };
}

/**
 * The arrivals' credits, by transfer.
 *
 * @param {Map<string, any>} arrived
 */
const paidWith = (arrived) => Object.fromEntries([...arrived].map(([hash, arrival]) => [hash, arrival.hash]));

describe("transfers out to BNB Smart Chain, on an RPC whose answers may hold no log", () => {
  // BNB Smart Chain's pace: a block every 0.45 s, the head 33 blocks on a call every 15 s.
  const BASE = 1_792_000_000;
  const timeAt = (/** @type {bigint} */ n) => BASE + Math.floor((Number(n) * 9) / 20);
  const H0 = 1_000_000n;
  const R1 = "0x1111111111111111111111111111111111111111";
  const R2 = "0x2222222222222222222222222222222222222222";
  // Two equal transfers to R1 and one to R2, sent at H0; their payouts, in order.
  const sends = [
    { byte: "a1", height: 4_000_000, memo: R1, notBefore: H0 - 5n, value: 2n * DUSK },
    { byte: "a2", height: 4_000_002, memo: R1, value: 2n * DUSK },
    { byte: "b1", height: 4_000_001, memo: R2, notBefore: H0 - 5n, value: 3n * DUSK },
  ];
  const payouts = { [dusk("a1")]: evmHash("0a"), [dusk("a2")]: evmHash("0b"), [dusk("b1")]: evmHash("0c") };
  const logs = () => [
    tokenTransfer({ block: H0 + 1_300n, from: TO_BSC.payoutAddress, hash: evmHash("0a"), to: R1, token: TO_BSC.chain.token, wei: DUSK * DUSK }),
    tokenTransfer({ block: H0 + 2_000n, from: TO_BSC.payoutAddress, hash: evmHash("0c"), to: R2, token: TO_BSC.chain.token, wei: 2n * DUSK * DUSK }),
    tokenTransfer({ block: H0 + 2_700n, from: TO_BSC.payoutAddress, hash: evmHash("0b"), to: R1, token: TO_BSC.chain.token, wei: DUSK * DUSK }),
  ];
  const archive = fakeArchive({
    accounts: { [TO_BSC.account]: { receiver: sends.map(({ byte, height, memo, value }) => moonlight({ hash: dusk(byte), height, memo, receiver: TO_BSC.account, sender: SENDER, value })), sender: [] } },
    details: {},
    finalized: 10_000_000,
    transactions: Object.fromEntries(sends.map(({ byte, height, memo, value }) => [dusk(byte), transferTx({ height, memo, receiver: TO_BSC.account, seconds: timeAt(H0), sender: SENDER, value })])),
  }).archiveClient();
  const hashes = sends.map(({ byte }) => dusk(byte));
  const notBefore = new Map(sends.map(({ byte, notBefore }) => [dusk(byte), notBefore ?? null]));

  /**
   * @param {{ head: bigint, fetch: any }} chain
   * @param {(input: string, init: any) => Promise<Response>} fetch
   * @param {Record<string, unknown>} [more]
   */
  const asker = (chain, fetch, more = {}) => (/** @type {{ hash: string, scan: any }[]} */ waiting, /** @type {string[]} */ taken) =>
    serviceArrivals({
      archive,
      fetch,
      network: 1,
      now: timeAt(chain.head) * 1000,
      taken,
      transfers: waiting.map(({ hash, scan }) => ({ hash, notBefore: notBefore.get(hash), route: TO_BSC.id, scan })),
      waitMs: Infinity,
      ...more,
    });

  it("each arrive with its own payout, followed from when they were sent", async () => {
    for (const seed of SEEDS) {
      const chain = fakeChain({ head: H0, logs: logs(), timeAt, url: TO_BSC.chain.rpcUrl });
      const rpc = emptying(chain.fetch, { seed });
      const { arrived, made } = await follow(chain, asker(chain, rpc.fetch), { calls: 400, hashes, step: 33n });

      assert.deepEqual(paidWith(arrived), payouts, `seed ${seed}, after ${made} calls`);
      // The last payout is 82 calls in: found within a few more.
      assert.ok(made <= 90, `seed ${seed}: ${made} calls`);
    }
  });

  it("each arrive with its own payout, first asked about long after they were paid", async () => {
    for (const seed of SEEDS) {
      // First asked 15 hours on: 24 windows, read three calls in a row.
      const chain = fakeChain({ head: H0 + 120_000n, logs: logs(), timeAt, url: TO_BSC.chain.rpcUrl });
      const rpc = emptying(chain.fetch, { seed });
      const { arrived, made } = await follow(chain, asker(chain, rpc.fetch), { calls: 480, hashes, step: 33n });

      assert.deepEqual(paidWith(arrived), payouts, `seed ${seed}, after ${made} calls`);
    }
  });

  it("each arrive with its own payout when equal and paid windows apart, first asked about a day later", async () => {
    // Sent an hour apart, paid ten hours after each: the later payout could be the earlier transfer's while that one's isn't read.
    const pair = [
      { block: H0, byte: "c1", height: 4_000_000 },
      { block: H0 + 8_000n, byte: "c2", height: 4_000_360 },
    ];
    const node = fakeArchive({
      accounts: { [TO_BSC.account]: { receiver: pair.map(({ byte, height }) => moonlight({ hash: dusk(byte), height, memo: R1, receiver: TO_BSC.account, sender: SENDER, value: 2n * DUSK })), sender: [] } },
      details: {},
      finalized: 10_000_000,
      transactions: Object.fromEntries(pair.map(({ block, byte, height }) => [dusk(byte), transferTx({ height, memo: R1, receiver: TO_BSC.account, seconds: timeAt(block), sender: SENDER, value: 2n * DUSK })])),
    }).archiveClient();
    const paidOut = [
      [H0 + 80_000n, "0d"],
      [H0 + 88_000n, "0e"],
    ].map(([block, n]) => tokenTransfer({ block: /** @type {bigint} */ (block), from: TO_BSC.payoutAddress, hash: evmHash(/** @type {string} */ (n)), to: R1, token: TO_BSC.chain.token, wei: DUSK * DUSK }));

    for (const seed of SEEDS) {
      const chain = fakeChain({ head: H0 + 192_000n, logs: paidOut, timeAt, url: TO_BSC.chain.rpcUrl });
      const rpc = emptying(chain.fetch, { seed });
      const ask = (/** @type {{ hash: string, scan: any }[]} */ waiting, /** @type {string[]} */ taken) =>
        serviceArrivals({ archive: node, fetch: rpc.fetch, network: 1, now: timeAt(chain.head) * 1000, taken, transfers: waiting.map(({ hash, scan }) => ({ hash, route: TO_BSC.id, scan })), waitMs: Infinity });
      const { arrived, made } = await follow(chain, ask, { calls: 480, hashes: [dusk("c1"), dusk("c2")], step: 33n });

      assert.deepEqual(paidWith(arrived), { [dusk("c1")]: evmHash("0d"), [dusk("c2")]: evmHash("0e") }, `seed ${seed}, after ${made} calls`);
    }
  });

  it("arrive though the window holding their payouts is answered without it twice in a row", async () => {
    for (const first of [H0, H0 + 120_000n]) {
      const chain = fakeChain({ head: first, logs: logs(), timeAt, url: TO_BSC.chain.rpcUrl });
      const rpc = emptying(chain.fetch, { rate: 0 });

      rpc.held.push({ block: H0 + 1_300n, times: 2 }, { block: H0 + 2_000n, times: 2 }, { block: H0 + 2_700n, times: 2 });

      const { arrived } = await follow(chain, asker(chain, rpc.fetch), { calls: 480, hashes, step: 33n });

      assert.deepEqual(paidWith(arrived), payouts, `first asked at ${first}`);
      assert.deepEqual(
        rpc.held.map(({ times }) => times),
        [0, 0, 0]
      );
    }
  });

  it("arrive where a search kept by an earlier version went past the payout: it reads again from the transfer's block", async () => {
    const chain = fakeChain({ head: H0 + 10_000n, logs: logs(), timeAt, url: TO_BSC.chain.rpcUrl });
    // What the payouts' search was, without where it began, past both payouts.
    const search = [TO_BSC.chain.token.toLowerCase(), "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", `0x${"0".repeat(24)}${TO_BSC.payoutAddress.slice(2).toLowerCase()}`, `0x${"0".repeat(24)}${R1.slice(2)}`, String(DUSK * DUSK)].join(":");
    const kept = { basis: timeAt(H0) * 1000, from: String(H0 + 9_000n), search, seen: [] };
    const ask = asker(chain, chain.fetch);
    const scans = new Map([dusk("a1"), dusk("a2")].map((hash) => [hash, kept]));
    /** @type {Map<string, any>} */
    let found = new Map();

    for (let call = 0; call < 20 && found.size < 2; call += 1) {
      const { arrivals } = await ask([dusk("a1"), dusk("a2")].filter((hash) => !found.has(hash)).map((hash) => ({ hash, scan: scans.get(hash) })), [...found.values()].map((a) => a.hash));

      for (const [hash, arrival] of arrivals) {
        if (arrival.state === "arrived") found = new Map([...found, [hash, arrival]]);
        else scans.set(hash, arrival.scan);
      }

      chain.head += 33n;
    }

    assert.deepEqual(paidWith(found), { [dusk("a1")]: evmHash("0a"), [dusk("a2")]: evmHash("0b") });
  });

  // With one, two or eight windows a call, and an RPC that won't search more
  // than 1,250 blocks at once: nearer the head, to fit a test.
  for (const maxWindows of [1, 2, 8]) {
    for (const maxRange of [undefined, 1_250n]) {
      const how = `${maxWindows} window${maxWindows > 1 ? "s" : ""} a call${maxRange ? ", 1,250 blocks a window at most" : ""}`;

      it(`each arrive with its own payout with ${how}`, async () => {
        // An equal pair an hour apart, paid windows apart.
        const pair = [
          { block: H0, byte: "c1", height: 4_000_000 },
          { block: H0 + 1_000n, byte: "c2", height: 4_000_045 },
        ];
        const node = fakeArchive({
          accounts: { [TO_BSC.account]: { receiver: pair.map(({ byte, height }) => moonlight({ hash: dusk(byte), height, memo: R1, receiver: TO_BSC.account, sender: SENDER, value: 2n * DUSK })), sender: [] } },
          details: {},
          finalized: 10_000_000,
          transactions: Object.fromEntries(pair.map(({ block, byte, height }) => [dusk(byte), transferTx({ height, memo: R1, receiver: TO_BSC.account, seconds: timeAt(block), sender: SENDER, value: 2n * DUSK })])),
        }).archiveClient();
        const paidOut = () =>
          /** @type {const} */ ([
            [H0 + 2_000n, "0d"],
            [H0 + 8_000n, "0e"],
          ]).map(([block, n]) => tokenTransfer({ block, from: TO_BSC.payoutAddress, hash: evmHash(n), to: R1, token: TO_BSC.chain.token, wei: DUSK * DUSK }));

        for (const seed of SEEDS.slice(0, 10)) {
          for (const first of [H0, H0 + 12_000n]) {
            const chain = fakeChain({ head: first, logs: logs(), maxRange, timeAt, url: TO_BSC.chain.rpcUrl });
            const rpc = emptying(chain.fetch, { seed });
            const { arrived, made } = await follow(chain, asker(chain, rpc.fetch, { maxWindows }), { calls: 1_600, hashes, step: 33n });

            assert.deepEqual(paidWith(arrived), payouts, `seed ${seed}, first asked at ${first}, after ${made} calls`);
          }

          const chain = fakeChain({ head: H0 + 12_000n, logs: paidOut(), maxRange, timeAt, url: TO_BSC.chain.rpcUrl });
          const rpc = emptying(chain.fetch, { seed });
          const ask = (/** @type {{ hash: string, scan: any }[]} */ waiting, /** @type {string[]} */ taken) =>
            serviceArrivals({ archive: node, fetch: rpc.fetch, maxWindows, network: 1, now: timeAt(chain.head) * 1000, taken, transfers: waiting.map(({ hash, scan }) => ({ hash, route: TO_BSC.id, scan })), waitMs: Infinity });
          const { arrived, made } = await follow(chain, ask, { calls: 1_600, hashes: [dusk("c1"), dusk("c2")], step: 33n });

          assert.deepEqual(paidWith(arrived), { [dusk("c1")]: evmHash("0d"), [dusk("c2")]: evmHash("0e") }, `seed ${seed}, the pair, after ${made} calls`);
        }
      });
    }
  }

  it("cost one log search a call while they wait, and a few more as their blocks are read again", async () => {
    // No payout yet: two hours of calls, every answer whole.
    const chain = fakeChain({ head: H0, timeAt, url: TO_BSC.chain.rpcUrl });
    const { made } = await follow(chain, asker(chain, chain.fetch), { calls: 480, hashes: [dusk("b1")], step: 33n });
    const counts = chain.methods().reduce((/** @type {Record<string, number>} */ n, method) => ({ ...n, [method]: (n[method] ?? 0) + 1 }), {});

    assert.equal(made, 480);
    // Its head each call; its blocks read again a pass at a time, the passes ever further apart.
    assert.equal(counts.eth_blockNumber, made);
    assert.ok(counts.eth_getLogs <= made * 1.02, `${counts.eth_getLogs} log searches for ${made} calls`);
  });
});

describe("deposits to DuskEVM, on an RPC whose answers may hold no log", () => {
  // Any valid Dusk account works as the sender; DuskEVM makes a block a second
  // here, and the app asks once a minute, as a page in the background does.
  const DEPOSITOR = networks.mainnet.routes.services[0].account;
  const FROM = evmAddressOf(DEPOSITOR);
  const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
  const second = (/** @type {number | bigint} */ n) => (1_792_980_000 + Number(n)) * 1000;
  const H0 = 100_000n;
  /** @param {string} byte @param {bigint} block @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, block, fields = {}) => ({ amount: TENTH, at: second(block), hash: dusk(byte), height: 5_000, sender: DEPOSITOR, to: RECIPIENT, ...fields });
  /** @param {string | number} n @param {bigint} block */
  const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: evmHash(n), to: RECIPIENT, wei: TENTH * DUSK });
  // Two equal deposits, two minutes apart, and the bridge's credits for them a minute after each.
  const deposits = [sent("d1", H0, { height: 5_000 }), sent("d2", H0 + 120n, { height: 5_012 })];
  const logs = () => [credit(1, H0 + 60n), credit(2, H0 + 180n)];
  const hashes = deposits.map((d) => d.hash);
  const credits = { [dusk("d1")]: evmHash(1), [dusk("d2")]: evmHash(2) };
  const archive = fakeArchive({
    accounts: { [DEPOSITOR]: { receiver: [], sender: deposits.map((d) => depositEntry({ hash: d.hash, height: d.height, sender: DEPOSITOR, value: d.amount })) } },
    details: Object.fromEntries(deposits.map((d) => [d.hash, details(Math.floor(d.at / 1000), { deposit: { amountLux: d.amount, to: RECIPIENT } })])),
    finalized: 10_000,
  }).archiveClient();

  /**
   * @param {{ head: bigint }} chain
   * @param {(input: string, init: any) => Promise<Response>} fetch
   * @param {Record<string, unknown>} [more]
   */
  const asker = (chain, fetch, more = {}) => (/** @type {{ hash: string, scan: any }[]} */ waiting, /** @type {string[]} */ taken) =>
    depositArrivals({
      deposits: deposits.filter((d) => waiting.some((w) => w.hash === d.hash)).map((d) => ({ ...d, scan: waiting.find((w) => w.hash === d.hash)?.scan })),
      fetch,
      network: 2,
      now: second(chain.head),
      taken,
      via: "rpc",
      waitMs: Infinity,
      ...more,
    });

  for (const [what, more] of /** @type {const} */ ([
    ["with the sender's history", { archive }],
    ["without the archive, alone in their windows", {}],
  ])) {
    it(`each arrive with their own credit, ${what}, followed as they're sent or first asked about later`, async () => {
      for (const seed of DEPOSIT_SEEDS) {
        for (const first of [H0 + 15n, H0 + 40_000n]) {
          const chain = fakeChain({ head: first, logs: logs() });
          const rpc = emptying(chain.fetch, { seed });
          const { arrived, made } = await follow(chain, asker(chain, rpc.fetch, more), { calls: 480, hashes, step: 60n });

          assert.deepEqual(paidWith(arrived), credits, `seed ${seed}, first asked at ${first}, after ${made} calls`);
        }
      }
    });
  }

  it("arrive though the window holding their credits is answered without them twice in a row", async () => {
    for (const first of [H0 + 15n, H0 + 40_000n]) {
      const chain = fakeChain({ head: first, logs: logs() });
      const rpc = emptying(chain.fetch, { rate: 0 });

      rpc.held.push({ block: H0 + 60n, times: 2 }, { block: H0 + 180n, times: 2 });

      const { arrived } = await follow(chain, asker(chain, rpc.fetch, { archive }), { calls: 480, hashes, step: 60n });

      assert.deepEqual(paidWith(arrived), credits, `first asked at ${first}`);
    }
  });

  for (const maxWindows of [1, 2, 8]) {
    for (const maxRange of [undefined, 1_250n]) {
      const how = `${maxWindows} window${maxWindows > 1 ? "s" : ""} a call${maxRange ? ", 1,250 blocks a window at most" : ""}`;

      it(`each arrive with their own credit with ${how}, with the sender's history or without`, async () => {
        for (const seed of DEPOSIT_SEEDS.slice(0, 5)) {
          for (const first of [H0 + 15n, H0 + 10_000n]) {
            for (const more of [{ archive }, {}]) {
              const chain = fakeChain({ head: first, logs: logs(), maxRange });
              const rpc = emptying(chain.fetch, { seed });
              const { arrived, made } = await follow(chain, asker(chain, rpc.fetch, { ...more, maxWindows }), { calls: 1_600, hashes, step: 60n });

              assert.deepEqual(paidWith(arrived), credits, `seed ${seed}, first asked at ${first}, after ${made} calls`);
            }
          }
        }
      });
    }
  }

  describe("an earlier one of two equal deposits, its credit found after the later one's", () => {
    // Searched from block 0, the earlier deposit's credit at block 1,000 and the later one's at 6,000.
    const pair = [sent("e1", 100n, { height: 4_990, notBefore: 0 }), sent("e2", 200n, { height: 5_000, notBefore: 0 })];
    const node = fakeArchive({
      accounts: { [DEPOSITOR]: { receiver: [], sender: pair.map((d) => depositEntry({ hash: d.hash, height: d.height, sender: DEPOSITOR, value: d.amount })) } },
      details: Object.fromEntries(pair.map((d) => [d.hash, details(Math.floor(d.at / 1000), { deposit: { amountLux: d.amount, to: RECIPIENT } })])),
      finalized: 10_000,
    }).archiveClient();
    /** @param {{ head: bigint }} chain @param {(input: string, init: any) => Promise<Response>} fetch @param {number} maxWindows */
    const askOf = (chain, fetch, maxWindows) => (/** @type {{ hash: string, scan: any }[]} */ waiting, /** @type {string[]} */ taken) =>
      depositArrivals({
        archive: node,
        deposits: pair.filter((d) => waiting.some((w) => w.hash === d.hash)).map((d) => ({ ...d, scan: waiting.find((w) => w.hash === d.hash)?.scan })),
        fetch,
        maxWindows,
        network: 2,
        now: second(chain.head),
        taken,
        via: "rpc",
        waitMs: Infinity,
      });

    it("waits for eight reads of the blocks before it, the first read aside: an empty pass is none of them", async () => {
      const chain = fakeChain({ head: 10_000, logs: [credit(22, 1_000n), credit(11, 6_000n)] });
      const rpc = emptying(chain.fetch, { rate: 0 });

      // Its own credit left out of the first read and the next seven.
      rpc.held.push({ block: 1_000n, times: 8 });

      const { arrived } = await follow(chain, askOf(chain, rpc.fetch, 8), { calls: 20, hashes: pair.map((d) => d.hash), step: 33n });

      assert.deepEqual(paidWith(arrived), { [dusk("e1")]: evmHash(22), [dusk("e2")]: evmHash(11) });
    });

    it("reads its blocks again in a window the RPC takes, kept from call to call, with two windows a call", async () => {
      // An RPC that won't search more than 1,250 blocks at once, followed as the head moves on: one credit, seven calls in.
      const chain = fakeChain({ head: 5_000, maxRange: 1_250n });
      const ask = askOf(chain, chain.fetch, 2);
      /** @type {Map<string, any>} */
      const scans = new Map();
      /** @type {any} */
      let arrival = null;

      for (let call = 0; call < 60 && arrival?.state !== "arrived"; call += 1) {
        if (call === 7) chain.logs.push(credit(11, chain.head - 1n));

        const { arrivals } = await ask(
          pair.map((d) => ({ hash: d.hash, scan: scans.get(d.hash) })),
          []
        );

        for (const [hash, each] of arrivals) if (each.scan) scans.set(hash, each.scan);
        arrival = arrivals.get(dusk("e1"));
        chain.head += 33n;
      }

      // The later one could have had it: the earlier one takes it once its blocks are read again.
      like(arrival, { hash: evmHash(11), state: "arrived" });
    });

    it("reads its blocks again from a credit kept from before where its search began", async () => {
      const chain = fakeChain({ head: 10_000, logs: [credit(11, 6_000n)] });
      const ask = askOf(chain, chain.fetch, 8);
      const first = await ask(
        pair.map((d) => ({ hash: d.hash, scan: undefined })),
        []
      );
      // Its scan says the search began after that credit, as one begun from a start that came out late would.
      /** @type {Map<string, any>} */
      const scans = new Map([...first.arrivals].map(([hash, each]) => [hash, { ...each.scan, start: "8000" }]));
      /** @type {any} */
      let arrival = first.arrivals.get(dusk("e1"));

      for (let call = 0; call < 20 && arrival?.state !== "arrived"; call += 1) {
        chain.head += 33n;

        const { arrivals } = await ask(
          pair.map((d) => ({ hash: d.hash, scan: scans.get(d.hash) })),
          []
        );

        for (const [hash, each] of arrivals) if (each.scan) scans.set(hash, each.scan);
        arrival = arrivals.get(dusk("e1"));
      }

      like(arrival, { hash: evmHash(11), state: "arrived" });
    });
  });

  it("reads the newest blocks again on each call, and no further back than where its search began", async () => {
    const chain = fakeChain({ head: H0 + 2_000n, logs: [] });
    const options = { archive, deposits: [sent("d1", H0, { height: 5_000, notBefore: H0 - 10n })], fetch: chain.fetch, network: 2, now: second(H0 + 2_000n), via: /** @type {const} */ ("rpc"), waitMs: Infinity };
    const first = /** @type {any} */ ((await depositArrivals(options)).arrivals.get(dusk("d1")));

    chain.head += 15n;
    like((await depositArrivals({ ...options, deposits: [{ ...options.deposits[0], scan: first.scan }], now: second(chain.head) })).arrivals.get(dusk("d1")), { state: "waiting" });

    // From the head it read before sending; then the last thousand blocks, the new ones among them.
    assert.deepEqual(chain.ranges(), [
      [H0 - 10n, H0 + 2_000n],
      [H0 + 1_016n, H0 + 2_015n],
    ]);
  });
});
