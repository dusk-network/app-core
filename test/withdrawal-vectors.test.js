// Byte for byte: for real testnet withdrawals, the package builds the proofs
// and claims the web wallet and the bridge site build today, from the same
// chain. The fixture holds what testnet answered to every read, and the
// arguments each app hands its wallet to sign, as the Portal's data driver
// encodes them; here the package reads the same answers, through the same
// pinned drivers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createWithdrawals } from "../src/duskevm-withdrawals.js";
import { readFixture } from "./fixtures/helpers.js";
import { DRIVERS_MISSING, PAID, pinnedDriver } from "./fixtures/withdrawals.js";

const NODE = "https://testnet.nodes.dusk.network";
const fixture = readFixture("duskevm-withdrawal-vectors.json");

/** @param {Uint8Array} bytes */
const hex = (bytes) => Buffer.from(bytes).toString("hex");

/** Testnet as recorded: each read by its contract, function and input. */
async function recordedNode(/** @type {string} */ url, /** @type {any} */ init) {
  const read = /\/on\/contracts:([0-9a-f]{64})\/(\w+)$/.exec(url);

  if (read) {
    const key = `${read[1]}/${read[2]}/${hex(new Uint8Array(init.body))}`;
    const kept = fixture.reads.node[key];

    if (!kept) throw new Error(`Not recorded: ${key.slice(0, 120)}`);

    return new Response(Buffer.from(kept.body, "hex"), { status: kept.status });
  }

  if (url === `${NODE}/on/graphql/query`) {
    const kept = fixture.reads.graphql[String(init.body).replace(/^query \{ /, "").replace(/ \}$/, "")];

    if (!kept) throw new Error(`Not recorded: ${init.body}`);

    return new Response(kept.body, { status: kept.status });
  }

  throw new Error(`Not a read: ${url}`);
}

/** DuskEVM as recorded, as a viem client gives it. */
const duskEvm = {
  /** @param {{ method: string, params: unknown[] }} request */
  request: async ({ method, params }) => {
    const kept = fixture.reads.rpc[`${method} ${JSON.stringify(params)}`];

    if (!kept) throw new Error(`Not recorded: ${method} ${JSON.stringify(params)}`);
    if (kept.error) throw new Error(kept.error.message);

    return kept.result;
  },
};

/** A value as the recording keeps it: bigints as "123n". */
const recorded = (/** @type {unknown} */ value) => JSON.parse(JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? `${item}n` : item)) ?? "null");

const drivers = { disputeGameFactory: await pinnedDriver("disputeGameFactory"), optimismPortal: await pinnedDriver("optimismPortal") };

// Each check is a session of its own, as each app's was.
const withdrawals = () => createWithdrawals({ drivers, duskEvm, fetch: /** @type {any} */ (recordedNode), maxBatch: 64, network: 2, nodeUrl: NODE });

describe("testnet's withdrawals, built as the apps build them", { skip: drivers.optimismPortal && drivers.disputeGameFactory ? false : DRIVERS_MISSING }, () => {
  it("are user2's and the 1,008 DUSK one to 213qXN…, with proofs and claims each app built", () => {
    const names = fixture.vectors.map((/** @type {any} */ vector) => vector.name);

    assert.deepEqual(names, ["nonce-42-1008-dusk", "nonce-41-1-dusk", "nonce-40-1-dusk", "nonce-39-contract-credit", "nonce-31-claimed", "nonce-19-proven"]);
    assert.equal(fixture.vectors.filter((/** @type {any} */ vector) => vector.prove).length, 4);
    assert.equal(fixture.vectors.filter((/** @type {any} */ vector) => vector.claim).length, 2);
  });

  for (const vector of fixture.vectors) {
    describe(vector.name, () => {
      it("has the status both apps read", async () => {
        const status = await withdrawals().status(vector.tx, { submitter: vector.submitter });
        const { bridgeSite, webWallet } = vector.status;

        assert.equal(status.stage, bridgeSite.stage);
        assert.equal(status.stage, webWallet.stage);
        assert.equal(status.withdrawalHash, bridgeSite.withdrawalHash);

        for (const field of ["readyAt", "readyAtExact", "claimOverdue", "disputeGameProxy", "disputeGameIndex", "proofRejected"]) {
          if (field in webWallet) assert.deepEqual(recorded(/** @type {any} */ (status)[field]), webWallet[field], `${field}, as the web wallet read it`);
          if (field in bridgeSite) assert.deepEqual(recorded(/** @type {any} */ (status)[field]), bridgeSite[field], `${field}, as the bridge site read it`);
        }

        // What only the bridge site reads: another account's proof, and when this one proved.
        if ("provenByOther" in bridgeSite) assert.equal(status.provenByOther, bridgeSite.provenByOther);
        if (status.stage === "proven_waiting" || status.stage === "ready_to_finalize") assert.equal(recorded(status.provenAt), bridgeSite.provenAt);
      });

      if (vector.prove) {
        it("proves with the bytes both apps sign", async () => {
          const prepared = await withdrawals().prepareProof(vector.tx, { submitter: vector.prove.submitter });
          const { call } = prepared;

          assert.equal(`0x${hex(call.fnArgs)}`, vector.prove.webWallet);
          assert.equal(`0x${hex(call.fnArgs)}`, vector.prove.bridgeSite);
          assert.equal(call.contractId, vector.prove.contractId);
          assert.equal(call.fnName, vector.prove.fnName);
          assert.equal(String(call.gasLimit), vector.prove.gasLimit);
          assert.deepEqual(prepared.claim, vector.prove.claimIfProvedNow);
          assert.equal(call.decoded.hash, vector.status.bridgeSite.withdrawalHash);
        });
      }

      if (vector.claim) {
        it("claims with the bytes both apps sign", async () => {
          const call = await withdrawals().claimCall(vector.tx, { submitter: vector.claim.submitter });

          assert.equal(`0x${hex(call.fnArgs)}`, vector.claim.webWallet);
          assert.equal(`0x${hex(call.fnArgs)}`, vector.claim.bridgeSite);
          assert.equal(call.contractId, vector.claim.contractId);
          assert.equal(call.fnName, vector.claim.fnName);
          assert.equal(String(call.gasLimit), vector.claim.gasLimit);
        });
      }
    });
  }

  it("pays the 1,008 DUSK to 213qXN…, as the proof and the claim say", async () => {
    const [vector] = fixture.vectors;
    const proof = await withdrawals().prepareProof(vector.tx, { submitter: vector.prove.submitter });
    const claim = await withdrawals().claimCall(vector.tx, { submitter: vector.claim.submitter });

    for (const { decoded } of [proof.call, claim]) {
      assert.deepEqual(decoded.recipient, { account: PAID, kind: "account" });
      assert.equal(decoded.amountWei, 1_008n * 10n ** 18n);
    }
  });
});
