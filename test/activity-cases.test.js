// The cases a row's facts are easiest to get wrong in: one rule each.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks, routes } from "@dusk-network/networks";

import { PENDING_MS, activityRows } from "../src/activity.js";
import { STAKE_CONTRACT, TRANSFER_CONTRACT } from "../src/history.js";
import { A, B, BRIDGE, C, DUSK, EVM, POOL, PORTAL, STORE, entryOf, hash, nameHook, recorded } from "./fixtures/activity.js";
import { like } from "./fixtures/helpers.js";

/** @typedef {import("../src/activity.js").ActivityInput} ActivityInput */

const NOW = Date.UTC(2026, 9, 30, 12);
/** @param {ActivityInput} input */
const rowsOf = (input) => activityRows({ network: 2, now: NOW, ...input });
/** @param {Record<string, unknown>} fields */
const sent = (fields) => ({ hash: hash(0xee), status: "submitted", submittedAt: NOW - 1000, ...fields });
const BSC = /** @type {any} */ (routes(networks.mainnet).find((route) => route.kind === "service")).account;

describe("the harder cases", () => {
  it("a transfer to the account itself is under All alone, not Sent", () => {
    const [row] = rowsOf({ public: [recorded(B, 2517146)] });

    like(row, { category: "other", direction: "self" });
  });

  it("Sozu's unstake read from the chain, a transfer back from its pool, is staking", () => {
    const unstake = entryOf({ contractId: POOL, counterparty: POOL, direction: "in", fnName: "sozu_unstake", kind: "transfer", payer: true, value: "4000000000" });
    const [row] = rowsOf({ public: [unstake] });

    like(row, { category: "staking", kind: "transfer", sozu: "unstake" });
  });

  it("a failed shield read from the chain, a call of the transfer contract's convert, is a shield", () => {
    const attempt = entryOf({ contractId: TRANSFER_CONTRACT, fee: "50000000", fnName: "convert", kind: "transfer", success: false, error: "Panic", value: "0" });
    const [row] = rowsOf({ public: [attempt] });

    like(row, { category: "other", kind: "shield", status: "failed" });
  });

  it("a deposit to DuskEVM that moved no DUSK, as one that failed, is still a deposit", () => {
    const failed = entryOf({ bridge: { amount: "500000000", kind: "deposit", to: EVM }, contractId: BRIDGE, fnName: "depositETHToWithValue", kind: "contract_call", success: false, value: "0" });
    const [row] = rowsOf({ public: [failed] });

    like(row.bridge, { step: "deposit", to: EVM });
  });

  it("a send that doesn't say its direction is on a route by its receiver, as one sent", () => {
    const [row] = rowsOf({ network: networks.mainnet, pending: [sent({ amount: "2000000000", kind: "transfer", to: BSC })] });

    like(row, { category: "bridge", direction: "out" });
    assert.equal(row.route?.id, "dusk-to-bsc");
  });

  it("only a transfer is on a route, not a call that pays a route's account", () => {
    const call = entryOf({ contractId: "cd".repeat(32), counterparty: BSC, fnName: "pay", kind: "contract_call", value: "1000000000" }, { network: networks.mainnet });
    const [row] = rowsOf({ network: networks.mainnet, public: [call] });

    like(row, { category: "sent", route: null });
  });

  it("a call of a pool Sozu's hub named is Sozu's", () => {
    const pool = "cd".repeat(32);
    const [row] = rowsOf({ pending: [sent({ amount: "1000000000", contractId: pool, fnName: "sozu_stake", kind: "contract_call" })], pools: [pool] });

    like(row, { category: "staking", sozu: "stake" });
  });

  it("a registration sent before its reservation's block names no reservation, by their times", () => {
    const R = "1f".repeat(32);
    const commit = recorded(A, 4658000, { reservation: R });
    const register = sent({ contractId: STORE, fnName: "register", kind: "contract_call", registeredName: "shpongle.dusk", reservation: R, submittedAt: /** @type {number} */ (commit.timestamp) - 60_000 });

    assert.equal(rowsOf({ nameCall: nameHook(), pending: [register], public: [commit] }).find((r) => r.hash === commit.hash)?.nameCall?.name, null);
  });

  it("a registration in a block, its time not read yet, doesn't name a reservation that isn't in one", () => {
    const R = "1f".repeat(32);
    const register = { ...recorded(A, 4658012, { registeredName: "shpongle.dusk", reservation: R }), detailsAt: undefined, timestamp: null };
    const commit = sent({ contractId: STORE, fnName: "commit", hash: hash(0xc1), kind: "contract_call", reservation: R });

    assert.equal(rowsOf({ nameCall: nameHook(), pending: [commit], public: [register] }).find((r) => r.hash === hash(0xc1))?.nameCall?.name, null);
  });

  it("what the chain read of a call comes before the wallet's record of it", () => {
    const chainEvm = "0x96BA8D18dBa0a9B933c2e733EA07F47767dc893e";
    const deposit = entryOf({ bridge: { amount: "500000000", kind: "deposit", to: chainEvm }, contractId: BRIDGE, fnName: "depositETHToWithValue", kind: "contract_call", value: "500000000" });
    const local = sent({ bridge: { amount: "500000000", kind: "deposit", to: EVM }, hash: deposit.hash, kind: "contract_call" });

    assert.equal(rowsOf({ pending: [local], public: [deposit] })[0].bridge?.to, chainEvm);

    const register = recorded(A, 4658012, { registeredName: "shpongle.dusk" });

    assert.equal(rowsOf({ nameCall: nameHook(), pending: [sent({ hash: register.hash, kind: "contract_call", registeredName: "other.dusk" })], public: [register] })[0].nameCall?.name, "shpongle.dusk");
  });

  it("a shielded send keeps the memo it was sent with once the shielded history has it", () => {
    const shielded = { blockHeight: 9, direction: /** @type {const} */ ("out"), fee: "1", hash: hash(0xab), kind: /** @type {const} */ ("transfer"), success: true, timestamp: null, value: "5" };
    const [row] = rowsOf({ pending: [sent({ amount: "5", hash: hash(0xab), kind: "transfer", memo: "Invoice 42", privacy: "shielded" })], shielded: [shielded] });

    like(row, { memo: "Invoice 42", source: "shielded" });
  });

  it("a send the chain's histories still don't have after 15 minutes is unknown", () => {
    const [row] = rowsOf({ now: NOW + PENDING_MS, pending: [sent({ amount: "5", kind: "transfer", submittedAt: NOW, to: B })] });

    like(row, { source: "sent", status: "unknown" });
  });

  it("a call moved its deposit and what it transferred to another account", () => {
    const [row] = rowsOf({ account: A, pending: [sent({ amount: "2000000000", contractId: "cd".repeat(32), deposit: "3000000000", fnName: "pay", kind: "contract_call", to: B })] });

    assert.equal(row.value, 5n * DUSK);
  });

  it("a shielded send, once the shielded history has it, isn't still to be looked up", () => {
    const shielded = { blockHeight: 9, direction: /** @type {const} */ ("out"), fee: "1", hash: hash(0xab), kind: /** @type {const} */ ("transfer"), success: true, timestamp: 1_792_000_000_000, value: "5" };
    const [row] = rowsOf({ pending: [sent({ amount: "5", hash: hash(0xab), kind: "transfer", privacy: "shielded" })], shielded: [shielded] });

    like(row, { incomplete: false, status: "executed", success: true });
  });

  it("a row not looked up yet has its block's time when another row of the block has it", () => {
    const sibling = { ...recorded(A, 4657992), detailsAt: undefined, hash: hash(0xdd), success: null, timestamp: null };
    const row = rowsOf({ public: [recorded(A, 4657992), sibling] }).find((r) => r.hash === hash(0xdd));

    assert.equal(row?.time, recorded(A, 4657992).timestamp);
  });

  it("a deposit's DuskEVM address is one", () => {
    const deposit = entryOf({ bridge: { amount: "500000000", kind: "deposit", to: "0x12" }, contractId: BRIDGE, fnName: "depositETHToWithValue", kind: "contract_call", value: "500000000" });

    assert.equal(rowsOf({ public: [deposit] })[0].bridge?.to, null);
  });

  it("a send of a kind there's no name for is under All alone", () => {
    const [row] = rowsOf({ pending: [sent({ amount: "5", kind: "", to: B })] });

    like(row, { category: "other", kind: null });
  });

  it("a send to the account itself that doesn't say its direction is to itself", () => {
    const [row] = rowsOf({ account: A, pending: [sent({ amount: "5", kind: "transfer", to: A })] });

    like(row, { category: "other", counterparty: A, direction: "self" });
  });

  it("a send the chain has, its details not read yet, keeps the fee and the gas the wallet saw", () => {
    const entry = { ...recorded(A, 4658012), detailsAt: undefined, fee: null, gasSpent: undefined, success: null, timestamp: null };
    const failed = sent({ error: "OutOfGas", feePaid: "3700000", gasSpent: "3700000", hash: entry.hash, kind: "contract_call", status: "failed" });

    like(rowsOf({ pending: [failed], public: [entry] })[0], { fee: 3_700_000n, gasSpent: 3_700_000n, source: "public", status: "failed" });
  });

  it("a claim that may never have run, dropped or no longer waited for, doesn't mark its withdrawal claimed", () => {
    const facts = { amount: "1008000000000", hash: `0x${"8e".repeat(32)}`, recipient: A, withdrawal: "0001".padEnd(64, "0") };
    const proof = entryOf({ bridge: { ...facts, kind: "prove" }, contractId: PORTAL, fnName: "proveWithdrawalTransaction", hash: hash(0xa1), kind: "contract_call" });
    /** @param {Record<string, unknown>} fields */
    const claim = (fields) => sent({ bridge: { ...facts, kind: "claim" }, contractId: PORTAL, fnName: "finalizeWithdrawalTransaction", hash: hash(0xa2), kind: "contract_call", ...fields });
    /** @param {Partial<ActivityInput>} input */
    const claimed = (input) => rowsOf({ public: [proof], ...input }).find((r) => r.hash === hash(0xa1))?.bridge?.claimed;

    assert.equal(claimed({ pending: [claim({ status: "removed" })] }), false);
    assert.equal(claimed({ pending: [claim({ status: "unknown" })] }), false);
    assert.equal(claimed({ now: NOW + PENDING_MS, pending: [claim({ submittedAt: NOW })] }), false);
    // On its way, or on chain with its outcome to be read, it is.
    assert.equal(claimed({ pending: [claim({})] }), true);
    assert.equal(claimed({ pending: [claim({ status: "unknown" })], public: [proof, entryOf({ detailsAt: undefined, hash: hash(0xa2), kind: "contract_call", success: null, timestamp: undefined })] }), true);
  });

  it("the chain's stake operation stands over the wallet's record of a plain contract call", () => {
    const unstake = recorded(B, 4643699);
    const [row] = rowsOf({ pending: [sent({ contractId: STAKE_CONTRACT, fnName: "unstake", hash: unstake.hash, kind: "contract_call" })], public: [unstake] });

    like(row, { category: "staking", kind: "unstake" });
  });

  it("an unshield the shielded history has was sent from the shielded side", () => {
    const unshield = recorded(C, 3602438);
    const shielded = { blockHeight: 3602438, direction: /** @type {const} */ ("out"), fee: "12429102", hash: unshield.hash, kind: /** @type {const} */ ("unshield"), success: true, timestamp: null, value: "9000000000" };

    like(rowsOf({ public: [unshield], shielded: [shielded] })[0], { kind: "unshield", privacy: "shielded", source: "public" });
    // Its public side alone says no more.
    assert.equal(rowsOf({ public: [unshield] })[0].privacy, "public");
  });

  it("a call the wallet sent pays the contract its deposit, as the chain will name it", () => {
    const pool = /** @type {string} */ (POOL);
    const [row] = rowsOf({ account: A, pending: [sent({ amount: "0", contractId: pool, deposit: "1000000000", fnName: "sozu_stake", kind: "contract_call", to: A })] });

    assert.equal(row.counterparty, pool);
  });
});
