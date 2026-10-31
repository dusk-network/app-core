// What an RPC search reads to follow a transfer: where it starts, how wide
// its windows are, and what it reads once a call rather than once a group.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { depositArrivals, serviceArrivals } from "../src/bridge.js";
import { bridgeFinalized, depositEntry, details, fakeChain, moonlight, tokenTransfer, transferTx, withRoutes } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const DUSK = 1_000_000_000n;
const TENTH = 100_000_000n;
// Any valid Dusk account works as the sender.
const SENDER = networks.mainnet.routes.services[0].account;
const FROM = evmAddressOf(SENDER);
const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";

/** @param {string} byte */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n */
const evmHash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
/** @param {string | number} n @param {number | bigint} block @param {string} [to] */
const credit = (n, block, to = RECIPIENT) => bridgeFinalized({ block, from: FROM, hash: evmHash(n), to, wei: TENTH * DUSK });

/**
 * The archive, the sender's history listing `deposits`, with their calls.
 *
 * @param {...any} deposits
 */
const listing = (...deposits) =>
  fakeArchive({
    accounts: { [SENDER]: { receiver: [], sender: deposits.map((d) => depositEntry({ hash: d.hash, height: d.height, sender: SENDER, value: d.amount })) } },
    details: Object.fromEntries(deposits.map((d) => [d.hash, details(Math.floor(d.at / 1000), { deposit: { amountLux: d.amount, to: d.to } })])),
    finalized: 10_000_000,
  }).archiveClient();

describe("where an RPC search starts", () => {
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 10, sender: SENDER, to: RECIPIENT, ...fields });

  it("is a block from before the transfer, its time read, however much faster the chain was before (#22)", async () => {
    // Blocks came 100 times as often before block 900,000: the pace of the last 100,000 says far too few blocks back.
    const H = 1_793_000_000;
    const timeAt = (/** @type {bigint} */ n) => Math.floor(n >= 900_000n ? H - (1_000_000 - Number(n)) : H - 100_000 - (900_000 - Number(n)) / 100);
    const at = timeAt(800_000n) * 1000;
    const chain = fakeChain({ head: 1_000_000, logs: [credit(7, 800_100)], timeAt });
    /** @type {any} */
    let arrival = null;

    // As an app asks, from where the last call stopped.
    for (let call = 0; call < 40 && arrival?.state !== "arrived"; call += 1) {
      const { arrivals } = await depositArrivals({ archive: listing(sent("ab", at)), deposits: [sent("ab", at, { scan: arrival?.scan })], fetch: chain.fetch, network: 2, now: H * 1000, via: "rpc" });

      arrival = arrivals.get(dusk("ab"));
    }

    like(arrival, { hash: evmHash(7), state: "arrived" });
  });

  it("is shortly before the transfer, so one log search finds a credit days later (#29)", async () => {
    // DuskEVM's pace, a block every 2 s, and a deposit five days old, paid a minute later.
    const H = 1_793_000_000;
    const timeAt = (/** @type {bigint} */ n) => H - (1_000_000 - Number(n)) * 2;
    const block = 1_000_000 - (5 * 86_400) / 2;
    const at = timeAt(BigInt(block)) * 1000;
    const chain = fakeChain({ head: 1_000_000, logs: [credit(7, block + 30)], timeAt });
    const { arrivals } = await depositArrivals({ archive: listing(sent("ab", at)), deposits: [sent("ab", at)], fetch: chain.fetch, network: 2, now: H * 1000, via: "rpc" });

    like(arrivals.get(dusk("ab")), { hash: evmHash(7), state: "arrived" });
    assert.equal(chain.ranges().length, 1);
  });
});

