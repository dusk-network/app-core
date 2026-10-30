// Where the web wallet (WW), the extension (EXT), the explorer (EXP) and the
// bridge site (BR) followed a transfer differently, the rule /bridge keeps,
// each with a case the other rule gets wrong.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { evmAddressOf } from "@dusk-network/networks/duskevm";

import { TRANSFER_TOPIC, depositArrivals, migrationPayouts, serviceArrivals, serviceTransferOf } from "../src/bridge.js";
import { bridgeFinalized, call, depositEntry, details, fakeChain, fakeExplorer, moonlight, tokenTransfer, topicOf, transferTx, withRoutes } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const DUSK = 1_000_000_000n;
const TO = "0xab84edffd745af9420ac74fec73121fbee9fc86f";
const AT = Date.parse("2026-10-27T05:50:00Z");
const HALF = 500_000_000n;
const SENDER = networks.mainnet.routes.services[0].account;
const OTHER = networks.testnet.routes.services[0].account;
const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";

/** @param {string} byte */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n */
const evmHash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;
/** @param {string} byte @param {number | null} at @param {Record<string, unknown>} [fields] @returns {any} */
const deposit = (byte, at, fields = {}) => ({ amount: HALF, at, hash: dusk(byte), to: TO, ...fields });
/** @param {number} ms */
const iso = (ms) => new Date(ms).toISOString();
/** Block n of a chain made at second 1_792_980_000 + n. */
const second = (/** @type {number} */ n) => (1_792_980_000 + n) * 1000;
const emptyArchive = () => fakeArchive({ accounts: {}, details: {}, finalized: 10_000_000 }).archiveClient();

/**
 * Transfers of two DUSK naming RECIPIENT to testnet's route account, as the
 * archive gives them: each one's transaction, and the account's history.
 *
 * @param {{ byte: string, height: number, seconds: number }[]} sends
 */
const routeArchive = (sends) =>
  fakeArchive({
    accounts: { [OTHER]: { receiver: sends.map(({ byte, height }) => moonlight({ hash: dusk(byte), height, memo: RECIPIENT, receiver: OTHER, sender: SENDER, value: 2n * DUSK })), sender: [] } },
    details: {},
    finalized: 10_000,
    transactions: Object.fromEntries(sends.map(({ byte, height, seconds }) => [dusk(byte), transferTx({ height, memo: RECIPIENT, receiver: OTHER, seconds, sender: SENDER, value: 2n * DUSK })])),
  });

/**
 * @param {any[]} deposits
 * @param {any[]} calls
 * @param {Record<string, unknown>} [more]
 */
async function onExplorer(deposits, calls, more = {}) {
  const explorer = fakeExplorer([calls]);
  const result = await depositArrivals({ deposits, fetch: explorer.fetch, network: 2, now: AT + 3_600_000, ...more });

  return { ...result, urls: explorer.urls };
}

