import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { ENTRY_KIND, STAKE_CONTRACT, TRANSFER_CONTRACT, addCoverage, historyEntry, parseHistoryEntry, shownDownTo, topGap } from "../src/history.js";
import { NAME_CONTRACT, fixture, like } from "./fixtures/helpers.js";

// Recorded on Testnet: A called a name contract twice and received two
// transfers; B has years of transfers, contract calls, a shield, stake
// rewards and an unstake; Z received an unshield.
const [A, B, Z] = Object.keys(fixture.accounts);
const DUSK = 1_000_000_000n;

/** @param {string} account @param {"out" | "in"} direction @returns {any[]} */
const entriesOf = (account, direction) => fixture.accounts[account][direction === "out" ? "sender" : "receiver"];
/** @param {string} account @param {number} height */
const entryAt = (account, height) => [...entriesOf(account, "out"), ...entriesOf(account, "in")].find((e) => e.block_height === height);
/** @param {string} account @param {number} height */
const parse = (account, height) => parseHistoryEntry(account, entryAt(account, height));

describe("parseHistoryEntry", () => {
  it("reads a transfer received, with its sender", () => {
    assert.deepEqual(parse(A, 4655845), {
      blockHeight: 4655845,
      counterparty: entryAt(A, 4655845).events[0].data.sender,
      direction: "in",
      hash: "8e247a33967153b229ce4f45f61e0f14808d8a417c4a4b37eabb269a8eb08e34",
      kind: "transfer",
      memo: "",
      payer: false,
      value: 1100n * DUSK,
    });
  });

  it("reads a contract call's deposit as what was sent, and a call without one as fee only", () => {
    like(parse(A, 4658012), { counterparty: NAME_CONTRACT, direction: "out", kind: "contract_call", payer: true, value: 100n * DUSK });
    like(parse(A, 4658000), { counterparty: null, direction: "out", kind: "contract_call", payer: true, value: 0n });
  });

  it("reads a transfer sent, and one without a receiver as sent to the account itself, with its memo", () => {
    const sent = entriesOf(B, "out").find((e) =>
      e.events.some((/** @type {any} */ ev) => ev.topic === "moonlight" && ev.data.receiver && ev.data.value !== "0")
    );

    like(parseHistoryEntry(B, sent), { counterparty: sent.events.at(-1).data.receiver, direction: "out", kind: "transfer" });
    // The archive leaves the receiver out when it is the sender.
    like(parse(B, 2517146), { counterparty: B, direction: "self", kind: "transfer", memo: "extension test", value: DUSK });
  });

  it("counts a gas refund paid to another account as what left the sender, and as what reached that account", () => {
    const OTHER = A;
    const sent = structuredClone(
      entriesOf(B, "out").find((e) =>
        e.events.some((/** @type {any} */ ev) => ev.topic === "moonlight" && ev.data.receiver && ev.data.receiver !== A && ev.data.value !== "0")
      )
    );
    const before = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(B, sent));
    const event = sent.events.find((/** @type {any} */ ev) => ev.topic === "moonlight");

    event.data.refund_info = [OTHER, "1500000"];
    like(parseHistoryEntry(B, sent), { counterparty: before.counterparty, direction: "out", kind: "transfer", value: before.value + 1_500_000n });
    like(parseHistoryEntry(OTHER, sent), { counterparty: B, direction: "in", payer: false, value: 1_500_000n });

    // A call that moved nothing but its gas, the unspent part paid to another account.
    const call = structuredClone(entryAt(A, 4658000));

    call.events[0].data.refund_info = [B, "3040407"];
    like(parseHistoryEntry(A, call), { counterparty: null, direction: "out", kind: "contract_call", payer: true, value: 3_040_407n });

    // Paid back to the sender itself, it moved nothing more.
    event.data.refund_info = [B, "1500000"];
    like(parseHistoryEntry(B, sent), { direction: "out", value: before.value });
  });

  it("tells the gas refund paid to another account apart from what the transaction moved, as kept and as read", () => {
    const sent = structuredClone(
      entriesOf(B, "out").find((e) =>
        e.events.some((/** @type {any} */ ev) => ev.topic === "moonlight" && ev.data.receiver && ev.data.receiver !== A && ev.data.value !== "0")
      )
    );
    const event = sent.events.find((/** @type {any} */ ev) => ev.topic === "moonlight");
    const moved = BigInt(event.data.value);

    // Paid to the receiver, as a payout could pay it: part of what reached it.
    event.data.refund_info = [event.data.receiver, "1500000"];
    const received = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(event.data.receiver, sent));

    assert.deepEqual([received.value, received.refund], [moved + 1_500_000n, 1_500_000n]);
    like(historyEntry({ ...received, refund: "1500000", value: String(received.value) }), { refund: 1_500_000n, value: moved + 1_500_000n });
    // Paid to a third account: part of what left the sender, and all that reached that account.
    event.data.refund_info = [A, "1500000"];
    assert.equal(parseHistoryEntry(B, sent)?.refund, 1_500_000n);
    assert.equal(parseHistoryEntry(A, sent)?.refund, 1_500_000n);
    // None: nothing to tell apart.
    event.data.refund_info = null;
    assert.equal("refund" in /** @type {object} */ (parseHistoryEntry(B, sent)), false);
  });

  it("reads a shield as sent to the shielded address, and an unshield as received", () => {
    like(parse(B, 2517213), {
      counterparty: "3rTbMbu2ffd3kuUiq766HJBh3eYHpKbwZFZtXLFtadRMFw6dLqxAUr1n5PtAXfb3xnBhGssELCC64cxd4dSYyjEj",
      direction: "out",
      kind: "shield",
      value: 13_351_700_000n,
    });
    like(parse(Z, 3602438), { counterparty: null, direction: "in", kind: "unshield", payer: false, value: 8_987_551_049n });
  });

  it("names stake rewards and unstakes from the stake contract's events", () => {
    like(parse(B, 3412754), { direction: "in", kind: "withdraw_reward", value: 1_609_142_758_405_397n });
    like(parse(B, 4643699), { direction: "in", kind: "unstake", value: 500_000n * DUSK });
  });

  it("reads a deposit to the stake contract as a stake", () => {
    // Derived from B's deposit to a contract: the same events, to the stake contract.
    const entry = structuredClone(entryAt(B, 3412903));

    entry.events.find((/** @type {any} */ e) => e.topic === "deposit").data.receiver = STAKE_CONTRACT;
    entry.events.push({ data: {}, reverted: false, target: STAKE_CONTRACT, topic: "stake" });
    like(parseHistoryEntry(B, entry), { direction: "out", kind: "stake", value: 1000n * DUSK });
  });

  it("leaves reverted events out", () => {
    // Derived from A's call with a deposit: a call that failed after taking
    // its deposit, which the archive flags as reverted, keeps the deposit.
    const entry = structuredClone(entryAt(A, 4658012));

    entry.events.find((/** @type {any} */ e) => e.topic === "deposit").reverted = true;
    like(parseHistoryEntry(A, entry), { direction: "out", kind: "contract_call", value: 0n });
  });

  it("refuses entries without a hash or height", () => {
    assert.equal(parseHistoryEntry(A, { ...entryAt(A, 4655845), origin: "nope" }), null);
    assert.equal(parseHistoryEntry(A, { ...entryAt(A, 4655845), block_height: -1 }), null);
    assert.equal(parseHistoryEntry(A, null), null);
  });

  it("keeps a memo as its text, and one that isn't text as 0x hex, telling bytes from typed 0x text", () => {
    const hex = (/** @type {string | Uint8Array} */ v) => Buffer.from(v).toString("hex");
    /** @param {string} memo */
    const withMemo = (memo) => {
      const entry = structuredClone(entryAt(A, 4655845));

      entry.events[0].data.memo = memo;

      const parsed = parseHistoryEntry(A, entry);

      return [parsed?.memo, parsed?.memoBinary];
    };
    const address = "0xeE1b68ED496712cda857ada41d326d357049E51C";

    // As the wallets read it: the text as sent, spaces too.
    assert.deepEqual(withMemo(hex(` ${address} `)), [` ${address} `, undefined]);
    assert.deepEqual(withMemo(hex(Uint8Array.of(0xff, 0x00, 0x01))), ["0xff0001", true]);
    assert.deepEqual(withMemo(hex("a\u0007bell")), [`0x${hex("a\u0007bell")}`, true]);
    assert.deepEqual(withMemo("abc"), ["", undefined]);
    // An EVM address typed as text, and the same 20 bytes raw.
    assert.deepEqual(withMemo(hex(address)), [address, undefined]);
    assert.deepEqual(withMemo(address.slice(2)), [address.toLowerCase(), true]);
  });

  it("names the kinds and contracts it reads", () => {
    assert.deepEqual(Object.values(ENTRY_KIND).sort(), ["contract_call", "shield", "stake", "transfer", "unshield", "unstake", "withdraw_reward"]);
    assert.equal(TRANSFER_CONTRACT, networks.testnet.contracts.transfer);
    assert.equal(STAKE_CONTRACT, networks.testnet.contracts.stake);
  });
});

