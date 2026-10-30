import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bridgeEnvelopeOk } from "@dusk-network/networks/duskevm";

import { WithdrawalError, createWithdrawals } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import { DRIVERS_MISSING, LOG_1008, PAID, TX, WITHDRAWER, fakeChain, hexOf, jsonDriver, passedLog, pinnedDriver, receiptOf, u256, withdrawalsOn } from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;

const portal = await pinnedDriver("optimismPortal");
/** What builds a call needs the Portal's pinned driver. */
const withDriver = { skip: portal ? false : DRIVERS_MISSING };

/**
 * The fixture's withdrawal, proved by the account (0x2c…) against game
 * 0x1e… on hub d5…, as the test says. By default, as the web wallet's
 * tests had it ready: its game resolved at 100, final at 302,500, the
 * latest block at 400,000, and the registry calls it proper and respected.
 *
 * @param {{ check?: () => unknown, finalized?: boolean, log?: any, game?: { createdAt: bigint, resolvedAt: bigint, status: number }, maturity?: number, proven?: unknown[], tip?: any, portal?: Record<string, any>, hub?: Record<string, any>, registry?: Record<string, any> }} [options]
 */
function setup({
  check = () => undefined,
  finalized = false,
  game = { createdAt: 50n, resolvedAt: 100n, status: 2 },
  hub = {},
  log = LOG_1008,
  maturity = 0,
  portal: portalReads = {},
  proven = [Array(20).fill(0x1e), 100],
  registry = {},
  tip = { height: 1_000_000n, timestamp: 400_000n },
} = {}) {
  const chain = fakeChain({
    dgf: { gameContractId: () => Array(32).fill(0xd5), gameCount: () => u256(0), virtualGameHubId: () => Array(32).fill(0xd5) },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: { createdAtForGame: () => game.createdAt, maxClockDuration: () => 302_400n, resolvedAtForGame: () => game.resolvedAt, statusForGame: () => game.status, ...hub },
    l2: { eth_getTransactionReceipt: () => receiptOf(log) },
    portal: {
      checkWithdrawal: check,
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => finalized,
      numProofSubmitters: () => u256(1),
      proofMaturityDelaySeconds: () => u256(maturity),
      provenWithdrawals: () => proven,
      respectedGameType: () => 8,
      ...portalReads,
    },
    registry: { isGameProper: () => true, isGameRespected: () => true, ...registry },
    tip,
  });

  return { chain, withdrawals: createWithdrawals(withdrawalsOn(chain)) };
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 * @param {Record<string, unknown>} [status]
 */
const refused = (promise, code, status) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof WithdrawalError, String(error));
    assert.equal(error.code, code);
    if (status) like(error.status, status);

    return true;
  });

