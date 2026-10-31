import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { bridgeEnvelopeOk } from "@dusk-network/networks/duskevm";
import { encodeAbiParameters, keccak256, toHex, toRlp } from "viem";

import { WithdrawalError, createWithdrawals } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import {
  DRIVERS_MISSING,
  LOG_1008,
  PAID,
  TESTNET,
  TIP,
  TX,
  bytes,
  fakeChain,
  hexOf,
  indexOfProxy,
  jsonDriver,
  pinnedDriver,
  receiptOf,
  u256,
  withdrawalsOn,
} from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;
const SENT_AT = Number(BigInt(LOG_1008.blockNumber));
const ZERO = `0x${"00".repeat(32)}`;

const portal = await pinnedDriver("optimismPortal");
/** What builds a call needs the Portal's pinned driver. */
const withDriver = { skip: portal ? false : DRIVERS_MISSING };

/**
 * An output's root.
 *
 * @param {{ hash: string, stateRoot: string }} block
 * @param {string} storage
 * @returns {`0x${string}`}
 */
const outputRoot = (block, storage) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [/** @type {`0x${string}`} */ (ZERO), /** @type {`0x${string}`} */ (block.stateRoot), /** @type {`0x${string}`} */ (storage), /** @type {`0x${string}`} */ (block.hash)]
    )
  );

/** @param {number[]} index */
const indexOf = (index) => Number(BigInt(hexOf(index)));

/**
 * The fixture's withdrawal, not yet proved, and the factory's games, as the
 * web wallet's tests had them: one every 1,800 s, the newest at the latest
 * block's time (block time), each covering 100 DuskEVM blocks more, the
 * covering ones from game 37 on; a game that `resolved` says has resolved
 * did 303,000 s after it was created. The registry the Portal asks says as
 * `proper` and `respected` do.
 *
 * @param {{ proper?: (i: number) => boolean, resolved: (i: number) => boolean, respected?: (i: number) => boolean, updatedAt?: number, registry?: boolean, maxBatch?: number, portal?: Record<string, any>, hub?: Record<string, any>, factory?: Record<string, any> }} options
 */
