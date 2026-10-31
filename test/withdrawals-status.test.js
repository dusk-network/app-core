import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evmAddressOf } from "@dusk-network/networks/duskevm";
import { encodeAbiParameters, keccak256, toRlp } from "viem";

import { WithdrawalError, createWithdrawals } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import {
  HUB,
  LOG_1008,
  PAID,
  TIP,
  TX,
  WITHDRAWER,
  bytes,
  fakeChain,
  hexOf,
  receiptOf,
  u256,
  withdrawalsOn,
} from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;
/** A contract time on the wall clock, in seconds, counted from the tip. */
const wall = (/** @type {bigint} */ seconds, tip = TIP) => tip.timestamp + seconds - 10n * tip.height;
const invalidGame = () => {
  throw new Error("OptimismPortal2: invalid dispute game");
};
const notMatured = () => {
  throw new Error("OptimismPortal: proven withdrawal has not matured yet");
};

/**
 * The fixture's withdrawal, proved by the account asked about (0x2c…)
 * against game 0x1e…, its game on hub d5…, as the test says.
 *
 * @param {{
 *   check?: () => unknown, count?: number, createdAt?: bigint, finality?: number, finalized?: boolean,
 *   gameStatus?: number, maturity?: number, proven?: unknown[], provenAt?: bigint | number, resolvedAt?: bigint,
 *   tip?: any, portal?: Record<string, any>, dgf?: Record<string, any>, hub?: Record<string, any>, l2?: Record<string, any>
 * }} options
 */
function chainOf({
  check = () => undefined,
  count = 1,
  createdAt = 46_876_050n,
  dgf = {},
  finality = 302_400,
  finalized = false,
  gameStatus = 0,
  hub = {},
  l2 = {},
  maturity = 604_800,
  portal = {},
  proven,
  provenAt = 46_877_440n,
  resolvedAt = 0n,
  tip = TIP,
}) {
  return fakeChain({
    dgf: { gameContractId: () => Array(32).fill(0xd5), gameCount: () => u256(0), virtualGameHubId: () => Array(32).fill(0xd5), ...dgf },
    hub: { createdAtForGame: () => createdAt, maxClockDuration: () => 302_400n, resolvedAtForGame: () => resolvedAt, statusForGame: () => gameStatus, ...hub },
    l2: { eth_getTransactionReceipt: () => receiptOf(LOG_1008), ...l2 },
    portal: {
      checkWithdrawal: check,
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(finality),
      finalizedWithdrawals: () => finalized,
      numProofSubmitters: () => u256(count),
      proofMaturityDelaySeconds: () => u256(maturity),
      proofSubmitters: () => bytes(SUBMITTER),
      provenWithdrawals: () => proven ?? [Array(20).fill(0x1e), provenAt],
      respectedGameType: () => 8,
      ...portal,
    },
    registry: { isGameProper: () => true, isGameRespected: () => true, respectedGameTypeUpdatedAt: () => 0n },
    tip,
  });
}

/** @param {Parameters<typeof chainOf>[0]} options */
function setup(options = {}) {
  const chain = chainOf(options);

  return { chain, withdrawals: createWithdrawals(withdrawalsOn(chain)) };
}

/**
 * As the web wallet's tests set the chain: proved at 100 against a game
 * created at 50, no maturity delay, the latest block at 200 on block time.
 *
 * @param {Parameters<typeof chainOf>[0]} options
 */
const walletSetup = (options = {}) =>
  setup({ createdAt: 50n, maturity: 0, provenAt: 100, tip: { height: 1_000_000n, timestamp: 200n }, ...options });

/** A proof long matured, against a game resolved and final long ago: claimable now. */
const CLAIMABLE = Object.freeze({ createdAt: 45_250_000n, gameStatus: 2, provenAt: 45_252_320n, resolvedAt: 45_555_010n });