describe("where the apps followed deposits differently, on DuskEVM's explorer", () => {
  it("a failed payment of its amount near its block leaves it unsure (WW and EXT took the next payment)", async () => {
    // The deposit's own delivery may have failed: the payment after it could be another deposit's.
    const { arrivals } = await onExplorer([deposit("a1", AT)], [call(evmHash(13), iso(AT + 50_000)), call(evmHash(12), iso(AT + 30_000), { success: false })]);

    like(arrivals.get(dusk("a1")), { reason: "unsure", state: "unknown" });
  });

  it("a payment more than two minutes after its block isn't its own (WW and EXT took any later one)", async () => {
    const { arrivals } = await onExplorer([deposit("a1", AT)], [call(evmHash(13), iso(AT + 133_000))]);

    like(arrivals.get(dusk("a1")), { reason: "late", state: "unknown" });
  });

  it("a deposit doesn't take the payment of one sent just before it that the app doesn't know (WW and EXT took the first after it)", async () => {
    // Sent from another device 20 seconds before: its payment comes first.
    const { arrivals } = await onExplorer([deposit("a1", AT)], [call(evmHash(14), iso(AT + 50_000)), call(evmHash(13), iso(AT + 30_000))]);

    like(arrivals.get(dusk("a1")), { reason: "unsure", state: "unknown" });
  });

  it("nothing is asked, or taken, until its window is over (WW and EXT took a payment at once)", async () => {
    const { arrivals, urls } = await onExplorer([deposit("a1", AT)], [call(evmHash(13), iso(AT + 30_000))], { now: AT + 60_000 });

    assert.deepEqual(arrivals.get(dusk("a1")), { state: "waiting" });
    assert.equal(urls.length, 0);
  });

  it("equal deposits the app knows share the payments near them in order (EXP, seeing one alone, took none of two)", async () => {
    const { arrivals } = await onExplorer(
      [deposit("a1", AT), deposit("a2", AT + 60_000)],
      [call(evmHash(14), iso(AT + 100_000)), call(evmHash(13), iso(AT + 40_000))]
    );

    like(arrivals.get(dusk("a1")), { hash: evmHash(13), state: "arrived" });
    like(arrivals.get(dusk("a2")), { hash: evmHash(14), state: "arrived" });
  });

  it("the recipient's calls are read up to five pages back (EXP read the first)", async () => {
    const explorer = fakeExplorer([[call(evmHash(20), iso(AT + 600_000))], [call(evmHash(13), iso(AT + 40_000)), call(evmHash(10), iso(AT - 600_000))]]);
    const { arrivals } = await depositArrivals({ deposits: [deposit("a1", AT)], fetch: explorer.fetch, network: 2, now: AT + 3_600_000 });

    like(arrivals.get(dusk("a1")), { hash: evmHash(13), state: "arrived" });
  });

  it("a deposit is waited for a week, then unknown and not asked about (WW, EXP and BR waited for good)", async () => {
    const { arrivals, urls } = await onExplorer([deposit("a1", AT)], [call(evmHash(13), iso(AT + 40_000))], { now: AT + 8 * 86_400_000 });

    like(arrivals.get(dusk("a1")), { reason: "expired", state: "unknown" });
    assert.equal(urls.length, 0);
  });
});

