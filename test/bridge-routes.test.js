import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";

import { TRANSFER_TOPIC, migrationPayoutOf, migrationPayouts, serviceArrivals, serviceTransferOf } from "../src/bridge.js";
import { fakeChain, moonlight, tokenTransfer, topicOf, transferTx, untilArrived, withRoutes } from "./fixtures/bridge.js";
import { fakeArchive, like } from "./fixtures/helpers.js";

const DUSK = 1_000_000_000n;
const ACCOUNT = "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";
const MIGRATION = `0x${"a6".repeat(32)}`;
const EVM = "0x1111111111111111111111111111111111111111";
const [BSC, ETHEREUM, TO_BSC] = /** @type {any[]} */ (["bsc-to-dusk", "ethereum-to-dusk", "dusk-to-bsc"].map((id) => routes(networks.mainnet).find((route) => route.id === id)));

/** @param {string} byte */
const dusk = (byte) => byte.repeat(64).slice(0, 64);
/** @param {string | number} n */
const evmHash = (n) => `0x${String(n).repeat(64).slice(0, 64)}`;

/**
 * An entry of the account's history, as `/history` keeps it.
 *
 * @param {Record<string, unknown>} fields
 * @returns {any}
 */
const row = (fields) => ({
  blockHeight: 4_000_000,
  counterparty: null,
  direction: "in",
  hash: dusk("bb"),
  kind: "transfer",
  memo: "",
  payer: false,
  success: true,
  timestamp: Date.UTC(2026, 9, 27, 7, 26),
  value: String(5n * DUSK),
  ...fields,
});

const NOW = Date.UTC(2026, 9, 28);