describe("a withdrawal's status, as the web wallet read it", () => {
  it("keeps a proven withdrawal waiting while the Portal refuses its claim and its game is in progress", async () => {
    const { chain, withdrawals } = walletSetup({ check: invalidGame });
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { reason: "game-in-progress", stage: "proven_waiting" });

    const [check] = chain.callsOf("checkWithdrawal");

    assert.equal(chain.callsOf("checkWithdrawal").length, 1);
    assert.equal(check.args[0].length, 32);
    assert.deepEqual(check.args[1], Array(20).fill(0x2c));
    // A proved withdrawal looks for no game to prove against.
    assert.deepEqual(chain.callsOf("findLatestGames"), []);
  });

  it("dates the claim from the proof's maturity and its game: the earliest while the game is in progress", async () => {
    const { withdrawals } = walletSetup({ check: notMatured, maturity: 604_800 });

    // Proven at 100: it matures at 604,900, a second later on block time.
    // The game, created at 50, is final no sooner than 50 + 302,400 + 302,400.
    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      claimOverdue: false,
      proofRejected: false,
      readyAt: 604_901n,
      readyAtExact: false,
      stage: "proven_waiting",
    });
  });

  it("gives the exact claim date once the proof's game has resolved", async () => {
    const { withdrawals } = walletSetup({ check: notMatured, gameStatus: 2, maturity: 604_800, resolvedAt: 400_000n });

    // The game is final at 400,000 + 302,400, after the proof matures.
    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { readyAt: 702_401n, readyAtExact: true, stage: "proven_waiting" });
  });

  it("counts testnet's contract time, Dusk block height × 10, from the latest block", async () => {
    // Proved at block 4,687,744 against a game created at block 4,687,605:
    // claimable from Mon 2 Nov, 03:20:39 UTC.
    const { withdrawals } = setup({ check: invalidGame });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      readyAt: BigInt(Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000),
      readyAtExact: false,
      stage: "proven_waiting",
    });
  });

  it("says when a proof's game is late to resolve, and the soonest it can be claimed", async () => {
    // Its clock ran out more than an hour before the latest block.
    const { withdrawals } = setup({ check: invalidGame, createdAt: 46_000_000n, provenAt: 46_100_000 });

    // It could resolve now: final 3.5 days from now, after the maturity.
    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      claimOverdue: true,
      readyAt: TIP.timestamp + 302_400n,
      readyAtExact: false,
    });
  });

  it("flags a proof whose game the challenger won, with no newer game to prove against", async () => {
    const { withdrawals } = walletSetup({ check: invalidGame, gameStatus: 1, resolvedAt: 400_000n });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      proofRejected: true,
      readyAt: null,
      reason: "proof-rejected",
      stage: "proven_waiting",
    });
  });

  it("flags a proof whose game was blacklisted", async () => {
    const { withdrawals } = walletSetup({ check: invalidGame, portal: { disputeGameBlacklist: () => true } });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { proofRejected: true, readyAt: null, stage: "proven_waiting" });
  });

  it("keeps the date known so far when the proof's game can't be read", async () => {
    const { withdrawals } = walletSetup({
      check: invalidGame,
      hub: {
        createdAtForGame: () => {
          throw new Error("The hub can't be read");
        },
      },
    });
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { reason: "game-unreadable", stage: "proven_waiting" });
    assert.equal("readyAt" in status, false);
  });

  it("gives no date once it has passed while the Portal still refuses the claim", async () => {
    const { withdrawals } = walletSetup({ check: invalidGame, gameStatus: 2, resolvedAt: 100n, tip: { height: 1_000_000n, timestamp: 2_000_000n } });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      readyAt: null,
      readyAtExact: false,
      reason: "portal-refuses",
      stage: "proven_waiting",
    });
  });

  it("waits for the claim's date even when the Portal takes the claim", async () => {
    // Final at 400 + 302,400, a second later on block time: after the latest
    // block, at 200. A Portal whose check takes just the proof and its game
    // says yes, and then refuses the claim itself.
    const { withdrawals } = walletSetup({ gameStatus: 2, resolvedAt: 400n });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), {
      disputeGameProxy: `0x${"1e".repeat(20)}`,
      readyAt: 302_801n,
      readyAtExact: true,
      reason: "game-not-final",
      stage: "proven_waiting",
    });
  });

  it("is ready to claim once the Portal takes the claim and its date has come", async () => {
    /** @param {bigint} timestamp The latest block's time */
    const stageAt = (timestamp) =>
      walletSetup({ gameStatus: 2, resolvedAt: 400n, tip: { height: 1_000_000n, timestamp } }).withdrawals.status(TX, { submitter: SUBMITTER });

    like(await stageAt(302_800n), { stage: "proven_waiting" });
    like(await stageAt(302_801n), { readyAt: 302_801n, readyAtExact: true, reason: null, stage: "ready_to_finalize" });
  });

  it("isn't overdue once ready to claim, and isn't ready while its game hasn't resolved", async () => {
    // Testnet's clock, block height × 10: the game, unresolved more than an
    // hour past its clock, is overdue, and with no finality delay its claim
    // would be due now. The web wallet called it ready; the Portal refuses
    // the claim until the game resolves for the defender.
    const late = { finality: 0, tip: { height: 40_000n, timestamp: 1_793_000_000n } };

    like(await walletSetup(late).withdrawals.status(TX, { submitter: SUBMITTER }), {
      claimOverdue: true,
      reason: "game-in-progress",
      stage: "proven_waiting",
    });
    like(await walletSetup({ ...late, gameStatus: 2, resolvedAt: 400n }).withdrawals.status(TX, { submitter: SUBMITTER }), {
      claimOverdue: false,
      stage: "ready_to_finalize",
    });
  });

  it("reads the game on Dusk, on its own hub, which the factory names, and asks DuskEVM for its finalized block and the receipt alone", async () => {
    const { chain, withdrawals } = walletSetup({ check: invalidGame });

    await withdrawals.status(TX, { submitter: SUBMITTER });

    assert.deepEqual(
      chain.callsOf("gameContractId").map(({ args }) => args),
      [Array(20).fill(0x1e)]
    );
    // The game and its hub's clock limit, on the hub the factory named.
    assert.deepEqual(new Set(chain.hubs), new Set([HUB]));
    assert.deepEqual(
      chain.rpc.map(({ method }) => method),
      ["eth_getBlockByNumber", "eth_getTransactionReceipt"]
    );
  });

  it("checks readiness for the account asked about rather than a third party", async () => {
    const { chain, withdrawals } = walletSetup();
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    assert.equal(status.proofSubmitter, SUBMITTER);
    assert.deepEqual(chain.callsOf("proofSubmitters"), []);
    assert.deepEqual(chain.callsOf("checkWithdrawal")[0].args[1], Array(20).fill(0x2c));
    // A Dusk account stands for its Portal address.
    const byAccount = await walletSetup().withdrawals.status(TX, { submitter: PAID });

    assert.equal(byAccount.proofSubmitter, evmAddressOf(PAID).toLowerCase());
  });
});

