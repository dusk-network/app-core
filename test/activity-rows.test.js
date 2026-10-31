import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";

import { PENDING_MS, activityRows, settleSends } from "../src/activity.js";
import { createHistory, historyEntry, parseHistoryEntry } from "../src/history.js";
import { A, B, BRIDGE, C, DUSK, EVM, STORE, entryOf, hash, nameHook, recorded } from "./fixtures/activity.js";
import { fakeArchive, fixture, like, memoryDatabase, readFixture } from "./fixtures/helpers.js";

/** @typedef {import("../src/activity.js").ActivityInput} ActivityInput */
/** @typedef {import("../src/shielded.js").ShieldedEntry} ShieldedEntry */

// A while after every recorded transaction.
const NOW = Date.UTC(2026, 9, 30, 12);
/** @param {ActivityInput} input */
const rowsOf = (input) => activityRows({ network: 2, now: NOW, ...input });
const received = () => recorded(A, 4657992);
const registered = () => recorded(A, 4658012);

/**
 * A shielded history entry, as `/shielded` gives it.
 *
 * @param {Partial<ShieldedEntry>} fields
 * @returns {ShieldedEntry}
 */
const shieldedEntry = (fields) => ({
  blockHeight: 9,
  direction: "out",
  fee: null,
  hash: hash(0xab),
  kind: "transfer",
  success: true,
  timestamp: null,
  value: "5",
  ...fields,
});

describe("a row of the public history", () => {
  it("gives a received transfer its sender, and a call its contract and what it paid", () => {
    like(rowsOf({ public: [received()] })[0], {
      category: "received",
      counterparty: received().counterparty,
      direction: "in",
      kind: "transfer",
      privacy: "public",
      source: "public",
      status: "executed",
      success: true,
      value: 1000n * DUSK,
    });
    like(rowsOf({ nameCall: nameHook(), public: [registered()] })[0], {
      category: "sent",
      contractId: STORE,
      direction: "out",
      fee: 2_897_558n,
      fnName: "register",
      kind: "contract_call",
      nameCall: { kind: "registration", name: null, reservation: null },
      value: 100n * DUSK,
    });
    // With the name it registered, once that's read.
    assert.equal(rowsOf({ nameCall: nameHook(), public: [recorded(A, 4658012, { registeredName: "alice.dusk" })] })[0].nameCall?.name, "alice.dusk");
  });

  it("leaves an entry whose outcome isn't looked up yet unknown, not executed, and still to be looked up", () => {
    const unknown = { ...received(), detailsAt: undefined, success: null, timestamp: null };

    like(rowsOf({ public: [unknown] })[0], { incomplete: true, status: "unknown", success: null, time: null });
    assert.equal(rowsOf({ public: [received()] })[0].incomplete, false);
  });

  it("marks a failed transaction failed with its error", () => {
    like(rowsOf({ public: [recorded(B, 3407780)] })[0], { error: "Panic: DRC20Phoenix: invalid proof", status: "failed", success: false });
  });

  it("reads a call that sent its value to its own account as the call it was, once its call data came", () => {
    // Derived: A's register call as it would read had it sent 5 DUSK to itself.
    const call = historyEntry({ ...registered(), counterparty: A, direction: "self", kind: "transfer", payer: true, value: "5000000000" });

    like(rowsOf({ public: [call] })[0], { contractId: STORE, direction: "out", fnName: "register", kind: "contract_call", value: 0n });
    // Before its details, it is the transfer it reads as.
    like(rowsOf({ public: [{ ...call, contractId: undefined, fnName: undefined }] })[0], { direction: "self", kind: "transfer" });
  });

  it("knows a call by the contract it paid before its details name it", () => {
    const before = { ...registered(), contractId: undefined, detailsAt: undefined, fnName: undefined, success: null, timestamp: null };

    like(rowsOf({ public: [before] })[0], { contractId: STORE, fnName: null, kind: "contract_call" });
  });

  it("takes an entry's value as it is: a gas refund paid to another account counts in the sender's, and in what reached that account", () => {
    const raw = structuredClone(
      [...fixture.accounts[B].sender].find((e) => e.events.some((/** @type {any} */ ev) => ev.topic === "moonlight" && ev.data.receiver && ev.data.receiver !== A && ev.data.value !== "0"))
    );
    const event = raw.events.find((/** @type {any} */ ev) => ev.topic === "moonlight");
    const plain = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(B, raw));

    event.data.refund_info = [A, "1500000"];

    /** @param {string} account */
    const read = (account) => {
      const entry = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(account, raw));

      return rowsOf({ account, public: [historyEntry({ ...entry, detailsAt: 1, success: true, value: entry.value.toString() })] })[0];
    };

    like(read(B), { direction: "out", value: plain.value + 1_500_000n });
    like(read(A), { category: "received", direction: "in", value: 1_500_000n });
  });

  it("keeps the facts a details view shows: the block, the gas and the time", () => {
    like(rowsOf({ public: [registered()] })[0], {
      blockHeight: 4658012,
      detailsAt: 1,
      entry: registered(),
      gasLimit: 81_000_000n,
      gasPrice: 1n,
      gasSpent: 2_897_558n,
      sent: null,
      time: 1_792_687_511_000,
    });
  });
});

