import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AGAIN_MS, matchRequests, sentAlready } from "../src/requests.js";
import { like } from "./fixtures/helpers.js";

/** @typedef {import("../src/activity.js").ActivityRow} ActivityRow */

const TO = "25z9o6qCaVk1ReyHjmB4pyXcE3D1vRu4FVV1rR8ChYcosdTSktkANLDHq9GD6B4985Q1S2KrDZYBRrohWAjrNmACFUb3UMSRyYctJRzh3d28R1ZNC1ZyKm1HwXL4FF5Etftt";
const SHIELDED = "47jNTgAhzn9KCKF3msCfvKg3k1P1QpPCLZ3HG3AoNp87sQ5WNS3QyjckYHWeuXqW7uvLmbKgejpP8Xkcip89vnMM";
const LUX = 150_000_000n;
const NOW = 1_793_900_000_000;
const HOUR = 3_600_000;

/** @param {Record<string, unknown>} [fields] */
const asked = (fields) => /** @type {import("../src/requests.js").KeptRequest} */ ({ at: NOW, id: "a", lux: String(LUX), memo: "Factura 33", network: "testnet", to: TO, ...fields });

/**
 * What else paid a request, by the fields a test is about.
 *
 * @param {import("../src/requests.js").RequestMatch | undefined} match
 */
const paidAgain = (match) => match?.more?.map(({ hash, lux, matched }) => ({ hash, lux, matched }));

/** @param {Record<string, unknown>} [fields] */
const payment = (fields) =>
  /** @type {ActivityRow} */ (/** @type {unknown} */ ({ category: "received", hash: "h1", memo: "Factura 33", privacy: "public", status: "executed", time: NOW + HOUR, value: LUX, ...fields }));