describe("a withdrawal's status, as the bridge site read it", () => {
  it("takes the amount, whom it pays and who sent it from its relayed call, and reads the recipient's proof without an account", async () => {
    const { chain, withdrawals } = setup();
    const status = await withdrawals.status(TX);

    like(status.facts, { amountWei: 1_008n * 10n ** 18n, from: WITHDRAWER, recipient: { account: PAID, kind: "account" } });
    assert.equal(status.proofSubmitter, evmAddressOf(PAID).toLowerCase());
    assert.equal(hexOf(chain.callsOf("provenWithdrawals")[0].args[1]), evmAddressOf(PAID).toLowerCase());
  });

  it("dates wallet-both.dusk's claim the earliest its proof and game allow, as an estimate, and converts the proof time", async () => {
    // wallet-both.dusk's 1 DUSK withdrawal, its game in progress on 28 Oct.
    const { chain, withdrawals } = setup({ check: invalidGame });
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { claimOverdue: false, proofRejected: false, readyAtExact: false, stage: "proven_waiting" });
    // Mon 2 Nov, 03:20:39 UTC: the proof's maturity, if the game resolves on time.
    assert.equal(status.readyAt, 1_793_589_639n);
    assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:20:39.000Z");
    // The proof time is converted from block height × 10, not dropped: 26 Oct, 03:20:39 UTC.
    assert.equal(status.provenAt, wall(46_877_440n));
    assert.equal(new Date(Number(status.provenAt) * 1_000).toISOString(), "2026-10-26T03:20:39.000Z");
    // The game is read on Dusk, from the hub the factory names.
    assert.deepEqual([...new Set(chain.hubs)], [HUB]);
    assert.equal(chain.callsOf("createdAtForGame").length, 1);
  });

  it("gives the exact date once the proven game has resolved", async () => {
    // Resolved 161 blocks after its earliest time, the resolver's median.
    const { withdrawals } = setup({ check: invalidGame, gameStatus: 2, resolvedAt: 47_180_060n });
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    // The game's finality comes after the proof's maturity: Mon 2 Nov, 03:24:19 UTC.
    assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:24:19.000Z");
    assert.equal(status.readyAtExact, true);
  });

  it("names a proof whose game the challenger won as rejected, with no newer output to prove against", async () => {
    const { withdrawals } = setup({ check: invalidGame, gameStatus: 1, resolvedAt: 47_180_060n });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { proofRejected: true, readyAt: null, stage: "proven_waiting" });
  });

  it("calls a game left unresolved an hour past its clock overdue, and the claim the earliest still possible", async () => {
    // 400 blocks past the game's earliest resolution, still in progress.
    const tip = { height: 4_718_245n, timestamp: 1_793_289_849n };
    const status = await setup({ check: invalidGame, tip }).withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { claimOverdue: true, readyAtExact: false });
    // It could resolve now: final 3.5 days from now, after the proof's maturity.
    assert.equal(status.readyAt, wall(10n * tip.height + 302_400n, tip));
  });

  it("converts a proof on the height clock from the tip, and is ready from its date", async () => {
    // The 1,008 DUSK withdrawal another account proved at block 4,525,232,
    // its game resolved at 4,555,501: claimable for it since block 4,585,741.
    const status = await setup(CLAIMABLE).withdrawals.status(TX, { submitter: SUBMITTER });

    assert.equal(status.stage, "ready_to_finalize");
    assert.equal(status.readyAt, wall(45_857_410n));
    assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-10-14T08:00:09.000Z");
    assert.equal(status.provenAt, wall(45_252_320n));
  });

  it("waits, with no date, when the game's hub can't be read, whatever the Portal's own check says", async () => {
    const unreadable = () => {
      throw new Error("Contract call failed.");
    };

    // The bridge site let the Portal's yes make it claimable; a check that
    // takes just the proof and its game says yes before the claim's date.
    for (const check of [() => undefined, invalidGame]) {
      const status = await setup({ check, dgf: { gameContractId: unreadable } }).withdrawals.status(TX, { submitter: SUBMITTER });

      assert.deepEqual([status.stage, status.reason, "readyAt" in status], ["proven_waiting", "game-unreadable", false]);
    }
  });

  it("gives no date that has passed while the Portal still refuses the claim", async () => {
    // Resolved long ago, matured, and refused for another reason than the game.
    const { withdrawals } = setup({
      ...CLAIMABLE,
      check: () => {
        throw new Error("OptimismPortal2: paused");
      },
    });
    const status = await withdrawals.status(TX, { submitter: SUBMITTER });

    assert.deepEqual([status.stage, status.readyAt, status.readyAtExact, status.reason], ["proven_waiting", null, false, "portal-refuses"]);
  });

  it("isn't ready before its date, even when the Portal's check says yes", async () => {
    // A Portal whose check takes just the proof and its game says yes on
    // 28 Oct, for a proof that matures, and a game final, on 2 Nov.
    const early = await setup({ gameStatus: 2, resolvedAt: 47_180_060n }).withdrawals.status(TX, { submitter: SUBMITTER });

    assert.deepEqual([early.stage, early.readyAtExact, early.claimOverdue], ["proven_waiting", true, false]);
    assert.equal(new Date(Number(early.readyAt) * 1_000).toISOString(), "2026-11-02T03:24:19.000Z");
    // From its date, the Portal's yes counts.
    assert.equal((await setup(CLAIMABLE).withdrawals.status(TX, { submitter: SUBMITTER })).stage, "ready_to_finalize");
  });

  it("says it's claimed, whoever asks", async () => {
    const status = await setup({ finalized: true }).withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { reason: null, stage: "finalized", withdrawalHash: "0x4b3472cff93e5bbf3231165ad48c0f302cf597c212b7d0e14dc671b49dc4101a" });
  });
});