describe("the wallet's own sends", () => {
  it("are replaced by the chain's row once it has them, keeping the name typed for the recipient and the wallet's own fields", () => {
    const pending = {
      hash: registered().hash,
      kind: "contract_call",
      origin: "https://app.example",
      profileIndex: 0,
      status: "submitted",
      submittedAt: 1_792_687_500_000,
      toName: "shpongle.dusk",
    };
    const [row] = rowsOf({ pending: [pending], profileIndex: 0, public: [registered()] });

    like(row, { profileIndex: 0, sent: pending, source: "public", status: "executed", time: 1_792_687_511_000, toName: "shpongle.dusk", value: 100n * DUSK });
    assert.equal(row.sent?.origin, "https://app.example");
  });

  it("keep what the wallet knows of a bridge call until the chain's row reads it", () => {
    const bridge = /** @type {const} */ ({ amount: "100000000000", kind: "deposit", to: "0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A" });
    const pending = {
      bridge,
      contractId: "2257".padEnd(64, "0"),
      fnName: "depositETHToWithValue",
      hash: registered().hash,
      kind: "contract_call",
      profileIndex: 0,
      status: "submitted",
      submittedAt: NOW - 60_000,
    };
    const [alone] = rowsOf({ pending: [pending], profileIndex: 0 });
    const [both] = rowsOf({ pending: [pending], profileIndex: 0, public: [{ ...registered(), bridge: undefined }] });

    like(alone, { contractId: pending.contractId, fnName: pending.fnName, source: "sent", status: "pending" });
    like(alone.bridge, { amount: 100n * DUSK, step: "deposit", to: bridge.to });
    like(both, { source: "public" });
    like(both.bridge, { step: "deposit", to: bridge.to });
  });

  it("take a row the chain has as final: the outcome the wallet saw, else unknown until its details come", () => {
    const unknown = { ...registered(), detailsAt: undefined, success: null };

    for (const [status, shown] of [
      ["submitted", "unknown"],
      ["mempool", "unknown"],
      ["unknown", "unknown"],
      ["removed", "unknown"],
      ["failed", "failed"],
      ["executed", "executed"],
    ]) {
      const local = { error: status === "failed" ? "OutOfGas" : undefined, hash: unknown.hash, kind: "contract_call", profileIndex: 0, status, submittedAt: NOW };
      const [row] = rowsOf({ pending: [local], profileIndex: 0, public: [unknown] });

      like(row, { detailsAt: null, dropped: false, error: shown === "failed" ? "OutOfGas" : null, source: "public", status: shown }, status);
    }
  });

  it("take a shielded row's outcome over the wallet's own that stopped waiting", () => {
    const local = { amount: "5", hash: hash(0xab), kind: "transfer", privacy: "shielded", profileIndex: 0, recoveryReason: "watcher_timeout", status: "unknown" };

    for (const [status, error] of [
      ["executed", undefined],
      ["failed", "Panic: out of gas"],
    ]) {
      const [row] = rowsOf({ pending: [local], profileIndex: 0, shielded: [shieldedEntry({ error, fee: "1", success: status === "executed" })] });

      like(row, { error: error ?? null, fee: 1n, source: "shielded", status });
    }
  });

  it("keep the memo and the name a shielded transfer was sent with", () => {
    const local = { amount: "5", hash: hash(0xab), kind: "transfer", memo: "Invoice 42", privacy: "shielded", profileIndex: 0, status: "submitted", toName: "alice.dusk" };
    const [row] = rowsOf({ pending: [local], profileIndex: 0, shielded: [shieldedEntry({})] });

    like(row, { memo: "Invoice 42", privacy: "shielded", source: "shielded", status: "executed", toName: "alice.dusk" });
  });

  it("show a settled record only with the chain's row of it", () => {
    const settled = { amount: "5", hash: hash(0xcd), kind: "transfer", profileIndex: 0, settled: true, status: "submitted", toName: "alice.dusk" };

    assert.deepEqual(rowsOf({ pending: [settled], profileIndex: 0 }), []);
    like(rowsOf({ pending: [settled], profileIndex: 0, shielded: [shieldedEntry({ hash: hash(0xcd) })] })[0], { source: "shielded", toName: "alice.dusk" });
  });

  it("keep the amount a send meant to move when it didn't go through, and the chain's when it did", () => {
    // B's call that failed on chain: what it sent with it never moved.
    const failed = recorded(B, 3407780);
    const local = { amount: "2000000000", hash: failed.hash, kind: "contract_call", profileIndex: 0, status: "failed" };

    like(rowsOf({ pending: [local], profileIndex: 0, public: [failed] })[0], { source: "public", status: "failed", value: 2n * DUSK });
    // A record that keeps the call's deposit apart, its amount to the account itself.
    const parts = { ...local, amount: "0", deposit: "2000000000", fnName: "transfer_private" };

    like(rowsOf({ pending: [parts], profileIndex: 0, public: [failed] })[0], { status: "failed", value: 2n * DUSK });
    // A's register went through: the chain's amount stands.
    const done = registered();

    like(rowsOf({ pending: [{ ...local, amount: "1", hash: done.hash }], profileIndex: 0, public: [done] })[0], { status: "executed", value: 100n * DUSK });
    like(rowsOf({ pending: [{ ...parts, deposit: "1", hash: done.hash }], profileIndex: 0, public: [done] })[0], { value: 100n * DUSK });
  });

  it("give an unshield the fee its shielded side paid", () => {
    // C's unshield at 3602438: the fee was paid from the shielded notes.
    const unshield = recorded(C, 3602438);

    assert.equal(unshield.fee, null);
    like(rowsOf({ public: [unshield], shielded: [shieldedEntry({ fee: "12429102", hash: unshield.hash, kind: "unshield" })] })[0], {
      direction: "in",
      fee: 12_429_102n,
      kind: "unshield",
      source: "public",
    });
  });

  it("show while the archive doesn't have them, shielded ones included, newest first", () => {
    const local = [
      { hash: hash(0xaa), kind: "transfer", privacy: "public", profileIndex: 0, status: "mempool", submittedAt: 1_792_700_000_000 },
      { hash: hash(0xbb), kind: "transfer", privacy: "shielded", profileIndex: 0, status: "executed", submittedAt: 1_700_000_000_000 },
    ];
    const rows = rowsOf({ pending: local, profileIndex: 0, public: [registered(), received()] });

    assert.deepEqual(
      rows.map((r) => [r.hash.slice(0, 4), r.source, r.status]),
      [
        ["aaaa", "sent", "pending"],
        [registered().hash.slice(0, 4), "public", "executed"],
        [received().hash.slice(0, 4), "public", "executed"],
        ["bbbb", "sent", "executed"],
      ]
    );
  });

  it("show the selected profile's own, and those without a profile", () => {
    const local = [
      { hash: hash(0xaa), profileIndex: 1, status: "submitted", submittedAt: 3 },
      { hash: hash(0xbb), profileIndex: 0, status: "submitted", submittedAt: 2 },
      { hash: hash(0xcc), status: "submitted", submittedAt: 1 },
    ];

    assert.deepEqual(
      rowsOf({ pending: local, profileIndex: 0 }).map((r) => r.hash.slice(0, 2)),
      ["bb", "cc"]
    );
    // Without a profile, as while locked: every profile's.
    assert.deepEqual(
      rowsOf({ pending: local }).map((r) => r.hash.slice(0, 2)),
      ["aa", "bb", "cc"]
    );
  });

  it("are pending until the wallet stops waiting for the chain, and then unknown", () => {
    const sent = { amount: "1000000000", hash: hash(0xee), kind: "transfer", privacy: "public", status: "submitted", submittedAt: NOW, to: B };

    assert.equal(rowsOf({ now: NOW + PENDING_MS - 1, pending: [sent] })[0].status, "pending");
    assert.equal(rowsOf({ now: NOW + PENDING_MS, pending: [sent] })[0].status, "unknown");
    // Seen in the node's queue, it is on its way.
    assert.equal(rowsOf({ now: NOW + PENDING_MS, pending: [{ ...sent, status: "mempool" }] })[0].status, "pending");
    // Any other status still waiting stops too.
    assert.equal(rowsOf({ now: NOW + PENDING_MS, pending: [{ ...sent, status: "pending" }] })[0].status, "unknown");
  });

  it("say a send the node dropped is unknown, dropped, until the chain has it", () => {
    const sent = { amount: "1000000000", hash: registered().hash, kind: "contract_call", status: "removed", submittedAt: NOW };

    like(rowsOf({ pending: [sent] })[0], { dropped: true, source: "sent", status: "unknown" });
    like(rowsOf({ pending: [sent], public: [{ ...registered(), success: null }] })[0], { dropped: false, status: "unknown" });
  });
});

