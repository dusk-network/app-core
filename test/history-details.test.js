import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { duskEvmContracts } from "@dusk-network/networks/duskevm";

import { DETAILS_BATCH, createArchive, createHistory, fetchTxDetails, fetchTxNonce, parseHistoryEntry } from "../src/history.js";
import {
  NAME_CALLS,
  NAME_CONTRACT,
  RESERVATION,
  fakeArchive,
  fixture,
  like,
  memoryDatabase,
  nameHook,
  readFixture,
  withCallArgs,
} from "./fixtures/helpers.js";

const [A, B] = Object.keys(fixture.accounts);
const NODE = fixture.nodeUrl;
const OK = "8e247a33967153b229ce4f45f61e0f14808d8a417c4a4b37eabb269a8eb08e34";
const FAILED = "10e446480bd93cd2ae24d221b738ec5cd109951717ca82b092cab0b53f949f00";
const { bridge: BRIDGE, portal: PORTAL } = /** @type {NonNullable<ReturnType<typeof duskEvmContracts>>} */ (duskEvmContracts(2));
// The account testnet's withdrawal of 1,008 DUSK pays.
const PAID = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
const bridgeCalls = readFixture("bridge-calls-testnet.json");
const deposit = readFixture("duskevm-deposit-history.json");

/** @param {string} name @returns {string} */
const callArgs = (name) => bridgeCalls.calls.find((/** @type {any} */ c) => c.name === name)?.args;

/**
 * The recorded details of OK, with another call.
 *
 * @param {string} contractId
 * @param {string} fnName
 * @param {string | undefined} data
 */
const txWith = (contractId, fnName, data) => ({ ...fixture.details[OK], tx: { ...fixture.details[OK].tx, callData: { contractId, data, fnName } } });

/** The hashes whose call arguments a query asked for. @param {ReturnType<typeof fakeArchive>} node */
const withArgs = (node) =>
  node.detailQueries().flatMap((l) => [...l.query.matchAll(/tx\(hash: "([0-9a-f]{64})"\)[^}]*\{ contractId fnName data \}/g)].map((m) => m[1]));

/**
 * @param {ReturnType<typeof fakeArchive>} node
 * @param {string} account
 * @param {{ callFacts?: any, db?: ReturnType<typeof memoryDatabase>, network?: any }} [options]
 */
function setup(node, account, { callFacts, db = memoryDatabase(), network = 2 } = {}) {
  const store = db.storeFor(`testnet::${account}`);

  return { history: createHistory({ account, archive: node.archiveClient(), callFacts, network, store }), store };
}

