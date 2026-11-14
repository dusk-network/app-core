/* @ts-self-types="./recovery-words.d.ts" */
/**
 * Checking the recovery words a person wrote down, as both wallets ask for
 * them: whether the words typed are the phrase's at the places asked, yes or
 * no, and nothing else.
 *
 * @module
 */

/** What a check that doesn't match says, and all it says, in both wallets. */
export const RECOVERY_WORDS_MISMATCH = "That doesn't match your recovery words. Check the words you wrote down.";

/** What shows the recovery words, apart from a check, behind the password as showing them always is. */
export const RECOVERY_WORDS_SHOW = "Show my recovery words";

/**
 * Text as a word is compared: its compatibility forms as plain letters (NFKD,
 * as BIP-39 reads a phrase), without the spaces around it, in lower case; ""
 * for what isn't text.
 *
 * @param {unknown} text
 */
const plain = (text) => (typeof text === "string" ? text.normalize("NFKD").trim().toLowerCase() : "");

/**
 * A phrase's words, as text or as its words in order: none for what isn't
 * one.
 *
 * @param {unknown} phrase
 * @returns {string[]}
 */
function wordsOf(phrase) {
  const text = Array.isArray(phrase) ? (phrase.every((word) => typeof word === "string") ? phrase.join(" ") : "") : phrase;
  const words = plain(text);

  return words ? words.split(/\s+/) : [];
}

/**
 * @param {unknown} phrase
 * @param {unknown} typed
 * @returns {boolean}
 */
export function recoveryWordsMatch(phrase, typed) {
  const words = wordsOf(phrase);
  /** @type {unknown[]} */
  let asked;

  try {
    asked = Array.from(/** @type {Iterable<unknown>} */ (typed));
  } catch {
    return false;
  }

  if (!words.length || !asked.length) return false;

  const places = new Set();
  let match = true;

  for (const each of asked) {
    if (!Array.isArray(each)) return false;

    const [place, word] = each;

    if (!Number.isInteger(place) || place < 1 || place > words.length || places.has(place)) return false;

    places.add(place);

    const said = plain(word);

    // Each word compared, a wrong one or not: the answer comes no sooner for one wrong word than another.
    match = said !== "" && said === words[place - 1] && match;
  }

  return match;
}