describe("the rows", () => {
  it("name counterparties only with a verified name", () => {
    const other = recorded(A, 4655845);
    /** @type {Map<string, string | null>} */
    const names = new Map([
      [String(received().counterparty), "faucet.dusk"],
      [String(other.counterparty), null],
    ]);

    assert.deepEqual(
      rowsOf({ names, public: [received(), other] }).map((r) => r.counterpartyName),
      ["faucet.dusk", null]
    );
  });

  it("take the shielded side's outcome and time while the public side's details aren't read", () => {
    const shield = { ...recorded(B, 2517213), detailsAt: undefined, success: undefined, timestamp: null };
    const at = 1_784_000_000_000;
    const [row] = rowsOf({ public: [shield], shielded: [shieldedEntry({ hash: shield.hash, kind: "shield", success: true, timestamp: at })] });

    like(row, { kind: "shield", source: "public", status: "executed", time: at });
  });

  it("keep one row for a shield or an unshield both histories have", () => {
    const shield = recorded(B, 2517213);
    const rows = rowsOf({ public: [shield], shielded: [shieldedEntry({ hash: shield.hash.toUpperCase(), kind: "shield" })] });

    assert.equal(rows.length, 1);
    like(rows[0], { category: "other", kind: "shield", privacy: "public", source: "public" });
  });

  it("sort entries not looked up yet by the time their height gives", () => {
    const later = { ...received(), blockHeight: 4_687_000, detailsAt: undefined, hash: hash(0xdd), timestamp: null };
    const rows = rowsOf({
      pending: [{ hash: hash(0xee), status: "submitted", submittedAt: 1_792_000_000_000 }],
      public: [received(), later],
      state: { finalized: 4_687_170, headAt: 1_792_979_099_000 },
    });

    assert.deepEqual(
      rows.map((r) => r.hash.slice(0, 2)),
      ["dd", received().hash.slice(0, 2), "ee"]
    );
    // Its time is its block's, which isn't known yet.
    assert.equal(rows[0].time, null);
  });

  it("give a row its block's time from another row of that block", () => {
    const sibling = { ...received(), detailsAt: undefined, hash: hash(0xdd), success: null, timestamp: null };
    const rows = rowsOf({ public: [received(), sibling] });

    assert.deepEqual(
      rows.map((r) => r.time),
      [received().timestamp, received().timestamp]
    );
    // Its outcome is still to be looked up.
    assert.equal(rows.find((r) => r.hash === sibling.hash)?.incomplete, true);
  });
});