describe("another account's proof", () => {
  const OWN = SUBMITTER;
  const OTHER = `0x${"3d".repeat(20)}`;
  const OWN_GAME = `0x${"1e".repeat(20)}`;
  const OTHER_GAME = `0x${"4f".repeat(20)}`;
  // The game this account's proof would go against, which stands.
  const SCAN_GAME = `0x${"5a".repeat(20)}`;
  // One proposed output, 10 blocks past the withdrawal's, that covers it.
  const BLOCK = { hash: `0x${"a1".repeat(32)}`, stateRoot: `0x${"a2".repeat(32)}` };
  const STORAGE = `0x${"a3".repeat(32)}`;

  /**
   * Proofs by account: `own` and `others` are `{ game, timestamp, check? }`,
   * in the contracts' time; games carry their status and blacklisting, and
   * an unreadable one fails on its hub.
   *
   * @param {{ own?: { game: string, timestamp: number } | null, others?: Array<{ address: string, game: string, timestamp: number, check?: string }>, games?: Record<string, { status?: number, blacklisted?: boolean, unreadable?: boolean }> }} options
   */
  async function proofs({ games = {}, others = [], own = null }) {
    const submitters = [...(own ? [OWN] : []), ...others.map(({ address }) => address)];
    /** @type {Map<string, any>} */
    const byAccount = new Map([...(own ? [[OWN, own]] : []), ...others.map(({ address, ...proof }) => [address, proof])]);
    /** @param {number[]} address */
    const game = (address) => {
      const known = games[hexOf(address)];

      if (known?.unreadable) throw new Error("Panic: unknown game");

      return known ?? {};
    };
    const { outputRoot } = rootOf(BLOCK, STORAGE);
    const chain = chainOf({
      dgf: {
        findLatestGames: () => [{ index: u256(5) }],
        gameAtIndex: () => ({ gameProxy: bytes(SCAN_GAME) }),
        gameCount: () => u256(6),
        gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(Number(BigInt(LOG_1008.blockNumber)) + 10), rootClaim: bytes(outputRoot) }),
      },
      hub: {
        createdAtForGame: (/** @type {number[]} */ address) => (game(address), 46_876_050n),
        resolvedAtForGame: (/** @type {number[]} */ address) => (game(address), 0n),
        statusForGame: (/** @type {number[]} */ address) => game(address).status ?? 0,
      },
      l2: {
        eth_getBlockByNumber: () => BLOCK,
        eth_getProof: () => ({ storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] }),
      },
      portal: {
        checkWithdrawal: (/** @type {any[]} */ [, submitter]) => {
          const check = byAccount.get(hexOf(submitter))?.check;

          if (check === "ready") return undefined;

          throw new Error(check ?? "OptimismPortal2: invalid dispute game");
        },
        disputeGameBlacklist: (/** @type {number[]} */ address) => Boolean(games[hexOf(address)]?.blacklisted),
        numProofSubmitters: () => u256(submitters.length),
        proofSubmitters: (/** @type {any[]} */ [, index]) => bytes(submitters[Number(BigInt(hexOf(index)))]),
        provenWithdrawals: (/** @type {any[]} */ [, submitter]) => {
          const proof = byAccount.get(hexOf(submitter));

          return proof ? [bytes(proof.game), proof.timestamp] : [Array(20).fill(0), 0];
        },
      },
    });

    return { chain, withdrawals: createWithdrawals(withdrawalsOn(chain)) };
  }

  it("leaves the account ready to prove its own, says so, and claims nothing with it", async () => {
    const { withdrawals } = await proofs({
      games: { [OTHER_GAME]: { status: 0 } },
      others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
    });
    const status = await withdrawals.status(TX, { submitter: OWN });

    like(status, { provenByOther: true, stage: "ready_to_prove" });
    // Claiming as this account isn't possible on another account's proof.
    await assert.rejects(withdrawals.claimCall(TX, { submitter: OWN }), (error) => {
      assert.ok(error instanceof WithdrawalError);
      assert.equal(error.code, "not-ready");
      like(error.status, { provenByOther: true, stage: "ready_to_prove" });

      return true;
    });
  });

  it("doesn't count when the account's own proof decides the stage", async () => {
    const { chain, withdrawals } = await proofs({
      games: { [OTHER_GAME]: { status: 0 }, [OWN_GAME]: { status: 0 } },
      others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_000 }],
      own: { game: OWN_GAME, timestamp: 46_877_440 },
    });
    const status = await withdrawals.status(TX, { submitter: OWN });

    assert.equal(status.stage, "proven_waiting");
    // The own proof's: matured Mon 2 Nov, 03:20:39 UTC, as an estimate.
    assert.equal(new Date(Number(status.readyAt) * 1_000).toISOString(), "2026-11-02T03:20:39.000Z");
    assert.equal(status.provenByOther, undefined);
    assert.deepEqual(chain.callsOf("proofSubmitters"), []);
  });

  it("doesn't count when it was rejected or its game blacklisted", async () => {
    for (const game of [{ status: 1 }, { blacklisted: true, status: 0 }]) {
      const { withdrawals } = await proofs({
        games: { [OTHER_GAME]: game },
        others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
      });

      like(await withdrawals.status(TX, { submitter: OWN }), { provenByOther: false, stage: "ready_to_prove" });
    }
  });

  it("counts when the Portal accepts it, even when its game can't be read", async () => {
    for (const check of ["ready", "OptimismPortal2: proof maturity delay not met"]) {
      const { withdrawals } = await proofs({
        games: { [OTHER_GAME]: { unreadable: true } },
        others: [{ address: OTHER, check, game: OTHER_GAME, timestamp: 46_877_440 }],
      });

      like(await withdrawals.status(TX, { submitter: OWN }), { provenByOther: true, stage: "ready_to_prove" });
    }
  });

  it("doesn't count with an unreadable game and without the Portal's acceptance", async () => {
    const { withdrawals } = await proofs({
      games: { [OTHER_GAME]: { unreadable: true } },
      others: [{ address: OTHER, game: OTHER_GAME, timestamp: 46_877_440 }],
    });

    assert.equal((await withdrawals.status(TX, { submitter: OWN })).provenByOther, false);
  });
});