describe("fetchTxDetails", () => {
  it("reads outcomes, errors and fees", async () => {
    const node = fakeArchive();
    const details = await fetchTxDetails(node.archiveClient(), [FAILED, OK, "00".repeat(32)]);

    like(details.get(FAILED), { error: "Panic: DRC20Phoenix: invalid proof", fee: "200000000", success: false });
    like(details.get(OK), { error: undefined, fee: "1849580", success: true, timestamp: 1_792_665_841_000 });
    // A transaction the node doesn't have gets no details.
    assert.equal(details.has("00".repeat(32)), false);
    // Asked of no call's arguments.
    assert.doesNotMatch(node.detailQueries()[0].query, /\bdata\b/);
  });

  it("asks nothing for hashes that aren't, and at most a batch at a time", async () => {
    const node = fakeArchive();
    const archive = node.archiveClient();

    assert.equal((await fetchTxDetails(archive, ["nope", OK.toUpperCase(), `0x${OK}`])).size, 0);
    assert.equal(node.log.length, 0);

    const many = Array.from({ length: DETAILS_BATCH + 5 }, (_, i) => i.toString(16).padStart(64, "0"));

    await fetchTxDetails(archive, many);
    assert.equal(node.detailQueries()[0].query.match(/tx\(hash:/g)?.length, DETAILS_BATCH);
  });

  it("reads what a call to the bridge did from its arguments: a deposit, a proof or a claim, and whom it pays", async () => {
    const prove = "c1".repeat(32);
    const depositHash = "c2".repeat(32);
    const claim = "c3".repeat(32);
    const contractProof = "c4".repeat(32);
    const details = {
      ...fixture.details,
      [claim]: txWith(PORTAL, "finalizeWithdrawalTransaction", callArgs("claim-account")),
      [contractProof]: txWith(PORTAL, "proveWithdrawalTransaction", callArgs("prove-wallet-both")),
      [depositHash]: txWith(BRIDGE, "depositETHToWithValue", callArgs("deposit-shoot")),
      [prove]: txWith(PORTAL, "proveWithdrawalTransaction", callArgs("prove-account")),
    };
    const node = fakeArchive({ details });
    const hashes = [prove, depositHash, claim, contractProof, OK];
    const read = await fetchTxDetails(node.archiveClient(), hashes, { args: new Set(hashes), network: 2 });

    assert.match(node.detailQueries()[0].query, /callData \{ contractId fnName data \}/);
    // The withdrawal a proof and its claim are for, in lux, and whom it pays
    // on Dusk: an account, or a contract.
    like(read.get(prove)?.bridge, { amount: "1008000000000", kind: "prove", recipient: PAID });
    assert.match(String(/** @type {any} */ (read.get(prove)?.bridge)?.hash), /^0x[0-9a-f]{64}$/);
    assert.match(String(/** @type {any} */ (read.get(prove)?.bridge)?.withdrawal), /^[0-9a-f]{64}$/);
    // Its claim is for the same withdrawal.
    like(read.get(claim)?.bridge, {
      amount: "1008000000000",
      kind: "claim",
      recipient: PAID,
      withdrawal: /** @type {any} */ (read.get(prove)?.bridge)?.withdrawal,
    });
    like(read.get(contractProof)?.bridge, {
      amount: "1000000000",
      hash: bridgeCalls.calls.find((/** @type {any} */ c) => c.name === "prove-wallet-both").expected.hash,
      recipient: "21a5cb174bbd7dd0ae1c5bb76c989bb62fb82354aeec9fb25f548c43677dedd0",
    });
    assert.deepEqual(read.get(depositHash)?.bridge, { amount: "100000000", kind: "deposit", to: "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e" });
    // Another contract's call: nothing to say.
    assert.equal(read.get(OK)?.bridge, undefined);
    assert.equal(Object.hasOwn(/** @type {object} */ (read.get(OK)), "bridge"), false);
  });

  it("reads a bridge call whose arguments don't decode as one of the bridge's as null, and reads none on a network without the bridge", async () => {
    const broken = "c5".repeat(32);
    const node = fakeArchive({ details: { ...fixture.details, [broken]: txWith(BRIDGE, "depositETHToWithValue", "00ff") } });
    const archive = node.archiveClient();

    assert.equal((await fetchTxDetails(archive, [broken], { args: new Set([broken]), network: 2 })).get(broken)?.bridge, null);
    // Mainnet has no DuskEVM bridge yet, and an unknown network none.
    assert.equal((await fetchTxDetails(archive, [broken], { args: new Set([broken]), network: 1 })).get(broken)?.bridge, undefined);
    assert.equal((await fetchTxDetails(archive, [broken], { args: new Set([broken]) })).get(broken)?.bridge, undefined);
  });
});

// Recorded on Testnet: a deposit of 0.5 DUSK to DuskEVM.
describe("a deposit to DuskEVM", () => {
  const HASH = deposit.entry.origin;
  const H = deposit.entry.block_height;
  const accounts = { [deposit.account]: { receiver: [], sender: [deposit.entry] } };
  const details = { ...fixture.details, ...deposit.details };

  it("keeps the DuskEVM address it paid, read from its call, whose arguments are asked of it alone", async () => {
    const node = fakeArchive({ accounts: { ...fixture.accounts, ...accounts }, details, finalized: H + 100 });
    const { history } = setup(node, deposit.account);

    await history.sync();

    const { entries } = await history.read();

    assert.equal(entries.length, 1);
    like(entries[0], { bridge: { amount: "500000000", kind: "deposit", to: deposit.recipient }, counterparty: BRIDGE, hash: HASH, success: true });
    assert.ok(
      node
        .detailQueries()
        .map((l) => l.query)
        .join("\n")
        .includes(`tx(hash: "${HASH}") { err gasSpent blockHash blockTimestamp tx { gasPrice gasLimit callData { contractId fnName data } } }`)
    );

    // Another account's transfers and calls: no arguments asked.
    node.log.length = 0;
    await setup(node, B).history.sync();
    assert.ok(node.detailQueries().length > 0);
    assert.equal(node.detailQueries().some((l) => /callData \{[^}]*\bdata\b/.test(l.query)), false);
  });

  it("reads it once for a deposit kept before the history read them, and not again when its call names none", async () => {
    const node = fakeArchive({ accounts, details, finalized: H + 100 });
    const db = memoryDatabase();
    const { history, store } = setup(node, deposit.account, { db });
    // Kept with its details, but not its DuskEVM address.
    const parsed = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(deposit.account, deposit.entry));
    const kept = { ...parsed, detailsAt: 1, success: true, value: String(parsed.value) };

    assert.equal(history.needsDetails(kept), true);
    await store.commit([kept], () => ({ account: deposit.account, covered: [[0, H + 90]], finalized: H + 100, genesis: "", headAt: 1, target: H + 90, updatedAt: 1, window: 1 }));
    await history.fillDetails([kept]);

    const [entry] = await store.list({ limit: 10 });

    like(entry, { bridge: { amount: "500000000", kind: "deposit", to: deposit.recipient } });
    assert.equal(history.needsDetails(entry), false);
    assert.equal(node.detailQueries().length, 1);

    // A deposit call that doesn't decode: looked up, and left so.
    const broken = { ...details, [HASH]: { ...details[HASH], tx: { ...details[HASH].tx, callData: { ...details[HASH].tx.callData, data: "00ff" } } } };
    const read = await fetchTxDetails(fakeArchive({ accounts, details: broken }).archiveClient(), [HASH], { args: new Set([HASH]), network: 2 });

    assert.equal(read.get(HASH)?.bridge, null);
    assert.equal(history.needsDetails({ ...kept, bridge: null }), false);
  });

  it("needs its details while it has none, or its call to the bridge isn't read, on a network with the bridge", () => {
    const { history } = setup(fakeArchive(), deposit.account);
    const onMainnet = setup(fakeArchive(), deposit.account, { network: 1 }).history;
    /** @param {Record<string, unknown>} entry */
    const needs = (entry, h = history) => h.needsDetails(/** @type {any} */ (entry));

    assert.equal(needs({ counterparty: "other" }), true);
    assert.equal(needs({ counterparty: "other", detailsAt: 1 }), false);
    assert.equal(needs({ counterparty: BRIDGE, detailsAt: 1 }), true);
    assert.equal(needs({ contractId: BRIDGE, detailsAt: 1 }), true);
    assert.equal(needs({ bridge: null, counterparty: BRIDGE, detailsAt: 1 }), false);
    assert.equal(needs({ bridge: { amount: "1", kind: "deposit", to: "0x00" }, contractId: BRIDGE, detailsAt: 1 }), false);
    // A call to the Portal read before: once more.
    assert.equal(needs({ contractId: PORTAL, detailsAt: 1 }), true);
    assert.equal(needs({ bridge: null, contractId: PORTAL, detailsAt: 1 }), false);
    assert.equal(needs({ contractId: "ab".repeat(32), detailsAt: 1 }), false);
    assert.equal(needs({ contractId: PORTAL }), true);
    // A proof or a claim read without its hash, which its claim date is read
    // by, or whom it pays, is read again; one with them isn't, whoever it pays.
    assert.equal(needs({ bridge: { amount: "1", kind: "prove", withdrawal: "01" }, contractId: PORTAL, detailsAt: 1 }), true);
    assert.equal(needs({ bridge: { amount: "1", kind: "claim", withdrawal: "01" }, contractId: PORTAL, detailsAt: 1 }), true);

    const proof = { amount: "1", hash: `0x${"8e".repeat(32)}`, kind: "prove", withdrawal: "01" };

    assert.equal(needs({ bridge: proof, contractId: PORTAL, detailsAt: 1 }), true);
    for (const recipient of [null, "213qXN"]) assert.equal(needs({ bridge: { ...proof, recipient }, contractId: PORTAL, detailsAt: 1 }), false);
    // Mainnet has no bridge yet.
    assert.equal(needs({ counterparty: BRIDGE, detailsAt: 1 }, onMainnet), false);
  });
});