describe("a .dusk name's reservation", () => {
  const R = "1f".repeat(32);
  const commit = () => ({ ...registered(), blockHeight: 4_658_000, fnName: "commit", hash: hash(0xc1), reservation: R });
  const register = () => ({ ...registered(), registeredName: "shpongle.dusk", reservation: R });
  /** @param {any[]} history @param {any[]} [local] */
  const name = (history, local = []) => rowsOf({ nameCall: nameHook(), pending: local, public: history }).find((r) => r.hash === hash(0xc1))?.nameCall?.name;

  it("is named by a registration after it for the same reservation", () => {
    assert.equal(name([commit(), register()]), "shpongle.dusk");
    // Not one that came before it, another reservation's, or one whose name didn't read.
    assert.equal(name([commit(), { ...register(), blockHeight: 4_657_000 }]), null);
    assert.equal(name([commit(), { ...register(), reservation: "2f".repeat(32) }]), null);
    assert.equal(name([commit(), { ...register(), registeredName: null }]), null);
    assert.equal(name([{ ...commit(), reservation: null }, register()]), null);
  });

  it("is named by the wallet's own registration, sent after it and not on chain yet", () => {
    const at = /** @type {number} */ (commit().timestamp);
    const sent = { contractId: STORE, fnName: "register", hash: hash(0xe1), kind: "contract_call", registeredName: "shpongle.dusk", reservation: R, status: "submitted", submittedAt: at + 60_000 };

    assert.equal(name([commit()], [sent]), "shpongle.dusk");
    assert.equal(name([commit()], [{ ...sent, submittedAt: at - 60_000 }]), null);
  });

  // As the web wallet keeps them: what the name contract's call says, with its kind.
  const COMMITMENT = "c0".repeat(32);
  /** @param {Record<string, unknown>} fields @param {string | null} [reservation] */
  const registration = (fields, reservation = COMMITMENT) =>
    entryOf({
      blockHeight: 100,
      contractId: STORE,
      fnName: "register",
      hash: hash(0xd1),
      nameCommit: { kind: "registration", name: "alice.dusk", reservation, role: "store" },
      registeredName: "alice.dusk",
      timestamp: undefined,
      ...fields,
    });
  /** @param {Record<string, unknown>} fields @param {string} [reservation] */
  const reservation = (fields, reservation = COMMITMENT) =>
    entryOf({ blockHeight: 80, contractId: STORE, fnName: "commit", hash: hash(0xc1), nameCommit: { kind: "reservation", reservation, role: "store" }, timestamp: undefined, ...fields });
  /** @param {Record<string, unknown>} fields */
  const sent = (fields) => ({ contractId: STORE, kind: "contract_call", status: "submitted", ...fields });

  it("is named, as the web wallet keeps the calls, by a registration in a later block, or one not in a block yet", () => {
    assert.equal(name([registration({}), reservation({})]), "alice.dusk");

    const pending = sent({ fnName: "register", hash: hash(0xd1), nameCommit: { kind: "registration", name: "alice.dusk", reservation: COMMITMENT }, registeredName: "alice.dusk", submittedAt: 2 });

    assert.equal(name([reservation({})], [pending]), "alice.dusk");
    // Two not in a block yet go by when they were sent.
    assert.equal(name([], [pending, sent({ fnName: "commit", hash: hash(0xc1), nameCommit: { kind: "reservation", reservation: COMMITMENT }, submittedAt: 1 })]), "alice.dusk");
    assert.equal(name([], [pending, sent({ fnName: "commit", hash: hash(0xc1), nameCommit: { kind: "reservation", reservation: COMMITMENT }, submittedAt: 3 })]), null);
  });

  it("is not named by a registration before it, for another reservation, or whose reservation didn't read for the account", () => {
    for (const rows of [
      [registration({}), reservation({ blockHeight: 101 })],
      [registration({}), reservation({}, "00".repeat(32))],
      [registration({}, null), reservation({})],
    ]) {
      assert.equal(name(rows), null);
    }
  });
});

