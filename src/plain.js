/**
 * Text in the plain letters it's written in look-alikes of, by Unicode's
 * confusables (UTS #39): the one reading `/names` and `/payment-links` read
 * look-alike letters by. Not an entry point.
 *
 * @module
 */

import { CONFUSABLES } from "./confusables.js";

/** @type {Map<number, string> | null} */
let looksLike = null;

/** Unicode's table, read the first time it's needed. */
function table() {
  if (!looksLike) {
    looksLike = new Map();

    for (const entry of CONFUSABLES.split(";")) {
      const [source, ...target] = entry.split(" ").map((hex) => Number.parseInt(hex, 16));

      looksLike.set(source, String.fromCodePoint(...target));
    }
  }

  return looksLike;
}

const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

// The small capitals, as the capitals they are, which NFKC leaves as they are: "ᴅᴜꜱᴋ" is DUSK. There's no small X.
const SMALL_CAPITALS = new Map(
  [..."\u1d00\u0299\u1d04\u1d05\u1d07\ua730\u0262\u029c\u026a\u1d0a\u1d0b\u029f\u1d0d\u0274\u1d0f\u1d18\ua7af\u0280\ua731\u1d1b\u1d1c\u1d20\u1d21\u028f\u1d22"].map((char, i) => [char, "ABCDEFGHIJKLMNOPQRSTUVWYZ"[i]])
);
// The capitals white on a black circle or square, 🅓 and 🆂, A to Z, which NFKC leaves as they are too.
const WHITE_ON_BLACK = [0x1f150, 0x1f170];

/**
 * @param {unknown} name
 * @returns {string}
 */
export function nameSkeleton(name) {
  const map = table();
  let shape = "";

  for (const char of String(name ?? "").normalize("NFD").replace(IGNORABLE, "")) shape += map.get(/** @type {number} */ (char.codePointAt(0))) ?? char;

  return shape.normalize("NFD");
}

/**
 * A name's letters as the plain ones they're styled as: its compatibility
 * forms as their letters (NFKC: fullwidth, mathematical, circled ⓢ, squared
 * 🄢, letterlike ℓ), its small capitals as the capitals they are (ᴅ is a D),
 * and the capitals white on black as theirs (🅓 is a D).
 *
 * @param {string} text
 */
export function lettersOf(text) {
  let letters = "";

  for (const char of text.normalize("NFKC")) {
    const code = /** @type {number} */ (char.codePointAt(0));
    const block = WHITE_ON_BLACK.find((first) => code >= first && code < first + 26);

    letters += SMALL_CAPITALS.get(char) ?? (block === undefined ? char : String.fromCharCode(65 + code - block));
  }

  return letters;
}

/**
 * A skeleton as a plain spelling compares it: without the marks over its
 * letters, in lower case.
 *
 * @param {string} shape
 */
export const bare = (shape) => shape.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** @type {Map<string, string> | null} */
let plainBySkeleton = null;

/**
 * The letter, digit, point or hyphen a skeleton is of, as Unicode's table
 * gives "rn" for an m, a letter before a digit: "o" for "O", not "0".
 *
 * @param {string} shape A character's skeleton, `bare`
 */
function plainOf(shape) {
  if (!plainBySkeleton) {
    plainBySkeleton = new Map();

    for (const char of "0123456789.-abcdefghijklmnopqrstuvwxyz") plainBySkeleton.set(bare(nameSkeleton(char)), char);
  }

  return plainBySkeleton.get(shape);
}

/**
 * A character as a plain one where it's written in one that looks like it:
 * ASCII as it is, in lower case; another as the letter, digit, point or
 * hyphen Unicode's table reads it as, where it reads as one, so a Cyrillic ѕ
 * is an s and what looks like an m (Unicode's "rn") an m; else as it is.
 *
 * @param {string} char
 */
export const plainChar = (char) => {
  if (/^[\x21-\x7e]$/.test(char)) return char.toLowerCase();

  const shape = bare(nameSkeleton(char));

  return plainOf(shape) ?? (/^[a-z0-9.-]+$/.test(shape) ? shape : char);
};
