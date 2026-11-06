import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";

import { activityRows } from "../src/activity.js";
import { formatAmount } from "../src/amounts.js";
import { migrationFacts, migrationsOf, serviceArrivals, transferLedger } from "../src/bridge.js";
import { createArchive } from "../src/history.js";
import { entryFrom, entryOf, hash } from "./fixtures/activity.js";
import { fakeChain, hex, tokenTransfer, transferTx } from "./fixtures/bridge.js";
import { fakeArchive, like, readFixture } from "./fixtures/helpers.js";

const { mainnet } = readFixture("bridge-status.json");
const deposit = readFixture("duskevm-deposit-history.json");
const BSC = /** @type {any} */ (routes(networks.mainnet).find((route) => route.id === "dusk-to-bsc"));
const MIGRATION = /** @type {any} */ (routes(networks.mainnet).find((route) => route.id === "bsc-to-dusk"));
const WEI = 1_000_000_000n;

/** The transfer of 20,301 DUSK to BSC's route recorded on mainnet, as its sender's activity has it. */
const serviceRow = () => {
  const [raw] = mainnet.paid;

  return activityRows({ account: mainnet.sender, network: 1, public: [entryFrom(mainnet.sender, raw, mainnet.details[raw.origin], {}, { network: 1 })] })[0];
};

/** @param {import("../src/bridge.js").TransferLedger | null} ledger */
const shown = (ledger) => ledger?.lines.map((line) => [line.key, line.text, line.exact, line.coin, line.expected]);