describe("settleSends", () => {
  const sent = { amount: "100000000000", hash: registered().hash, kind: "contract_call", privacy: "public", status: "submitted", submittedAt: 1 };

  it("keeps a failed send for the amount it tried to move, which the chain's row doesn't say", () => {
    const failed = { ...registered(), success: false, value: "0" };
    const { drop, keep } = settleSends({ pending: [sent], public: [failed] });

    assert.deepEqual(drop, []);
    assert.deepEqual(keep, [{ ...sent, settled: true }]);
    like(rowsOf({ pending: keep, public: [failed] })[0], { status: "failed", value: 100n * DUSK });
  });

  it("drops a send the chain's row says all of, once it has its outcome", () => {
    assert.deepEqual(settleSends({ pending: [sent], public: [registered()] }), { drop: [sent.hash], keep: [] });
    // Not before its outcome is looked up.
    assert.deepEqual(settleSends({ pending: [sent], public: [{ ...registered(), success: null }] }), { drop: [], keep: [] });
    assert.deepEqual(settleSends({ pending: [sent] }), { drop: [], keep: [] });
  });

  it("keeps a send with the name typed for its recipient, marked settled, once", () => {
    const named = { ...sent, toName: "alice.dusk" };
    const { drop, keep } = settleSends({ pending: [named], public: [registered()] });

    assert.deepEqual(drop, []);
    assert.deepEqual(keep, [{ ...named, settled: true }]);
    assert.deepEqual(settleSends({ pending: keep, public: [registered()] }), { drop: [], keep: [] });
    // Its row is the chain's, with the name.
    like(rowsOf({ pending: keep, public: [registered()] })[0], { source: "public", status: "executed", toName: "alice.dusk" });
  });

  it("keeps a shielded send's recipient, which the shielded history doesn't have", () => {
    const shielded = { amount: "2000000000", hash: hash(0xab), kind: "transfer", privacy: "shielded", status: "submitted", to: B };
    const entries = [shieldedEntry({ value: "2000000000" })];
    const { drop, keep } = settleSends({ pending: [shielded], shielded: entries });

    assert.deepEqual(drop, []);
    assert.deepEqual(keep, [{ ...shielded, settled: true }]);
    like(rowsOf({ pending: keep, shielded: entries })[0], { counterparty: B, source: "shielded" });
  });

  it("keeps a shielded send's memo, settled against the shielded history", () => {
    const shielded = { amount: "2000000000", hash: hash(0xab), kind: "transfer", memo: "Invoice 42", privacy: "shielded", status: "submitted", to: B };
    const entries = [shieldedEntry({ value: "2000000000" })];
    const { keep } = settleSends({ pending: [shielded], shielded: entries });

    assert.deepEqual(keep, [{ ...shielded, settled: true }]);
    like(rowsOf({ pending: keep, shielded: entries })[0], { memo: "Invoice 42", source: "shielded", status: "executed" });
    // A public send's memo is the chain's too.
    assert.deepEqual(settleSends({ pending: [{ ...sent, memo: "Rent" }], public: [registered()] }).drop, [sent.hash]);
  });

  it("keeps what the app says adds to the chain's row, and leaves alone a send the app's rule fails on", () => {
    const token = { ...sent, asset: { symbol: "TKN", type: "DRC20" } };

    assert.deepEqual(settleSends({ keeps: (s) => Boolean(s.asset), pending: [token], public: [registered()] }).keep, [{ ...token, settled: true }]);
    assert.deepEqual(
      settleSends({
        keeps: () => {
          throw new Error("no");
        },
        pending: [token],
        public: [registered()],
      }),
      { drop: [], keep: [] }
    );
  });
});