describe("a withdrawal no game covers yet", () => {
  it("waits for the first game", async () => {
    const status = await setup({ count: 0, provenAt: 0 }).withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { proofSubmitterCount: 0n, reason: "no-games", stage: "waiting_for_output" });
    assert.equal("error" in status, false);
  });

  it("waits for one that covers it, with what couldn't be read while looking", async () => {
    const games = setup({
      count: 0,
      dgf: {
        findLatestGames: () => [{ index: u256(1) }, { index: u256(0) }],
        gameCount: () => u256(2),
        gameMetadataAtIndex: () => {
          throw new Error("The factory can't be read");
        },
      },
      provenAt: 0,
    });
    const status = await games.withdrawals.status(TX, { submitter: SUBMITTER });

    like(status, { reason: "no-output", stage: "waiting_for_output" });
    assert.equal(status.error?.message, "The factory can't be read");
  });
});

/**
 * An output's root, as the package's games carry theirs.
 *
 * @param {{ hash: string, stateRoot: string }} block
 * @param {string} storage
 */
function rootOf(block, storage) {
  const outputRoot = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [/** @type {`0x${string}`} */ (`0x${"00".repeat(32)}`), /** @type {`0x${string}`} */ (block.stateRoot), /** @type {`0x${string}`} */ (storage), /** @type {`0x${string}`} */ (block.hash)]
    )
  );

  return { outputRoot };
}