describe("a call to the bridge without a deposit", () => {
  const HASH = "d1".repeat(32);
  // A proof sent from PAID's account: the transfer contract's fee alone.
  const raw = {
    block_height: 4_687_744,
    events: [{ data: { memo: "", receiver: null, sender: PAID, value: "0" }, reverted: false, target: `01${"0".repeat(62)}`, topic: "moonlight" }],
    origin: HASH,
  };
  const accounts = { [PAID]: { receiver: [], sender: [raw] } };

  it("is read once its details name the bridge's Portal: one more request, with its arguments", async () => {
    const node = fakeArchive({ accounts, details: { [HASH]: txWith(PORTAL, "proveWithdrawalTransaction", callArgs("prove-account")) }, finalized: 4_687_800 });
    const { history } = setup(node, PAID);

    await history.sync();

    assert.equal(node.detailQueries().length, 2);
    assert.deepEqual(withArgs(node), [HASH]);
    like((await history.read()).entries[0].bridge, { amount: "1008000000000", kind: "prove", recipient: PAID });

    // Read now: not asked again.
    const asked = node.detailQueries().length;

    await history.sync();
    assert.equal(node.detailQueries().length, asked);
  });

  it("is read once when the contract it paid isn't the one it called", async () => {
    // As if paid to the bridge, while its call went to another contract.
    const paid = structuredClone(raw);

    paid.events.unshift({ data: { receiver: BRIDGE, sender: PAID, value: "5" }, reverted: false, target: `01${"0".repeat(62)}`, topic: "deposit" });

    const node = fakeArchive({ accounts: { [PAID]: { receiver: [], sender: [paid] } }, details: { [HASH]: txWith("ab".repeat(32), "f", "00") }, finalized: 4_687_800 });
    const { history, store } = setup(node, PAID);

    await history.sync();
    like(store.rows()[0], { bridge: null, contractId: "ab".repeat(32) });
    assert.equal(node.detailQueries().length, 1);
    await history.sync();
    assert.equal(node.detailQueries().length, 1);
  });
});

