// A proof only stands, and a claim is only ready, on what the chain says of
// its game, not on the Portal's check alone: a check may take just the proof
// and its game's registration. And a proof only goes against a game the
// Portal takes one against.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GAME_STATUS } from "@dusk-network/networks/duskevm";
import { encodeAbiParameters, keccak256, toRlp } from "viem";

import { WithdrawalError, createWithdrawals, syncWithdrawals } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import { DRIVERS_MISSING, LOG_1008, TESTNET, TIP, TX, bytes, fakeChain, hexOf, indexOfProxy, jsonDriver, pinnedDriver, receiptOf, u256, withdrawalsOn } from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;
const PROVEN_GAME = Array(20).fill(0x1e);
const NOW = 10n * TIP.height;
const SENT = Number(BigInt(LOG_1008.blockNumber));
const BLOCK = { hash: `0x${"b1".repeat(32)}`, stateRoot: `0x${"b2".repeat(32)}` };
const STORAGE = `0x${"b3".repeat(32)}`;
const ROOT = bytes(
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [`0x${"00".repeat(32)}`, /** @type {`0x${string}`} */ (BLOCK.stateRoot), /** @type {`0x${string}`} */ (STORAGE), /** @type {`0x${string}`} */ (BLOCK.hash)]
    )
  )
);

const OTHER = `0x${"3d".repeat(20)}`;
const OTHER_GAME = Array(20).fill(0x4f);
const portal = await pinnedDriver("optimismPortal");
/** What builds a call needs the Portal's pinned driver. */
const withDriver = { skip: portal ? false : DRIVERS_MISSING };

/**
 * What a game's hub, the Portal and the registry say of a game.
 *
 * @typedef {{ status: number, createdAt?: bigint, resolvedAt?: bigint, blacklisted?: boolean, proper?: boolean, respected?: boolean, unreadable?: string }} Game
 */

/**
 * The fixture's withdrawal, and games of the Portal's type at factory
 * indexes 0 up, the newest last: each covers the withdrawal with its
 * output's root, and says what `games` says. The account (0x2c…) proved it
 * against `proven`'s game when given (its proof made at `provenAt`);
 * another account (0x3d…) against `other`'s, when given.
 *
 * @param {{ games?: Game[], proven?: Game | null, other?: Game | null, provenAt?: bigint, check?: () => unknown, tip?: any, registry?: boolean, finality?: number }} options
 */
function chainOf({ check = () => undefined, finality = 302_400, games = [], other = null, proven = null, provenAt = 45_252_320n, registry = true, tip = TIP }) {
  /** @param {number[]} address */
  const gameOf = (address) => (hexOf(address) === hexOf(PROVEN_GAME) ? proven : hexOf(address) === hexOf(OTHER_GAME) ? other : games[indexOfProxy(address)]);
  const submitters = [...(proven ? [SUBMITTER] : []), ...(other ? [OTHER] : [])];
  /** @param {number[]} address @param {keyof Game} field */
  const read = (address, field) => {
    const game = gameOf(address);

    if (!game || game.unreadable === field) throw new Error(`The ${String(field)} read failed`);

    return game[field];
  };
  const proxyOf = (/** @type {number} */ i) => [...Array(18).fill(0x9a), i >> 8, i & 0xff];
  const indexOf = (/** @type {number[]} */ index) => Number(BigInt(hexOf(index)));
  const created = (/** @type {number} */ i) => games[i]?.createdAt ?? NOW - 600n - BigInt(games.length - 1 - i) * 1_800n;
  const chain = fakeChain({
    dgf: {
      findLatestGames: (/** @type {any[]} */ [, start, n]) =>
        Array.from({ length: Math.max(0, Math.min(indexOf(n), indexOf(start) + 1)) }, (_, k) => {
          const i = indexOf(start) - k;

          return { ["extra_data"]: u256(SENT), index: u256(i), metadata: [0, 0, 0, 8, ...u256(created(i)).slice(24), ...proxyOf(i)], ["root_claim"]: ROOT, timestamp: Number(created(i)) };
        }),
      gameAtIndex: (/** @type {number[]} */ index) => ({ gameProxy: proxyOf(indexOf(index)) }),
      gameContractId: () => Array(32).fill(0xd5),
      gameCount: () => u256(games.length),
      gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(SENT), rootClaim: ROOT }),
      virtualGameHubId: () => Array(32).fill(0xd5),
    },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: {
      createdAtForGame: (/** @type {number[]} */ a) => {
        const game = gameOf(a);

        if (!game || game.unreadable === "createdAt") throw new Error("The createdAt read failed");

        // A proof's game when it was made long ago; a game to prove against as its index says.
        return game.createdAt ?? ([hexOf(PROVEN_GAME), hexOf(OTHER_GAME)].includes(hexOf(a)) ? 45_250_000n : created(indexOfProxy(a)));
      },
      maxClockDuration: () => 302_400n,
      resolvedAtForGame: (/** @type {number[]} */ a) => read(a, "resolvedAt") ?? 0n,
      statusForGame: (/** @type {number[]} */ a) => read(a, "status"),
    },
    l2: {
      eth_getBlockByNumber: () => BLOCK,
      eth_getProof: () => ({ storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] }),
      eth_getTransactionReceipt: () => receiptOf(LOG_1008),
    },
    portal: {
      checkWithdrawal: check,
      disputeGameBlacklist: (/** @type {number[]} */ a) => read(a, "blacklisted") ?? false,
      disputeGameFinalityDelaySeconds: () => u256(finality),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(submitters.length),
      proofMaturityDelaySeconds: () => u256(604_800),
      proofSubmitters: (/** @type {any[]} */ [, index]) => bytes(submitters[Number(BigInt(hexOf(index)))]),
      provenWithdrawals: (/** @type {any[]} */ [, who]) =>
        proven && hexOf(who) === SUBMITTER ? [PROVEN_GAME, provenAt] : other && hexOf(who) === OTHER ? [OTHER_GAME, provenAt] : [Array(20).fill(0), 0],
      respectedGameType: () => 8,
    },
    registry: registry
      ? {
          isGameProper: (/** @type {number[]} */ a) => read(a, "proper") ?? true,
          isGameRespected: (/** @type {number[]} */ a) => read(a, "respected") ?? true,
          respectedGameTypeUpdatedAt: () => 0n,
        }
      : {},
    tip,
  });
  const network = registry ? TESTNET : withoutRegistry();

  return { chain, proxyOf, withdrawals: createWithdrawals(withdrawalsOn(chain, { network })) };
}

