import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { createWithdrawals } from "../src/duskevm-withdrawals.js";
import { like } from "./fixtures/helpers.js";
import { FACTORY, HUB, LOG_1008, NODE, PORTAL, TESTNET, TIP, TX, fakeChain, hexOf, jsonDriver, receiptOf, u256, withdrawalsOn } from "./fixtures/withdrawals.js";

const SUBMITTER = `0x${"2c".repeat(20)}`;

/**
 * The fixture's withdrawal, proved by the account (0x2c…) against game
 * 0x6f…, waiting for its game, which the registry calls proper and
 * respected; its reads as `portal`, `dgf`, `hub` and `registry` add.
 *
 * @param {{ portal?: Record<string, any>, dgf?: Record<string, any>, hub?: Record<string, any>, registry?: Record<string, any>, tip?: any }} [more]
 */
function waiting({ dgf = {}, hub = {}, portal = {}, registry = {}, tip = TIP } = {}) {
  return fakeChain({
    dgf: { gameContractId: () => Array(32).fill(0xd5), gameCount: () => u256(3_948), virtualGameHubId: () => Array(32).fill(0xd5), ...dgf },
    hub: { createdAtForGame: () => 46_876_050n, maxClockDuration: () => 302_400n, resolvedAtForGame: () => 0n, statusForGame: () => 0, ...hub },
    l2: { eth_getTransactionReceipt: () => receiptOf(LOG_1008) },
    portal: {
      checkWithdrawal: () => {
        throw new Error("Panic: OptimismPortal2: invalid dispute game");
      },
      disputeGameBlacklist: () => false,
      disputeGameFinalityDelaySeconds: () => u256(302_400),
      finalizedWithdrawals: () => false,
      numProofSubmitters: () => u256(1),
      proofMaturityDelaySeconds: () => u256(604_800),
      provenWithdrawals: () => [Array(20).fill(0x6f), 46_877_440],
      respectedGameType: () => 8,
      ...portal,
    },
    registry: { isGameProper: () => true, isGameRespected: () => true, ...registry },
    tip,
  });
}

