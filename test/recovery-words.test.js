import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, recoveryWordsMatch } from "../src/recovery-words.js";

// BIP-39's own test phrase, published with the standard: no one's wallet.
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const WORDS = PHRASE.split(" ");

describe("checking recovery words", () => {
  it("matches the words typed at the places asked, counted from 1, whatever their case or the spaces around them", () => {
    assert.equal(recoveryWordsMatch(PHRASE, [[1, "legal"], [6, "sausage"], [12, "yellow"]]), true);
    // As a phone's keyboard gives them: a capital first, a space after, a no-break space before.
    assert.equal(recoveryWordsMatch(PHRASE, [[1, "Legal"], [6, " Sausage "], [12, " YELLOW\t"]]), true);
    // The phrase as the wallet keeps it, or as its words, in any case and spacing.
    assert.equal(recoveryWordsMatch(WORDS, [[4, "year"], [7, "worth"]]), true);
    assert.equal(recoveryWordsMatch(`  ${PHRASE.toUpperCase().replaceAll(" ", "  \n")} `, [[2, "winner"]]), true);
    // By their places, in any order, and from a Map as from pairs.
    assert.equal(recoveryWordsMatch(PHRASE, new Map([[12, "yellow"], [3, "thank"]])), true);
  });

  it("says no, and only no, to one wrong word or to three made up: never the words, and never which one", () => {
    // Nandini's typo and another of her own words; Amélie's three made-up words.
    for (const typed of [
      [[1, "legal"], [6, "sausag"], [12, "yellow"]],
      [[1, "legal"], [6, "sausage"], [12, "winner"]],
      [[1, "maison"], [6, "velo"], [12, "gateau"]],
      [[1, "winner"], [6, "sausage"], [12, "yellow"]],
    ]) {
      const said = recoveryWordsMatch(PHRASE, typed);

      // A boolean, false, whichever word is wrong: nothing to show, nothing to tell one wrong word from another.
      assert.equal(said, false, JSON.stringify(typed));
    }
  });

  it("says no to a place that isn't the phrase's, one asked twice, a word left empty, or nothing typed, and never throws", () => {
    for (const typed of [
      [[0, "legal"]],
      [[13, "legal"]],
      [[1.5, "legal"]],
      [["1", "legal"]],
      [[1, "legal"], [1, "legal"]],
      [[1, ""]],
      [[1, "   "]],
      [[1, "legal winner"]],
      [[1]],
      [[1, null]],
      [null],
      ["legal"],
      [],
      new Map(),
      null,
      undefined,
      42,
      {},
    ]) {
      assert.doesNotThrow(() => recoveryWordsMatch(PHRASE, /** @type {any} */ (typed)), JSON.stringify(typed));
      assert.equal(recoveryWordsMatch(PHRASE, /** @type {any} */ (typed)), false, JSON.stringify(typed));
    }

    // A phrase that isn't one matches nothing.
    for (const phrase of ["", "   ", null, undefined, 12, {}, [], [1, 2]]) {
      assert.equal(recoveryWordsMatch(/** @type {any} */ (phrase), [[1, "legal"]]), false, JSON.stringify(phrase));
    }
  });

  it("logs nothing, of a match, a mismatch or what isn't a check", () => {
    const methods = /** @type {const} */ (["log", "info", "warn", "error", "debug", "trace", "dir", "table"]);
    const kept = methods.map((method) => console[method]);
    /** @type {string[]} */
    const logged = [];

    for (const method of methods) console[method] = () => void logged.push(method);

    try {
      recoveryWordsMatch(PHRASE, [[1, "legal"], [6, "sausage"], [12, "yellow"]]);
      recoveryWordsMatch(PHRASE, [[1, "maison"], [6, "velo"], [12, "gateau"]]);
      recoveryWordsMatch(PHRASE, /** @type {any} */ ([[13, "legal"], null]));
      recoveryWordsMatch(/** @type {any} */ (null), /** @type {any} */ ("legal"));
    } finally {
      methods.forEach((method, i) => (console[method] = /** @type {any} */ (kept[i])));
    }

    assert.deepEqual(logged, []);
  });

  it("gives both wallets the same words for a mismatch, all it says, and for showing the words apart from a check", () => {
    assert.equal(RECOVERY_WORDS_MISMATCH, "That doesn't match your recovery words. Check the words you wrote down.");
    assert.equal(RECOVERY_WORDS_SHOW, "Show my recovery words");
  });
});