describe("where the apps followed deposits differently, on DuskEVM's RPC", () => {
  const FROM = evmAddressOf(SENDER);
  const TENTH = 100_000_000n;
  /** @param {string} byte @param {number} at @param {Record<string, unknown>} [fields] */
  const sent = (byte, at, fields = {}) => ({ amount: TENTH, at, hash: dusk(byte), height: 10, sender: SENDER, to: RECIPIENT, ...fields });
  /** @param {string | number} n @param {number} block */
  const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: evmHash(n), to: RECIPIENT, wei: TENTH * DUSK });

  it("a credit from before the deposit's block isn't its own, though it is after where the search starts (BR took the first one there)", async () => {
    // Five minutes before the deposit: another, older deposit's.
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 700), credit(2, 1_100)] });
    const { arrivals } = await depositArrivals({ archive: emptyArchive(), deposits: [sent("ab", second(1_000))], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

    like(arrivals.get(dusk("ab")), { hash: evmHash(2), state: "arrived" });
  });

  it("a deposit whose block's time isn't known yet isn't looked for (BR looked from the device's clock)", async () => {
    const chain = fakeChain({ head: 2_000, logs: [credit(1, 1_100)] });
    const { arrivals, requests } = await depositArrivals({ archive: emptyArchive(), deposits: [sent("ab", /** @type {any} */ (null))], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

    assert.deepEqual(arrivals.get(dusk("ab")), { state: "waiting" });
    assert.equal(requests, 0);
  });

  it("the sender's earlier equal deposit, read from its history, takes its credit first (WW and EXT went by the deposits they kept)", async () => {
    const node = fakeArchive({
      accounts: { [SENDER]: { receiver: [], sender: [depositEntry({ hash: dusk("ef"), height: 4_990, sender: SENDER, value: TENTH }), depositEntry({ hash: dusk("ab"), height: 5_000, sender: SENDER, value: TENTH })] } },
      details: { [dusk("ef")]: details(1_792_980_100, { deposit: { amountLux: TENTH, to: RECIPIENT } }) },
      finalized: 10_000,
    });
    const chain = fakeChain({ head: 2_000, logs: [credit(34, 1_900)] });
    const { arrivals } = await depositArrivals({ archive: node.archiveClient(), deposits: [sent("ab", second(200), { height: 5_000 })], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

    assert.deepEqual(arrivals.get(dusk("ab"))?.state, "waiting");
  });
});

describe("where the apps searched an EVM chain's logs differently", () => {
  const FROM = evmAddressOf(SENDER);
  const TENTH = 100_000_000n;
  /** @param {string | number} n @param {number} block */
  const credit = (n, block) => bridgeFinalized({ block, from: FROM, hash: evmHash(n), to: RECIPIENT, wei: TENTH * DUSK });
  /** @param {number} at @param {Record<string, unknown>} [fields] */
  const sent = (at, fields = {}) => ({ amount: TENTH, at, hash: dusk("ab"), height: 10, sender: SENDER, to: RECIPIENT, ...fields });

  it("a search starts at a block made before the transfer, its time read and not only estimated (WW and BR estimated it from the chain's recent pace)", async () => {
    // A chain whose blocks came four times as often before block 900,000: its last 100,000 blocks' pace says too few blocks back.
    const H = 1_793_000_000;
    const timeAt = (/** @type {bigint} */ n) => Math.floor(n >= 900_000n ? H - (1_000_000 - Number(n)) : H - 100_000 - (900_000 - Number(n)) * 0.25);
    const at = timeAt(800_000n) * 1000;
    const chain = fakeChain({ head: 1_000_000, logs: [credit(7, 800_100)], timeAt });
    const { arrivals } = await depositArrivals({ archive: emptyArchive(), deposits: [sent(at)], fetch: chain.fetch, network: 2, now: H * 1000, via: "rpc" });

    like(arrivals.get(dusk("ab")), { hash: evmHash(7), state: "arrived" });
  });

  it("an RPC that won't search 5,000 blocks at once is asked a quarter as many (WW's search failed)", async () => {
    const chain = fakeChain({ head: 2_000, logs: [credit(7, 1_100)], maxRange: 1_000n });
    const { arrivals } = await depositArrivals({ archive: emptyArchive(), deposits: [sent(second(999), { notBefore: 1_000 })], fetch: chain.fetch, network: 2, now: second(2_000), via: "rpc" });

    like(arrivals.get(dusk("ab")), { hash: evmHash(7), state: "arrived" });
    assert.deepEqual(chain.ranges().slice(0, 3), [[1_000n, 2_000n], [1_000n, 2_000n], [1_000n, 1_311n]]);
  });

  it("a search carries on from where it stopped only while it starts from the same transfer or a later one (WW carried on from any)", async () => {
    // A transfer kept with where its search stopped, past the payout of an equal one sent before it from another device.
    const PAYOUT = `0x${"77".repeat(20)}`;
    const net = withRoutes(networks.testnet, { services: { "dusk-to-ethereum": { payoutAddress: PAYOUT } } });
    const token = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
    const node = routeArchive([
      { byte: "ef", height: 4_000, seconds: 1_792_980_100 },
      { byte: "ab", height: 4_001, seconds: 1_792_980_200 },
    ]);
    const paid = (/** @type {string} */ n, /** @type {number} */ block) => tokenTransfer({ block, from: PAYOUT, hash: evmHash(n), to: RECIPIENT, token, wei: DUSK * DUSK });
    const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500), paid("0b", 1_600)] });
    // What it searched for: the token's transfers of one DUSK from the payout address to the recipient.
    const search = [token.toLowerCase(), TRANSFER_TOPIC, topicOf(PAYOUT), topicOf(RECIPIENT), String(DUSK * DUSK)].join(":");
    const transfer = { hash: dusk("ab"), route: "dusk-to-ethereum", scan: { basis: second(200), from: "1550", search } };
    const { arrivals } = await serviceArrivals({ archive: node.archiveClient(), fetch: chain.fetch, network: net, now: second(2_000), transfers: [transfer] });

    like(arrivals.get(dusk("ab")), { hash: evmHash("0b"), state: "arrived" });
  });
});