// The bridge site's cases: what it keeps of a history are deposits to the
// DuskEVM bridge, transfers to the bridge's account, and payouts whose memo
// names the transaction that paid them.
describe("the bridge's transfers in a history", () => {
  const ACCOUNT = "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
  const OTHER = networks.mainnet.routes.services[0].account;
  const SERVICE = networks.testnet.routes.services[0].account;
  const BRIDGE = "2257e5f8ff49cf7c9704a14ca35acbf48eb7ade11a079d98d5cd5655eea1b31d";
  /** @param {string} text */
  const hex = (text) => Buffer.from(text).toString("hex");
  /** @param {number} n */
  const h = (n) => n.toString(16).padStart(64, "0");
  /** @param {any} entry */
  const kept = (entry) => ({ ...entry, value: String(entry.value) });

  const deposit = {
    block_height: 10,
    events: [
      { data: { receiver: BRIDGE, sender: ACCOUNT, value: "100000000" }, reverted: false, target: TRANSFER_CONTRACT, topic: "deposit" },
      { data: `${"0".repeat(48)}016345785d8a0000e0ffffff00000000975729af8e43f9d690d24da68d9e92d2e82731743e5b8223e638cb414bef8cf95393460ca1c3a11d`, reverted: false, target: BRIDGE, topic: "eth_bridge_initiated" },
      { data: { gas_spent: "1986599", memo: "", receiver: null, sender: ACCOUNT, value: "0" }, reverted: false, target: TRANSFER_CONTRACT, topic: "moonlight" },
    ],
    origin: h(1),
  };
  const service = {
    block_height: 11,
    events: [{ data: { memo: hex("0xeE1b68ED496712cda857ada41d326d357049E51C"), receiver: SERVICE, sender: ACCOUNT, value: "50000000000" }, reverted: false, target: TRANSFER_CONTRACT, topic: "moonlight" }],
    origin: h(2),
  };
  const payout = {
    block_height: 12,
    events: [{ data: { memo: hex(`0x${"ab".repeat(32)}`), receiver: ACCOUNT, sender: OTHER, value: "1000000000000" }, reverted: false, target: TRANSFER_CONTRACT, topic: "moonlight" }],
    origin: h(3),
  };

  it("reads a deposit as paid to the bridge's contract", () => {
    assert.deepEqual(parseHistoryEntry(ACCOUNT, deposit), {
      blockHeight: 10,
      counterparty: BRIDGE,
      direction: "out",
      hash: h(1),
      kind: "contract_call",
      memo: "",
      payer: true,
      value: 100_000_000n,
    });
    // A reverted deposit moved nothing.
    const reverted = structuredClone(deposit);

    reverted.events[0].reverted = true;
    like(parseHistoryEntry(ACCOUNT, reverted), { counterparty: null, value: 0n });
  });

  it("reads a transfer to the bridge's account as on its route, its memo the address it pays", () => {
    const entry = parseHistoryEntry(ACCOUNT, service);

    like(entry, { counterparty: SERVICE, direction: "out", kind: "transfer", memo: "0xeE1b68ED496712cda857ada41d326d357049E51C", value: 50_000_000_000n });
    assert.equal(historyEntry(kept(entry), { network: 2 }).route?.id, "dusk-to-ethereum");
    // On another network, that account is no one's.
    assert.equal(historyEntry(kept(entry), { network: 1 }).route, null);
  });

  it("reads a payout with its payer, and the memo naming the transaction that paid it", () => {
    const entry = parseHistoryEntry(ACCOUNT, payout);

    like(entry, { counterparty: OTHER, direction: "in", kind: "transfer", memo: `0x${"ab".repeat(32)}`, value: 1_000_000_000_000n });
    // Mainnet's BSC account pays BSC's migrations, and takes DUSK to BSC.
    assert.equal(historyEntry(kept(entry), { network: networks.mainnet }).route?.id, "bsc-to-dusk");
    assert.equal(historyEntry(kept({ ...entry, direction: "out" }), { network: networks.mainnet }).route?.id, "dusk-to-bsc");
  });
});

