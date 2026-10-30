// Where the web wallet and the bridge site differed, the rule the package
// takes, one test each. Each would fail with the other app's rule.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { encodeAbiParameters, keccak256, toRlp } from "viem";

import { WithdrawalError, createWithdrawals, withdrawalCall } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import { DRIVERS_MISSING, LOG_1008, LOG_OFF_ROUTE, PAID, TIP, TX, USER2, bytes, fakeChain, hexOf, jsonDriver, pinnedDriver, receiptOf, u256, withdrawalsOn } from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;

const portal = await pinnedDriver("optimismPortal");
/** What builds a call needs the Portal's pinned driver. */
const withDriver = { skip: portal ? false : DRIVERS_MISSING };

/** DuskEVM's block every game's output is of, and its root: the games' root claim. */
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
const SENT = Number(BigInt(LOG_1008.blockNumber));
const L2 = {
  eth_getBlockByNumber: () => BLOCK,
  eth_getProof: () => ({ storageHash: STORAGE, storageProof: [{ proof: [toRlp(["0x20", "0x01"])] }] }),
};

/**
 * The fixture's withdrawal: proved by the account (0x2c…) against game
 * 0x1e… unless `provenAt` is 0, claimable now by default; a game to prove
 * against when `games` says so. The registry calls every game proper and
 * respected.
 *
 * @param {{ provenAt?: number | bigint, check?: () => unknown, finalized?: boolean, log?: any, tip?: any, games?: boolean, portal?: Record<string, any> }} [options]
 */
function chainOf({ check = () => undefined, finalized = false, games = false, log = LOG_1008, portal: portalReads = {}, provenAt = 45_252_320n, tip = TIP } = {}) {
  return fakeChain({
    dgf: {
      findLatestGames: () => (games ? [{ index: u256(1) }] : []),
      gameAtIndex: () => ({ gameProxy: Array(20).fill(0x9a) }),
      gameContractId: () => Array(32).fill(0xd5),
      gameCount: () => u256(games ? 2 : 0),
      gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(SENT), rootClaim: ROOT }),
      virtualGameHubId: () => Array(32).fill(0xd5),
    },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: { createdAtForGame: () => 45_250_000n, maxClockDuration: () => 302_400n, resolvedAtForGame: () => 45_555_010n, statusForGame: () => 2 },
    l2: { ...L2, eth_getTransactionReceipt: () => receiptOf(log) },
    portal: {
      checkWithdrawal: check,
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => finalized,
      numProofSubmitters: () => u256(provenAt ? 1 : 0),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: () => (provenAt ? [Array(20).fill(0x1e), provenAt] : [Array(20).fill(0), 0]),
      respectedGameType: () => 8,
      ...portalReads,
    },
    registry: { isGameProper: () => true, isGameRespected: () => true },
    tip,
  });
}

/**
 * @param {Promise<unknown>} promise
 * @param {string} code
 */
const refused = (promise, code) =>
  assert.rejects(promise, (error) => {
    assert.ok(error instanceof WithdrawalError, String(error));
    assert.equal(error.code, code);

    return true;
  });