// The app's hook for a name contract's calls (helpers.js): the history asks
// their arguments only of the calls it wants, and keeps what it reads.
describe("calls the app reads through its hook", () => {
  it("keeps what it reads, the arguments asked of those calls alone, a call without a deposit once its contract is known", async () => {
    const log = /** @type {any[]} */ ([]);
    const node = fakeArchive({ details: withCallArgs(fixture.details) });
    const { history } = setup(node, A, { callFacts: nameHook({ log }) });

    await history.sync();

    const { entries } = await history.read();

    like(entries.find((e) => e.hash === NAME_CALLS.register.hash), { fnName: "register", registeredName: "shpongle.dusk", reservation: RESERVATION });
    like(entries.find((e) => e.hash === NAME_CALLS.commit.hash), { fnName: "commit", reservation: RESERVATION });
    // The one that paid the contract with its details; the other once its contract is known.
    assert.deepEqual(withArgs(node), [NAME_CALLS.register.hash, NAME_CALLS.commit.hash]);
    // Each read for the account whose history it is.
    assert.deepEqual(log.map((l) => [l.call.fnName, l.account]), [["register", A], ["commit", A]]);
  });

  it("reads one again for an entry kept before the hook read it, and not again once its call doesn't read", async () => {
    const { history } = setup(fakeArchive(), A, { callFacts: nameHook() });
    const entry = fixture.accounts[A].sender.find((/** @type {any} */ e) => e.origin === NAME_CALLS.register.hash);
    const parsed = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(A, entry));
    const kept = { ...parsed, contractId: NAME_CONTRACT, detailsAt: 1, fnName: "register", success: true, value: String(parsed.value) };

    assert.equal(history.needsDetails(kept), true);
    assert.equal(history.needsDetails({ ...kept, fnName: "commit" }), true);
    assert.equal(history.needsDetails({ ...kept, fnName: "commit", reservation: null }), false);
    assert.equal(history.needsDetails({ ...kept, fnName: "renew" }), false);

    const node = fakeArchive({ details: withCallArgs(fixture.details, { register: "00ff" }) });
    const read = await fetchTxDetails(node.archiveClient(), [NAME_CALLS.register.hash], {
      account: A,
      args: new Set([NAME_CALLS.register.hash]),
      callFacts: nameHook(),
    });

    like(read.get(NAME_CALLS.register.hash), { registeredName: null, reservation: null });
    assert.equal(history.needsDetails({ ...kept, registeredName: null, reservation: null }), false);
    assert.deepEqual(withArgs(node), [NAME_CALLS.register.hash]);
  });

  it("reads them for the account whose history it is", async () => {
    const hashes = [NAME_CALLS.register.hash, NAME_CALLS.commit.hash];
    const read = await fetchTxDetails(fakeArchive({ details: withCallArgs(fixture.details) }).archiveClient(), hashes, {
      account: B,
      args: new Set(hashes),
      callFacts: nameHook(),
    });

    // The commit's own reads the same; the other doesn't check out for another account.
    assert.deepEqual([read.get(NAME_CALLS.register.hash)?.reservation, read.get(NAME_CALLS.commit.hash)?.reservation], [null, RESERVATION]);
  });

  it("gives the hook each entry as the store keeps it, when the app passes the entries it read too", async () => {
    /** @type {any[]} */
    const seen = [];
    const hook = {
      read: () => ({}),
      wants: (/** @type {any} */ entry) => {
        seen.push(entry);

        return false;
      },
    };
    const node = fakeArchive();
    const { history, store } = setup(node, A, { callFacts: hook });

    await history.sync();

    const { entries } = await history.read();

    seen.length = 0;
    history.needsDetails(entries[0]);
    await history.fillDetails(entries);
    assert.equal(seen.length, entries.length + 1);

    /** @param {Record<string, unknown>} entry */
    const defined = (entry) => Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== undefined));
    const rows = new Map(store.rows().map((row) => [row.hash, defined(row)]));

    for (const entry of seen) {
      assert.equal(typeof entry.value, "string");
      assert.deepEqual(defined(entry), rows.get(entry.hash));
    }
  });

  it("keeps the history's own fields over the hook's, and goes on when the hook throws", async () => {
    const node = fakeArchive({ details: withCallArgs(fixture.details) });
    const hashes = [NAME_CALLS.register.hash];
    const read = await fetchTxDetails(node.archiveClient(), hashes, {
      account: A,
      args: new Set(hashes),
      callFacts: { read: () => ({ fee: "0", note: "kept" }), wants: () => true },
    });

    like(read.get(NAME_CALLS.register.hash), { fee: "2897558", note: "kept" });

    const throwing = {
      read: () => {
        throw new Error("hook");
      },
      wants: () => {
        throw new Error("hook");
      },
    };
    const { history } = setup(fakeArchive({ details: withCallArgs(fixture.details) }), A, { callFacts: throwing });

    await history.sync();
    assert.equal((await history.read()).entries.every((e) => e.detailsAt), true);
  });
});