/** Testnet, its anchor state registry unknown. */
function withoutRegistry() {
  const contracts = { ...TESTNET.duskEvm?.contracts };

  delete contracts.anchor_state_registry;

  return /** @type {any} */ ({ ...TESTNET, duskEvm: { ...TESTNET.duskEvm, contracts } });
}

/** A proof's game resolved for the defender long ago, its proof matured: claimable, on its own. */
const STANDING = Object.freeze({ createdAt: 45_250_000n, resolvedAt: 45_555_010n, status: GAME_STATUS.DEFENDER_WINS });
/** A game newer than the proof's, still in progress: a proof can go against it. */
const OPEN = Object.freeze({ status: GAME_STATUS.IN_PROGRESS });

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

describe("a proof whose game the challenger won (finding 1)", () => {
  const lost = { ...STANDING, status: GAME_STATUS.CHALLENGER_WINS };

  it("is rejected even when the Portal's check passes: no date, nothing to claim", async () => {
    const { withdrawals } = chainOf({ proven: lost });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { proofRejected: true, readyAt: null, reason: "proof-rejected", stage: "proven_waiting" });
    await refused(withdrawals.claimCall(TX, { submitter: SUBMITTER }), "not-ready", { proofRejected: true });
  });

  it("is proved again against a newer game the Portal takes", withDriver, async () => {
    const { withdrawals } = chainOf({ games: [OPEN], proven: lost });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { disputeGameIndex: 0n, proofRejected: false, reason: "proof-rejected", stage: "ready_to_prove" });
    like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 0n });
  });

  it("is to prove again in the History's claims, whatever the Portal's check says", async () => {
    const { withdrawals } = chainOf({ proven: lost });

    like((await withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { at: null, ready: false, reprove: true });
  });
});

describe("a proof whose game the anchor state registry retired, or no longer respects (finding 2)", () => {
  for (const [what, game] of /** @type {const} */ ([
    ["retired", { ...STANDING, proper: false }],
    ["not respected", { ...STANDING, respected: false }],
  ])) {
    it(`is rejected while its game is ${what}, though it resolved for the defender and isn't blacklisted`, async () => {
      const refusing = () => {
        throw new Error("OptimismPortal2: invalid dispute game");
      };
      const { withdrawals } = chainOf({ check: refusing, proven: game });

      like(await withdrawals.status(TX, { submitter: SUBMITTER }), { proofRejected: true, reason: "proof-rejected", stage: "proven_waiting" });
      like((await withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { ready: false, reprove: true });
    });

    it(`is proved again against a newer game when its game is ${what}`, withDriver, async () => {
      const { withdrawals } = chainOf({ games: [OPEN], proven: game });

      like(await withdrawals.status(TX, { submitter: SUBMITTER }), { reason: "proof-rejected", stage: "ready_to_prove" });
      like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 0n });
    });
  }
});