describe("what a send moved and with whom", () => {
  const FAUCET = A;
  const SENDER = B;
  const CONTRACT = "cd".repeat(32);
  /** @param {Record<string, unknown>} over */
  const call = (over) => ({ contractId: CONTRACT, fnName: "pay", hash: hash(7), kind: "contract_call", profileIndex: 0, status: "submitted", submittedAt: NOW, ...over });
  /** @param {any[]} pending @param {Partial<ActivityInput>} [input] */
  const valueOf = (pending, input = {}) => rowsOf({ account: SENDER, pending, ...input }).map((r) => r.value);

  it("counts a call's deposit and what it transfers to another account, the chain's value as it is", () => {
    // Sent: 2 DUSK to someone else, and 3 DUSK attached to the call.
    const pending = call({ amount: "2000000000", deposit: "3000000000", to: FAUCET });

    assert.deepEqual(valueOf([pending]), [5n * DUSK]);
    // The amount back to the profile itself, with no recipient or its own: the deposit alone left.
    assert.deepEqual(valueOf([{ ...pending, to: undefined }]), [3n * DUSK]);
    assert.deepEqual(valueOf([{ ...pending, to: SENDER }]), [3n * DUSK]);
    // A record that names neither, as the web wallet keeps a call: its amount, to the contract.
    assert.deepEqual(valueOf([call({ amount: "4000000000" })]), [4n * DUSK]);
    // The chain's record says what left in one value; the wallet's own until the chain settled it.
    const chain = entryOf({ contractId: CONTRACT, counterparty: CONTRACT, fnName: "pay", hash: hash(7), kind: "contract_call", value: "9000000000" });

    assert.deepEqual(valueOf([], { public: [chain] }), [9n * DUSK]);
    assert.deepEqual(valueOf([pending], { public: [{ ...chain, success: null }] }), [5n * DUSK]);
    assert.deepEqual(valueOf([pending], { public: [chain] }), [9n * DUSK]);
  });

  it("names whom a call pays as the chain will: the contract it pays a deposit, else the account it pays", () => {
    const [deposit, other, none] = [
      call({ amount: "0", deposit: "3000000000", hash: hash(1), to: SENDER }),
      call({ amount: "2000000000", hash: hash(2), to: FAUCET }),
      call({ amount: "0", hash: hash(3), to: SENDER }),
    ];

    assert.deepEqual(
      rowsOf({ account: SENDER, pending: [deposit, other, none] })
        .sort((a, b) => (a.hash < b.hash ? -1 : 1))
        .map((r) => r.counterparty),
      [CONTRACT, FAUCET, null]
    );
    // A contract a site called, by its ID as every Dusk app writes one.
    assert.equal(rowsOf({ pending: [call({ contractId: `0x${CONTRACT.toUpperCase()}` })] })[0].contractId, CONTRACT);
  });

  it("goes the way its kind says when the record doesn't: back for an unshield, an unstake, rewards and Sozu's unstake", () => {
    const sends = [
      { hash: hash(1), kind: "transfer", to: FAUCET },
      { hash: hash(2), kind: "unshield" },
      { hash: hash(3), kind: "unstake" },
      { hash: hash(4), kind: "withdraw_reward" },
      { contractId: CONTRACT, fnName: "sozu_unstake", hash: hash(5), kind: "contract_call" },
      { contractId: CONTRACT, fnName: "sozu_stake", hash: hash(6), kind: "contract_call" },
      { hash: hash(7), kind: "transfer", to: SENDER },
    ].map((s) => ({ ...s, status: "submitted", submittedAt: NOW }));

    assert.deepEqual(
      rowsOf({ account: SENDER, pending: sends })
        .sort((a, b) => (a.hash < b.hash ? -1 : 1))
        .map((r) => r.direction),
      ["out", "in", "in", "in", "in", "out", "self"]
    );
  });

  it("names who paid it, not whom it paid, when the chain's row says the account received it", () => {
    const shielded = { blockHeight: 9, direction: /** @type {const} */ ("in"), fee: null, hash: hash(0xab), kind: /** @type {const} */ ("transfer"), success: true, timestamp: null, value: "5" };
    const [row] = rowsOf({ pending: [{ hash: hash(0xab), kind: "transfer", status: "submitted", submittedAt: NOW, to: FAUCET }], shielded: [shielded] });

    like(row, { counterparty: null, direction: "in" });
  });

  it("is a transfer on a route to another chain through the bridge's account, the memo the address there", () => {
    const bsc = /** @type {any} */ (routes(networks.mainnet).find((route) => route.kind === "service")).account;
    const sent = { amount: "2000000000", hash: hash(8), kind: "transfer", memo: EVM, privacy: "public", status: "executed", submittedAt: NOW, to: bsc };
    const [row] = rowsOf({ network: networks.mainnet, pending: [sent] });

    like(row, { category: "bridge", counterparty: bsc, direction: "out", memo: EVM, value: 2n * DUSK });
    assert.equal(row.route?.id, "dusk-to-bsc");
  });
  it("is on its route also when its entry was read without a network", () => {
    const bsc = /** @type {any} */ (routes(networks.mainnet).find((route) => route.kind === "service")).account;
    // historyEntry without a network gives `route: null`.
    const entry = { ...received(), counterparty: bsc, direction: /** @type {const} */ ("out"), memo: EVM, route: null };
    const [row] = rowsOf({ network: networks.mainnet, public: [entry] });

    like(row, { category: "bridge", counterparty: bsc, direction: "out" });
    assert.equal(row.route?.id, "dusk-to-bsc");
  });
});

