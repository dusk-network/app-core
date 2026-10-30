// Each credit pays one transfer: the cases where telling whose it is takes
// the most care. A false arrival, or a paid transfer left waiting, is what
// these keep out.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { depositArrivals, migrationPayoutOf, migrationPayouts, serviceArrivals, serviceTransferOf } from "../src/bridge.js";
import { bridgeFinalized, call, depositEntry, details, fakeChain, fakeExplorer, moonlight, tokenTransfer, transferTx, withRoutes } from "./fixtures/bridge.js";
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

describe("deposits to DuskEVM, on its explorer", () => {
  it("one waited for too long still takes its payment first: a newer equal one doesn't (#20)", async () => {
    // Two equal deposits 200 s apart, and one payment, 100 s after the older.
    const older = { amount: TENTH, at: second(1_000), hash: dusk("a5"), to: RECIPIENT };
    const newer = { ...older, at: second(1_200), hash: dusk("b5") };
    const explorer = fakeExplorer([[call(evmHash(5), new Date(second(1_100)).toISOString(), { value: String(TENTH * DUSK) })]]);
    // Waited for 1,000 seconds.
    const options = { deposits: [older, newer], fetch: explorer.fetch, network: 2, waitMs: 1_000_000 };
    const both = await depositArrivals({ ...options, now: second(1_900) });

    like(both.arrivals.get(dusk("a5")), { hash: evmHash(5), state: "arrived" });
    like(both.arrivals.get(dusk("b5")), { reason: "late", state: "unknown" });

    // The older one is past its wait: the payment is still its, not the newer one's.
    const after = await depositArrivals({ ...options, now: second(2_100) });

    like(after.arrivals.get(dusk("a5")), { reason: "expired", state: "unknown" });
    like(after.arrivals.get(dusk("b5")), { reason: "late", state: "unknown" });
  });
});