describe("the bridge's reads on Dusk, in queries", () => {
  it("check a waiting withdrawal in one query once its game's hub is known", async () => {
    const chain = waiting();
    const withdrawals = createWithdrawals(withdrawalsOn(chain));
    const first = await withdrawals.status(TX, { submitter: SUBMITTER });

    like(first, { readyAt: BigInt(Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000), stage: "proven_waiting" });
    // The Portal's values; the game's hub, with the Portal's two and the registry's two that don't wait for it; then the game.
    assert.deepEqual(chain.queries, [
      ["finalizedWithdrawals", "numProofSubmitters", "provenWithdrawals", "proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds", "respectedGameType", "gameCount"],
      ["disputeGameBlacklist", "checkWithdrawal", "isGameProper", "isGameRespected", "gameContractId"],
      ["createdAtForGame", "resolvedAtForGame", "statusForGame", "maxClockDuration"],
    ]);

    chain.queries.length = 0;

    // Every check after: the game's reads with the Portal's, in one query.
    like(await withdrawals.status(TX, { proofGame: first.disputeGameProxy, submitter: SUBMITTER }), { readyAt: first.readyAt });
    assert.deepEqual(chain.queries, [
      [
        "createdAtForGame",
        "resolvedAtForGame",
        "statusForGame",
        "disputeGameBlacklist",
        "checkWithdrawal",
        "isGameProper",
        "isGameRespected",
        "finalizedWithdrawals",
        "numProofSubmitters",
        "provenWithdrawals",
        "proofMaturityDelaySeconds",
        "disputeGameFinalityDelaySeconds",
        "respectedGameType",
        "gameCount",
      ],
    ]);
    // The latest block, once a check: the first after the Portal's values, the next beside them.
    assert.equal(chain.counts.tips, 2);
  });

  it("read a claimed withdrawal's status in one query", async () => {
    const chain = waiting({ portal: { finalizedWithdrawals: () => true } });

    like(await createWithdrawals(withdrawalsOn(chain)).status(TX, { submitter: SUBMITTER }), { stage: "finalized" });
    assert.deepEqual(chain.queries.map((names) => names.length), [7]);
    assert.equal(chain.counts.tips, 0);
  });

  it("read the History's claim dates with each proof's game, whether it was blacklisted and the registry's word on it, in one query", async () => {
    const chain = waiting();
    const hash = /** @type {`0x${string}`} */ (`0x${"ec".repeat(32)}`);
    const claims = await createWithdrawals(withdrawalsOn(chain)).claims([hash], { submitter: SUBMITTER });

    like(claims.get(hash), { at: Date.UTC(2026, 10, 2, 3, 20, 39), reprove: false });
    // The Portal's record, then the game's hub, then the game with its blacklisting and the registry's two.
    assert.deepEqual(chain.queries, [
      ["proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds", "finalizedWithdrawals", "provenWithdrawals", "checkWithdrawal"],
      ["gameContractId"],
      ["createdAtForGame", "resolvedAtForGame", "statusForGame", "maxClockDuration", "disputeGameBlacklist", "isGameProper", "isGameRespected"],
    ]);
  });

  it("go to the node's contracts, as the app's fetch sends them, and carry a refusal's own words", async () => {
    /** @type {any[]} */
    const sent = [];
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
      sent.push([url, init.method, init.headers["Content-Type"]]);

      return url.endsWith("/finalizedWithdrawals") ? new Response("Panic: paused", { status: 500 }) : new Response("null");
    };
    const withdrawals = createWithdrawals({
      drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() },
      duskEvm: { request: async () => receiptOf(LOG_1008) },
      fetch: /** @type {any} */ (fetch),
      network: TESTNET,
      nodeUrl: `${NODE}/`,
    });

    await assert.rejects(withdrawals.status(TX, { submitter: SUBMITTER }), { message: "Panic: paused" });
    assert.deepEqual(sent[0], [`${NODE}/on/contracts:${PORTAL}/finalizedWithdrawals`, "POST", "application/octet-stream"]);
    assert.ok(sent.some(([url]) => url === `${NODE}/on/contracts:${FACTORY}/gameCount`));
  });

  it("are sent again, twice at most, when the node is busy", async () => {
    let busy = 2;
    /** @type {string[]} */
    const asked = [];
    const fetch = async (/** @type {string} */ url) => {
      asked.push(url.split("/").pop() ?? "");

      if (url.endsWith("/gameCount") && busy > 0) {
        busy -= 1;

        return new Response("", { status: 503 });
      }

      return new Response(url.endsWith("/gameCount") ? JSON.stringify(u256(0)) : url.endsWith("/respectedGameType") ? "8" : JSON.stringify(u256(1)));
    };
    const withdrawals = createWithdrawals({
      drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() },
      fetch: /** @type {any} */ (fetch),
      network: TESTNET,
      nodeUrl: NODE,
    });

    assert.deepEqual(await withdrawals.timing(), { finalitySeconds: 1, maturitySeconds: 1, outputSeconds: null });
    assert.equal(asked.filter((fn) => fn === "gameCount").length, 3);

    // A third time busy: it fails, with the status.
    busy = 3;
    await assert.rejects(withdrawals.timing(), /gameCount read failed with HTTP 503/);
  });
});

describe("what a deployment doesn't change", () => {
  it("is read once: each game's hub, each type's hub, each hub's clock, kept in the app's cache", async () => {
    const chain = waiting();
    /** @type {Map<string, string>} */
    const cache = new Map();
    const withdrawals = createWithdrawals(withdrawalsOn(chain, { cache }));

    await withdrawals.status(TX, { submitter: SUBMITTER });
    await withdrawals.status(TX, { submitter: SUBMITTER });

    assert.equal(chain.callsOf("gameContractId").length, 1);
    assert.equal(chain.callsOf("maxClockDuration").length, 1);
    assert.deepEqual(
      [...cache].sort(),
      [
        [`clock:${HUB}`, "302400"],
        [`hub:${FACTORY}:0x${"6f".repeat(20)}`, HUB],
      ]
    );

    // Another object with the same cache reads neither again.
    const other = waiting();

    await createWithdrawals(withdrawalsOn(other, { cache })).status(TX, { submitter: SUBMITTER });
    assert.deepEqual(other.callsOf("gameContractId"), []);
    assert.deepEqual(other.callsOf("maxClockDuration"), []);
  });

  it("is read again after a read of it failed, and a hub that isn't a contract ID is none", async () => {
    let fails = 1;
    const chain = waiting({
      dgf: {
        gameContractId: () => {
          if (fails-- > 0) throw new Error("Offline");

          return Array(32).fill(0xd5);
        },
      },
    });
    const withdrawals = createWithdrawals(withdrawalsOn(chain));

    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { reason: "game-unreadable" });
    like(await withdrawals.status(TX, { submitter: SUBMITTER }), { reason: "game-in-progress" });
    assert.equal(chain.callsOf("gameContractId").length, 2);

    const short = waiting({ dgf: { gameContractId: () => [1, 2, 3] } });

    like(await createWithdrawals(withdrawalsOn(short)).status(TX, { submitter: SUBMITTER }), { reason: "game-unreadable" });
  });
});