describe("migrations into Dusk", () => {
  it("are paid once the route's payout account pays this account the amount, with the migration's hash as the memo", async () => {
    const sent = [{ amount: 5n * DUSK, at: Date.UTC(2026, 9, 27, 6, 20), hash: MIGRATION.toUpperCase().replace("0X", "0x"), route: "bsc-to-dusk" }];
    const ask = (/** @type {any[]} */ entries) => migrationPayouts({ entries, migrations: sent, network: 1, now: NOW });

    assert.deepEqual((await ask([])).payouts.get(MIGRATION), { state: "waiting" });

    // Anyone can send a transfer with that memo: only the payout account's, of exactly the amount, pays it.
    const elsewhere = row({ counterparty: ACCOUNT, memo: MIGRATION });
    const less = row({ counterparty: BSC.payoutAccount, hash: dusk("c1"), memo: MIGRATION, value: String(4n * DUSK) });

    assert.deepEqual((await ask([elsewhere])).payouts.get(MIGRATION), { state: "waiting" });
    // The payout account's, of another amount: its own, but not of what it migrated.
    like((await ask([elsewhere, less])).payouts.get(MIGRATION), { reason: "unsure", state: "unknown" });

    const payout = row({ counterparty: BSC.payoutAccount, memo: MIGRATION });
    const paid = await ask([elsewhere, less, payout]);

    assert.deepEqual(paid.payouts.get(MIGRATION), { amount: 5n * DUSK, at: payout.timestamp, block: payout.blockHeight, hash: payout.hash, state: "arrived" });
    assert.equal(paid.requests, 0);
    // A payout from the payout account naming a migration given isn't another's.
    assert.deepEqual(paid.unlisted, []);
  });

  it("include the payouts in the history of migrations sent elsewhere, from either route's payout account", async () => {
    const fromBsc = row({ counterparty: BSC.payoutAccount, memo: `0x${"c3".repeat(32)}` });
    const fromEthereum = row({ blockHeight: 4_000_100, counterparty: ETHEREUM.payoutAccount, hash: dusk("bd"), memo: ` 0x${"C4".repeat(32)} `, timestamp: null });
    // A transfer from anyone else with a transaction hash as its memo pays no migration.
    const spoof = row({ counterparty: ACCOUNT, hash: dusk("be"), memo: `0x${"c5".repeat(32)}` });
    const { unlisted } = await migrationPayouts({ entries: [fromEthereum, spoof, fromBsc], migrations: [], network: 1 });

    // When it was sent isn't known from its payout: only when it was paid.
    assert.deepEqual(unlisted, [
      { amount: 5n * DUSK, at: fromBsc.timestamp, block: 4_000_000, hash: `0x${"c3".repeat(32)}`, payer: BSC.payoutAccount, payout: dusk("bb"), route: "bsc-to-dusk" },
      { amount: 5n * DUSK, at: null, block: 4_000_100, hash: `0x${"c4".repeat(32)}`, payer: ETHEREUM.payoutAccount, payout: dusk("bd"), route: "ethereum-to-dusk" },
    ]);
    assert.equal(migrationPayoutOf(spoof, 1), null);
    // Sent from the payout account, not received from it.
    assert.equal(migrationPayoutOf({ ...fromBsc, direction: "out" }, 1), null);
    assert.equal(migrationPayoutOf({ ...fromBsc, success: false }, 1), null);
  });

  it("are paid only by a memo of text: the hash's bytes, which /history gives as 0x hex, name no migration", async () => {
    const sent = [{ amount: 5n * DUSK, at: Date.UTC(2026, 9, 27, 6, 20), hash: MIGRATION, route: "bsc-to-dusk" }];
    const bytes = row({ counterparty: BSC.payoutAccount, memo: MIGRATION, memoBinary: true });

    assert.equal(migrationPayoutOf(bytes, 1), null);
    assert.deepEqual((await migrationPayouts({ entries: [bytes], migrations: sent, network: 1, now: NOW })).payouts.get(MIGRATION), { state: "waiting" });
    // The same hash as text pays it.
    like(migrationPayoutOf(row({ counterparty: BSC.payoutAccount, memo: MIGRATION }), 1), { hash: MIGRATION });
  });

  it("are paid by an account that pays out both routes by the route each was sent on, and one not listed names no route", async () => {
    // One account pays out both chains' migrations, as a deployment can set it.
    const net = withRoutes(networks.mainnet, { migrations: { "ethereum-to-dusk": { payoutAccount: BSC.payoutAccount } } });
    const sent = [{ amount: 5n * DUSK, at: Date.UTC(2026, 9, 27, 6, 20), hash: MIGRATION, route: "ethereum-to-dusk" }];
    const payout = row({ counterparty: BSC.payoutAccount, memo: MIGRATION });
    const elsewhere = row({ counterparty: BSC.payoutAccount, hash: dusk("bd"), memo: `0x${"c3".repeat(32)}` });
    const paid = await migrationPayouts({ entries: [payout, elsewhere], migrations: sent, network: net, now: NOW });

    assert.deepEqual(paid.payouts.get(MIGRATION), { amount: 5n * DUSK, at: payout.timestamp, block: payout.blockHeight, hash: payout.hash, state: "arrived" });
    // Which chain a payout of a migration not listed is for, its transfer doesn't say.
    assert.deepEqual(paid.unlisted.map(({ payer, route }) => [payer, route]), [[BSC.payoutAccount, null]]);
    like(migrationPayoutOf(elsewhere, net), { payer: BSC.payoutAccount, route: null });

    // From the archive's memo index too.
    const node = fakeArchive({
      accounts: {},
      details: { [dusk("ef")]: { blockHash: "aa".repeat(32), blockTimestamp: 1_792_990_000, err: null, gasSpent: 1, tx: { callData: null, gasLimit: 1, gasPrice: 1 } } },
      finalized: 10_000,
      memos: { [MIGRATION]: [moonlight({ hash: dusk("ef"), height: 101, memo: MIGRATION, receiver: ACCOUNT, sender: BSC.payoutAccount, value: 5n * DUSK })] },
    });
    const found = await migrationPayouts({ account: ACCOUNT, archive: node.archiveClient(), migrations: sent, network: net, now: NOW });

    like(found.payouts.get(MIGRATION), { amount: 5n * DUSK, hash: dusk("ef"), state: "arrived" });
  });

  describe("found by the archive's memo index, as a receipt shows one migration", () => {
    // Testnet's migration route, with a payout account.
    const PAYER = networks.testnet.routes.services[0].account;
    const OTHER = networks.mainnet.routes.services[0].account;
    const net = withRoutes(networks.testnet, { migrations: { "ethereum-to-dusk": { payoutAccount: PAYER } } });
    const HASH = `0x${"cd".repeat(32)}`;
    const migration = { amount: 3n * DUSK, at: 1_792_980_000_000, hash: HASH, route: "ethereum-to-dusk" };
    /** @param {any[]} payouts */
    const node = (payouts) =>
      fakeArchive({
        accounts: {},
        details: { [dusk("ef")]: { blockHash: "aa".repeat(32), blockTimestamp: 1_792_990_000, err: null, gasSpent: 1, tx: { callData: null, gasLimit: 1, gasPrice: 1 } } },
        finalized: 10_000,
        memos: { [HASH]: payouts },
      });

    it("is waiting until the payout account pays it out, then paid with the payout's time", async () => {
      const none = node([]);
      const waiting = await migrationPayouts({ account: ACCOUNT, archive: none.archiveClient(), migrations: [migration], network: net, now: NOW });

      assert.deepEqual(waiting.payouts.get(HASH), { state: "waiting" });
      assert.match(none.memoQueries()[0].query, new RegExp(`transactionsByMemo\\(memo: "${HASH}"\\)`));

      const paid = node([
        moonlight({ hash: dusk("00"), height: 100, memo: HASH, receiver: OTHER, sender: PAYER, value: 3n * DUSK }),
        moonlight({ hash: dusk("ef"), height: 101, memo: HASH, receiver: ACCOUNT, sender: PAYER, value: 3n * DUSK }),
      ]);
      const result = await migrationPayouts({ account: ACCOUNT, archive: paid.archiveClient(), migrations: [migration], network: net, now: NOW });

      assert.deepEqual(result.payouts.get(HASH), { amount: 3n * DUSK, at: 1_792_990_000_000, block: 101, hash: dusk("ef"), state: "arrived" });
      // The memo index, then the payout's details.
      assert.equal(result.requests, 2);
    });

    it("is paid only by the migrated amount, and only from the payout account", async () => {
      const spoofs = [
        moonlight({ hash: dusk("01"), height: 100, memo: HASH, receiver: ACCOUNT, sender: OTHER, value: 1 }),
        moonlight({ hash: dusk("02"), height: 101, memo: HASH, receiver: ACCOUNT, sender: OTHER, value: 3n * DUSK }),
      ];
      const less = moonlight({ hash: dusk("03"), height: 102, memo: HASH, receiver: ACCOUNT, sender: PAYER, value: 2n * DUSK });
      const ask = (/** @type {any[]} */ payouts) => migrationPayouts({ account: ACCOUNT, archive: node(payouts).archiveClient(), migrations: [migration], network: net, now: NOW });

      assert.deepEqual((await ask(spoofs)).payouts.get(HASH), { state: "waiting" });
      // The payout account's, of another amount: unsure.
      like((await ask([...spoofs, less])).payouts.get(HASH), { reason: "unsure", state: "unknown" });
      like((await ask([...spoofs, less, moonlight({ hash: dusk("ef"), height: 103, memo: HASH, receiver: ACCOUNT, sender: PAYER, value: 3n * DUSK })])).payouts.get(HASH), { hash: dusk("ef"), state: "arrived" });
    });

    it("isn't asked about once waited for a week", async () => {
      const archive = node([]);
      const old = await migrationPayouts({ account: ACCOUNT, archive: archive.archiveClient(), migrations: [migration], network: net, now: migration.at + 8 * 86_400_000 });

      like(old.payouts.get(HASH), { reason: "expired", state: "unknown" });
      assert.equal(archive.log.length, 0);
    });
  });

  it("are each paid by one payout, which no other migration has", async () => {
    const payout = row({ counterparty: BSC.payoutAccount, memo: MIGRATION });
    const twice = await migrationPayouts({
      entries: [payout],
      migrations: [
        { amount: 5n * DUSK, hash: MIGRATION, route: "bsc-to-dusk" },
        { amount: 5n * DUSK, hash: MIGRATION.toUpperCase().replace("0X", "0x"), route: "bsc-to-dusk" },
      ],
      network: 1,
    });

    assert.equal(twice.payouts.size, 1);
    like(twice.payouts.get(MIGRATION), { hash: payout.hash, state: "arrived" });

    const taken = await migrationPayouts({ entries: [payout], migrations: [{ amount: 5n * DUSK, hash: MIGRATION, route: "bsc-to-dusk" }], network: 1, taken: [payout.hash] });

    assert.deepEqual(taken.payouts.get(MIGRATION), { state: "waiting" });
    // Waited for a week, it is unknown.
    const old = await migrationPayouts({ entries: [], migrations: [{ amount: 1n, at: NOW - 8 * 86_400_000, hash: MIGRATION, route: "bsc-to-dusk" }], network: 1, now: NOW });

    like(old.payouts.get(MIGRATION), { reason: "expired", state: "unknown" });
    await assert.rejects(migrationPayouts({ migrations: [{ amount: 1n, hash: "nope", route: "bsc-to-dusk" }], network: 1 }), TypeError);
    await assert.rejects(migrationPayouts({ migrations: [], network: 1 }), TypeError);
  });
});