describe("deposits to DuskEVM, on its RPC", () => {
  const FROM = evmAddressOf(SENDER);
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] @returns {any} */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 5_000, sender: SENDER, to: RECIPIENT, ...fields });
  /** @param {string | number} n @param {number} block @param {string} [from] */
  const credit = (n, block, from = FROM) => bridgeFinalized({ block, from, hash: evmHash(n), to: RECIPIENT, wei: TENTH * DUSK });
  const asDeposit = (/** @type {number} */ seconds) => details(seconds, { deposit: { amountLux: TENTH, to: RECIPIENT } });

  it("one polled alone takes its own credit: an equal earlier one that arrived comes back from the history as paid", async () => {
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("d1"), height: 4_990, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("d2"), height: 5_000, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d1")]: asDeposit(1_792_980_100), [dusk("d2")]: asDeposit(1_792_980_200) },
      finalized: 10_000,
    });
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 1_500)] });
    const d1 = sent("d1", second(100), { height: 4_990 });
    const d2 = sent("d2", second(200));
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: 2, via: /** @type {const} */ ("rpc") };
    const first = await depositArrivals({ ...options, deposits: [d1, d2], now: second(2_000) });
    const stopped = /** @type {any} */ (first.arrivals.get(dusk("d2")));

    like(first.arrivals.get(dusk("d1")), { hash: evmHash(1), state: "arrived" });
    like(stopped, { state: "waiting" });

    // Its own credit, later; the app keeps the first one's arrival and asks for the second alone.
    chain.head = 2_200n;
    chain.logs.push(credit(2, 2_100));

    for (const scan of [stopped.scan, undefined]) {
      const next = await depositArrivals({ ...options, deposits: [{ ...d2, scan }], now: second(2_200), taken: [evmHash(1)] });

      like(next.arrivals.get(dusk("d2")), { hash: evmHash(2), state: "arrived" });
    }
  });

  it("one polled beside equal ones of its sender the app no longer looks for, or has no time for, leaves them their credits", async () => {
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("d1"), height: 4_990, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("d2"), height: 5_000, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d1")]: asDeposit(1_792_980_100), [dusk("d2")]: asDeposit(1_792_981_200) },
      finalized: 10_000,
    });
    // The earlier one's credit, shortly before the later one was sent.
    const chain = fakeChain({ head: 2_150, logs: [credit(1, 1_110)] });

    // Waited for 1,000 seconds, the earlier one is past it; or the app has no time for it.
    for (const d1 of [sent("d1", second(100), { height: 4_990 }), sent("d1", null, { height: 4_990 })]) {
      const { arrivals } = await depositArrivals({
        archive: node.archiveClient(),
        deposits: [d1, sent("d2", second(1_200))],
        fetch: chain.fetch,
        network: 2,
        now: second(2_150),
        via: "rpc",
        waitMs: 1_000_000,
      });

      like(arrivals.get(dusk("d2")), { state: "waiting" });
    }
  });

  it("without the sender's history, one waited for too long still takes its credit first: a newer equal one doesn't (#20)", async () => {
    // Two equal deposits 200 s apart, and one credit, 100 s after the older; with their sender or without.
    for (const fields of [{}, { sender: null }]) {
      const chain = fakeChain({ head: 2_100, logs: [credit(5, 1_100)] });
      const { arrivals } = await depositArrivals({
        deposits: [sent("a5", second(1_000), fields), sent("b5", second(1_200), fields)],
        fetch: chain.fetch,
        network: 2,
        now: second(2_100),
        via: "rpc",
        waitMs: 1_000_000,
      });

      like(arrivals.get(dusk("a5")), { reason: "expired", state: "unknown" });
      like(arrivals.get(dusk("b5")), { reason: "late", state: "unknown" });
    }
  });

  it("read back from the history, one no longer looked for keeps the block the app gave it its credit can't be before (#21)", async () => {
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("d1"), height: 4_990, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("d2"), height: 5_000, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d1")]: asDeposit(1_792_981_000), [dusk("d2")]: asDeposit(1_792_981_200) },
      finalized: 10_000,
    });
    // A credit from before the head the app read before sending the older one, though within the clock's slack of it; then its own.
    const chain = fakeChain({ head: 2_150, logs: [credit(4, 950), credit(1, 1_100)] });

    // Waited for 1,000 seconds, the older one is past it; or the app has no time for it.
    for (const at of [second(1_000), null]) {
      const { arrivals } = await depositArrivals({
        archive: node.archiveClient(),
        deposits: [sent("d1", at, { height: 4_990, notBefore: 1_000 }), sent("d2", second(1_200))],
        fetch: chain.fetch,
        network: 2,
        now: second(2_150),
        via: "rpc",
        waitMs: 1_000_000,
      });

      like(arrivals.get(dusk("d2")), { state: "waiting" });
    }
  });

  it("carries on a search only for what it searched: one that read every sender's credits isn't carried on for one sender", async () => {
    // Its sender not known, its window closed without a credit; another sender's came after.
    const chain = fakeChain({ head: 2_000, logs: [credit(9, 1_400, evmAddressOf(OTHER))] });
    const deposit = sent("d4", second(1_000), { sender: null });
    const first = /** @type {any} */ ((await depositArrivals({ deposits: [deposit], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" })).arrivals.get(dusk("d4")));

    like(first, { reason: "late", state: "unknown" });

    // Its sender known now, with its history: the other sender's credit is none of its.
    const node = fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: [depositEntry({ hash: dusk("d4"), height: 5_000, sender: SENDER, value: TENTH })] } },
      details: { [dusk("d4")]: asDeposit(1_792_981_000) },
      finalized: 10_000,
    });

    chain.head = 2_100n;

    const next = await depositArrivals({ archive: node.archiveClient(), deposits: [{ ...deposit, scan: first.scan, sender: SENDER }], fetch: chain.fetch, network: 2, now: second(2_100), via: "rpc" });

    like(next.arrivals.get(dusk("d4")), { state: "waiting" });
  });

  it("is unsure while an earlier deposit of its sender that could be equal can't be read", async () => {
    // The sender's history lists an earlier deposit of its amount whose details the archive doesn't give.
    const node = fakeArchive({
      accounts: {
        [SENDER]: {
          receiver: [],
          sender: [depositEntry({ hash: dusk("d1"), height: 4_990, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("d2"), height: 5_000, sender: SENDER, value: TENTH })],
        },
      },
      details: { [dusk("d2")]: asDeposit(1_792_980_200) },
      finalized: 10_000,
    });
    // The earlier one's credit.
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 1_500)] });
    const { arrivals } = await depositArrivals({ archive: node.archiveClient(), deposits: [sent("d2", second(200))], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

    like(arrivals.get(dusk("d2")), { reason: "unsure", state: "unknown" });
  });

  it("without its sender, among equal deposits whose senders are known, takes none of their credits, whatever the order given", async () => {
    // Two deposits close together, one of them without its sender; only the known one's credit is there.
    const chain = fakeChain({ head: 2_000, logs: [credit(7, 1_040)] });
    const known = sent("a7", second(1_010));
    const unknown = sent("b7", second(1_000), { sender: null });

    for (const deposits of [
      [unknown, known],
      [known, unknown],
    ]) {
      const { arrivals } = await depositArrivals({ deposits, fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

      like(arrivals.get(dusk("a7")), { hash: evmHash(7), state: "arrived" });
      assert.notEqual(arrivals.get(dusk("b7"))?.state, "arrived");
    }

    // The known one's credit, while its own window is still open: it is no credit of the other.
    const open = await depositArrivals({ deposits: [unknown, sent("a7", second(1_900))], fetch: fakeChain({ head: 2_000, logs: [credit(7, 1_040)] }).fetch, network: 2, now: second(2_000), via: "rpc" });

    assert.notEqual(open.arrivals.get(dusk("b7"))?.state, "arrived");
  });

  it("without its sender, takes no credit of a sender of the app's other equal deposits, even one not looked for, or not read", async () => {
    const known = sent("a7", second(1_000));
    const unknown = sent("b7", second(1_160), { sender: null });
    // The known one's credit, in the other's window.
    const logs = [credit(7, 1_100)];
    // Waited for 1,000 seconds: the known one is past it.
    const past = await depositArrivals({ deposits: [known, unknown], fetch: fakeChain({ head: 2_150, logs }).fetch, network: 2, now: second(2_150), via: "rpc", waitMs: 1_000_000 });

    like(past.arrivals.get(dusk("a7")), { reason: "expired", state: "unknown" });
    assert.notEqual(past.arrivals.get(dusk("b7"))?.state, "arrived");

    // The known one's sender's history can't be read.
    const node = fakeArchive({ accounts: {}, details: {}, finalized: 10_000 });

    node.down = true;

    const unread = await depositArrivals({ archive: node.archiveClient(), deposits: [known, unknown], fetch: fakeChain({ head: 2_150, logs }).fetch, network: 2, now: second(2_150), via: "rpc" });

    like(unread.arrivals.get(dusk("a7")), { reason: "error", state: "unknown" });
    assert.notEqual(unread.arrivals.get(dusk("b7"))?.state, "arrived");
  });
});