function walletGames({ factory = {}, hub = {}, maxBatch, portal: portalReads = {}, proper = () => true, registry = true, resolved, respected = () => true, updatedAt = 0 }) {
  const COUNT = 400;
  const tip = { height: 1_000_000n, timestamp: 2_000_000n };
  const created = (/** @type {number} */ i) => 2_000_000 - (COUNT - 1 - i) * 1_800;
  const l2Block = (/** @type {number} */ i) => SENT_AT - 3_668 + 100 * i;
  const proxyOf = (/** @type {number} */ i) => [...Array(18).fill(0x9a), i >> 8, i & 0xff];
  const BLOCK = { hash: `0x${"b1".repeat(32)}`, stateRoot: `0x${"b2".repeat(32)}`, timestamp: "0x1" };
  const STORAGE = `0x${"b3".repeat(32)}`;
  const rootClaim = bytes(outputRoot(BLOCK, STORAGE));
  const chain = fakeChain({
    dgf: {
      findLatestGames: (/** @type {any[]} */ [, start, size]) => {
        const from = indexOf(start);

        return Array.from({ length: Math.min(indexOf(size), from + 1) }, (_, k) => {
          const index = from - k;

          return {
            ["extra_data"]: u256(l2Block(index)),
            index: u256(index),
            metadata: [0, 0, 0, 8, ...u256(created(index)).slice(24), ...proxyOf(index)],
            ["root_claim"]: rootClaim,
            timestamp: created(index),
          };
        });
      },
      gameAtIndex: (/** @type {number[]} */ index) => [8, created(indexOf(index)), proxyOf(indexOf(index))],
      gameContractId: () => Array(32).fill(0xd5),
      gameCount: () => u256(COUNT),
      gameMetadataAtIndex: (/** @type {number[]} */ index) => ({ extraData: [], l2SequenceNumber: u256(l2Block(indexOf(index))), rootClaim }),
      virtualGameHubId: () => Array(32).fill(0xd5),
      ...factory,
    },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: {
      createdAtForGame: (/** @type {number[]} */ a) => BigInt(created(indexOfProxy(a))),
      maxClockDuration: () => 302_400n,
      resolvedAtForGame: (/** @type {number[]} */ a) => (resolved(indexOfProxy(a)) ? BigInt(created(indexOfProxy(a)) + 303_000) : 0n),
      statusForGame: (/** @type {number[]} */ a) => (resolved(indexOfProxy(a)) ? 2 : 0),
      ...hub,
    },
    l2: {
      eth_getBlockByNumber: () => BLOCK,
      eth_getProof: () => ({ storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x01"])] }] }),
      eth_getTransactionReceipt: () => receiptOf(LOG_1008),
    },
    portal: {
      checkWithdrawal: () => undefined,
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(0),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: () => [Array(20).fill(0), 0],
      respectedGameType: () => 8,
      ...portalReads,
    },
    registry: {
      isGameProper: (/** @type {number[]} */ a) => proper(indexOfProxy(a)),
      isGameRespected: (/** @type {number[]} */ a) => respected(indexOfProxy(a)),
      respectedGameTypeUpdatedAt: () => BigInt(updatedAt),
    },
    tip,
  });
  const network = registry ? TESTNET : withoutRegistry();

  return { chain, created, proxyOf, withdrawals: createWithdrawals(withdrawalsOn(chain, { maxBatch, network })) };
}

/** Testnet, its anchor state registry unknown. */
function withoutRegistry() {
  const contracts = { ...TESTNET.duskEvm?.contracts };

  delete contracts.anchor_state_registry;

  return { ...TESTNET, duskEvm: { ...TESTNET.duskEvm, contracts } };
}

/** Games old enough to have resolved, in the wallet's set: their clock ran out, and their resolver's lag passed. */
const OLD = (/** @type {number} */ i) => 2_000_000 - (399 - i) * 1_800 <= 2_000_000 - 302_400 - 3_600;

describe("the game a proof goes against, as the web wallet chose it", withDriver, () => {
  it("is a covering game that has already resolved, so the claim date is exact", async () => {
    const { withdrawals } = walletGames({ resolved: OLD });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    // The newest of them: its clock ran out, and its resolver's lag passed.
    like(prepared.proof, { disputeGameIndex: 229n });
    // Proved now: exactly the maturity from now, a second later on block time.
    assert.deepEqual(prepared.claim, { at: (2_000_000 + 604_800 + 1) * 1_000, exact: true, overdue: false });
    // The proof whose date was shown, with the gas a claim of it gets.
    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(229));
    assert.equal(prepared.call.gasLimit, 51_000_000n);
    like(prepared.call.decoded, { disputeGameIndex: 229n, kind: "prove" });
  });

  it("is a resolved one once the factory names its game type's hub, which isn't kept before (review)", async () => {
    let named = 0;
    const { withdrawals } = walletGames({
      factory: { virtualGameHubId: () => Array(32).fill(named) },
      // No hub at the all-zero contract ID.
      hub: { maxClockDuration: (/** @type {unknown} */ _, /** @type {string} */ id) => (/^0+$/.test(id) ? assert.fail("No such contract") : 302_400n) },
      resolved: OLD,
    });

    // No hub for its type yet: none old enough is found, and the newest covering game is it.
    like((await withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 399n });

    named = 0xd5;

    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    like(prepared.proof, { disputeGameIndex: 229n });
    like(prepared.claim, { exact: true });
  });

  it("is the newest covering game when none has resolved, its date the earliest", async () => {
    const prepared = await walletGames({ resolved: () => false }).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    like(prepared.proof, { disputeGameIndex: 399n });
    like(prepared.claim, { exact: false });
  });

  it("passes over resolved games the Portal wouldn't take: improper or unrespected, as the registry it asks says", async () => {
    const { chain, proxyOf, withdrawals } = walletGames({ proper: (i) => i !== 229, resolved: OLD, respected: (i) => i !== 228 });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    like(prepared.proof, { disputeGameIndex: 227n });
    like(prepared.claim, { exact: true });
    // Asked of each game by its address.
    assert.ok(chain.callsOf("isGameProper").some(({ args }) => hexOf(args) === hexOf(proxyOf(229))));
    assert.ok(chain.callsOf("isGameRespected").some(({ args }) => hexOf(args) === hexOf(proxyOf(228))));
  });

  it("passes over games made at or before the respected game type last changed", async () => {
    const after = walletGames({ resolved: OLD, updatedAt: 2_000_000 - (399 - 229) * 1_800 - 1 });

    like((await after.withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 229n });

    // Made when it changed, or before: none old enough is left.
    const at = walletGames({ resolved: OLD, updatedAt: 2_000_000 - (399 - 229) * 1_800 });

    like((await at.withdrawals.prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 399n });
  });

  it("asks about eight games a query by default, newest first, until one passes", async () => {
    const { chain, withdrawals } = walletGames({ proper: (i) => i < 220, resolved: OLD });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    like(prepared.proof, { disputeGameIndex: 219n });
    // Four reads a game, 32 a query: 229 to 222, then 221 to 214, no more.
    // The web wallet asked the registry about ten a query, without the Portal's blacklist.
    assert.equal(chain.callsOf("isGameProper").length, 16);
    assert.equal(chain.callsOf("disputeGameBlacklist").length, 16);
    assert.equal(chain.callsOf("respectedGameTypeUpdatedAt").length, 1);
  });

  for (const [when, options] of /** @type {const} */ ([
    ["no resolved game passes", { proper: (/** @type {number} */ i) => !OLD(i), resolved: OLD }],
    ["the anchor state registry isn't known", { registry: false, resolved: OLD }],
  ])) {
    it(`is the newest covering game when ${when}, its date the earliest`, async () => {
      const prepared = await walletGames(options).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

      like(prepared.proof, { disputeGameIndex: 399n });
      like(prepared.claim, { exact: false });
    });
  }

  it("still comes when its game's date can't be read, without a date", async () => {
    const { withdrawals } = walletGames({
      hub: {
        createdAtForGame: () => {
          throw new Error("The hub can't be read");
        },
      },
      resolved: () => false,
    });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    // The proof stands on its own; only the date is the game's.
    like(prepared.proof, { disputeGameIndex: 399n });
    assert.equal(prepared.claim, null);
  });
});

/**
 * The fixture's withdrawal, not yet proved, and 200 games of the Portal's
 * type, as the bridge site's tests had them (testnet's height clock): one
 * every 30 minutes up to 10 minutes ago, each covering 100 DuskEVM blocks
 * more from `firstL2`, resolved 15 minutes after its clock ran out where
 * that's passed. Game i sits at factory index i × `stride`: other game
 * types take the indexes between.
 *
 * @param {{ blacklisted?: number[], firstL2: number, registry?: boolean, retired?: number[], stride?: number, unrespected?: number[], updatedAt?: bigint, maxBatch?: number }} options
 */
function bridgeGames({ blacklisted = [], firstL2, maxBatch = 64, registry = true, retired = [], stride = 1, unrespected = [], updatedAt = 0n }) {
  const GAMES = 200;
  const NOW = 10n * TIP.height;
  const createdAtOf = (/** @type {number} */ i) => NOW - 600n - BigInt(GAMES - 1 - i) * 1_800n;
  const proxyOf = (/** @type {number} */ i) => [...Array(18).fill(0x9a), Math.floor(i / 256), i % 256];
  const resolvedOf = (/** @type {number} */ i) => (createdAtOf(i) + 302_400n + 900n <= NOW ? createdAtOf(i) + 302_400n + 900n : 0n);
  const blockOf = (/** @type {number} */ l2) => ({ hash: keccak256(toHex(`block ${l2}`)), stateRoot: keccak256(toHex(`state ${l2}`)) });
  const STORAGE = keccak256(toHex("message passer"));
  const l2Of = (/** @type {number} */ i) => firstL2 + i * 100;
  const searched = (/** @type {number} */ i) => ({
    ["extra_data"]: u256(l2Of(i)),
    index: u256(i * stride),
    metadata: [0, 0, 0, 8, ...u256(createdAtOf(i)).slice(24), ...proxyOf(i)],
    ["root_claim"]: bytes(outputRoot(blockOf(l2Of(i)), STORAGE)),
    timestamp: Number(createdAtOf(i)),
  });
  const gameAt = (/** @type {number} */ index) => Math.floor(index / stride);
  /** @type {number[]} */
  const proofsAt = [];
  const chain = fakeChain({
    dgf: {
      findLatestGames: (/** @type {any[]} */ [, start, n]) => {
        const from = gameAt(indexOf(start));

        return Array.from({ length: Math.max(0, Math.min(indexOf(n), from + 1)) }, (_, k) => searched(from - k));
      },
      gameAtIndex: (/** @type {number[]} */ index) => ({ gameProxy: proxyOf(gameAt(indexOf(index))) }),
      gameContractId: () => Array(32).fill(0xd5),
      gameCount: () => u256((GAMES - 1) * stride + 1),
      gameMetadataAtIndex: (/** @type {number[]} */ index) => {
        const i = gameAt(indexOf(index));

        return { extraData: [], l2SequenceNumber: u256(l2Of(i)), rootClaim: searched(i)["root_claim"] };
      },
      virtualGameHubId: () => Array(32).fill(0xd5),
    },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: {
      createdAtForGame: (/** @type {number[]} */ a) => createdAtOf(indexOfProxy(a)),
      maxClockDuration: () => 302_400n,
      resolvedAtForGame: (/** @type {number[]} */ a) => resolvedOf(indexOfProxy(a)),
      statusForGame: (/** @type {number[]} */ a) => (resolvedOf(indexOfProxy(a)) ? 2 : 0),
    },
    l2: {
      eth_getBlockByNumber: (/** @type {any[]} */ [block]) => blockOf(Number(BigInt(block))),
      eth_getProof: (/** @type {any[]} */ params) => {
        proofsAt.push(Number(BigInt(params[2])));

        return { storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] };
      },
      eth_getTransactionReceipt: () => receiptOf(LOG_1008),
    },
    portal: {
      checkWithdrawal: () => undefined,
      disputeGameBlacklist: (/** @type {number[]} */ a) => blacklisted.includes(indexOfProxy(a)),
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(0),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: () => [Array(20).fill(0), 0],
      respectedGameType: () => 8,
    },
    registry: {
      isGameProper: (/** @type {number[]} */ a) => ![...blacklisted, ...retired].includes(indexOfProxy(a)),
      isGameRespected: (/** @type {number[]} */ a) => !unrespected.includes(indexOfProxy(a)),
      respectedGameTypeUpdatedAt: () => updatedAt,
    },
  });

  return { chain, createdAtOf, proofsAt, withdrawals: createWithdrawals(withdrawalsOn(chain, { maxBatch, network: registry ? TESTNET : withoutRegistry() })) };
}