describe("a claim whose timing can't be established (finding 3)", () => {
  it("waits when its game can't be read, though the Portal's check passes", async () => {
    // Proved now, so nowhere near matured: only the game's reads would say so.
    for (const unreadable of ["createdAt", "resolvedAt", "status"]) {
      const { withdrawals } = chainOf({ proven: { ...STANDING, unreadable }, provenAt: NOW });
      const status = await withdrawals.status(TX, { submitter: SUBMITTER });

      like(status, { reason: "game-unreadable", stage: "proven_waiting" }, unreadable);
      assert.equal("readyAt" in status, false);
      await refused(withdrawals.claimCall(TX, { submitter: SUBMITTER }), "not-ready");
    }
  });

  it("waits when whether its game stands can't be read: the blacklist or the registry", async () => {
    for (const unreadable of ["blacklisted", "proper", "respected"]) {
      const { withdrawals } = chainOf({ proven: { ...STANDING, unreadable } });

      like(await withdrawals.status(TX, { submitter: SUBMITTER }), { reason: "game-unreadable", stage: "proven_waiting" }, unreadable);
      await refused(withdrawals.claimCall(TX, { submitter: SUBMITTER }), "not-ready");
    }
  });

  it("waits while its game hasn't resolved, even with no finality delay and the Portal's yes", async () => {
    const { withdrawals } = chainOf({ finality: 0, proven: { createdAt: 45_250_000n, status: GAME_STATUS.IN_PROGRESS } });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { readyAtExact: false, reason: "game-in-progress", stage: "proven_waiting" });
    await refused(withdrawals.claimCall(TX, { submitter: SUBMITTER }), "not-ready");
  });

  it("isn't ready in the History's claims when its game or the latest block can't be read", async () => {
    const unreadable = chainOf({ proven: { ...STANDING, unreadable: "createdAt" }, provenAt: NOW });

    like((await unreadable.withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { at: null, ready: false, reprove: false });

    const noTip = chainOf({
      proven: STANDING,
      tip: () => {
        throw new Error("The node can't be read");
      },
    });

    like((await noTip.withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { at: null, ready: false });

    const unresolved = chainOf({ finality: 0, proven: { createdAt: 45_250_000n, status: GAME_STATUS.IN_PROGRESS } });

    like((await unresolved.withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { exact: false, ready: false });
  });

  it("is still ready once all of it is read, and the Portal takes it", withDriver, async () => {
    const { withdrawals } = chainOf({ proven: STANDING });

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { readyAtExact: true, stage: "ready_to_finalize" });
    assert.equal((await withdrawals.claimCall(TX, { submitter: SUBMITTER })).fnName, "finalizeWithdrawalTransaction");
    like((await withdrawals.claims([TX], { submitter: SUBMITTER })).get(TX), { exact: true, ready: true });
  });
});

/**
 * Whether the Portal takes a proof against a game, as it checks one: a game
 * that isn't blacklisted, that the registry calls proper (registered, not
 * retired) and respected, and that the challenger didn't win.
 *
 * @param {Game} game
 */
const portalTakesProof = (game) => !game.blacklisted && game.proper !== false && game.respected !== false && game.status !== GAME_STATUS.CHALLENGER_WINS;

describe("the newest game that covers a withdrawal, when none resolved (finding 4)", () => {
  for (const [what, newest] of /** @type {const} */ ([
    ["blacklisted", { ...OPEN, blacklisted: true }],
    ["retired", { ...OPEN, proper: false }],
    ["not respected", { ...OPEN, respected: false }],
    ["won by the challenger", { status: GAME_STATUS.CHALLENGER_WINS }],
  ])) {
    it(`is passed over when it's ${what}, for an older one the Portal takes`, withDriver, async () => {
      // Games 0 and 1 cover it; 1, the newest, is the one the old rule took.
      const games = [OPEN, newest];
      const { withdrawals } = chainOf({ games });

      assert.equal(portalTakesProof(games[1]), false, "the old choice is one the Portal refuses");
      assert.equal(portalTakesProof(games[0]), true);
      like(await withdrawals.status(TX, { submitter: SUBMITTER }), { disputeGameIndex: 0n, stage: "ready_to_prove" });
      like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 0n });
    });
  }

  it("is the newest the Portal takes, as before, when the newest is one", withDriver, async () => {
    const { withdrawals } = chainOf({ games: [OPEN, { ...OPEN, blacklisted: true }, OPEN] });

    like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 2n });
  });

  it("is none when the Portal takes none of them, or whether it would can't be read", async () => {
    for (const [games, error] of /** @type {const} */ ([
      [[{ ...OPEN, proper: false }, { status: GAME_STATUS.CHALLENGER_WINS }], undefined],
      [[{ ...OPEN, unreadable: "status" }], "Whether the Portal takes a proof against game 0 can't be read"],
    ])) {
      const { withdrawals } = chainOf({ games: /** @type {Game[]} */ (/** @type {unknown} */ (games)) });
      const status = await withdrawals.status(TX, { submitter: SUBMITTER });

      like(status, { reason: "no-output", stage: "waiting_for_output" });
      // What couldn't be read while looking, if anything.
      assert.equal(status.error?.message, error);
      await assert.rejects(withdrawals.prepareProof(TX, { submitter: SUBMITTER }), { code: "no-proof", reason: "no-output" });
    }
  });

  it("checks the Portal's blacklist without the registry, where the network names none", withDriver, async () => {
    const { withdrawals } = chainOf({ games: [OPEN, { ...OPEN, blacklisted: true }], registry: false });

    like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 0n });
  });

  it("passes over a resolved game the Portal blacklisted, though the registry calls it proper", withDriver, async () => {
    // Resolved long ago, all of them: the newest the Portal takes is 0.
    const old = (/** @type {Partial<Game>} */ game) => ({ createdAt: NOW - 400_000n, resolvedAt: NOW - 90_000n, status: GAME_STATUS.DEFENDER_WINS, ...game });
    const { withdrawals } = chainOf({ games: [old({ createdAt: NOW - 401_800n }), old({ blacklisted: true })] });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    like(prepared.proof, { disputeGameIndex: 0n });
    like(prepared.claim, { exact: true });
  });
});