describe("a call to DuskEVM's bridge", () => {
  it("is a deposit to the DuskEVM address its call paid, as the history synced it, which the wallet's own record may lack", async () => {
    // Recorded on Testnet: a deposit of 0.5 DUSK to DuskEVM.
    const deposit = readFixture("duskevm-deposit-history.json");
    const H = deposit.entry.block_height;
    const node = fakeArchive({ accounts: { [deposit.account]: { receiver: [], sender: [deposit.entry] } }, details: { ...fixture.details, ...deposit.details }, finalized: H + 100 });
    const history = createHistory({ account: deposit.account, archive: node.archiveClient(), network: 2, store: memoryDatabase().storeFor("deposit") });

    await history.sync();

    const { entries } = await history.read();
    const [row] = rowsOf({ account: deposit.account, public: entries });

    like(row, { category: "bridge", counterparty: BRIDGE, kind: "contract_call", status: "executed", value: 500_000_000n });
    like(row.bridge, { amount: 500_000_000n, step: "deposit", to: deposit.recipient });

    const local = { deposit: "500000000", hash: deposit.entry.origin, kind: "contract_call", profileIndex: 0, status: "submitted", submittedAt: NOW };
    const [both] = rowsOf({ account: deposit.account, pending: [local], profileIndex: 0, public: entries });

    like(both, { sent: local, source: "public", status: "executed" });
    assert.equal(both.bridge?.to, deposit.recipient);
  });

  it("is a deposit to the DuskEVM address its call paid", () => {
    const deposit = entryOf({ bridge: { amount: "500000000", kind: "deposit", to: EVM }, contractId: BRIDGE, counterparty: BRIDGE, fnName: "depositETHToWithValue", kind: "contract_call", value: "500000000" });
    const [row] = rowsOf({ public: [deposit] });

    like(row, { category: "bridge", counterparty: BRIDGE, value: 500_000_000n });
    assert.deepEqual(row.bridge, { amount: 500_000_000n, arrival: null, claim: null, claimed: false, hash: null, nonce: null, recipient: null, step: "deposit", to: EVM });
  });

  it("says where a deposit that went through arrived on DuskEVM, and nothing for one that didn't", () => {
    const l2 = `0x${"29".repeat(32)}`;
    const deposit = entryOf({ bridge: { amount: "500000000", kind: "deposit", to: EVM }, contractId: BRIDGE, counterparty: BRIDGE, fnName: "depositETHToWithValue", kind: "contract_call", value: "500000000" });
    const arrivals = new Map([[deposit.hash, { at: 1, hash: l2 }]]);

    assert.deepEqual(rowsOf({ arrivals, public: [deposit] })[0].bridge?.arrival, { at: 1, hash: l2 });
    // Only one that went through to a DuskEVM address arrives.
    assert.equal(rowsOf({ arrivals, public: [{ ...deposit, success: false }] })[0].bridge?.arrival, null);
    assert.equal(rowsOf({ arrivals, public: [{ ...deposit, bridge: null }] })[0].bridge?.arrival, null);
    assert.equal(rowsOf({ arrivals: new Map([[deposit.hash, { at: 1, hash: "0x12" }]]), public: [deposit] })[0].bridge?.arrival, null);
  });

  it("names a proof's withdrawal claimed by a claim of this activity that didn't fail, or as the app read it", () => {
    const nonce = "0001".padEnd(64, "0");
    const withdrawal = `0x${"8E".repeat(32)}`;
    const facts = { amount: "1008000000000", hash: withdrawal, recipient: A, withdrawal: nonce };
    const proof = entryOf({ bridge: { ...facts, kind: "prove" }, contractId: BRIDGE.replace("2257", "14ee"), fnName: "proveWithdrawalTransaction", hash: hash(0xa1), kind: "contract_call" });
    const claim = entryOf({ bridge: { ...facts, kind: "claim" }, fnName: "finalizeWithdrawalTransaction", hash: hash(0xa2), kind: "contract_call" });
    /** @param {any[]} entries @param {Partial<ActivityInput>} [input] */
    const proved = (entries, input = {}) => rowsOf({ public: entries, ...input }).find((r) => r.hash === hash(0xa1))?.bridge;

    like(proved([proof]), { amount: 1_008_000_000_000n, claim: null, claimed: false, hash: withdrawal.toLowerCase(), nonce, recipient: A, step: "proof" });
    assert.equal(proved([proof, claim])?.claimed, true);
    assert.equal(proved([proof, { ...claim, success: false }])?.claimed, false);
    // As the Portal says, read by the app, by the withdrawal's hash.
    const read = { at: 1_793_000_000_000, claimed: false, ready: true };

    like(proved([proof], { claims: new Map([[withdrawal.toLowerCase(), read]]) }), { claim: read, claimed: false });
    assert.equal(proved([proof], { claims: new Map([[withdrawal.toLowerCase(), { claimed: true }]]) })?.claimed, true);
    // The claim itself, of a withdrawal that pays someone else.
    like(rowsOf({ public: [claim] })[0].bridge, { amount: 1_008_000_000_000n, nonce, step: "claim" });
  });

  it("is a received transfer for an account another one's call paid its gas refund", async () => {
    // Recorded on Testnet: a deposit of 0.5 DUSK to DuskEVM; here its unspent gas goes to A.
    const deposit = readFixture("duskevm-deposit-history.json");
    const raw = structuredClone(deposit.entry);

    raw.events.find((/** @type {any} */ e) => e.topic === "moonlight").data.refund_info = [A, "1500000"];

    const node = fakeArchive({ accounts: { [A]: { receiver: [raw], sender: [] } }, details: { ...fixture.details, ...deposit.details }, finalized: raw.block_height + 100 });
    const history = createHistory({ account: A, archive: node.archiveClient(), network: 2, store: memoryDatabase().storeFor("refund") });

    await history.sync();

    const { entries } = await history.read();

    // The history says what the call was; the row, that the bridge paid A nothing.
    like(entries[0], { bridge: { amount: "500000000", kind: "deposit", to: deposit.recipient }, contractId: BRIDGE });
    like(rowsOf({ account: A, public: entries })[0], { bridge: null, category: "received", counterparty: deposit.account, direction: "in", value: 1_500_000n });
  });

  it("is a withdrawal for the account it paid", () => {
    const paid = entryOf({ bridge: null, counterparty: "14eeb3d4021aff09af2c515603a01f8d956a7f6411d11a1b1c0b0561a93fb1b9", direction: "in", kind: "transfer", payer: false, value: "500000000" });

    like(rowsOf({ public: [paid] })[0], { category: "bridge", direction: "in", value: 500_000_000n });
    assert.equal(rowsOf({ public: [paid] })[0].bridge?.step, "withdrawal");
  });
});

describe("a list that isn't there", () => {
  it("is an empty one", () => {
    assert.deepEqual(activityRows({ pending: null, pools: null, public: null, shielded: null }), []);
    assert.deepEqual(settleSends({ keeps: null, pending: null, public: null, shielded: null }), { drop: [], keep: [] });
  });
});

describe("the name service's hook", () => {
  it("is asked for each contract call, with what the entry or the send keeps, and its errors are a call it doesn't read", () => {
    /** @type {any[]} */
    const log = [];
    const sent = { contractId: STORE, fnName: "register", hash: hash(0xe1), kind: "contract_call", registeredName: "x.dusk", status: "submitted", submittedAt: NOW };

    rowsOf({ nameCall: nameHook({ log }), pending: [sent], public: [registered(), received()] });
    assert.deepEqual(
      log.map(({ call, kept }) => [call.fnName, kept.hash.slice(0, 4)]).sort(),
      [
        ["register", registered().hash.slice(0, 4)],
        ["register", "e1e1"],
      ]
    );
    assert.equal(
      rowsOf({
        nameCall: () => {
          throw new Error("no");
        },
        public: [registered()],
      })[0].nameCall,
      null
    );
  });
});