// The fixture's withdrawal was sent at SENT_AT: games from 7 on cover it
// when they start at OLDER, only the newest 73 when they start at FRESH.
const OLDER = SENT_AT - 668;
const FRESH = SENT_AT - 12_668;

/** @param {number[]} address */
const asked = (/** @type {{ args: number[] }[]} */ calls) => calls.map(({ args }) => indexOfProxy(args));

describe("the game a proof goes against, as the bridge site chose it", withDriver, () => {
  it("is a covering game that has already resolved, so its claim date is exact", async () => {
    // An older withdrawal: games from 7 on cover it, and those up to 29 have resolved.
    const { proofsAt, withdrawals } = bridgeGames({ firstL2: OLDER });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(29));
    assert.deepEqual(proofsAt, [OLDER + 29 * 100]);
    // Exactly the proof's maturity from now: Wed 4 Nov, 03:09:49 UTC.
    assert.deepEqual(prepared.claim, { at: Number(TIP.timestamp + 604_800n) * 1_000, exact: true, overdue: false });
  });

  it("is the newest when none that covers it has resolved, its date an estimate", async () => {
    // A fresh withdrawal: only the newest games cover it, none resolved yet.
    const { proofsAt, withdrawals } = bridgeGames({ firstL2: FRESH });
    const prepared = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(199));
    assert.equal(proofsAt.at(-1), FRESH + 199 * 100);
    // The newest game, created 10 minutes ago, can be final before the proof
    // matures 7 days from now: that date, as an estimate until it resolves.
    assert.deepEqual(prepared.claim, { at: Number(TIP.timestamp + 604_800n) * 1_000, exact: false, overdue: false });
  });

  it("passes over a blacklisted resolved game for the next resolved one", async () => {
    const prepared = await bridgeGames({ blacklisted: [29], firstL2: OLDER }).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(28));
    assert.equal(prepared.claim?.exact, true);
  });

  it("counts the factory's index, which other game types share", async () => {
    // Three games of other types between each of the Portal's type.
    const prepared = await bridgeGames({ firstL2: OLDER, stride: 4 }).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(29 * 4));
    assert.equal(prepared.claim?.exact, true);
  });

  it("passes over resolved games the Portal wouldn't take, and with none it takes, goes against the newest", async () => {
    // Game 29 retired after it resolved, and 28 of a type no longer respected: the next resolved one.
    const passedOver = bridgeGames({ firstL2: OLDER, retired: [29], unrespected: [28] });
    const prepared = await passedOver.withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (prepared.call.args)[1], u256(27));
    assert.equal(prepared.claim?.exact, true);
    assert.ok(asked(passedOver.chain.callsOf("isGameProper")).includes(29));
    assert.ok(asked(passedOver.chain.callsOf("isGameRespected")).includes(28));
    // Four reads a candidate, as many as one query of 64 holds: 16 of the 23 covering games.
    // The bridge site's three, without the Portal's blacklist, took 21.
    assert.deepEqual(asked(passedOver.chain.callsOf("isGameProper")), Array.from({ length: 16 }, (_, k) => 29 - k));

    // Every resolved covering game retired: the newest covering game, as before.
    const newest = await bridgeGames({ firstL2: OLDER, retired: Array.from({ length: 30 }, (_, i) => i) }).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (newest.call.args)[1], u256(199));
    assert.equal(newest.claim?.exact, false);

    // Without the registry, nothing says the Portal would take a resolved game: the newest too.
    const unknown = await bridgeGames({ firstL2: OLDER, registry: false }).withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (unknown.call.args)[1], u256(199));
  });

  it("passes over games created at or before the respected game type last changed", async () => {
    // Changed just after game 28 was created: 29, the newest resolved, is the one.
    const after28 = bridgeGames({ firstL2: OLDER, updatedAt: 10n * TIP.height - 600n - 171n * 1_800n });
    const proved = await after28.withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (proved.call.args)[1], u256(29));
    assert.equal(proved.claim?.exact, true);
    // Read once, with the hub and the newest games.
    assert.equal(after28.chain.callsOf("respectedGameTypeUpdatedAt").length, 1);

    // Changed when game 29 was created: every resolved game is retired, so the newest covering game, as with none.
    const at29 = bridgeGames({ firstL2: OLDER, updatedAt: 10n * TIP.height - 600n - 170n * 1_800n });
    const newest = await at29.withdrawals.prepareProof(TX, { submitter: SUBMITTER });

    assert.deepEqual(/** @type {any[]} */ (newest.call.args)[1], u256(199));
    assert.equal(newest.claim?.exact, false);
    // None of the retired games was asked about: only the newest, which the Portal must take.
    assert.deepEqual(asked(at29.chain.callsOf("isGameProper")), [199]);
  });
});