describe("where the apps followed migrations and transfers out differently", () => {
  it("a migration route without its payout account pays out nothing that can be told apart (WW and BR took a transfer from anyone)", async () => {
    const HASH = `0x${"cd".repeat(32)}`;
    const spoof = { blockHeight: 100, counterparty: OTHER, direction: "in", hash: dusk("01"), kind: "transfer", memo: HASH, payer: false, timestamp: 1, value: String(3n * DUSK) };
    // Testnet's migration route has no payout account.
    const { payouts, unlisted } = await migrationPayouts({ entries: [/** @type {any} */ (spoof)], migrations: [{ amount: 3n * DUSK, hash: HASH, route: "ethereum-to-dusk" }], network: 2 });

    like(payouts.get(HASH), { reason: "no-route", state: "unknown" });
    assert.deepEqual(unlisted, []);
  });

  it("a transfer out on a route without its payout address takes no transfer as its payout (WW and BR took one from anyone)", async () => {
    const token = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
    const chain = fakeChain({ head: 2_000, logs: [tokenTransfer({ block: 1_500, from: `0x${"5a".repeat(20)}`, hash: evmHash(1), to: RECIPIENT, token, wei: DUSK * DUSK })] });
    const { arrivals } = await serviceArrivals({
      archive: emptyArchive(),
      fetch: chain.fetch,
      network: 2,
      now: second(2_000),
      transfers: [{ amount: 2n * DUSK, at: second(200), hash: dusk("ab"), route: "dusk-to-ethereum", to: RECIPIENT }],
    });

    like(arrivals.get(dusk("ab")), { reason: "no-route", state: "unknown" });
    assert.equal(chain.calls.length, 0);
  });

  it("an equal transfer out another device sent just before takes its payout first: the route's account's history lists it (WW went by the transfers it kept)", async () => {
    const PAYOUT = `0x${"77".repeat(20)}`;
    const net = withRoutes(networks.testnet, { services: { "dusk-to-ethereum": { payoutAddress: PAYOUT } } });
    const token = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
    const node = routeArchive([
      { byte: "ef", height: 4_000, seconds: 1_792_980_100 },
      { byte: "ab", height: 4_001, seconds: 1_792_980_200 },
    ]);
    const chain = fakeChain({ head: 2_000, logs: [tokenTransfer({ block: 1_500, from: PAYOUT, hash: evmHash("0a"), to: RECIPIENT, token, wei: DUSK * DUSK })] });
    const { arrivals } = await serviceArrivals({
      archive: node.archiveClient(),
      fetch: chain.fetch,
      network: net,
      now: second(2_000),
      transfers: [{ hash: dusk("ab"), route: "dusk-to-ethereum" }],
    });

    assert.deepEqual(arrivals.get(dusk("ab"))?.state, "waiting");
  });

  describe("a transfer out's memo is read as the route's bridge reads it", () => {
    const route = networks.mainnet.routes.services[0];
    /** @param {string} memo @returns {any} */
    const sentWith = (memo) => ({ blockHeight: 1, counterparty: route.account, direction: "out", hash: dusk("dd"), kind: "transfer", memo, payer: true, success: true, timestamp: 1, value: String(5n * DUSK) });

    it("spaces around the address make it none: the bridge pays nothing out (WW trimmed them)", () => {
      assert.equal(serviceTransferOf(sentWith(` ${RECIPIENT}`), 1)?.problem, "no-address");
    });

    it("in any case, its checksum unchecked: the bridge pays it (BR refused a mixed-case address whose checksum is wrong)", () => {
      // The first letter's case flipped: still mixed case, its checksum now wrong.
      const i = RECIPIENT.slice(2).search(/[a-fA-F]/) + 2;
      const letter = RECIPIENT[i];
      const wrong = `${RECIPIENT.slice(0, i)}${letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase()}${RECIPIENT.slice(i + 1)}`;

      assert.notEqual(wrong, RECIPIENT);
      like(serviceTransferOf(sentWith(wrong), 1), { problem: null, to: wrong });
    });
  });
});