describe("fillDetails", () => {
  it("reads the details of the entries shown that need them, a request per 50", async () => {
    const node = fakeArchive();
    const db = memoryDatabase();
    const { history, store } = setup(node, B, { db });

    await history.sync({ maxDetailRequests: 0 });

    const before = node.detailQueries().length;
    const { entries } = await history.read({ limit: 1_000 });
    let steps = 0;

    assert.equal(before, 0);
    await history.fillDetails(entries, { onStep: () => (steps += 1) });

    const due = entries.length;

    assert.equal(node.detailQueries().length, Math.ceil(due / DETAILS_BATCH));
    assert.equal(steps, Math.ceil(due / DETAILS_BATCH));
    assert.equal(store.rows().filter((r) => r.detailsAt).length, due);
    // Nothing left to read: no request.
    await history.fillDetails((await history.read({ limit: 1_000 })).entries);
    assert.equal(node.detailQueries().length, Math.ceil(due / DETAILS_BATCH));
  });
});

describe("details a sync reads by itself", () => {
  it("go on past the newest entries that already have theirs, down to the oldest", async () => {
    const node = fakeArchive();
    const { history, store } = setup(node, B);
    const total = () => store.rows().length;
    const detailed = () => store.rows().filter((r) => r.detailsAt).length;

    // The whole history first, without details.
    for (let run = 0; run < 20 && !(await history.read()).complete; run += 1) await history.sync({ maxDetailRequests: 0 });

    assert.ok(total() > 2 * DETAILS_BATCH, "the history is longer than one run's details");

    // Then enough runs to read every entry's details, a batch per request.
    for (let run = 0; run < 6 && detailed() < total(); run += 1) await history.sync();

    assert.equal(detailed(), total());
  });
});