describe("transfers out to another chain", () => {
  const PAYOUT = `0x${"77".repeat(20)}`;
  const ROUTE = networks.testnet.routes.services[0];
  const net = withRoutes(networks.testnet, { services: { "dusk-to-ethereum": { payoutAddress: PAYOUT } } });
  const TOKEN = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
  /** @param {string} n @param {number} block @param {bigint} [wei] */
  const paid = (n, block, wei = DUSK * DUSK) => tokenTransfer({ block, from: PAYOUT, hash: evmHash(n), to: RECIPIENT, token: TOKEN, wei });

  /**
   * Transfers to the route's account naming `memo`, as the archive lists
   * them every way: the account's history, the memo index, each one's
   * details and its transaction.
   *
   * @param {{ byte: string, height: number, seconds: number, value?: bigint, memo?: string, known?: boolean, edit?: (tx: any) => any }[]} transfers
   */
  function archiveOf(transfers) {
    const listed = transfers.map(({ byte, height, memo = RECIPIENT, value = 2n * DUSK }) => moonlight({ hash: dusk(byte), height, memo, receiver: ROUTE.account, sender: SENDER, value }));
    /** @type {Record<string, any[]>} */
    const memos = {};

    for (const entry of listed) {
      const memo = Buffer.from(entry.events[0].data.memo, "hex").toString();

      memos[memo] = [...(memos[memo] ?? []), entry];
    }

    const known = transfers.filter((t) => t.known !== false);

    return fakeArchive({
      accounts: { [ROUTE.account]: { receiver: listed, sender: [] } },
      details: Object.fromEntries(known.map(({ byte, seconds }) => [dusk(byte), { blockHash: "aa".repeat(32), blockTimestamp: seconds, err: null, gasSpent: 1, tx: { callData: null, gasLimit: 1, gasPrice: 1 } }])),
      finalized: 10_000,
      memos,
      transactions: Object.fromEntries(
        known.map(({ byte, edit = (tx) => tx, height, memo = RECIPIENT, seconds, value = 2n * DUSK }) => [
          dusk(byte),
          edit(transferTx({ height, memo, receiver: ROUTE.account, seconds, sender: SENDER, value })),
        ])
      ),
    });
  }

  /**
   * A transfer as the app passes it, with what an earlier version asked
   * for beside it: its amount, its memo's address and its time.
   *
   * @param {string} byte @param {number} seconds @param {Record<string, unknown>} [fields]
   * @returns {any}
   */
  const transfer = (byte, seconds, fields = {}) => ({ amount: 2n * DUSK, at: seconds * 1000, hash: dusk(byte), height: 4_000, route: ROUTE.id, to: RECIPIENT, ...fields });

  it("one polled alone takes its own payout: an equal earlier one that arrived comes back from the account's history as paid", async () => {
    const node = archiveOf([
      { byte: "e1", height: 4_000, seconds: 1_792_980_100 },
      { byte: "d1", height: 4_001, seconds: 1_792_980_200 },
    ]);
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: net };
    const later = transfer("d1", 1_792_980_200, { height: 4_001 });
    const first = await serviceArrivals({ ...options, now: second(2_000), transfers: [transfer("e1", 1_792_980_100), later] });
    const stopped = /** @type {any} */ (first.arrivals.get(dusk("d1")));

    like(first.arrivals.get(dusk("e1")), { hash: evmHash("0a"), state: "arrived" });
    like(stopped, { state: "waiting" });

    chain.head = 2_200n;
    chain.logs.push(paid("0b", 2_100));

    for (const scan of [stopped.scan, undefined]) {
      const next = await serviceArrivals({ ...options, now: second(2_200), taken: [evmHash("0a")], transfers: [{ ...later, scan }] });

      like(next.arrivals.get(dusk("d1")), { hash: evmHash("0b"), state: "arrived" });
    }
  });

  it("is unsure while an earlier equal transfer the account received can't be read", async () => {
    // Listed, but its transaction isn't given, or doesn't say whom it paid; the payout there is that one's.
    for (const unread of [{ known: false }, { edit: (/** @type {any} */ tx) => ({ ...tx, tx: { ...tx.tx, json: tx.tx.json.replace(/"receiver":"[^"]*",/, "") } }) }]) {
      const node = archiveOf([
        { byte: "e1", height: 4_000, seconds: 1_792_980_100, ...unread },
        { byte: "d1", height: 4_001, seconds: 1_792_980_200 },
      ]);
      const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
      const { arrivals } = await serviceArrivals({ archive: node.archiveClient(), fetch: chain.fetch, network: net, now: second(2_000), transfers: [transfer("d1", 1_792_980_200, { height: 4_001 })] });

      like(arrivals.get(dusk("d1")), { reason: "unsure", state: "unknown" });
    }
  });

  it("one polled beside equal ones the app no longer looks for, or can't read, leaves them their payouts", async () => {
    // The earlier one's payout, shortly before the later one was sent.
    const chain = fakeChain({ head: 2_150, logs: [paid("0a", 1_110)] });
    const transfers = [transfer("e1", 1_792_980_100), transfer("d1", 1_792_981_200, { height: 4_001 })];
    // Waited for 1,000 seconds: the earlier one is past it.
    const past = await serviceArrivals({
      archive: archiveOf([
        { byte: "e1", height: 4_000, seconds: 1_792_980_100 },
        { byte: "d1", height: 4_001, seconds: 1_792_981_200 },
      ]).archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_150),
      transfers,
      waitMs: 1_000_000,
    });

    like(past.arrivals.get(dusk("e1")), { reason: "expired", state: "unknown" });
    like(past.arrivals.get(dusk("d1")), { state: "waiting" });

    // The earlier one's transaction can't be read: the payout could be its.
    const unread = await serviceArrivals({
      archive: archiveOf([
        { byte: "e1", edit: (tx) => ({ ...tx, tx: { ...tx.tx, json: "{" } }), height: 4_000, seconds: 1_792_980_100 },
        { byte: "d1", height: 4_001, seconds: 1_792_981_200 },
      ]).archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_150),
      transfers,
    });

    like(unread.arrivals.get(dusk("e1")), { reason: "unsure", state: "unknown" });
    like(unread.arrivals.get(dusk("d1")), { reason: "unsure", state: "unknown" });
  });

  it("read back from the account's history, one no longer looked for keeps the block the app gave it its payout can't be before (#21)", async () => {
    const node = archiveOf([
      { byte: "e1", height: 4_000, seconds: 1_792_981_000 },
      { byte: "d1", height: 4_001, seconds: 1_792_981_200 },
    ]);
    // A payout from before the head the app read before sending the older one, though within the clock's slack of it; then its own.
    const chain = fakeChain({ head: 2_150, logs: [paid("0e", 950), paid("0a", 1_100)] });
    // Waited for 1,000 seconds: the older one is past it.
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_150),
      transfers: [transfer("e1", 1_792_981_000, { notBefore: 1_000 }), transfer("d1", 1_792_981_200, { height: 4_001 })],
      waitMs: 1_000_000,
    });

    like(arrivals.get(dusk("e1")), { reason: "expired", state: "unknown" });
    like(arrivals.get(dusk("d1")), { state: "waiting" });
  });

  it("count one the app no longer looks for by the fee the app gave it", async () => {
    // Two DUSK less a half, and two and a half less one: both pay out one and a half.
    const node = archiveOf([
      { byte: "e1", height: 4_000, seconds: 1_792_980_100 },
      { byte: "d1", height: 4_001, seconds: 1_792_981_200, value: (5n * DUSK) / 2n },
    ]);
    const chain = fakeChain({ head: 2_150, logs: [paid("0a", 1_110, (3n * DUSK * DUSK) / 2n)] });
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_150),
      transfers: [transfer("e1", 1_792_980_100, { fee: DUSK / 2n }), transfer("d1", 1_792_981_200, { amount: (5n * DUSK) / 2n, fee: DUSK, height: 4_001 })],
      waitMs: 1_000_000,
    });

    like(arrivals.get(dusk("e1")), { reason: "expired", state: "unknown" });
    like(arrivals.get(dusk("d1")), { state: "waiting" });
  });

  it("is unsure when its transaction gives no block height to read the account's history to", async () => {
    const node = archiveOf([
      { byte: "e1", height: 4_000, seconds: 1_792_980_100 },
      { byte: "d1", edit: (tx) => ({ ...tx, blockHeight: null }), height: 4_001, seconds: 1_792_980_200 },
    ]);
    // The earlier one's payout.
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
    const { arrivals } = await serviceArrivals({ archive: node.archiveClient(), fetch: chain.fetch, network: net, now: second(2_000), transfers: [transfer("d1", 1_792_980_200)] });

    like(arrivals.get(dusk("d1")), { reason: "unsure", state: "unknown" });
  });

  it("carries on a search only for what it searched: a payout of another amount is looked for afresh", async () => {
    const node = archiveOf([{ byte: "c3", height: 4_000, seconds: 1_792_980_100 }]);
    // Two DUSK, less the half DUSK the bridge took.
    const chain = fakeChain({ head: 2_000, logs: [paid("0c", 1_500, (3n * DUSK * DUSK) / 2n)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: net };
    const first = /** @type {any} */ ((await serviceArrivals({ ...options, now: second(2_000), transfers: [transfer("c3", 1_792_980_100, { fee: DUSK })] })).arrivals.get(dusk("c3")));

    like(first, { state: "waiting" });
    chain.head = 2_200n;

    // The fee the app gives, put right.
    const next = await serviceArrivals({ ...options, now: second(2_200), transfers: [transfer("c3", 1_792_980_100, { fee: DUSK / 2n, scan: first.scan })] });

    like(next.arrivals.get(dusk("c3")), { amount: (3n * DUSK) / 2n, hash: evmHash("0c"), state: "arrived" });
  });

  it("counts an earlier equal transfer that wrote the address in another case, as the bridge pays any", async () => {
    const node = archiveOf([
      { byte: "e1", height: 4_000, memo: `0x${RECIPIENT.slice(2).toUpperCase()}`, seconds: 1_792_980_100 },
      { byte: "d1", height: 4_001, seconds: 1_792_980_200 },
    ]);
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
    const options = { archive: node.archiveClient(), fetch: chain.fetch, network: net, now: second(2_000), transfers: [transfer("d1", 1_792_980_200, { height: 4_001 })] };

    // The one payout so far is the earlier one's.
    like((await serviceArrivals(options)).arrivals.get(dusk("d1")), { state: "waiting" });
    chain.logs.push(paid("0b", 1_600));
    like((await serviceArrivals(options)).arrivals.get(dusk("d1")), { hash: evmHash("0b"), state: "arrived" });
  });

  it("are told apart by what they pay out: equal amounts, with different fees, are no equal transfers", async () => {
    const node = archiveOf([
      { byte: "f1", height: 4_000, seconds: 1_792_980_100 },
      { byte: "f2", height: 4_001, seconds: 1_792_980_200 },
    ]);
    // Two DUSK less a fee of one, and of a half.
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500), paid("0b", 1_600, (3n * DUSK * DUSK) / 2n)] });
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_000),
      transfers: [transfer("f1", 1_792_980_100, { fee: DUSK }), transfer("f2", 1_792_980_200, { fee: DUSK / 2n, height: 4_001 })],
    });

    like(arrivals.get(dusk("f1")), { amount: DUSK, hash: evmHash("0a"), state: "arrived" });
    like(arrivals.get(dusk("f2")), { amount: (3n * DUSK) / 2n, hash: evmHash("0b"), state: "arrived" });
  });

  it("pay out what the route's account received, not what left the sender with a gas refund paid elsewhere", async () => {
    const node = archiveOf([{ byte: "d1", height: 4_000, seconds: 1_792_980_100 }]);
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
    // The sender's entry: two DUSK sent, and 500 lux of unspent gas refunded to another account.
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_000),
      transfers: [transfer("d1", 1_792_980_100, { amount: 2n * DUSK + 500n })],
    });

    like(arrivals.get(dusk("d1")), { amount: DUSK, hash: evmHash("0a"), state: "arrived" });
  });

  it("from the sender's entry alone, have no amount the route's account received while a refund may have gone elsewhere", () => {
    /** @param {Record<string, unknown>} fields @returns {any} */
    const entry = (fields) => ({
      blockHeight: 1,
      counterparty: networks.mainnet.routes.services[0].account,
      direction: "out",
      gasLimit: "500000000",
      gasPrice: "1",
      gasSpent: "104124",
      hash: dusk("dd"),
      kind: "transfer",
      memo: RECIPIENT,
      payer: true,
      success: true,
      timestamp: 1,
      value: String(2n * DUSK + 500n),
      ...fields,
    });

    like(serviceTransferOf(entry({}), 1), { amount: null, problem: null, sent: 2n * DUSK + 500n, to: RECIPIENT });
    // Its gas all spent, nothing was refunded: what left is what the account received.
    like(serviceTransferOf(entry({ gasLimit: "104124" }), 1), { amount: 2n * DUSK + 500n });
    // No more than the fee left it: nothing is paid out, whatever was refunded.
    like(serviceTransferOf(entry({ value: String(DUSK) }), 1), { problem: "under-fee" });
  });
});