describe("how wide an RPC search's windows are", () => {
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 10, sender: SENDER, to: RECIPIENT, ...fields });
  /** Block n of the chain's, made at second 1_792_980_000 + n. */
  const second = (/** @type {number | bigint} */ n) => (1_792_980_000 + Number(n)) * 1000;

  /**
   * Follows a deposit as an app does, `step` blocks on each call, with the
   * scan the last call gave, until it arrives or `calls` calls.
   *
   * @param {ReturnType<typeof fakeChain>} chain
   * @param {any} deposit
   * @param {{ calls: number, step: bigint, maxWindows?: number }} options
   */
  async function follow(chain, deposit, { calls, maxWindows, step }) {
    /** @type {any} */
    let arrival = null;

    for (let call = 0; call < calls && arrival?.state !== "arrived"; call += 1) {
      const { arrivals } = await depositArrivals({ archive: listing(deposit), deposits: [{ ...deposit, scan: arrival?.scan }], fetch: chain.fetch, maxWindows, network: 2, now: second(chain.head), via: "rpc" });

      arrival = arrivals.get(deposit.hash);
      chain.head += step;
    }

    return arrival;
  }

  /** The log searches the RPC refused, wider than `max`. @param {ReturnType<typeof fakeChain>} chain @param {bigint} max */
  const refusals = (chain, max) => chain.ranges().filter(([from, to]) => to - from + 1n > max).length;

  it("keep the width the RPC took from call to call, with one window a call, as the head moves on (#23)", async () => {
    // An RPC that searches 100 blocks at most, asked once a call, the head 60 blocks on each time: a credit 600 blocks in.
    const chain = fakeChain({ head: 2_000, logs: [credit(7, 2_600)], maxRange: 100n });
    const arrival = await follow(chain, sent("ab", second(1_990), { notBefore: 1_990 }), { calls: 60, maxWindows: 1, step: 60n });

    like(arrival, { hash: evmHash(7), state: "arrived" });
    // Refused once, when the window at the head reached back further than it takes: not again.
    assert.equal(refusals(chain, 100n), 1);
  });

  it("keep the width the RPC took from call to call, with one window a call, from behind the head (#23)", async () => {
    // An RPC that searches 1,000 blocks at most, its credit 10,000 blocks behind the head.
    const chain = fakeChain({ head: 12_000, logs: [credit(7, 10_000)], maxRange: 1_000n });
    const arrival = await follow(chain, sent("ab", second(1_990), { notBefore: 1_990 }), { calls: 40, maxWindows: 1, step: 10n });

    like(arrival, { hash: evmHash(7), state: "arrived" });
    // Narrowed twice, then once more as its windows grew back: never wider than one it refused.
    assert.ok(refusals(chain, 1_000n) <= 3, `${refusals(chain, 1_000n)} refused`);
  });

  it("grow while the RPC takes them, so a long way to the head takes a few log searches", async () => {
    // Its credit 150,000 blocks after it, the head 200,000: 5,000 blocks a window would take 30.
    const chain = fakeChain({ head: 202_000, logs: [credit(7, 152_000)] });
    const arrival = await follow(chain, sent("ab", second(1_990), { notBefore: 1_990 }), { calls: 3, step: 10n });

    like(arrival, { hash: evmHash(7), state: "arrived" });
    assert.ok(chain.ranges().length <= 6, `${chain.ranges().length} log searches`);
  });

  it("are kept in the scan of a deposit waiting for its sender's history, and of one whose search failed", async () => {
    // The sender's history: 201 other transfers before the deposit, more than one call reads; and an RPC that doesn't answer.
    const OTHER = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
    const busy = Array.from({ length: 201 }, (_, i) => moonlight({ hash: (0xb0000 + i).toString(16).padStart(64, "0"), height: 9_000 + i, receiver: OTHER, sender: SENDER, value: 1 }));
    const archive = fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: [...busy, depositEntry({ hash: dusk("ab"), height: 10_000, sender: SENDER, value: TENTH })] } },
      details: { [dusk("ab")]: details(1_792_982_000, { deposit: { amountLux: TENTH, to: RECIPIENT } }) },
      finalized: 20_000,
    }).archiveClient();
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    const deposit = sent("ab", second(2_000), { height: 10_000 });
    // Where a search stopped, its windows narrowed to what the RPC takes.
    const kept = { basis: deposit.at, from: "2500", refused: 1_001, search: "kept", seen: [], size: 1_000, start: "1990" };
    const ask = async (/** @type {any} */ scan) => /** @type {any} */ ((await depositArrivals({ archive, deposits: [{ ...deposit, scan }], fetch: down, network: 2, now: second(3_000), via: "rpc" })).arrivals.get(deposit.hash));
    const waiting = await ask(kept);

    like(waiting, { state: "waiting" });
    like(waiting.scan, { refused: 1_001, size: 1_000 });

    const failed = await ask(waiting.scan);

    like(failed, { reason: "error", state: "unknown" });
    like(failed.scan, { refused: 1_001, size: 1_000 });
  });

  it("are asked again narrower where the RPC doesn't answer one grown past 5,000 blocks in time, rather than failing", async () => {
    // An RPC that takes too long over more than 20,000 blocks.
    const chain = fakeChain({ head: 202_000, logs: [credit(7, 152_000)] });
    /** @param {string} url @param {any} init */
    const fetch = async (url, init) => {
      const [filter] = JSON.parse(init.body).params;

      if (filter?.toBlock && BigInt(filter.toBlock) - BigInt(filter.fromBlock) + 1n > 20_000n) {
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
      }

      return chain.fetch(url, init);
    };
    const deposit = sent("ab", second(1_990), { notBefore: 1_990 });
    /** @type {any} */
    let arrival = null;

    for (let call = 0; call < 3 && arrival?.state !== "arrived"; call += 1) {
      const { arrivals } = await depositArrivals({ archive: listing(deposit), deposits: [{ ...deposit, scan: arrival?.scan }], fetch, network: 2, now: second(chain.head), timeoutMs: 50, via: "rpc" });

      arrival = arrivals.get(deposit.hash);
    }

    like(arrival, { hash: evmHash(7), state: "arrived" });
  });
});