describe("Sozu pools a read is given", () => {
  it("are read once, so a one-shot iterable marks every row of a pool's calls", async () => {
    const { history, store } = setup(fakeArchive(), B);
    const pool = "cd".repeat(32);
    const stake = (/** @type {number} */ n) => ({
      blockHeight: 4_658_000 + n, contractId: pool, counterparty: pool, detailsAt: 1, direction: /** @type {const} */ ("out"), fee: "1000",
      fnName: "sozu_stake", hash: String(n).repeat(64).slice(0, 64), kind: /** @type {const} */ ("contract_call"), memo: "", payer: true,
      success: true, timestamp: 1_792_687_511_000 + n, value: "100000000000",
    });

    await store.commit([stake(1), stake(2), stake(3)], () => ({
      account: B, covered: [[0, 4_658_010]], finalized: 4_658_020, genesis: "", headAt: 1, target: 4_658_010, updatedAt: 1, window: 1,
    }));

    const { entries } = await history.read({ limit: 10, pools: new Set([pool]).values() });

    assert.deepEqual(entries.map((e) => e.sozu), [true, true, true]);
  });
});

describe("fetchTxNonce", () => {
  /** @param {any} answer */
  const archiveAnswering = (answer) => {
    /** @type {string[]} */
    const asked = [];

    return { archive: createArchive({ query: async (document) => (asked.push(document), answer), url: NODE }), asked };
  };

  it("reads a public transaction's nonce, exact", async () => {
    const { archive, asked } = archiveAnswering({ tx: { tx: { json: '{"type":"moonlight","nonce":18446744073709551615}' } } });

    assert.equal(await fetchTxNonce(archive, OK), "18446744073709551615");
    assert.deepEqual(asked, [`query { tx(hash: "${OK}") { tx { json } } }`]);
    assert.equal(await fetchTxNonce(archiveAnswering({ tx: { tx: { json: '{"nonce":19}' } } }).archive, OK), "19");
  });

  it("gives null for a shielded transaction, one the archive doesn't have, and a hash that isn't one", async () => {
    assert.equal(await fetchTxNonce(archiveAnswering({ tx: { tx: { json: '{"type":"phoenix"}' } } }).archive, OK), null);
    assert.equal(await fetchTxNonce(archiveAnswering({ tx: null }).archive, OK), null);
    assert.equal(await fetchTxNonce(archiveAnswering({ tx: { tx: { json: "not json" } } }).archive, OK), null);

    const none = archiveAnswering({});

    assert.equal(await fetchTxNonce(none.archive, "nope"), null);
    assert.deepEqual(none.asked, []);
  });
});