describe("what came in for each request", () => {
  it("calls a request paid only by a payment with its amount and its memo, both", () => {
    assert.deepEqual(matchRequests([asked()], [payment()]).get("a"), { at: NOW + HOUR, hash: "h1", lux: LUX, matched: "amount-memo", memo: "Factura 33", state: "paid" });
  });

  it("never calls a guess paid: it says what matched, for checking", () => {
    like(matchRequests([asked()], [payment({ memo: "Other" })]).get("a"), { matched: "amount", memo: "Other", state: "check" });
    like(matchRequests([asked()], [payment({ value: 1n })]).get("a"), { lux: 1n, matched: "memo", state: "check" });
    // A request of an amount alone can't tell one payer from another.
    like(matchRequests([asked({ memo: "" })], [payment({ memo: "" })]).get("a"), { matched: "amount", state: "check" });
  });

  it("calls a request of no amount paid by a payment with its memo, of any amount, and paid twice by another with it", () => {
    const anyAmount = asked({ lux: null });

    assert.deepEqual(matchRequests([anyAmount], [payment({ value: 7n })]).get("a"), { at: NOW + HOUR, hash: "h1", lux: 7n, matched: "amount-memo", memo: "Factura 33", state: "paid" });
    const twice = matchRequests([anyAmount], [payment(), payment({ hash: "h2", time: NOW + 2 * HOUR, value: 9n })]).get("a");

    like(twice, { hash: "h1", state: "paid" });
    assert.deepEqual(paidAgain(twice), [{ hash: "h2", lux: 9n, matched: "amount-memo" }]);
    // Without its memo, nothing pays it: there's nothing else it asked.
    assert.deepEqual(matchRequests([anyAmount], [payment({ memo: "Other" })]).get("a"), { state: "waiting" });
    assert.deepEqual(matchRequests([asked({ lux: null, memo: "" })], [payment({ memo: "" })]).get("a"), { state: "waiting" });
  });

  it("takes a payment of nothing with a request's memo for none: not paid, paid twice or to check", () => {
    // Codex's: anyone could mark a request paid for free with its memo.
    const nothing = [payment({ value: 0n }), payment({ entry: { refund: 4_000n }, hash: "h2", value: 4_000n })];

    for (const request of [asked({ lux: null }), asked()]) {
      assert.deepEqual(matchRequests([request], nothing).get("a"), { state: "waiting" });
    }
    assert.equal(matchRequests([asked({ lux: null })], [payment({ hash: "h0", time: NOW + 1 }), ...nothing]).get("a")?.more, undefined);
  });

  it("says waiting with nothing that matches: another amount and memo, what failed or waits, what went out, and what came before", () => {
    for (const row of [
      payment({ memo: "Other", value: 1n }),
      payment({ status: "failed" }),
      payment({ status: "pending" }),
      payment({ category: "sent" }),
      payment({ time: NOW - HOUR }),
      payment({ time: null }),
      // A record that timed out unconfirmed, or a row whose outcome isn't read yet: it may have failed.
      payment({ status: "unknown" }),
    ]) {
      assert.deepEqual(matchRequests([asked()], [row]).get("a"), { state: "waiting" });
    }
  });

  it("reads a memo of bytes as no text, which no request's memo is", () => {
    // Codex's: byte 00 comes as the memo "0x00", marked as bytes.
    const bytes = payment({ entry: { memoBinary: true }, memo: "0x00" });

    like(matchRequests([asked({ memo: "0x00" })], [bytes]).get("a"), { matched: "amount", state: "check" });
    assert.deepEqual(matchRequests([asked({ lux: null, memo: "0x00" })], [bytes]).get("a"), { state: "waiting" });
  });

  it("reads a request's memo as its link sends it, without the spaces around it", () => {
    like(matchRequests([asked({ memo: "  Factura 33 " })], [payment()]).get("a"), { matched: "amount-memo", state: "paid" });
    like(matchRequests([asked({ lux: null, memo: " Factura 33" })], [payment({ value: 9n })]).get("a"), { matched: "amount-memo", state: "paid" });
    // A memo of spaces asks for none.
    assert.deepEqual(matchRequests([asked({ lux: null, memo: "   " })], [payment({ memo: "" })]).get("a"), { state: "waiting" });
  });

  it("reads what a payment paid, without the gas refund its transaction paid to the account with it", () => {
    const refunded = payment({ entry: { refund: 3_000n }, value: LUX + 3_000n });

    assert.deepEqual(matchRequests([asked()], [refunded]).get("a"), { at: NOW + HOUR, hash: "h1", lux: LUX, matched: "amount-memo", memo: "Factura 33", state: "paid" });
  });

  it("lets a payment answer one request: the one it matches best, then the oldest", () => {
    const matches = matchRequests([asked({ id: "older", memo: "" }), asked({ at: NOW + 1, id: "memo" })], [payment()]);

    assert.equal(matches.get("memo")?.state, "paid");
    assert.equal(matches.get("older")?.state, "waiting");

    const one = matchRequests([asked({ id: "first", memo: "" }), asked({ at: NOW + 1, id: "second", memo: "" })], [payment({ memo: "" })]);

    assert.equal(one.get("first")?.state, "check");
    assert.equal(one.get("second")?.state, "waiting");
  });

  it("answers a request only with a payment to the address it asked on: public to the account, shielded to the shielded address", () => {
    const list = [asked({ id: "shielded", to: SHIELDED }), asked({ at: NOW + 1, id: "public" })];
    const fromPublic = matchRequests(list, [payment()]);

    assert.equal(fromPublic.get("public")?.state, "paid");
    assert.deepEqual(fromPublic.get("shielded"), { state: "waiting" });

    // A shielded payment has no memo to read: the amount alone, to check.
    const fromShielded = matchRequests(list, [payment({ hash: "h2", memo: null, privacy: "shielded" })]);

    like(fromShielded.get("shielded"), { hash: "h2", matched: "amount", state: "check" });
    assert.deepEqual(fromShielded.get("public"), { state: "waiting" });
  });

  it("says what else came in for a request answered: the same payment again, or one to check, but not one another request took", () => {
    const matches = matchRequests(
      [asked(), asked({ at: NOW + 1, id: "b", lux: "1", memo: "" })],
      [
        payment(),
        payment({ hash: "h2", time: NOW + 2 * HOUR }),
        payment({ hash: "h3", memo: "Fra 33", time: NOW + 3 * HOUR }),
        payment({ hash: "h4", memo: "", time: NOW + 4 * HOUR, value: 1n }),
      ]
    );

    assert.deepEqual(matches.get("a"), {
      at: NOW + HOUR,
      hash: "h1",
      lux: LUX,
      matched: "amount-memo",
      memo: "Factura 33",
      more: [
        { at: NOW + 2 * HOUR, hash: "h2", lux: LUX, matched: "amount-memo", memo: "Factura 33" },
        { at: NOW + 3 * HOUR, hash: "h3", lux: LUX, matched: "amount", memo: "Fra 33" },
      ],
      state: "paid",
    });
    like(matches.get("b"), { hash: "h4", state: "check" });
    assert.equal(matches.get("b")?.more, undefined);
  });

  it("counts a payment again with all of a request as its repeat, not as a guess at another request for the amount", () => {
    const matches = matchRequests([asked(), asked({ at: NOW + 1, id: "b", memo: "Factura 34" })], [payment(), payment({ hash: "h2", time: NOW + 2 * HOUR })]);

    like(matches.get("a"), { hash: "h1", state: "paid" });
    assert.deepEqual(paidAgain(matches.get("a")), [{ hash: "h2", lux: LUX, matched: "amount-memo" }]);
    assert.deepEqual(matches.get("b"), { state: "waiting" });
  });

  it("gives a payment again to the request it matches in full, not to an older one it matches by amount", () => {
    const matches = matchRequests(
      [asked(), asked({ at: NOW + 1, id: "b", memo: "Factura 34" })],
      [payment(), payment({ hash: "h2", memo: "Factura 34", time: NOW + 2 * HOUR }), payment({ hash: "h3", memo: "Factura 34", time: NOW + 3 * HOUR })]
    );

    like(matches.get("a"), { hash: "h1", state: "paid" });
    assert.equal(matches.get("a")?.more, undefined);
    like(matches.get("b"), { hash: "h2", state: "paid" });
    assert.deepEqual(paidAgain(matches.get("b")), [{ hash: "h3", lux: LUX, matched: "amount-memo" }]);
  });

  it("prefers a payment with all of it to an earlier one with part of it", () => {
    like(matchRequests([asked()], [payment({ hash: "h2", memo: "Other", time: NOW + 1 }), payment({ hash: "h3", time: NOW + 2 })]).get("a"), { hash: "h3", state: "paid" });
  });

  it("keeps a request paid by the payment it kept, which no other request takes, and says what that payment paid", () => {
    const matches = matchRequests([asked({ paid: { at: NOW + HOUR, hash: "h1" } }), asked({ at: NOW + 1, id: "b" })], [payment()]);

    assert.deepEqual(matches.get("a"), { at: NOW + HOUR, hash: "h1", lux: LUX, matched: "amount-memo", state: "paid" });
    assert.deepEqual(matches.get("b"), { state: "waiting" });
  });

  it("says what a kept payment paid once it's too far back to read, as it was kept with it", () => {
    // Marek's: a request of any amount, paid with its memo and one lux.
    const kept = (/** @type {unknown} */ lux) => asked({ lux: null, paid: { at: NOW + HOUR, hash: "h1", lux } });

    assert.deepEqual(matchRequests([kept("1")], []).get("a"), { at: NOW + HOUR, hash: "h1", lux: 1n, matched: "amount-memo", state: "paid" });
    // The chain's, where its payment is read.
    like(matchRequests([kept("1")], [payment({ value: 9n })]).get("a"), { lux: 9n, state: "paid" });
    // Kept without it, or not as lux: not known.
    for (const lux of [undefined, "abc", "-1", 5]) {
      assert.deepEqual(matchRequests([kept(lux)], []).get("a"), { at: NOW + HOUR, hash: "h1", matched: "amount-memo", state: "paid" }, String(lux));
    }
  });
});

