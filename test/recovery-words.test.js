import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { RECOVERY_WORDS_MISMATCH, RECOVERY_WORDS_SHOW, isRecoveryWord, recoveryWordsMatch, wordSuggestions } from "../src/recovery-words.js";

// BIP-39's own test phrase, published with the standard: no one's wallet.
const PHRASE = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const WORDS = PHRASE.split(" ");

// BIP-39's English list, as the wallets pass it (@scure/bip39's `wordlist`): the standard's english.txt, by its hash.
const ENGLISH_TEXT = readFileSync(new URL("./fixtures/bip39-english.txt", import.meta.url), "utf8");
const ENGLISH = ENGLISH_TEXT.trimEnd().split("\n");
// Words of BIP-39's Spanish list, some with accents, in the list's order: as written here, and as @scure/bip39 has them, decomposed (NFKD).
const SPANISH = ["ábaco", "abdomen", "abeja", "abierto", "acción", "aceite", "acelga", "acento", "aceptar", "ácido"];
const SPANISH_NFKD = SPANISH.map((word) => word.normalize("NFKD"));

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
    // A word typed with an accent, or in full-width letters, is the word, as its box reads it (`isRecoveryWord`).
    assert.equal(recoveryWordsMatch(PHRASE, [[1, "légal"], [6, "ｓａｕｓａｇｅ"], [12, "yellow\u0301"]]), true);
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
      // Nor of a word suggested, checked, or of what's neither.
      wordSuggestions("sau", ENGLISH);
      wordSuggestions("xq", ENGLISH);
      isRecoveryWord("sausage", ENGLISH);
      isRecoveryWord("maison", ENGLISH);
      wordSuggestions(/** @type {any} */ (null), /** @type {any} */ ("legal"));
      isRecoveryWord(/** @type {any} */ ({}), /** @type {any} */ (null));
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