describe("a claim's call", () => {
  it("is refused for a withdrawal claimed already", async () => {
    await refused(setup({ finalized: true }).withdrawals.claimCall(TX, { submitter: SUBMITTER }), "not-ready", { stage: "finalized" });
  });

  it("reads the status again first, and is refused while it waits", async () => {
    const invalid = () => {
      throw new Error("OptimismPortal2: invalid dispute game");
    };

    await refused(
      setup({ check: invalid, game: { createdAt: 50n, resolvedAt: 0n, status: 0 } }).withdrawals.claimCall(TX, { submitter: SUBMITTER }),
      "not-ready",
      { reason: "game-in-progress", stage: "proven_waiting" }
    );
  });

  it("is refused before its date, even when the Portal's check says yes", async () => {
    await refused(
      setup({ tip: { height: 1_000_000n, timestamp: 302_499n } }).withdrawals.claimCall(TX, { submitter: SUBMITTER }),
      "not-ready",
      { reason: "game-not-final", stage: "proven_waiting" }
    );
  });

  it("is refused when it needs more gas than the bound", async () => {
    await refused(setup().withdrawals.claimCall(TX, { gasLimitUpper: 50_000_000n, submitter: SUBMITTER }), "gas");
  });

  it("sends the withdrawal as the SDK serializes it, through the Portal's data driver, with its own gas on top", withDriver, async () => {
    const { chain, withdrawals } = setup();
    const call = await withdrawals.claimCall(TX, { submitter: SUBMITTER });
    const args = /** @type {any} */ (call.args);

    assert.equal(call.fnName, "finalizeWithdrawalTransaction");
    // 50M plus the 519,542 gas the withdrawal asks for, raised to the 1M the proof uses too.
    assert.equal(call.gasLimit, 51_000_000n);
    assert.equal(call.deposit, 0n);
    assert.deepEqual(Object.keys(args), ["data", "gas_limit", "nonce", "sender", "target", "value"]);
    assert.deepEqual(args.data.slice(0, 4), [0xd7, 0x64, 0xad, 0x0b]);
    assert.deepEqual([args.gas_limit.length, args.nonce.length, args.sender.length, args.target.length, args.value.length], [32, 32, 20, 20, 32]);
    // What Dusk Wallet reads from it: whom it pays, how much, and who sent it on DuskEVM.
    like(call.decoded, { amountWei: 1_008n * 10n ** 18n, from: WITHDRAWER, kind: "claim", recipient: { account: PAID, kind: "account" } });
    assert.equal("proofSubmitter" in call.decoded, false);
    assert.equal(bridgeEnvelopeOk(call.decoded, { deposit: call.deposit }), true);
    // For the account it was asked for.
    assert.deepEqual([...new Set(chain.callsOf("checkWithdrawal").map(({ args: [, who] }) => hexOf(who)))], [SUBMITTER]);
  });

  it("gets 50M and the withdrawal's own gas, at least 1M, up to the bound", withDriver, async () => {
    for (const [own, limit] of /** @type {const} */ ([
      [519_542n, 51_000_000n],
      [1_500_000n, 51_500_000n],
      [9_000_000n, 59_000_000n],
      [950_000_000n, 1_000_000_000n],
    ])) {
      const { withdrawals } = setup({ log: passedLog({ gasLimit: own }) });

      assert.equal((await withdrawals.claimCall(TX, { submitter: SUBMITTER })).gasLimit, limit, String(own));
    }

    await refused(setup({ log: passedLog({ gasLimit: 950_000_001n }) }).withdrawals.claimCall(TX, { submitter: SUBMITTER }), "gas");
    await refused(setup({ log: passedLog({ gasLimit: 2_000_000_000n }) }).withdrawals.claimCall(TX, { submitter: SUBMITTER }), "gas");
  });

  it("is for one account, given", async () => {
    await assert.rejects(setup().withdrawals.claimCall(TX, /** @type {any} */ ({})), TypeError);
  });
});