/**
 * The Dusk archive as a route's transfers out need it: each one's
 * transaction, as `tx(hash) { … tx { memo json } }` gives it, and the
 * route's account's history, which lists them all.
 *
 * @param {string} account the route's account
 * @param {{ byte: string, height: number, seconds: number, sender?: string, value?: bigint, memo?: string, err?: string | null, receiver?: string }[]} sends
 */
function routeArchive(account, sends) {
  const listed = sends
    .filter(({ err, receiver = account }) => !err && receiver === account)
    .map(({ byte, height, memo = "", sender = ACCOUNT, value = 2n * DUSK }) => moonlight({ hash: dusk(byte), height, memo, receiver: account, sender, value }));

  return fakeArchive({
    accounts: { [account]: { receiver: listed, sender: [] } },
    details: {},
    finalized: 10_000_000,
    transactions: Object.fromEntries(
      sends.map(({ byte, err = null, height, memo = "", receiver = account, seconds, sender = ACCOUNT, value = 2n * DUSK }) => [dusk(byte), transferTx({ err, height, memo, receiver, seconds, sender, value })])
    ),
  });
}

describe("transfers out to BNB Smart Chain", () => {
  const SENT_AT = Date.UTC(2026, 9, 27, 11, 55);
  const sent = row({
    counterparty: TO_BSC.account,
    direction: "out",
    hash: dusk("dd"),
    memo: EVM,
    payer: true,
    timestamp: SENT_AT,
    value: String(200_001n * DUSK),
  });

  it("are sent until they arrive, and pay nothing out at or under the bridge fee, without an address as the memo, or when they failed", () => {
    assert.deepEqual(serviceTransferOf(sent, 1), {
      amount: null,
      at: SENT_AT,
      fee: DUSK,
      hash: dusk("dd"),
      height: 4_000_000,
      problem: null,
      route: "dusk-to-bsc",
      sent: 200_001n * DUSK,
      to: EVM,
    });
    assert.deepEqual(
      [{ value: String(DUSK) }, { memo: "alice" }, { success: false }].map((fields) => serviceTransferOf({ ...sent, ...fields }, 1)?.problem),
      ["under-fee", "no-address", "failed"]
    );
    // Received from the route's account isn't a transfer out.
    assert.equal(serviceTransferOf({ ...sent, direction: "in" }, 1), null);
    assert.equal(serviceTransferOf({ ...sent, counterparty: ACCOUNT }, 1), null);
  });

  it("arrive with the token transfer from the route's payout address to the memo's address of the amount less the fee, searched from about when sent", async () => {
    const head = 130_200_000n;
    /** BNB Smart Chain's pace: a block every 0.45 s. */
    const timeAt = (/** @type {bigint} */ n) => Math.floor(Date.UTC(2026, 9, 28, 0, 0) / 1_000 - Number(head - n) * 0.45);
    const payout = evmHash("1f");
    // The payout, 10 hours after it was sent, and an hour before it someone else's transfer of the same to the same address.
    const chain = fakeChain({
      head,
      logs: [
        tokenTransfer({ block: head - BigInt(Math.round((3 * 3_600) / 0.45)), from: `0x${"5a".repeat(20)}`, hash: evmHash("2e"), to: EVM, token: TO_BSC.chain.token, wei: 200_000n * DUSK * DUSK }),
        tokenTransfer({ block: head - BigInt(Math.round((2 * 3_600) / 0.45)), from: TO_BSC.payoutAddress, hash: payout, to: EVM, token: TO_BSC.chain.token, wei: 200_000n * DUSK * DUSK }),
      ],
      timeAt,
      url: TO_BSC.chain.rpcUrl,
    });
    // And an equal transfer a minute after it.
    const archive = routeArchive(TO_BSC.account, [
      { byte: "dd", height: 4_000_000, memo: EVM, seconds: SENT_AT / 1000, value: 200_001n * DUSK },
      { byte: "ab", height: 4_000_006, memo: EVM, seconds: SENT_AT / 1000 + 60, value: 200_001n * DUSK },
    ]).archiveClient();
    const transfer = /** @type {any} */ ({ hash: dusk("dd"), route: "dusk-to-bsc" });
    const ask = (/** @type {any} */ one, /** @type {Record<string, unknown>} */ more = {}) =>
      serviceArrivals({ archive, fetch: chain.fetch, maxWindows: 2, network: 1, now: Date.UTC(2026, 9, 28), transfers: [one], ...more });

    // A check searches a few windows, two here, and says where it got to.
    const first = /** @type {any} */ ((await ask(transfer)).arrivals.get(dusk("dd")));
    const [asked] = chain.calls.filter((c) => c.method === "eth_getLogs");

    like(first, { reason: "searching", state: "unknown" });
    like(asked.params[0], { address: TO_BSC.chain.token.toLowerCase(), topics: [TRANSFER_TOPIC, topicOf(TO_BSC.payoutAddress), topicOf(EVM)] });
    assert.ok(BigInt(first.scan.from) > BigInt(asked.params[0].fromBlock));

    // Until it's found, on later checks: the payout, not the other transfer.
    /** @type {any} */
    let found = first;

    for (let i = 0; i < 20 && found.state !== "arrived"; i += 1) found = (await ask({ ...transfer, scan: found.scan })).arrivals.get(dusk("dd"));

    like(found, { amount: 200_000n * DUSK, hash: payout, state: "arrived" });

    // The equal one after it, asked alone, isn't paid with it: that payout is the first one's.
    const other = (await ask({ hash: dusk("ab"), route: "dusk-to-bsc", scan: found.scan }, { taken: [payout] })).arrivals.get(dusk("ab"));

    assert.notEqual(other?.state, "arrived");
  });

  it("read their chain until they arrive, and nothing for the rest", async () => {
    const chain = fakeChain({ head: 16, timeAt: () => 16 });
    const node = routeArchive(TO_BSC.account, [{ byte: "dd", height: 4_000_000, memo: EVM, seconds: SENT_AT / 1000, value: 200_001n * DUSK }]);

    like((await serviceArrivals({ archive: node.archiveClient(), fetch: chain.fetch, network: 1, transfers: [{ hash: dusk("dd"), route: "dusk-to-bsc" }] })).arrivals.get(dusk("dd")), { state: "waiting" });
    assert.deepEqual(chain.methods(), ["eth_getBlockByNumber", "eth_getBlockByNumber", "eth_getLogs"]);
    // Its transaction, and the route's account's history.
    assert.deepEqual([node.log.length, node.historyQueries().length], [2, 1]);

    // Once it arrived, the app asks nothing for it: nothing is read.
    chain.calls.length = 0;
    node.log.length = 0;
    await serviceArrivals({ archive: node.archiveClient(), fetch: chain.fetch, network: 1, transfers: [] });
    assert.deepEqual([chain.calls.length, node.log.length], [0, 0]);
  });

  describe("on the Sepolia route, with its payout address", () => {
    const SENDER = networks.mainnet.routes.services[0].account;
    const SERVICE = networks.testnet.routes.services[0].account;
    const RECIPIENT = "0x3E5B8223e638CB414BEF8CF95393460cA1C3a11d";
    const PAYOUT = `0x${"77".repeat(20)}`;
    const TOKEN = /** @type {string} */ (networks.testnet.routes.chains.ethereum.token);
    const net = withRoutes(networks.testnet, { services: { "dusk-to-ethereum": { payoutAddress: PAYOUT } } });
    /** @param {string} byte @param {Record<string, unknown>} [fields] @returns {any} */
    const transfer = (byte, fields = {}) => ({ hash: dusk(byte), route: "dusk-to-ethereum", ...fields });
    /** @param {string} n @param {number} block @param {bigint} [wei] */
    const paid = (n, block, wei = DUSK * DUSK) => tokenTransfer({ block, from: PAYOUT, hash: evmHash(n), to: RECIPIENT, token: TOKEN, wei });
    /** @param {{ byte: string, height: number, seconds: number, value?: bigint, memo?: string, err?: string | null, receiver?: string }[]} sends */
    const archiveWith = (sends) => routeArchive(SERVICE, sends.map((each) => ({ memo: RECIPIENT, sender: SENDER, ...each })));

    it("take one payout each when equal, in the order they were sent", async () => {
      const node = archiveWith([
        { byte: "ab", height: 4_000, seconds: 1_792_980_100 },
        { byte: "ef", height: 4_001, seconds: 1_792_980_200 },
      ]);
      const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
      const options = { archive: node.archiveClient(), fetch: chain.fetch, network: net, now: 1_792_982_000_000 };
      const both = await untilArrived((scans) => serviceArrivals({ ...options, transfers: [transfer("ef"), transfer("ab")].map((t) => ({ ...t, scan: scans.get(t.hash) })) }), dusk("ab"));

      // One payout so far: it's the first transfer's, once its blocks are read again.
      like(both.arrivals.get(dusk("ab")), { hash: evmHash("0a"), state: "arrived" });
      like(both.arrivals.get(dusk("ef")), { state: "waiting" });

      // The payout the first one took isn't the second one's.
      like((await serviceArrivals({ ...options, taken: [evmHash("0a")], transfers: [transfer("ef")] })).arrivals.get(dusk("ef")), { state: "waiting" });
      chain.logs.push(paid("0b", 1_600));
      like((await serviceArrivals({ ...options, taken: [evmHash("0a")], transfers: [transfer("ef")] })).arrivals.get(dusk("ef")), { hash: evmHash("0b"), state: "arrived" });
    });

    it("leave the earlier equal transfer's payout to it, on a device that only knows the later one: the account's history lists both", async () => {
      const node = archiveWith([
        // Sent three days before: paid long ago.
        { byte: "aa", height: 3_000, seconds: 1_792_980_200 - 3 * 86_400 },
        { byte: "ef", height: 4_000, seconds: 1_792_980_100 },
        { byte: "ab", height: 4_001, seconds: 1_792_980_200 },
        // Another amount.
        { byte: "bb", height: 4_002, seconds: 1_792_980_150, value: 5n * DUSK },
      ]);
      const chain = fakeChain({ head: 2_000, logs: [paid("0a", 1_500)] });
      const options = { archive: node.archiveClient(), fetch: chain.fetch, network: net, now: 1_792_982_000_000, transfers: [transfer("ab")] };

      // The one payout so far is the earlier transfer's.
      like((await serviceArrivals(options)).arrivals.get(dusk("ab")), { state: "waiting" });
      assert.match(node.historyQueries()[0].query, new RegExp(`moonlightHistory\\(receiver: "${SERVICE}", fromBlock: 0, toBlock: 4001, maxCount: 50\\)`));
      chain.logs.push(paid("0b", 1_600));
      like((await serviceArrivals(options)).arrivals.get(dusk("ab")), { hash: evmHash("0b"), state: "arrived" });
    });

    it("complete when the bridge pays the memo address what the account received less the fee", async () => {
      const chain = fakeChain({ head: 2_000, logs: [paid("01", 1_500, 2n * DUSK * DUSK), paid("02", 1_600)] });
      const result = await serviceArrivals({ archive: archiveWith([{ byte: "ab", height: 4_000, seconds: 1_792_980_999 }]).archiveClient(), fetch: chain.fetch, network: net, now: 1_792_982_000_000, transfers: [transfer("ab")] });

      // 2 DUSK minus the 1 DUSK fee, in 18 decimals.
      assert.deepEqual(result.arrivals.get(dusk("ab")), { amount: DUSK, at: (1_792_980_000 + 1_600) * 1000, block: 1_600, hash: evmHash("02"), state: "arrived" });

      const [asked] = chain.calls.filter((c) => c.method === "eth_getLogs");

      assert.deepEqual(asked.params[0].topics, [TRANSFER_TOPIC, topicOf(PAYOUT), topicOf(RECIPIENT)]);
      assert.equal(asked.params[0].address, TOKEN.toLowerCase());
      assert.equal(asked.url, networks.testnet.routes.chains.ethereum.rpcUrl);
    });

    it("isn't paid by a payout from before it was sent here", async () => {
      // Sent here: the head read before sending (block 1,700) bounds the search.
      const chain = fakeChain({ head: 2_000, logs: [paid("01", 1_500), paid("02", 1_800)] });
      const result = await serviceArrivals({
        archive: archiveWith([{ byte: "ab", height: 4_000, seconds: 1_792_980_999 }]).archiveClient(),
        fetch: chain.fetch,
        network: net,
        now: 1_792_982_000_000,
        transfers: [transfer("ab", { notBefore: 1_700 })],
      });

      like(result.arrivals.get(dusk("ab")), { hash: evmHash("02"), state: "arrived" });
    });

    it("pay nothing out, as the chain shows them, and wait while the archive doesn't have them", async () => {
      const node = archiveWith([
        { byte: "a1", height: 4_000, seconds: 1_792_980_999, value: DUSK },
        { byte: "a2", height: 4_000, memo: "alice", seconds: 1_792_980_999 },
        { byte: "a3", height: 4_000, memo: ` ${RECIPIENT}`, seconds: 1_792_980_999 },
        { byte: "a4", err: "Panic", height: 4_000, seconds: 1_792_980_999 },
        { byte: "a5", height: 4_000, receiver: SENDER, seconds: 1_792_980_999 },
      ]);
      const chain = fakeChain({ head: 2_000 });
      const { arrivals } = await serviceArrivals({
        archive: node.archiveClient(),
        fetch: chain.fetch,
        network: net,
        now: 1_792_982_000_000,
        transfers: ["a1", "a2", "a3", "a4", "a5", "a6"].map((byte) => transfer(byte)),
      });

      assert.deepEqual(
        ["a1", "a2", "a3", "a4", "a5"].map((byte) => /** @type {any} */ (arrivals.get(dusk(byte))).problem),
        ["under-fee", "no-address", "no-address", "failed", "elsewhere"]
      );
      like(arrivals.get(dusk("a1")), { reason: "no-payout", state: "unknown" });
      assert.deepEqual(arrivals.get(dusk("a6")), { state: "waiting" });
      assert.equal(chain.calls.length, 0);
      await assert.rejects(serviceArrivals({ archive: node.archiveClient(), network: net, transfers: [transfer("ab", { hash: "nope" })] }), TypeError);
      await assert.rejects(serviceArrivals(/** @type {any} */ ({ network: net, transfers: [] })), TypeError);
    });
  });
});