describe("a transfer's ledger", () => {
  it("says what was sent, the bridge's fee, the network's fee and what arrives, before it arrives", () => {
    const ledger = transferLedger({ locale: "en-GB", row: serviceRow() });

    assert.deepEqual(shown(ledger), [
      ["sent", "20,301", "20,301", "DUSK", false],
      ["bridgeFee", "1", "1", "DUSK", false],
      ["networkFee", "0.0019", "0.001858749", "DUSK", false],
      ["received", "20,300", "20,300", "BEP20 DUSK", true],
    ]);
    like(ledger, { arrived: false, failed: false, kind: "service", route: "dusk-to-bsc" });
  });

  it("says what arrived, as /bridge found it on the other chain, to the same numbers as the chains'", async () => {
    // The payout recorded on BNB Smart Chain of that transfer.
    const memo = "0xe5006cb536a927d13a2cace8e7666d1083b329e0";
    const [log] = mainnet.bsc.logs;
    const chain = fakeChain({
      head: BigInt(mainnet.bsc.head),
      logs: [tokenTransfer({ block: BigInt(log.blockNumber), from: BSC.payoutAddress, hash: log.transactionHash, to: memo, token: BSC.chain.token, wei: BigInt(log.data) })],
      stamps: true,
      timeAt: (n) => Number(log.blockTimestamp) + Math.round(Number(n - BigInt(log.blockNumber)) * 0.45),
    });
    const paid = mainnet.details[mainnet.paid[0].origin];
    const archive = fakeArchive({
      accounts: { [BSC.account]: { receiver: mainnet.received, sender: mainnet.sent } },
      details: mainnet.details,
      finalized: mainnet.finalized,
      transactions: { [mainnet.paid[0].origin]: transferTx({ height: paid.blockHeight, memo, receiver: BSC.account, seconds: paid.blockTimestamp, sender: mainnet.sender, value: 20_301_000_000_000n }) },
      url: networks.mainnet.urls.node,
    });
    const row = serviceRow();
    const { arrivals } = await serviceArrivals({
      archive: createArchive({ fetch: archive.fetch, url: networks.mainnet.urls.node }),
      fetch: chain.fetch,
      network: 1,
      now: 1793876603000,
      transfers: [{ hash: row.hash, route: "dusk-to-bsc" }],
    });
    const arrival = /** @type {any} */ (arrivals.get(row.hash));

    assert.equal(arrival.state, "arrived");

    const ledger = /** @type {any} */ (transferLedger({ arrival, locale: "en-GB", row }));

    assert.equal(ledger.arrived, true);
    assert.equal(ledger.received.amount, 20_300_000_000_000n);
    assert.equal(ledger.received.expected, false);
    // Sent, less the bridge's fee, is what arrived, to the lux.
    assert.equal(ledger.sent.amount - ledger.bridgeFee.amount, ledger.received.amount);
  });

  it("writes each amount short for a row and exact for its detail, as Nandini's transfer shows", () => {
    // 0.190082082 sent, 0.1 taken, 0.090082082 received, at a fee of 0.001859281.
    const ledger = /** @type {any} */ (transferLedger({ bridgeFee: 100_000_000n, locale: "en-GB", networkFee: 1_859_281n, received: 90_082_082n, route: "dusk-to-bsc", network: 1, sent: 190_082_082n }));

    assert.deepEqual(shown(ledger), [
      ["sent", "0.19", "0.190082082", "DUSK", false],
      ["bridgeFee", "0.1", "0.1", "DUSK", false],
      ["networkFee", "0.0019", "0.001859281", "DUSK", false],
      ["received", "0.09", "0.090082082", "BEP20 DUSK", false],
    ]);
    // In the language's separators.
    assert.equal(/** @type {any} */ (transferLedger({ locale: "de-DE", network: 1, route: "dusk-to-bsc", sent: 190_082_082n })).sent.exact, "0,190082082");
  });

  it("takes out a gas refund the sender paid another account, as it isn't the transfer's", () => {
    const row = serviceRow();
    const refunded = { ...row, entry: { ...row.entry, refund: 500n }, value: row.value + 500n };

    assert.equal(/** @type {any} */ (transferLedger({ row: /** @type {any} */ (refunded) })).sent.amount, row.value);
  });

  it("takes no refund out of what the wallet's record says it sent, which holds none", () => {
    // On chain before its details are read: the row's value is the record's.
    const row = serviceRow();
    const recorded = { ...row, entry: { ...row.entry, refund: 500n, success: undefined }, sent: { amount: String(row.value), hash: row.hash }, value: row.value };

    assert.equal(/** @type {any} */ (transferLedger({ row: /** @type {any} */ (recorded) })).sent.amount, row.value);
  });

  it("says nothing arrives of one the fee takes whole, and of one the bridge won't pay", () => {
    const under = /** @type {any} */ (transferLedger({ network: 1, route: "dusk-to-bsc", sent: 1_000_000_000n }));

    assert.equal(under.received.amount, 0n);
    assert.equal(under.received.expected, true);

    const paysNothing = /** @type {any} */ (transferLedger({ arrival: { problem: "no-address", reason: "no-payout", state: "unknown" }, network: 1, route: "dusk-to-bsc", sent: 5_000_000_000n }));

    assert.equal(paysNothing.received.amount, 0n);
    assert.equal(paysNothing.received.expected, false);
  });

  it("says only the fee of one that failed: nothing moved", () => {
    const row = serviceRow();
    const failed = transferLedger({ row: { ...row, status: "failed" } });

    assert.deepEqual(shown(failed), [["networkFee", "0.0019", "0.001858749", "DUSK", false]]);
    like(failed, { arrived: false, failed: true, received: null, sent: null });
  });

  it("has a deposit's: what it sent, its fee, and what arrived on DuskEVM, with no bridge fee", () => {
    const tx = deposit.details[deposit.entry.origin];
    const entry = entryFrom(deposit.account, deposit.entry, tx, { bridge: { amount: "500000000", kind: "deposit", to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F" } });
    const [row] = activityRows({ account: deposit.account, network: 2, public: [entry] });
    const ledger = transferLedger({ locale: "en-GB", network: 2, row });

    assert.deepEqual(shown(ledger), [
      ["sent", "0.5", "0.5", "DUSK", false],
      ["networkFee", "0.002", "0.001985878", "DUSK", false],
      ["received", "0.5", "0.5", "DUSK", true],
    ]);
    assert.equal(ledger?.route, "dusk-to-dusk-evm");
    assert.equal(/** @type {any} */ (transferLedger({ arrival: { amount: 500_000_000n, at: 1, block: 2, hash: "0x", state: "arrived" }, row })).received.expected, false);
  });

  it("has a migration's: its token sent, the gas in its chain's coin, and the DUSK paid", () => {
    const ledger = /** @type {any} */ (transferLedger({ arrival: { amount: 54_325_305_359n, at: 1, block: 2, hash: "0x", state: "arrived" }, gasWei: 210_000_123_456_789n, locale: "en-GB", route: MIGRATION, sent: 54_325_305_359n }));

    assert.deepEqual(shown(ledger), [
      ["sent", "54.3253", "54.325305359", "BEP20 DUSK", false],
      ["received", "54.3253", "54.325305359", "DUSK", false],
      ["gas", "0.00021", "0.000210000123456789", "BNB", false],
    ]);
    assert.equal(/** @type {any} */ (transferLedger({ gasWei: 10n ** 15n, network: 1, route: "ethereum-to-dusk", sent: 1n })).gas.coin, "ETH");
    assert.equal(/** @type {any} */ (transferLedger({ network: 1, route: "ethereum-to-dusk", sent: 1n })).sent.coin, "ERC20 DUSK");
  });

  it("has a migration's payout alone, as a row on Dusk knows it", () => {
    const raw = mainnet.sent[1];
    const receiver = raw.events[0].data.receiver;
    const [row] = activityRows({ account: receiver, network: 1, public: [entryFrom(receiver, raw, mainnet.details[raw.origin], {}, { network: 1 })] });
    const ledger = transferLedger({ locale: "en-GB", row });

    assert.deepEqual(shown(ledger), [
      ["sent", "54.3253", "54.325305359", "BEP20 DUSK", false],
      ["received", "54.3253", "54.325305359", "DUSK", false],
    ]);
    assert.equal(ledger?.networkFee, null);
  });

  it("has a withdrawal's: its proof's and claim's fees together, and its gas on DuskEVM", () => {
    const contracts = /** @type {any} */ (duskEvmContracts(2));
    const claim = entryOf({ bridge: undefined, contractId: contracts.portal, counterparty: contracts.portal, direction: "in", fee: "2300000", fnName: "finalizeWithdrawalTransaction", hash: hash(0x61), kind: "contract_call", value: "1000000000" });
    const [row] = activityRows({ network: 2, public: [claim] });
    const ledger = /** @type {any} */ (transferLedger({ gasWei: 138_000_000_000n, locale: "en-GB", network: 2, networkFee: [2_300_000n, 2_400_000n], row, sent: 1_000_000_000n }));

    assert.deepEqual(shown(ledger), [
      ["sent", "1", "1", "DUSK", false],
      ["networkFee", "0.0047", "0.0047", "DUSK", false],
      ["received", "1", "1", "DUSK", false],
      ["gas", "0.00000014", "0.000000138", "DUSK", false],
    ]);
    assert.equal(ledger.route, "dusk-evm-to-dusk");
  });

  it("takes what an app keeps of a transfer, as the standalone keeps its own", () => {
    const entry = { amountLux: "20301000000000", feeLux: "1858749", routeId: "dusk-to-bsc" };
    const ledger = transferLedger({ locale: "en-GB", network: 1, networkFee: entry.feeLux, route: { id: entry.routeId }, sent: entry.amountLux });

    assert.deepEqual(shown(ledger), shown(transferLedger({ locale: "en-GB", row: serviceRow() })));
  });

  it("is the same in every app, written by /amounts' one rule", () => {
    const ledger = /** @type {any} */ (transferLedger({ locale: "fr-FR", network: 1, route: "dusk-to-bsc", sent: 1_484_923_500_000n }));

    assert.deepEqual([ledger.sent.text, ledger.sent.exact], [formatAmount(1_484_923_500_000n, { locale: "fr-FR", round: "down" }).text, formatAmount(1_484_923_500_000n, { locale: "fr-FR" }).exact]);
  });

  it("is nothing for a row that's no bridge transfer", () => {
    const [row] = activityRows({ network: 2, public: [entryOf({ counterparty: null, kind: "transfer", value: "5" })] });

    assert.equal(transferLedger({ row }), null);
    assert.equal(transferLedger(), null);
  });
});

describe("a migration's side on its own chain", () => {
  // Recorded on BNB Smart Chain: an account's two migrations, each after its own approval, and their payouts on Dusk.
  const bsc = readFixture("bridge-migration-bsc.json");
  const [firstApproval, firstMigration, secondApproval, secondMigration] = Object.keys(bsc.receipts);
  /** @param {any} log */
  const asLog = (log) => ({ address: log.address, block: BigInt(log.blockNumber), data: log.data, hash: log.transactionHash, index: Number(BigInt(log.logIndex)), topics: log.topics });
  /**
   * BSC's RPC as recorded, without what `drop` names.
   *
   * @param {{ drop?: string[], logs?: boolean, maxRange?: bigint, receipts?: Record<string, any> }} [options]
   */
  const chainOf = ({ drop = [], logs = true, maxRange, receipts = {} } = {}) =>
    fakeChain({
      head: BigInt(bsc.head),
      logs: logs ? bsc.logs.filter((/** @type {any} */ log) => !drop.includes(log.transactionHash)).map(asLog) : [],
      maxRange,
      receipts: { ...Object.fromEntries(Object.entries(bsc.receipts).filter(([hash]) => !drop.includes(hash))), ...receipts },
      timeAt: (n) => Number(BigInt(bsc.blocks[hex(n)]?.timestamp ?? "0x0")),
    });
  const [payout] = activityRows({
    account: bsc.payouts.entries[0].events[0].data.receiver,
    network: 1,
    public: bsc.payouts.entries.map((/** @type {any} */ raw) => entryFrom(raw.events[0].data.receiver, raw, bsc.payouts.details[raw.origin], {}, { network: 1 })),
  }).filter((row) => row.memo === firstMigration);
  /** When a recorded transaction's block was made, in milliseconds. @param {string} hash */
  const timeOf = (hash) => Number(BigInt(bsc.blocks[bsc.receipts[hash].blockNumber].timestamp)) * 1000;
  const route = "bsc-to-dusk";

  it("reads what a migration sent and paid there, and the approval it spent, to the wei, as the chain says", async () => {
    const chain = chainOf();
    const facts = await migrationFacts({ fetch: chain.fetch, migrations: [{ hash: firstMigration, route: "bsc-to-dusk" }], network: 1 });

    assert.deepEqual(facts.get(firstMigration), {
      approval: { at: timeOf(firstApproval), block: 131_836_513, gasWei: 2_310_900_000_000n, hash: firstApproval },
      approvalState: "found",
      at: timeOf(firstMigration),
      block: 131_836_535,
      coin: "BNB",
      from: bsc.owner,
      gasWei: 2_437_650_000_000n,
      hash: firstMigration,
      lux: 1_041_531_062_630n,
      route: "bsc-to-dusk",
      state: "mined",
      totalWei: 4_748_550_000_000n,
    });
  });

  it("finds the approval whatever app signed it, and that a later migration's is its own, not an earlier one's", async () => {
    const facts = await migrationFacts({ fetch: chainOf().fetch, migrations: migrationsOf([payout]).concat([{ hash: secondMigration, payout: "", route: "bsc-to-dusk" }]), network: 1 });

    like(facts.get(firstMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });
    like(facts.get(secondMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });
    assert.equal(facts.get(secondMigration)?.approval?.hash, secondApproval);
  });

  it("gives an approval two migrations spent to the first, whose fee it is", async () => {
    // As if one approval had been for both.
    const facts = await migrationFacts({ fetch: chainOf({ drop: [secondApproval] }).fetch, migrations: [{ hash: secondMigration, route: "bsc-to-dusk" }], network: 1 });

    like(facts.get(secondMigration), { approvalState: "earlier", gasWei: 2_437_650_000_000n, totalWei: 2_437_650_000_000n });
    assert.equal(facts.get(secondMigration)?.approval?.hash, firstApproval);
  });

  it("gives an approval two migrations spent to the first, also where the app names it for the second", async () => {
    const facts = await migrationFacts({ fetch: chainOf({ drop: [secondApproval] }).fetch, migrations: [{ approval: firstApproval, hash: secondMigration, route }], network: 1 });

    like(facts.get(secondMigration), { approvalState: "earlier", totalWei: 2_437_650_000_000n });
  });

  it("counts an approval the app names where the logs can't be read only when it allowed exactly what the migration sent", async () => {
    // The first approval allowed what the first migration sent, to the wei: it can only be that one's.
    const own = await migrationFacts({ fetch: chainOf({ logs: false }).fetch, migrations: [{ approval: firstApproval, hash: firstMigration, route }], network: 1 });

    like(own.get(firstMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });

    // Named for the second migration, which sent another amount: not counted, as it can't be told.
    const other = await migrationFacts({ fetch: chainOf({ logs: false }).fetch, migrations: [{ approval: firstApproval, hash: secondMigration, route }], network: 1 });

    like(other.get(secondMigration), { approvalState: "unread", totalWei: 2_437_650_000_000n });
  });

  it("says so where the RPC no longer gives the logs, or the approval is further back than it reads", async () => {
    const unread = await migrationFacts({ fetch: chainOf({ logs: false }).fetch, migrations: [{ hash: firstMigration, route }], network: 1 });

    like(unread.get(firstMigration), { approval: null, approvalState: "unread", totalWei: 2_437_650_000_000n });

    const beyond = await migrationFacts({ fetch: chainOf({ drop: [firstApproval] }).fetch, migrations: [{ hash: firstMigration, route }], network: 1 });

    like(beyond.get(firstMigration), { approval: null, approvalState: "beyond", totalWei: 2_437_650_000_000n });
  });

  it("reads narrower windows where the RPC refuses wide ones, and the logs also for an approval the app names", async () => {
    const narrow = chainOf({ maxRange: 2_000n });

    like((await migrationFacts({ fetch: narrow.fetch, migrations: [{ hash: firstMigration, route }], network: 1 })).get(firstMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });
    // Asked 5,000 blocks first, then narrower until the RPC answers.
    const widths = narrow.ranges().map(([from, to]) => to - from + 1n);

    assert.equal(widths[0], 5_000n);
    assert.ok(/** @type {bigint} */ (widths.at(-1)) <= 2_000n);

    const given = chainOf();

    like((await migrationFacts({ fetch: given.fetch, migrations: [{ approval: firstApproval, hash: firstMigration, route }], network: 1 })).get(firstMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });
    // Read as without it, for an earlier migration that spent from it first.
    assert.ok(given.methods().includes("eth_getLogs"));
  });

  it("counts no approval for a migration that failed, and says what isn't one or isn't there yet", async () => {
    const failedHash = `0x${"f".repeat(64)}`;
    const failed = { ...bsc.receipts[firstMigration], logs: [], status: "0x0", transactionHash: failedHash };
    const facts = await migrationFacts({ fetch: chainOf({ receipts: { [failedHash]: failed } }).fetch, migrations: [{ hash: failedHash, route }, { hash: firstApproval, route }, { hash: `0x${"a".repeat(64)}`, route }], network: 1 });

    // Its block's time, read from the block: it has no logs to say it.
    like(facts.get(failedHash), { approval: null, approvalState: "none", at: timeOf(firstMigration), lux: null, state: "failed", totalWei: 2_437_650_000_000n });
    like(facts.get(firstApproval), { state: "not-migration", totalWei: null });
    like(facts.get(`0x${"a".repeat(64)}`), { state: "pending", totalWei: null });
  });

  it("keeps nothing for good while the approval's receipt can't be read, and reads it again", async () => {
    const cache = new Map();
    // The RPC lists the approval, but has no receipt of it for a moment.
    const brief = chainOf({ receipts: { [firstApproval]: null } });
    const first = await migrationFacts({ cache, fetch: brief.fetch, migrations: [{ hash: firstMigration, route }], network: 1 });

    like(first.get(firstMigration), { approvalState: "found", totalWei: 2_437_650_000_000n });
    assert.equal(cache.size, 0);

    const later = await migrationFacts({ cache, fetch: chainOf().fetch, migrations: [{ hash: firstMigration, route }], network: 1 });

    like(later.get(firstMigration), { approvalState: "found", totalWei: 4_748_550_000_000n });
  });

  it("keeps what's final in a cache, and reads it once", async () => {
    const cache = new Map();
    const chain = chainOf();
    const first = await migrationFacts({ cache, fetch: chain.fetch, migrations: [{ hash: firstMigration, route }], network: 1 });
    const calls = chain.calls.length;

    assert.ok(calls > 0);
    assert.deepEqual(await migrationFacts({ cache, fetch: chain.fetch, migrations: [{ hash: firstMigration, route }], network: 1 }), first);
    assert.equal(chain.calls.length, calls);
  });

  it("has the way back's gas in the ledger, the approval with it, in every app the same", async () => {
    const facts = await migrationFacts({ fetch: chainOf().fetch, migrations: migrationsOf([payout]), network: 1 });
    const ledger = /** @type {any} */ (transferLedger({ evm: facts.get(firstMigration), locale: "en-GB", row: payout }));

    assert.deepEqual(shown(ledger), [
      ["sent", "1,041.531", "1,041.53106263", "BEP20 DUSK", false],
      ["received", "1,041.531", "1,041.53106263", "DUSK", false],
      ["gas", "0.0000047", "0.00000474855", "BNB", false],
    ]);
    assert.deepEqual(ledger.gas.parts, ["approval", "migration"]);
    // Kept by an app, as the standalone keeps a transfer: the same numbers.
    assert.deepEqual(shown(transferLedger({ evm: facts.get(firstMigration), locale: "en-GB", network: 1, received: 1_041_531_062_630n, route: "bsc-to-dusk" })), shown(ledger));
    // Without its approval, the migration's alone, and it says so.
    const unread = (await migrationFacts({ fetch: chainOf({ logs: false }).fetch, migrations: [{ hash: firstMigration, route }], network: 1 })).get(firstMigration);

    assert.deepEqual(/** @type {any} */ (transferLedger({ evm: unread, row: payout })).gas.parts, ["migration"]);
  });
});