describe("when the History's proved withdrawals can be claimed", () => {
  const hash = (/** @type {number} */ byte) => /** @type {`0x${string}`} */ (`0x${byte.toString(16).repeat(64)}`);
  /** @param {number[]} id */
  const keyOf = (id) => hexOf(id);

  it("is claimed, ready, a date, or none, for the account's own proofs", async () => {
    // Their game resolved at 100, final at 302,500; the latest block at 1,000,000.
    /** @type {Record<string, unknown[]>} */
    const proofs = {
      [hash(0xa)]: [Array(20).fill(0x1e), 100],
      [hash(0xb)]: [Array(20).fill(0x1e), 100],
      [hash(0xc)]: [Array(20).fill(0x1e), 500_000],
      // Another account's proof only.
      [hash(0xd)]: [Array(20).fill(0), 0],
      [hash(0xe)]: [Array(20).fill(0x1e), 500_000],
    };
    const { chain, withdrawals } = setup({
      maturity: 604_800,
      portal: {
        // The Portal takes the claims of 0xb… and 0xe….
        checkWithdrawal: (/** @type {any[]} */ [id]) => {
          if (id[0] !== 0xbb && id[0] !== 0xee) throw new Error("OptimismPortal: proven withdrawal has not matured yet");
        },
        finalizedWithdrawals: (/** @type {number[]} */ id) => id[0] === 0xaa,
        provenWithdrawals: (/** @type {any[]} */ [id]) => proofs[keyOf(id)],
      },
      tip: { height: 1_000_000n, timestamp: 1_000_000n },
    });
    const claims = await withdrawals.claims([hash(0xa), hash(0xb), hash(0xc), hash(0xd), hash(0xe)], { submitter: SUBMITTER });

    like(claims.get(hash(0xa)), { at: null, claimed: true });
    // Proven at 100: matured at 604,900, a second later on block time.
    like(claims.get(hash(0xb)), { at: 604_901_000, claimed: false, ready: true });
    // Proven at 500,000: it matures at 1,104,800.
    assert.deepEqual(claims.get(hash(0xc)), { at: 1_104_801_000, claimed: false, exact: true, overdue: false, ready: false, reprove: false });
    like(claims.get(hash(0xd)), { at: null, ready: false });
    // The Portal takes its claim, but its date hasn't come: not ready yet.
    like(claims.get(hash(0xe)), { at: 1_104_801_000, ready: false });
    // The account's own proofs: its submitter's.
    assert.ok(chain.callsOf("provenWithdrawals").every(({ args: [, who] }) => hexOf(who) === SUBMITTER));
  });

  it("gives no date for a proof whose game was blacklisted, or that the challenger won, but that it must be made again", async () => {
    // Each proof's game: 0x1e… blacklisted, 0x2f… the challenger won, 0x3a… waiting.
    /** @type {Record<string, number[]>} */
    const games = { [hash(0xa)]: Array(20).fill(0x1e), [hash(0xb)]: Array(20).fill(0x2f), [hash(0xc)]: Array(20).fill(0x3a) };
    const { withdrawals } = setup({
      game: { createdAt: 50n, resolvedAt: 0n, status: 0 },
      hub: { statusForGame: (/** @type {number[]} */ a) => (a[0] === 0x2f ? 1 : 0) },
      maturity: 604_800,
      portal: {
        checkWithdrawal: () => {
          throw new Error("OptimismPortal: invalid dispute game");
        },
        disputeGameBlacklist: (/** @type {number[]} */ address) => address[0] === 0x1e,
        provenWithdrawals: (/** @type {any[]} */ [id]) => [games[keyOf(id)], 100],
      },
      tip: { height: 1_000_000n, timestamp: 200n },
    });
    const claims = await withdrawals.claims([hash(0xa), hash(0xb), hash(0xc)], { submitter: SUBMITTER });
    const again = { at: null, claimed: false, exact: false, overdue: false, ready: false, reprove: true };

    assert.deepEqual(claims.get(hash(0xa)), again);
    assert.deepEqual(claims.get(hash(0xb)), again);
    like(claims.get(hash(0xc)), { at: 604_901_000, reprove: false });
  });

  it("isn't ready, with no date, when the latest block can't be read, whatever the Portal's check says", async () => {
    // The web wallet kept the Portal's yes: a check that takes just the
    // proof and its game says yes before the claim's date.
    const { withdrawals } = setup({
      tip: () => {
        throw new Error("The node can't be read");
      },
    });

    like((await withdrawals.claims([LOG_1008.transactionHash], { submitter: SUBMITTER })).get(LOG_1008.transactionHash), { at: null, ready: false });
  });
});

describe("how long a withdrawal takes", () => {
  const delays = { disputeGameFinalityDelaySeconds: () => u256(302_400), proofMaturityDelaySeconds: () => u256(604_800), respectedGameType: () => 8 };

  it("is the Portal's delays, and how often outputs come from the latest games, in two queries", async () => {
    // As DuskEVM testnet's on 27 Oct 2026: an output every 170 Dusk blocks, one late by as much again.
    const stamps = [46_986_550, 46_984_850, 46_983_150, 46_979_750, 46_978_050, 46_976_350];
    const games = fakeChain({ dgf: { findLatestGames: () => stamps.map((timestamp) => ({ timestamp })), gameCount: () => u256(3_915) }, portal: delays });

    assert.deepEqual(await createWithdrawals(withdrawalsOn(games)).timing(), { finalitySeconds: 302_400, maturitySeconds: 604_800, outputSeconds: 1_700 });
    // The latest six games of the type the Portal takes.
    assert.deepEqual(games.callsOf("findLatestGames")[0].args, [8, u256(3_914), u256(6)]);
    assert.deepEqual(games.queries, [["proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds", "respectedGameType", "gameCount"], ["findLatestGames"]]);
  });

  it("says nothing of how often outputs come without two games", async () => {
    const none = fakeChain({ dgf: { gameCount: () => u256(0) }, portal: delays });

    assert.equal((await createWithdrawals(withdrawalsOn(none)).timing()).outputSeconds, null);
  });
});