describe("suggesting recovery words", () => {
  it("is given BIP-39's English list, as the standard publishes it", () => {
    assert.equal(createHash("sha256").update(ENGLISH_TEXT).digest("hex"), "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda");
    assert.equal(ENGLISH.length, 2048);
  });

  it("suggests, once two letters are typed, up to four of the list's words that start with them, in the list's order", () => {
    assert.deepEqual(wordSuggestions("ab", ENGLISH), ["abandon", "ability", "able", "about"]);
    assert.deepEqual(wordSuggestions("aba", ENGLISH), ["abandon"]);
    assert.deepEqual(wordSuggestions("abs", ENGLISH), ["absent", "absorb", "abstract", "absurd"]);
    assert.deepEqual(wordSuggestions("sau", ENGLISH), ["sauce", "sausage"]);
    assert.deepEqual(wordSuggestions("saus", ENGLISH), ["sausage"]);
    // A word typed in full that's the only one: just that word, for the box to show no chip.
    assert.deepEqual(wordSuggestions("zoo", ENGLISH), ["zoo"]);
    assert.deepEqual(wordSuggestions("abandon", ENGLISH), ["abandon"]);
    // A word typed in full that starts others comes first, then those, as Tab or Enter take the first.
    assert.deepEqual(wordSuggestions("act", ENGLISH), ["act", "action", "actor", "actress"]);
    assert.deepEqual(wordSuggestions("art", ENGLISH), ["art", "artefact", "artist", "artwork"]);

    // Every word of the list is suggested first for itself, and one of four letters or more alone for its first four.
    for (const word of ENGLISH) {
      assert.equal(wordSuggestions(word, ENGLISH)[0], word, word);
      if (word.length >= 4) assert.deepEqual(wordSuggestions(word.slice(0, 4), ENGLISH), [word], word);
    }

    // Before two letters, and for what starts no word, nothing.
    for (const typed of ["", " ", "a", " z ", "zq", "xy", "abandonn", "zoos", "ab c", "aban don"]) {
      assert.deepEqual(wordSuggestions(typed, ENGLISH), [], JSON.stringify(typed));
    }
  });

  it("suggests as many as asked, the first in the list's order, and four for a count that isn't one", () => {
    const ab = ["abandon", "ability", "able", "about", "above", "absent", "absorb", "abstract", "absurd", "abuse"];

    assert.deepEqual(wordSuggestions("ab", ENGLISH, 2), ab.slice(0, 2));
    assert.deepEqual(wordSuggestions("ab", ENGLISH, 1), ["abandon"]);
    assert.deepEqual(wordSuggestions("ab", ENGLISH, 0), []);
    // All there are, when asked for more.
    assert.deepEqual(wordSuggestions("ab", ENGLISH, 50), ab);

    for (const limit of [undefined, null, Number.NaN, Infinity, -1, 1.5, "2", 2n, {}]) {
      assert.deepEqual(wordSuggestions("ab", ENGLISH, /** @type {any} */ (limit)), ab.slice(0, 4), String(limit));
    }
  });

  it("reads what's typed as BIP-39 does: in any case, the spaces around it aside, in compatibility forms, accents aside", () => {
    // As a phone's keyboard gives it: a capital first, in capitals, with a space, a no-break space or a tab around it.
    assert.deepEqual(wordSuggestions("Ab", ENGLISH), ["abandon", "ability", "able", "about"]);
    assert.deepEqual(wordSuggestions(" AB\u00a0", ENGLISH), ["abandon", "ability", "able", "about"]);
    assert.deepEqual(wordSuggestions("\tZoo\n", ENGLISH), ["zoo"]);
    // Full-width letters, from a Chinese or Japanese keyboard, and accents, written in one or added after.
    assert.deepEqual(wordSuggestions("ａｂ", ENGLISH), ["abandon", "ability", "able", "about"]);
    assert.deepEqual(wordSuggestions("abá", ENGLISH), ["abandon"]);
    assert.deepEqual(wordSuggestions("ÁBAN", ENGLISH), ["abandon"]);
    assert.deepEqual(wordSuggestions("aba\u0301", ENGLISH), ["abandon"]);
    // Two letters as they're read: an accent alone counts for none.
    assert.deepEqual(wordSuggestions("á", ENGLISH), []);
    assert.deepEqual(wordSuggestions("a\u0301", ENGLISH), []);

    // The list's own words come back, with their accents, whether typed with them or without.
    assert.deepEqual(wordSuggestions("aba", SPANISH), ["ábaco"]);
    assert.deepEqual(wordSuggestions("Ába", SPANISH), ["ábaco"]);
    assert.deepEqual(wordSuggestions("ac", SPANISH, 10), ["acción", "aceite", "acelga", "acento", "aceptar", "ácido"]);
    assert.deepEqual(wordSuggestions("accio", SPANISH), ["acción"]);
    assert.deepEqual(wordSuggestions("acid", SPANISH), ["ácido"]);
    assert.deepEqual(wordSuggestions("Ácid", SPANISH_NFKD), [SPANISH_NFKD[9]]);
    assert.deepEqual(wordSuggestions("ac", SPANISH_NFKD, 10), SPANISH_NFKD.slice(4));
  });

  it("says whether a word is one of the list's, read as suggestions read it", () => {
    for (const word of ENGLISH) assert.equal(isRecoveryWord(word, ENGLISH), true, word);

    for (const [word, listed] of [[" Zoo ", "zoo"], ["ZOO", "zoo"], ["Sausage\u00a0", "sausage"], ["ｓａｕｓａｇｅ", "sausage"], ["abándon", "abandon"], ["aba\u0301ndon", "abandon"], ["ÁCT", "act"]]) {
      assert.equal(isRecoveryWord(word, ENGLISH), true, word);
      // The list's word, to hand on: the first suggested.
      assert.equal(wordSuggestions(word, ENGLISH, 1)[0], listed, word);
    }

    // Not the start of one, one with a letter more or wrong, two words, a word of another language, or nothing.
    for (const word of ["aban", "zo", "zoos", "sausag", "sausages", "legal winner", "maison", "gâteau", "", "   ", "\u0301"]) {
      assert.equal(isRecoveryWord(word, ENGLISH), false, word);
    }

    // A list's words with accents, typed with them or without.
    for (const word of ["ábaco", "abaco", "ÁBACO", "accion", "Acción", "acido"]) {
      assert.equal(isRecoveryWord(word, SPANISH), true, word);
      assert.equal(isRecoveryWord(word, SPANISH_NFKD), true, word);
    }
    assert.equal(isRecoveryWord("abandon", SPANISH), false);
  });

  it("suggests nothing and says no for what isn't text or a list, passes over what in a list isn't a word, and never throws", () => {
    for (const typed of [null, undefined, 42, true, {}, [], ["ab"], ["abandon"], Symbol("ab"), new String("abandon")]) {
      assert.deepEqual(wordSuggestions(/** @type {any} */ (typed), ENGLISH), [], String(typed));
      assert.equal(isRecoveryWord(/** @type {any} */ (typed), ENGLISH), false, String(typed));
    }

    // An unreadable list: one whose words can't be read.
    const unreadable = new Proxy([...ENGLISH], {
      get(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) throw new Error("unreadable");

        return Reflect.get(target, key);
      },
    });

    for (const [i, list] of [null, undefined, "abandon ability able", 42, {}, new Set(ENGLISH), { length: 2, 0: "abandon", 1: "ability" }, unreadable].entries()) {
      assert.deepEqual(wordSuggestions("ab", /** @type {any} */ (list)), [], `list ${i}`);
      assert.equal(isRecoveryWord("abandon", /** @type {any} */ (list)), false, `list ${i}`);
    }

    assert.deepEqual(wordSuggestions("ab", /** @type {any} */ ([null, 42, "abandon", { word: "able" }, "ability", ["about"]])), ["abandon", "ability"]);
    assert.equal(isRecoveryWord("abandon", /** @type {any} */ ([null, "abandon"])), true);
    assert.equal(isRecoveryWord("able", /** @type {any} */ ([{ word: "able" }, ["able"]])), false);
  });

  it("leaves the list as it is, and gives a new list of suggestions each time", () => {
    const frozen = Object.freeze([...ENGLISH]);
    const first = wordSuggestions("ab", frozen);

    first.length = 0;
    first.push("maison");

    assert.deepEqual(wordSuggestions("ab", frozen), ["abandon", "ability", "able", "about"]);
    assert.equal(isRecoveryWord("zoo", frozen), true);
    assert.deepEqual(frozen, ENGLISH);
  });
});