describe("a game's hub and the anchor state registry, read raw", () => {
  it("take a game's address and give a u64, little-endian, or the game's status byte", async () => {
    // maxClockDuration on testnet: 302,400 s, as the hub answered.
    const chain = waiting({ hub: { maxClockDuration: () => Uint8Array.of(0x40, 0x9d, 0x04, 0, 0, 0, 0, 0) } });

    like(await createWithdrawals(withdrawalsOn(chain)).status(TX, { submitter: SUBMITTER }), { readyAt: BigInt(Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000) });
    assert.deepEqual(chain.callsOf("createdAtForGame")[0].args, Array(20).fill(0x6f));
    assert.deepEqual(chain.callsOf("maxClockDuration")[0].args, []);

    // A u64 that isn't 8 bytes, or no status byte: the game can't be read.
    for (const hub of [{ resolvedAtForGame: () => new Uint8Array(4) }, { statusForGame: () => new Uint8Array(0) }]) {
      like(await createWithdrawals(withdrawalsOn(waiting({ hub }))).status(TX, { submitter: SUBMITTER }), { reason: "game-unreadable" });
    }
  });

  it("is asked only where the network's file names it, and gives yes, no, or nothing it can be read as", async () => {
    // As testnet's registry answered on 28 Oct 2026: set at height 3,907,068.
    const updatedAt = Uint8Array.of(0xd8, 0x2b, 0x54, 0x02, 0, 0, 0, 0);
    const SENT = Number(BigInt(LOG_1008.blockNumber));
    const games = (/** @type {Record<string, any>} */ registry, network = TESTNET) => {
      const BLOCK = { hash: `0x${"b1".repeat(32)}`, stateRoot: `0x${"b2".repeat(32)}` };
      const chain = waiting({
        dgf: {
          findLatestGames: (/** @type {any[]} */ [, start]) =>
            Array.from({ length: 2 }, (_, k) => ({
              ["extra_data"]: u256(SENT + 100),
              index: u256(Number(BigInt(hexOf(start))) - k),
              metadata: [0, 0, 0, 8, ...Array(8).fill(0), ...Array(20).fill(0x9a - k)],
              ["root_claim"]: Array(32).fill(0),
              // Created after the respected game type was set.
              timestamp: 39_080_000,
            })),
          gameAtIndex: () => ({ gameProxy: Array(20).fill(0x9a) }),
          gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(SENT + 100), rootClaim: Array(32).fill(0) }),
        },
        portal: { numProofSubmitters: () => u256(0), provenWithdrawals: () => [Array(20).fill(0), 0] },
        registry,
      });

      return { chain, withdrawals: createWithdrawals(withdrawalsOn(chain, { duskEvm: { request: async ({ method }) => (method === "eth_getTransactionReceipt" ? receiptOf(LOG_1008) : method === "eth_getBlockByNumber" ? BLOCK : { storageHash: `0x${"b3".repeat(32)}`, storageProof: [{ proof: ["0xc20120"] }] }) }, network })) };
    };
    // The registry answered a byte that is neither: the game isn't taken, and nothing breaks.
    const odd = games({ isGameProper: () => Uint8Array.of(2), isGameRespected: () => true, respectedGameTypeUpdatedAt: () => updatedAt });

    await odd.withdrawals.prepareProof(TX, { submitter: SUBMITTER }).catch(() => {});
    assert.ok(odd.chain.callsOf("respectedGameTypeUpdatedAt").length === 1);
    assert.deepEqual(odd.chain.callsOf("respectedGameTypeUpdatedAt")[0].args, []);
    assert.ok(odd.chain.callsOf("isGameProper").length > 0);

    // A network whose file names no registry: it isn't asked.
    const contracts = { ...TESTNET.duskEvm?.contracts };

    delete contracts.anchor_state_registry;

    const none = games({}, /** @type {any} */ ({ ...TESTNET, duskEvm: { ...TESTNET.duskEvm, contracts } }));

    await none.withdrawals.prepareProof(TX, { submitter: SUBMITTER }).catch(() => {});
    assert.deepEqual(none.chain.callsOf("respectedGameTypeUpdatedAt"), []);
    assert.deepEqual(none.chain.callsOf("isGameProper"), []);
  });
});

