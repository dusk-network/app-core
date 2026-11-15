/* @ts-self-types="./recovery-words.d.ts" */
/**
 * Recovery words as the wallets' boxes take them: the list's words that
 * start with what's typed, whether a word is one of them, and the check of
 * the words a person wrote down: whether those typed are the phrase's at the
 * places asked, yes or no, and nothing else.
 *
 * @module
 */

/** What a check that doesn't match says, and all it says, in both wallets. */
export const RECOVERY_WORDS_MISMATCH = "That doesn't match your recovery words. Check the words you wrote down.";

/** What shows the recovery words, apart from a check, behind the password as showing them always is. */
export const RECOVERY_WORDS_SHOW = "Show my recovery words";

/**
 * Text as a word is compared: its compatibility forms as plain letters (NFKD,
 * as BIP-39 reads a phrase), without the accents BIP-39's lists don't tell
 * words apart by ("ábaco" is "abaco"), without the spaces around it, in lower
 * case; "" for what isn't text.
 *
 * @param {unknown} text
 */
const plain = (text) =>
  typeof text === "string"
    ? text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
    : "";

/** How many words a box suggests unless it's told. */
const SUGGESTED = 4;

/**
 * The list's words in its order, each with what it's compared as; none for
 * what isn't a list. What in it isn't text is passed over.
 *
 * @param {unknown} wordlist
 * @returns {Generator<[word: string, read: string]>}
 */
function* listed(wordlist) {
  if (!Array.isArray(wordlist)) return;

  for (let i = 0; i < wordlist.length; i++) {
    const word = wordlist[i];

    if (typeof word === "string") yield [word, plain(word)];
  }
}

/**
 * @param {unknown} prefix
 * @param {unknown} wordlist
 * @param {unknown} [limit]
 * @returns {string[]}
 */
export function wordSuggestions(prefix, wordlist, limit = SUGGESTED) {
  const start = plain(prefix);
  const most = Number.isInteger(limit) && /** @type {number} */ (limit) >= 0 ? /** @type {number} */ (limit) : SUGGESTED;
  /** @type {string[]} */
  const found = [];

  // Two letters at least, as they're read: "á" is one.
  if ([...start].length < 2 || most === 0) return found;

  try {
    for (const [word, read] of listed(wordlist)) {
      if (!read.startsWith(start)) continue;

      found.push(word);
      if (found.length === most) break;
    }
  } catch {
    return [];
  }

  return found;
}

/**
 * @param {unknown} word
 * @param {unknown} wordlist
 * @returns {boolean}
 */
export function isRecoveryWord(word, wordlist) {
  const said = plain(word);

  if (!said) return false;

  try {
    for (const [, read] of listed(wordlist)) if (read === said) return true;
  } catch {
    return false;
  }

  return false;
}

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