describe("what an RPC search reads on each call", () => {
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 10, sender: SENDER, to: RECIPIENT, ...fields });
  const second = (/** @type {number | bigint} */ n) => (1_792_980_000 + Number(n)) * 1000;

  it("is nothing past a window that closed and was read, for a deposit without its sender's history, until its blocks are read again", async () => {
    // Its window closed long ago, without a credit: the first call reads as far as past it.
    const chain = fakeChain({ head: 10_000, logs: [] });
    const blockTimes = new Map();
    const deposit = sent("ab", second(2_000), { notBefore: 1_990 });
    const ask = async (/** @type {any} */ scan) => /** @type {any} */ ((await depositArrivals({ blockTimes, deposits: [{ ...deposit, scan }], fetch: chain.fetch, network: 2, now: second(chain.head), via: "rpc" })).arrivals.get(deposit.hash));
    const first = await ask(undefined);

    like(first, { reason: "late", state: "unknown" });

    // Half a minute on, its blocks not due to be read again yet.
    chain.head += 30n;
    chain.calls.length = 0;
    like(await ask(first.scan), { reason: "late", state: "unknown" });
    assert.deepEqual(chain.methods(), ["eth_blockNumber"]);
  });
});

describe("a chain's block times, as the app keeps them", () => {
  // Mainnet with a second service route, to Ethereum: its own account, its own payout address.
  const ETHEREUM = { ...networks.mainnet.routes.services[0], account: networks.testnet.routes.services[0].account, chain: "ethereum", id: "dusk-to-ethereum", payoutAddress: `0x${"e7".repeat(20)}` };
  const base = withRoutes(networks.mainnet, {});
  const net = { ...base, routes: { ...base.routes, services: [...base.routes.services, ETHEREUM] } };
  const [toBsc, toEthereum] = net.routes.services;
  const { bsc, ethereum } = net.routes.chains;
  const SENT = 1_793_000_000;
  // Who sent both, and the address both pay.
  const ACCOUNT = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
  const R = "0x1111111111111111111111111111111111111111";
  // Each chain's payout at its block 1,010,000: an hour after it was sent on BNB Smart Chain, five on Ethereum.
  const N = 1_010_000n;
  const bscAt = (/** @type {bigint} */ n) => SENT + 3_600 - Math.round(Number(N - n) * 0.45);
  const ethereumAt = (/** @type {bigint} */ n) => SENT + 5 * 3_600 - Number(N - n) * 12;
  const paid = (/** @type {any} */ route, /** @type {any} */ chain, /** @type {string} */ n) => tokenTransfer({ block: N, from: route.payoutAddress, hash: `0x${n.repeat(32)}`, to: R, token: chain.token, wei: DUSK * DUSK });
  const sentTo = (/** @type {any} */ route, /** @type {string} */ byte, /** @type {number} */ height) => ({
    listed: moonlight({ hash: dusk(byte), height, memo: R, receiver: route.account, sender: ACCOUNT, value: 2n * DUSK }),
    tx: transferTx({ height, memo: R, receiver: route.account, seconds: SENT, sender: ACCOUNT, value: 2n * DUSK }),
  });
  const [a, b] = [sentTo(toBsc, "aa", 4_000_000), sentTo(toEthereum, "bb", 4_000_001)];
  const archive = fakeArchive({
    accounts: { [toBsc.account]: { receiver: [a.listed], sender: [] }, [toEthereum.account]: { receiver: [b.listed], sender: [] } },
    details: {},
    finalized: 10_000_000,
    transactions: { [dusk("aa")]: a.tx, [dusk("bb")]: b.tx },
  }).archiveClient();

  /** @param {any} blockTimes */
  const ask = async (blockTimes) => {
    const chains = [fakeChain({ head: N + 100n, logs: [paid(toBsc, bsc, "0a")], timeAt: bscAt, url: bsc.rpcUrl }), fakeChain({ head: N + 100n, logs: [paid(toEthereum, ethereum, "0b")], timeAt: ethereumAt, url: ethereum.rpcUrl })];
    /** @param {string} url @param {any} init */
    const fetch = (url, init) => chains[url === bsc.rpcUrl ? 0 : 1].fetch(url, init);

    return (
      await serviceArrivals({
        archive,
        blockTimes,
        fetch,
        network: net,
        now: (SENT + 6 * 3_600) * 1000,
        transfers: [
          { hash: dusk("aa"), notBefore: N - 1_000n, route: toBsc.id },
          { hash: dusk("bb"), notBefore: N - 1_000n, route: toEthereum.id },
        ],
        waitMs: Infinity,
      })
    ).arrivals;
  };

  it("are each chain's own: one cache for a network whose service routes are on more than one chain isn't used (#27)", async () => {
    const arrivals = await ask(new Map());

    like(arrivals.get(dusk("aa")), { at: bscAt(N) * 1000, hash: `0x${"0a".repeat(32)}`, state: "arrived" });
    like(arrivals.get(dusk("bb")), { at: ethereumAt(N) * 1000, hash: `0x${"0b".repeat(32)}`, state: "arrived" });
  });

  it("are kept a cache a chain, by its chain ID, where the app gives one for each", async () => {
    /** @type {Map<number, Map<number, number>>} */
    const caches = new Map([
      [bsc.chainId, new Map()],
      [ethereum.chainId, new Map()],
    ]);
    const arrivals = await ask((/** @type {number} */ chainId) => caches.get(chainId));

    like(arrivals.get(dusk("bb")), { at: ethereumAt(N) * 1000, state: "arrived" });
    assert.equal(caches.get(bsc.chainId)?.get(Number(N)), bscAt(N) * 1000);
    assert.equal(caches.get(ethereum.chainId)?.get(Number(N)), ethereumAt(N) * 1000);
  });
});