describe("the withdrawals of a network", () => {
  it("are the network's file's: its Portal, its factory and its registry; none without DuskEVM", () => {
    assert.throws(() => createWithdrawals({ drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() }, network: networks.mainnet, nodeUrl: NODE }), TypeError);
    assert.throws(() => createWithdrawals({ drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() }, network: 99, nodeUrl: NODE }), TypeError);
    assert.throws(() => createWithdrawals({ drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() }, network: 2, nodeUrl: "testnet" }), TypeError);
    assert.throws(() => createWithdrawals(/** @type {any} */ ({ drivers: { optimismPortal: jsonDriver() }, network: 2, nodeUrl: NODE })), TypeError);
    assert.equal(createWithdrawals({ drivers: { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() }, network: "dusk:2", nodeUrl: NODE }).network, TESTNET);
  });

  it("load each driver once, before any read, and again after one failed to load", async () => {
    let loads = 0;
    let fail = true;
    const portal = () => {
      loads += 1;

      if (fail) return Promise.reject(new Error("The driver isn't there"));

      return jsonDriver();
    };
    const chain = waiting();
    const withdrawals = createWithdrawals(withdrawalsOn(chain, { drivers: { disputeGameFactory: Promise.resolve(jsonDriver()), optimismPortal: portal } }));

    await assert.rejects(withdrawals.status(TX, { submitter: SUBMITTER }), /The driver isn't there/);
    assert.deepEqual(chain.calls, []);

    fail = false;
    await withdrawals.status(TX, { submitter: SUBMITTER });
    await withdrawals.status(TX, { submitter: SUBMITTER });
    assert.equal(loads, 2);
    await assert.rejects(
      createWithdrawals(withdrawalsOn(waiting(), { drivers: { disputeGameFactory: jsonDriver(), optimismPortal: /** @type {any} */ ({}) } })).status(TX),
      TypeError
    );
  });

  it("read Dusk's latest block from the node's GraphQL when the app passes none", async () => {
    /** @type {any[]} */
    const asked = [];
    const chain = waiting();
    const fetch = async (/** @type {string} */ url, /** @type {any} */ init) => {
      if (url.endsWith("/on/graphql/query")) {
        asked.push([url, init.body]);

        return new Response(JSON.stringify({ block: { header: { height: 4_704_959, timestamp: 1_793_156_989 } } }));
      }

      return chain.fetch(url, init);
    };
    const { latestBlock, ...rest } = withdrawalsOn(chain);
    const status = await createWithdrawals({ ...rest, fetch: /** @type {any} */ (fetch) }).status(TX, { submitter: SUBMITTER });

    like(status, { readyAt: BigInt(Date.UTC(2026, 10, 2, 3, 20, 39) / 1_000) });
    assert.deepEqual(asked, [[`${NODE}/on/graphql/query`, "query { block(height: -1) { header { height timestamp } } }"]]);
    assert.equal(typeof latestBlock, "function");
  });

  it("look among the newest 64 games for a proof, or as many as asked", async () => {
    for (const [depth, pages] of /** @type {const} */ ([
      [undefined, 2],
      [0, 2],
      ["not-a-number", 2],
      [32, 1],
      [128, 4],
    ])) {
      const chain = waiting({
        dgf: { findLatestGames: (/** @type {any[]} */ [, start, n]) => Array.from({ length: Number(BigInt(hexOf(n))) }, (_, k) => ({ index: u256(Number(BigInt(hexOf(start))) - k) })), gameMetadataAtIndex: () => ({ extraData: [], l2SequenceNumber: u256(0), rootClaim: Array(32).fill(0) }) },
        portal: { numProofSubmitters: () => u256(0), provenWithdrawals: () => [Array(20).fill(0), 0] },
      });

      await createWithdrawals(withdrawalsOn(chain, { gameSearchDepth: depth })).status(TX, { submitter: SUBMITTER });
      assert.equal(chain.callsOf("findLatestGames").length, pages, String(depth));
    }
  });
});