describe("historyEntry", () => {
  const row = {
    blockHeight: 4658012,
    contractId: NAME_CONTRACT,
    counterparty: NAME_CONTRACT,
    detailsAt: 1,
    direction: /** @type {const} */ ("out"),
    fee: "2897558",
    fnName: "register",
    hash: "1553f874eb8df9187675f099bbb422c6266d23c5a682e92a06faac3dfeb34a24",
    kind: /** @type {const} */ ("contract_call"),
    memo: "",
    payer: true,
    success: true,
    timestamp: 1_792_687_511_000,
    value: "100000000000",
  };

  it("gives amounts as bigints, and the fee only where the account paid it", () => {
    like(historyEntry(row), { fee: 2_897_558n, route: null, sozu: false, value: 100n * DUSK });
    assert.equal(historyEntry({ ...row, payer: false }).fee, null);
    // Before its details: no fee, no outcome, no time.
    like(historyEntry({ ...row, detailsAt: undefined, fee: undefined, success: undefined, timestamp: undefined }), { fee: null, success: null, timestamp: null });
    // A value that isn't a u64 reads as 0.
    assert.equal(historyEntry({ ...row, value: "-1" }).value, 0n);
    assert.equal(historyEntry({ ...row, value: (1n << 64n).toString() }).value, 0n);
  });

  it("passes on what the store keeps beside the entry", () => {
    like(historyEntry({ ...row, registeredName: "shpongle.dusk", reservation: null }), { registeredName: "shpongle.dusk", reservation: null });
    like(historyEntry({ ...row, memo: "0xff0001", memoBinary: true }), { memo: "0xff0001", memoBinary: true });
  });

  it("says a call is Sozu's on the network's own pool, or one its hub named", () => {
    const pool = networks.testnet.sozu?.fallbacks.pool ?? "";
    const stake = { ...row, contractId: pool, counterparty: pool, fnName: "sozu_stake" };

    assert.equal(historyEntry(stake, { network: 2 }).sozu, true);
    assert.equal(historyEntry({ ...stake, fnName: "sozu_unstake" }, { network: networks.testnet }).sozu, true);
    // The same function on another contract is someone else's.
    assert.equal(historyEntry({ ...stake, contractId: "cd".repeat(32) }, { network: 2 }).sozu, false);
    assert.equal(historyEntry({ ...stake, contractId: "cd".repeat(32) }, { network: 2, pools: ["cd".repeat(32)] }).sozu, true);
    // Without a network, or before its call is known, nothing is said.
    assert.equal(historyEntry(stake).sozu, false);
    assert.equal(historyEntry({ ...stake, fnName: undefined }, { network: 2 }).sozu, false);
  });

  it("finds no route or Sozu on a network there's no file for", () => {
    like(historyEntry(row, { network: 0 }), { route: null, sozu: false });
  });
});