describe("the payment a send would make again", () => {
  /** @param {Record<string, unknown>} [fields] */
  const sent = (fields) =>
    /** @type {ActivityRow} */ (/** @type {unknown} */ ({ counterparty: TO, direction: "out", hash: "s1", memo: null, status: "executed", time: NOW - 20_000, value: 1_900_000n, ...fields }));
  const again = { lux: 1_900_000n, memo: "", now: NOW, to: TO };

  it("is the same payment made moments ago, and the newest of them", () => {
    like(sentAlready([sent()], again), { hash: "s1" });
    like(sentAlready([sent({ hash: "old", time: NOW - 60_000 }), sent({ hash: "new", time: NOW - 30_000 })], again), { hash: "new" });
    // One on its way counts as well: it's going.
    like(sentAlready([sent({ status: "pending" })], again), { hash: "s1" });
  });

  it("is a payment whose transaction refunded its unspent gas to another account, by what it paid", () => {
    like(sentAlready([sent({ entry: { refund: 2_000n, success: true }, value: 1_900_000n + 2_000n })], again), { hash: "s1" });
    // On chain before its details are read, its value is the wallet's record's, which has no refund in it.
    like(sentAlready([sent({ entry: { refund: 3_000n }, sent: { amount: "1900000" }, value: 1_900_000n })], again), { hash: "s1" });
  });

  it("is none for a send whose memo was bytes, though they read as the memo typed", () => {
    assert.equal(sentAlready([sent({ entry: { memoBinary: true }, memo: "0x00" })], { ...again, memo: "0x00" }), null);
  });

  it("is none for a send the node dropped, whatever its memo, though one on its way counts", () => {
    const paid = { ...again, memo: "Factura 044" };

    assert.equal(sentAlready([sent({ dropped: true, memo: "Factura 044", status: "unknown", time: NOW - 5 * AGAIN_MS })], paid), null);
    like(sentAlready([sent({ memo: "Factura 044", status: "pending" })], paid), { hash: "s1" });
  });

  it("is none for another amount or recipient, one that failed, or the same long ago without a memo", () => {
    assert.equal(sentAlready([sent({ value: 3_000_000n })], again), null);
    assert.equal(sentAlready([sent({ counterparty: SHIELDED })], again), null);
    assert.equal(sentAlready([sent({ status: "failed" })], again), null);
    assert.equal(sentAlready([sent({ time: NOW - AGAIN_MS - 1 })], again), null);
    assert.equal(sentAlready([sent({ direction: "in" })], again), null);
    assert.equal(sentAlready([sent()], { ...again, lux: 0n }), null);
    assert.equal(sentAlready([sent()], { ...again, to: "" }), null);
  });

  it("is a payment with the same memo whenever it went, as a request paid already", () => {
    const paid = sent({ memo: "Factura 044", time: Date.UTC(2026, 9, 29, 9, 30) });

    like(sentAlready([paid], { ...again, memo: " Factura 044 " }), { hash: "s1" });
    assert.equal(sentAlready([paid], { ...again, memo: "Factura 045" }), null);
  });
});