describe("a proof's call", withDriver, () => {
  it("carries the withdrawal, the game, the output root proof and the storage proof, as the Portal's driver writes them", async () => {
    const { withdrawals } = bridgeGames({ firstL2: OLDER });
    const { call, proof, receipt } = await withdrawals.prepareProof(TX, { submitter: SUBMITTER });
    const [withdrawal, index, rootProof, nodes] = /** @type {any[]} */ (call.args);

    assert.equal(call.contractId, TESTNET.duskEvm?.contracts.optimism_portal.contractId);
    assert.equal(call.fnName, "proveWithdrawalTransaction");
    assert.equal(call.deposit, 0n);
    // The SDK's serialization: the numbers as 32 big-endian bytes, the addresses as 20.
    assert.deepEqual(Object.keys(withdrawal), ["data", "gas_limit", "nonce", "sender", "target", "value"]);
    assert.deepEqual(withdrawal.data.slice(0, 4), [0xd7, 0x64, 0xad, 0x0b]);
    assert.deepEqual([withdrawal.gas_limit.length, withdrawal.nonce.length, withdrawal.sender.length, withdrawal.target.length, withdrawal.value.length], [32, 32, 20, 20, 32]);
    assert.deepEqual(index, u256(29));
    assert.deepEqual(Object.keys(rootProof), ["latest_blockhash", "message_passer_storage_root", "state_root", "version"]);
    assert.deepEqual(rootProof.version, Array(32).fill(0));
    assert.deepEqual(nodes, [bytes(toRlp(["0x20", "0x01"]))]);
    // What Dusk Wallet reads from it: the withdrawal, whom it pays, the game.
    like(call.decoded, { amountWei: 1_008n * 10n ** 18n, disputeGameIndex: 29n, hash: receipt.withdrawalHash, kind: "prove", proofNodes: 1, recipient: { account: PAID, kind: "account" } });
    // The game's root claim is the output's root: of its block and the message passer's storage.
    const { latestBlockhash, messagePasserStorageRoot, stateRoot } = proof.outputRootProof;

    assert.equal(proof.outputRoot, outputRoot({ hash: latestBlockhash, stateRoot }, messagePasserStorageRoot));
    // Sent as the bridge's route expects: no DUSK along, no one paid.
    assert.equal(bridgeEnvelopeOk(call.decoded, { deposit: call.deposit }), true);
  });

  it("asks for the message passer's slot of the withdrawal, and appends a terminal node its last branch embeds", async () => {
    const STORAGE = `0x${"b3".repeat(32)}`;
    const BLOCK = { hash: `0x${"b1".repeat(32)}`, stateRoot: `0x${"b2".repeat(32)}` };
    const withdrawalHash = "0x4b3472cff93e5bbf3231165ad48c0f302cf597c212b7d0e14dc671b49dc4101a";
    const key = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [withdrawalHash, 0n]));
    // A branch node whose 11th item embeds the terminal node for the key's path.
    const terminal = /** @type {[`0x${string}`, `0x${string}`]} */ ([`0x3${keccak256(key).slice(-3)}`, "0xbeef"]);
    const branch = /** @type {any[]} */ (Array(17).fill("0x"));

    branch[10] = terminal;

    for (const embedded of [terminal, toRlp(terminal)]) {
      branch[10] = embedded;

      /** @type {any[][]} */
      const asked = [];
      const chain = fakeChain({
        dgf: {
          findLatestGames: () => [{ index: u256(0) }],
          gameAtIndex: () => ({ gameProxy: Array(20).fill(0x9a) }),
          gameContractId: () => Array(32).fill(0xd5),
          gameCount: () => u256(1),
          gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(SENT_AT), rootClaim: bytes(outputRoot(BLOCK, STORAGE)) }),
          virtualGameHubId: () => Array(32).fill(0xd5),
        },
        drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
        hub: { createdAtForGame: () => 0n, maxClockDuration: () => 302_400n, resolvedAtForGame: () => 0n, statusForGame: () => 0 },
        l2: {
          eth_getBlockByNumber: () => BLOCK,
          eth_getProof: (/** @type {any[]} */ params) => {
            asked.push(params);

            return { storageHash: STORAGE, storageProof: [{ proof: [toRlp(branch)] }] };
          },
          eth_getTransactionReceipt: () => receiptOf(LOG_1008),
        },
        portal: {
          disputeGameBlacklist: () => false,
          disputeGameFinalityDelaySeconds: () => u256(302_400),
          finalizedWithdrawals: () => false,
          numProofSubmitters: () => u256(0),
          proofMaturityDelaySeconds: () => u256(604_800),
          provenWithdrawals: () => [Array(20).fill(0), 0],
          respectedGameType: () => 8,
        },
      });
      const { proof } = await createWithdrawals(withdrawalsOn(chain, { network: withoutRegistry() })).prepareProof(TX, { submitter: SUBMITTER });

      assert.deepEqual(asked[0], ["0x4200000000000000000000000000000000000016", [key], toHex(SENT_AT)]);
      assert.deepEqual(proof.withdrawalProof, [toRlp(branch), toRlp(terminal)]);
    }
  });
});