describe("another account's proof", () => {
  it("doesn't stand when its game was won by the challenger, or retired, whatever the Portal's check says", async () => {
    for (const lost of [{ ...STANDING, status: GAME_STATUS.CHALLENGER_WINS }, { ...STANDING, proper: false }, { ...STANDING, respected: false }]) {
      const { withdrawals } = chainOf({ games: [OPEN], other: lost });

      like(await withdrawals.status(TX, { submitter: SUBMITTER }), { provenByOther: false, stage: "ready_to_prove" });
    }

    // One that stands still counts.
    like(await chainOf({ games: [OPEN], other: STANDING }).withdrawals.status(TX, { submitter: SUBMITTER }), { provenByOther: true });
  });
});

describe("an address's withdrawals found above a final head that came back down (finding 5)", () => {
  const EVM = "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d";
  const h = (/** @type {number} */ n) => `0x${n.toString(16).padStart(64, "0")}`;
  const log = (/** @type {number} */ n, /** @type {number} */ block) => ({
    blockNumber: `0x${block.toString(16)}`,
    data: encodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], [10n ** 18n, "0x"]),
    topics: [],
    transactionHash: h(n),
  });
  /**
   * An RPC whose final head and logs are as given.
   *
   * @param {number} head
   * @param {ReturnType<typeof log>[]} logs
   */
  const rpcAt = (head, logs) => ({
    /** @param {{ method: string, params: any[] }} request */
    request: async ({ method, params }) => {
      if (method === "eth_getBlockByNumber") return { number: `0x${head.toString(16)}` };

      const [{ fromBlock, toBlock }] = params;

      return logs.filter((each) => Number(each.blockNumber) >= Number(fromBlock) && Number(each.blockNumber) <= Number(toBlock));
    },
  });

  it("are dropped with the blocks no longer covered, and found again where they land", async () => {
    // A run counted blocks up to 1,000 final, and found 1 at 900 and 2 at 500.
    const kept = {
      covered: [[0, 1_000]],
      entries: {
        [h(1)]: { amountWei: "1", blockNumber: 900, destination: null, hash: /** @type {`0x${string}`} */ (h(1)) },
        [h(2)]: { amountWei: "1", blockNumber: 500, destination: null, hash: /** @type {`0x${string}`} */ (h(2)) },
      },
      target: 1_000,
      window: 100_000,
    };
    // The final head is 800 now: 1 was above it, and may not be there at all.
    const lower = await syncWithdrawals({ address: EVM, duskEvm: rpcAt(800, []), network: TESTNET, state: kept });

    assert.deepEqual(lower.state.covered, [[0, 800]]);
    assert.deepEqual(Object.keys(lower.state.entries), [h(2)]);

    // Final again up to 1,000: 1 was reorged into block 960.
    const again = await syncWithdrawals({ address: EVM, duskEvm: rpcAt(1_000, [log(1, 960)]), network: TESTNET, state: lower.state });

    assert.deepEqual(
      again.found.map((entry) => [entry.hash, entry.blockNumber]),
      [[h(1), 960]]
    );
    assert.equal(again.state.entries[h(1)].blockNumber, 960);
    assert.equal(again.state.entries[h(2)].blockNumber, 500);
  });
});