describe("migrations into Dusk", () => {
  const PAYER = networks.mainnet.routes.migrations[0].payoutAccount;
  const HASH = `0x${"cd".repeat(32)}`;
  const migration = { amount: 3n * DUSK, at: 1_792_980_000_000, hash: HASH, route: "bsc-to-dusk" };

  it("are unsure, not waiting, when their payout's entry shows another amount, as a gas refund paid to the account would", async () => {
    const payout = { blockHeight: 100, counterparty: PAYER, direction: "in", hash: dusk("ef"), kind: "transfer", memo: HASH, payer: false, success: true, timestamp: 1, value: String(3n * DUSK + 500n) };
    const { payouts } = await migrationPayouts({ entries: [/** @type {any} */ (payout)], migrations: [migration], network: 1, now: 1_792_980_000_000 });

    like(payouts.get(HASH), { reason: "unsure", state: "unknown" });
  });

  it("are paid by the payout's own amount where its entry tells a gas refund to the account apart", async () => {
    const payout = { blockHeight: 100, counterparty: PAYER, direction: "in", hash: dusk("ef"), kind: "transfer", memo: HASH, payer: false, refund: "500", success: true, timestamp: 1, value: String(3n * DUSK + 500n) };
    const { payouts } = await migrationPayouts({ entries: [/** @type {any} */ (payout)], migrations: [migration], network: 1, now: 1_792_980_000_000 });

    like(payouts.get(HASH), { amount: 3n * DUSK, hash: dusk("ef"), state: "arrived" });
    like(migrationPayoutOf(/** @type {any} */ (payout), 1), { amount: 3n * DUSK, payout: dusk("ef") });
  });

  it("are paid by the payout's own amount, as its transaction gave it, a gas refund to the account aside", async () => {
    const node = fakeArchive({
      accounts: {},
      details: { [dusk("ef")]: { blockHash: "aa".repeat(32), blockTimestamp: 1_792_990_000, err: null, gasSpent: 1, tx: { callData: null, gasLimit: 1, gasPrice: 1 } } },
      finalized: 10_000,
      memos: { [HASH]: [moonlight({ hash: dusk("ef"), height: 101, memo: HASH, receiver: OTHER, refund: [OTHER, 500n], sender: /** @type {string} */ (PAYER), value: 3n * DUSK })] },
    });
    const { payouts } = await migrationPayouts({ account: OTHER, archive: node.archiveClient(), migrations: [migration], network: 1, now: 1_792_980_000_000 });

    like(payouts.get(HASH), { amount: 3n * DUSK, hash: dusk("ef"), state: "arrived" });
  });
});