describe("a proof that isn't prepared", () => {
  /**
   * The fixture's withdrawal, proved by the account (0x2c…) against game
   * 0x1e… unless `provenAt` is 0, and no games to prove against.
   *
   * @param {{ check?: () => unknown, finalized?: boolean, gameStatus?: number, provenAt?: number | bigint, resolvedAt?: bigint, createdAt?: bigint }} options
   */
  const proved = ({ check = () => undefined, createdAt = 46_876_050n, finalized = false, gameStatus = 0, provenAt = 46_877_440n, resolvedAt = 0n } = {}) => {
    const chain = fakeChain({
      dgf: { gameContractId: () => Array(32).fill(0xd5), gameCount: () => u256(0), virtualGameHubId: () => Array(32).fill(0xd5) },
      drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
      hub: { createdAtForGame: () => createdAt, maxClockDuration: () => 302_400n, resolvedAtForGame: () => resolvedAt, statusForGame: () => gameStatus },
      l2: { eth_getTransactionReceipt: () => receiptOf(LOG_1008) },
      portal: {
        checkWithdrawal: check,
        disputeGameBlacklist: () => false,
        disputeGameFinalityDelaySeconds: () => u256(302_400),
        finalizedWithdrawals: () => finalized,
        numProofSubmitters: () => u256(provenAt ? 1 : 0),
        proofMaturityDelaySeconds: () => u256(604_800),
        provenWithdrawals: () => (provenAt ? [Array(20).fill(0x1e), provenAt] : [Array(20).fill(0), 0]),
        respectedGameType: () => 8,
      },
      registry: { isGameProper: () => true, isGameRespected: () => true, respectedGameTypeUpdatedAt: () => 0n },
    });

    return { chain, withdrawals: createWithdrawals(withdrawalsOn(chain)) };
  };
  const invalid = () => {
    throw new Error("OptimismPortal2: invalid dispute game");
  };

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

  it("is one this account has already: ready to claim, still waiting, or rejected with no newer game", async () => {
    const claimable = { createdAt: 45_250_000n, gameStatus: 2, provenAt: 45_252_320n, resolvedAt: 45_555_010n };

    await refused(proved(claimable).withdrawals.prepareProof(TX, { submitter: SUBMITTER }), "proven", { stage: "ready_to_finalize" });
    await refused(proved({ check: invalid }).withdrawals.prepareProof(TX, { submitter: SUBMITTER }), "proven", { reason: "game-in-progress", stage: "proven_waiting" });
    await refused(proved({ check: invalid, gameStatus: 1 }).withdrawals.prepareProof(TX, { submitter: SUBMITTER }), "proven", {
      proofRejected: true,
      reason: "proof-rejected",
      stage: "proven_waiting",
    });
  });

  it("is one of a claimed withdrawal", async () => {
    await refused(proved({ finalized: true }).withdrawals.prepareProof(TX, { submitter: SUBMITTER }), "claimed", { stage: "finalized" });
  });

  it("is one no game covers yet: it goes on to look, and says why it waits", async () => {
    await assert.rejects(proved({ provenAt: 0 }).withdrawals.prepareProof(TX, { submitter: SUBMITTER }), (error) => {
      assert.ok(error instanceof WithdrawalError);
      assert.deepEqual([error.code, error.reason], ["no-proof", "no-games"]);

      return true;
    });
  });

  it("is one whose claim would need more gas than the bound: refused before any read on Dusk", async () => {
    const { chain, withdrawals } = proved({ provenAt: 0 });

    await refused(withdrawals.prepareProof(TX, { gasLimitUpper: 50_000_000n, submitter: SUBMITTER }), "gas");
    assert.deepEqual(chain.calls, []);
  });

  it("is for the account it's prepared for, and needs one", async () => {
    const other = `0x${"3d".repeat(20)}`;
    const { chain, withdrawals } = proved({ provenAt: 0 });

    await withdrawals.prepareProof(TX, { submitter: other }).catch(() => {});
    assert.deepEqual([...new Set(chain.callsOf("provenWithdrawals").map(({ args }) => hexOf(args[1])))], [other]);
    await assert.rejects(withdrawals.prepareProof(TX, /** @type {any} */ ({})), TypeError);
    await assert.rejects(withdrawals.prepareProof(TX, { submitter: "not an account" }), TypeError);
  });

  it("is one whose driver writes another valid call: another game, output root proof, proof node, or withdrawal", withDriver, async () => {
    /** @type {Record<string, (args: any[]) => void>} */
    const tamper = {
      // A byte of the relay's own gas, which no fact Dusk Wallet shows carries: only the hash tells.
      data: (args) => {
        args[0].data[4 + 159] ^= 1;
      },
      game: (args) => {
        args[1] = u256(30);
      },
      nonce: (args) => {
        args[0].nonce[31] ^= 1;
      },
      node: (args) => {
        args[3][0][1] ^= 1;
      },
      // A node more than the proof has: those it has read the same.
      nodes: (args) => {
        args[3].push([0xc0]);
      },
      root: (args) => {
        args[2].state_root[0] ^= 1;
      },
    };

    for (const [what, change] of Object.entries(tamper)) {
      const games = bridgeGames({ firstL2: OLDER });
      const lying = {
        ...jsonDriver(portal),
        /** @param {string} fn @param {string} json */
        encodeInputFn: (fn, json) => {
          if (fn !== "proveWithdrawalTransaction") return jsonDriver().encodeInputFn(fn, json);

          const args = JSON.parse(json);

          change(args);

          return portal.encodeInputFn(fn, JSON.stringify(args));
        },
      };
      const withdrawals = createWithdrawals(withdrawalsOn(games.chain, { drivers: { disputeGameFactory: jsonDriver(), optimismPortal: lying }, maxBatch: 64 }));

      await assert.rejects(withdrawals.prepareProof(TX, { submitter: SUBMITTER }), { code: "bad-call" }, what);
    }
  });

  it("is one whose driver writes another call than the one it was built as", withDriver, async () => {
    // A driver that encodes some other withdrawal: nothing is handed over to sign.
    const games = bridgeGames({ firstL2: OLDER });
    const swapped = {
      ...jsonDriver(portal),
      /** @param {string} fn @param {string} json */
      encodeInputFn: (fn, json) =>
        fn === "proveWithdrawalTransaction"
          ? portal.encodeInputFn(fn, json.replace(/"value":\[(\d+,){31}\d+\]/, `"value":[${u256(1n).join(",")}]`))
          : jsonDriver().encodeInputFn(fn, json),
    };
    const withdrawals = createWithdrawals(withdrawalsOn(games.chain, { drivers: { disputeGameFactory: jsonDriver(), optimismPortal: swapped }, maxBatch: 64 }));

    await refused(withdrawals.prepareProof(TX, { submitter: SUBMITTER }), "bad-call");
  });
});