describe("where the apps differed", () => {
  it("1. a withdrawal to anything but Dusk's messenger is refused, for its status, its proof and its claim (the bridge site's rule)", async () => {
    // The web wallet followed, proved and claimed any MessagePassed.
    const withdrawals = createWithdrawals(withdrawalsOn(chainOf({ log: LOG_OFF_ROUTE })));

    await refused(withdrawals.status(LOG_OFF_ROUTE.transactionHash, { submitter: SUBMITTER }), "not-a-withdrawal");
    await refused(withdrawals.prepareProof(LOG_OFF_ROUTE.transactionHash, { submitter: SUBMITTER }), "not-a-withdrawal");
    await refused(withdrawals.claimCall(LOG_OFF_ROUTE.transactionHash, { submitter: SUBMITTER }), "not-a-withdrawal");
  });

  it("2. a proof isn't prepared for a claimed withdrawal, nor again over the account's standing proof (the bridge site's rule)", withDriver, async () => {
    // The web wallet prepared one either way; only its screen held it back.
    await refused(createWithdrawals(withdrawalsOn(chainOf({ finalized: true, games: true }))).prepareProof(TX, { submitter: SUBMITTER }), "claimed");
    await refused(createWithdrawals(withdrawalsOn(chainOf({ games: true }))).prepareProof(TX, { submitter: SUBMITTER }), "proven");
    // Not proved: it is.
    like((await createWithdrawals(withdrawalsOn(chainOf({ games: true, provenAt: 0 }))).prepareProof(TX, { submitter: SUBMITTER })).proof, { disputeGameIndex: 1n });
  });

  it("3. without Dusk's latest block, a proved withdrawal's status fails, and no claim is built (the bridge site's rule)", async () => {
    // The web wallet counted the Portal's yes: ready to claim, with no date checked.
    const tip = () => {
      throw new Error("The node can't be read");
    };
    const withdrawals = createWithdrawals(withdrawalsOn(chainOf({ tip })));

    await assert.rejects(withdrawals.status(TX, { submitter: SUBMITTER }), /The node can't be read/);
    await assert.rejects(withdrawals.claimCall(TX, { submitter: SUBMITTER }), /The node can't be read/);
  });

  it("4. the games checked a query follow the app's batch, and the game chosen doesn't (the web wallet's 32, the bridge site's 64)", withDriver, async () => {
    // Forty resolved games, those newer than 26 improper. Each game checked
    // takes four reads: the web wallet's 10 and the bridge site's 21 a query
    // took three, without the Portal's blacklist.
    /** @type {bigint[]} */
    const chosen = [];

    for (const [maxBatch, perQuery] of [
      [32, 8],
      [64, 16],
    ]) {
      const chain = gamesChain();
      const prepared = await createWithdrawals(withdrawalsOn(chain, { maxBatch })).prepareProof(TX, { submitter: SUBMITTER });

      chosen.push(prepared.proof.disputeGameIndex);
      assert.equal(chain.queries.find((names) => names.includes("isGameProper"))?.filter((name) => name === "isGameProper").length, perQuery, String(maxBatch));
    }

    assert.deepEqual(chosen, [26n, 26n]);
  });

  it("5. a status says whether another account holds a standing proof, and when this one proved (the bridge site's)", async () => {
    const OTHER = `0x${"3d".repeat(20)}`;
    const chain = chainOf({
      games: true,
      portal: {
        checkWithdrawal: () => undefined,
        numProofSubmitters: () => u256(1),
        proofSubmitters: () => Array.from(Buffer.from(OTHER.slice(2), "hex")),
        provenWithdrawals: (/** @type {any[]} */ [, who]) => (hexOf(who) === OTHER ? [Array(20).fill(0x4f), 46_877_440] : [Array(20).fill(0), 0]),
      },
      provenAt: 0,
    });

    like(await createWithdrawals(withdrawalsOn(chain)).status(TX, { submitter: SUBMITTER }), { provenByOther: true, stage: "ready_to_prove" });
    // The web wallet's status said neither.
    const proved = await createWithdrawals(withdrawalsOn(chainOf())).status(TX, { submitter: SUBMITTER });

    assert.equal(proved.provenAt, TIP.timestamp + 45_252_320n - 10n * TIP.height);
  });

  it("6. a status reads the recipient's own proof when no account is given; a proof or a claim is only ever for the account given", async () => {
    // The bridge site fell back to the connected account, then the recipient's,
    // for its calls too; the web wallet always used its own account.
    const chain = chainOf();
    const status = await createWithdrawals(withdrawalsOn(chain)).status(TX);

    assert.equal(hexOf(chain.callsOf("provenWithdrawals")[0].args[1]), status.proofSubmitter);
    await assert.rejects(createWithdrawals(withdrawalsOn(chainOf())).claimCall(TX, /** @type {any} */ ({})), TypeError);
    await assert.rejects(createWithdrawals(withdrawalsOn(chainOf({ games: true, provenAt: 0 }))).prepareProof(TX, /** @type {any} */ ({})), TypeError);
  });

  it("7. a proof that would need more gas than the bound is refused before the games are read (the bridge site's rule)", async () => {
    // The web wallet found the proof first, and refused it as it sent it.
    const chain = chainOf({ games: true, provenAt: 0 });

    await refused(createWithdrawals(withdrawalsOn(chain)).prepareProof(TX, { gasLimitUpper: 50_000_000n, submitter: SUBMITTER }), "gas");
    assert.deepEqual(chain.calls, []);
  });

  it("8. a call the driver encodes is read back before it's handed over, and refused when it says anything else (neither app did)", withDriver, async () => {
    // A driver that writes the claim of another amount.
    const lying = {
      ...jsonDriver(portal),
      /** @param {string} fn @param {string} json */
      encodeInputFn: (fn, json) =>
        fn === "finalizeWithdrawalTransaction" ? portal.encodeInputFn(fn, json.replace(/"value":\[(\d+,){31}\d+\]/, `"value":[${u256(1n).join(",")}]`)) : jsonDriver().encodeInputFn(fn, json),
    };
    const chain = chainOf();

    await refused(createWithdrawals(withdrawalsOn(chain, { drivers: { disputeGameFactory: jsonDriver(), optimismPortal: lying } })).claimCall(TX, { submitter: SUBMITTER }), "bad-call");
  });

  it("9. a read the node answers busy is sent again, twice at most (the bridge site's node client)", async () => {
    // The web wallet's reads failed at once.
    let busy = 2;
    const chain = chainOf({ check: () => undefined });
    const fetch = (/** @type {string} */ url, /** @type {any} */ init) =>
      url.endsWith("/finalizedWithdrawals") && busy-- > 0 ? Promise.resolve(new Response("", { status: 429 })) : chain.fetch(url, init);

    like(await createWithdrawals(withdrawalsOn(chain, { fetch })).status(TX, { submitter: SUBMITTER }), { stage: "ready_to_finalize" });
  });

  it("10. a sender whose address has its checksum wrong is refused for a start (both apps took it in lower case)", () => {
    assert.throws(() => withdrawalCall(2, { amountWei: 10n ** 18n, sender: "0xC11d5aAb4234E255E214aC6e8c0ad61FA0836473", to: USER2 }), TypeError);
    assert.equal(withdrawalCall(2, { amountWei: 10n ** 18n, sender: "0xc11d5aab4234e255e214ac6e8c0ad61fa0836473", to: PAID }).value, 10n ** 18n);
  });

  it("11. a proof isn't prepared without the Portal's delays, which come with whether it's claimed or proved (the bridge site's rule)", async () => {
    // The web wallet read the delays apart, and prepared the proof without a date.
    const chain = chainOf({
      games: true,
      portal: {
        proofMaturityDelaySeconds: () => {
          throw new Error("The Portal can't be read");
        },
      },
      provenAt: 0,
    });

    await assert.rejects(createWithdrawals(withdrawalsOn(chain)).prepareProof(TX, { submitter: SUBMITTER }), /The Portal can't be read/);
  });
});

/**
 * Forty games of the Portal's type, created and resolved long before the
 * latest block, each covering the withdrawal; the registry calls those
 * newer than game 26 improper, so 26 is the one, in whichever batch it's
 * checked.
 */
function gamesChain() {
  const NOW = 10n * TIP.height;
  const created = (/** @type {number} */ i) => NOW - 400_000n - BigInt(39 - i) * 1_800n;
  const proxy = (/** @type {number} */ i) => [...Array(19).fill(0x9a), i];
  const indexOf = (/** @type {number[]} */ index) => Number(BigInt(hexOf(index)));

  return fakeChain({
    dgf: {
      findLatestGames: (/** @type {any[]} */ [, start, n]) =>
        Array.from({ length: Math.max(0, Math.min(indexOf(n), indexOf(start) + 1)) }, (_, k) => {
          const i = indexOf(start) - k;

          return { ["extra_data"]: u256(SENT), index: u256(i), metadata: [0, 0, 0, 8, ...u256(created(i)).slice(24), ...proxy(i)], ["root_claim"]: ROOT, timestamp: Number(created(i)) };
        }),
      gameAtIndex: (/** @type {number[]} */ index) => ({ gameProxy: proxy(indexOf(index)) }),
      gameContractId: () => Array(32).fill(0xd5),
      gameCount: () => u256(40),
      gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(SENT), rootClaim: ROOT }),
      virtualGameHubId: () => Array(32).fill(0xd5),
    },
    drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver(portal) },
    hub: {
      createdAtForGame: (/** @type {number[]} */ a) => created(a[19]),
      maxClockDuration: () => 302_400n,
      resolvedAtForGame: (/** @type {number[]} */ a) => created(a[19]) + 303_000n,
      statusForGame: () => 2,
    },
    l2: { ...L2, eth_getTransactionReceipt: () => receiptOf(LOG_1008) },
    portal: {
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(0),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: () => [Array(20).fill(0), 0],
      respectedGameType: () => 8,
    },
    registry: {
      isGameProper: (/** @type {number[]} */ a) => a[19] <= 26,
      isGameRespected: () => true,
      respectedGameTypeUpdatedAt: () => 0n,
    },
  });
}