describe("coverage", () => {
  it("joins touching ranges and finds the highest gap", () => {
    let covered = addCoverage([], 100, 200);

    covered = addCoverage(covered, 0, 49);
    assert.deepEqual(covered, [[100, 200], [0, 49]]);
    assert.deepEqual(topGap(covered, 300), [201, 300]);
    assert.deepEqual(topGap(covered, 200), [50, 99]);
    covered = addCoverage(covered, 50, 99);
    assert.deepEqual(covered, [[0, 200]]);
    assert.equal(topGap(covered, 200), null);
    assert.equal(shownDownTo([[150, 300], [0, 99]], 300), 150);
    assert.equal(shownDownTo([], 300), null);
  });

  it("joins a range touching another, keeps one apart, and names the gap between", () => {
    assert.deepEqual(addCoverage([[50, 60]], 61, 80), [[50, 80]]);
    assert.deepEqual(addCoverage([[50, 60]], 10, 20), [[50, 60], [10, 20]]);
    assert.deepEqual(addCoverage([[50, 60]], 20, 10), [[50, 60]]);
    assert.deepEqual(topGap([[50, 100]], 120), [101, 120]);
    assert.deepEqual(topGap([[50, 100], [0, 20]], 100), [21, 49]);
    assert.equal(topGap([[0, 100]], 100), null);
    assert.equal(topGap([], -1), null);
  });
});
