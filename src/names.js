/* @ts-self-types="./names.d.ts" */
/**
 * Names a person gives, as a contact's or a profile's: whether two read as
 * the same name, or look alike though they're written differently, by
 * Unicode's confusables (UTS #39). Only for what a person reads: a name never
 * stands for an address.
 *
 * @module
 */

import { shortAccount } from "@dusk-network/networks/format";

import { CONFUSABLES } from "./confusables.js";
import { ownerOf } from "./owners.js";
import { displayText } from "./text.js";

/** @typedef {{ same: string, written: string, paired: string, lower: string, digits: string, strokes: string }} NameKeys */

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
// What can't be seen: what renders as nothing, and controls, which turn text
// around or break it. A name is read without them.
const UNSEEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/gu;
// What a name is read by: its letters and digits.
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
// The letters two others look like in most fonts, as Unicode's table has an m as rn: a w as vv, a d as cl.
const PAIRS = /[wWd]/g;
/** @type {Readonly<Record<string, string>>} */
const PAIRED = Object.freeze({ W: "VV", d: "cl", w: "vv" });
// What's written for a letter: a 0 for an o, a 5 or a $ for an s, an @ for an a and a € for an e.
const STANDS_IN = /[05$@€]/g;
/** @type {Readonly<Record<string, string>>} */
const STOOD_FOR = Object.freeze({ $: "s", 0: "o", 5: "s", "@": "a", "€": "e" });
/** What a 1 in a name's digits key can stand in for, where the other name has it: an i, an l, or a 1. */
const ONE = new Set(["1", "i", "l"]);
// What Unicode's table reads as a thin upright stroke, an i, an l or a !, as it reads a 1, an I, a | and a ¡: each
// looks like the others, so "Davld", "Dav!d" and "Dav1d" look like "David".
const STROKES = /[il!]/g;
// The small capitals, as the capitals they are, which NFKC leaves as they are: "ᴅᴜꜱᴋ" is DUSK. There's no small X.
const SMALL_CAPITALS = new Map(
  [..."\u1d00\u0299\u1d04\u1d05\u1d07\ua730\u0262\u029c\u026a\u1d0a\u1d0b\u029f\u1d0d\u0274\u1d0f\u1d18\ua7af\u0280\ua731\u1d1b\u1d1c\u1d20\u1d21\u028f\u1d22"].map((char, i) => [char, "ABCDEFGHIJKLMNOPQRSTUVWYZ"[i]])
);
// The capitals white on a black circle or square, 🅓 and 🆂, A to Z, which NFKC leaves as they are too.
const WHITE_ON_BLACK = [0x1f150, 0x1f170];

/** What an app says of a name it refuses for what can't be seen in it. */
export const NAME_HIDES = "This name has hidden characters. Type it again without them.";

/** What answers a name's question so that it's saved: a name asked about is saved only once it's answered. */
export const NAME_SAVE_YES = "Yes, save it";

/**
 * @param {unknown} name
 * @returns {boolean}
 */
export const nameHides = (name) => displayText(name ?? "").neutralized;

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
 * What's left to tell names apart once their case, accents, spaces and
 * punctuation are off, and what can't be seen.
 *
 * @param {string} text
 */
const folded = (text) => text.normalize("NFD").replace(UNSEEN, "").replace(NOT_LETTER_OR_DIGIT, "").toLowerCase();

/**
 * A skeleton with each letter that two others look like as those two, as
 * the name is written: "Wendy" as "VVendy" and "David" as "Davicl", as
 * Unicode's own table has "Emma" as "Ernrna". As written only: "Dara" in
 * lower case looks like "clara", but "Dara" doesn't look like "Clara".
 *
 * @param {string} shape A skeleton
 */
const paired = (shape) => shape.replace(PAIRS, (char) => PAIRED[char]);

/**
 * A name's letters as the plain ones they're styled as: its compatibility
 * forms as their letters (NFKC: fullwidth, mathematical, circled ⓢ, squared
 * 🄢, letterlike ℓ), its small capitals as the capitals they are (ᴅ is a D),
 * and the capitals white on black as theirs (🅓 is a D).
 *
 * @param {string} text
 */
function lettersOf(text) {
  let letters = "";

  for (const char of text.normalize("NFKC")) {
    const code = /** @type {number} */ (char.codePointAt(0));
    const block = WHITE_ON_BLACK.find((first) => code >= first && code < first + 26);

    letters += SMALL_CAPITALS.get(char) ?? (block === undefined ? char : String.fromCharCode(65 + code - block));
  }

  return letters;
}

/**
 * A name in plain letters (`lettersOf`) with what's written for a letter as
 * that letter: a 0 as an o, a 5 and a $ as an s, an @ as an a, a € as an e.
 *
 * @param {string} text
 */
const lettered = (text) => lettersOf(text).replace(STANDS_IN, (char) => STOOD_FOR[char]);

/**
 * A name's skeleton with what's written for letters as those letters
 * (`lettered`), and each small y as the v it looks like, as written: "Ro5a"
 * and "Ro$a" as "Rosa", "Wendv" as "Wendy". A capital Y stays: "Yan" isn't
 * "Van". Each 1 stays a 1, which Unicode's table would make an l: it stands
 * in for an i or an l, each on its own (`digitsAlike`), so its key, in lower
 * case, has "luca5" as "Lucas" and "L11ian" as "Lilian".
 *
 * @param {string} text
 */
const digitShape = (text) =>
  lettered(text)
    .split("1")
    .map((part) => nameSkeleton(part))
    .join("1")
    .replace(/y/g, "v");

/**
 * Whether two names' digits keys (or words of them) look alike: the same,
 * but where one has a 1 the other may have an i or an l, each 1 on its own,
 * as "L11ian" reads as "Lilian" and "Dav1d" as "David".
 *
 * @param {string} a
 * @param {string} b
 */
function digitsAlike(a, b) {
  if (a === b) return a !== "";

  const [x, y] = [Array.from(a), Array.from(b)];

  return x.length > 0 && x.length === y.length && x.every((char, i) => char === y[i] || (char === "1" && ONE.has(y[i])) || (y[i] === "1" && ONE.has(char)));
}

/**
 * A name's skeleton with what's written for letters as those letters
 * (`lettered`), each thin upright stroke as one and the same, an i, an l, a
 * 1, a ! or a |, and each small y as the v it looks like, as written: "Dav!d"
 * and "Davld" as "David". A capital L and a capital Y stay: "Lia" isn't
 * "Ila", nor "Yan" "Van".
 *
 * @param {string} text
 */
const strokeShape = (text) =>
  nameSkeleton(lettered(text))
    .replace(STROKES, "1")
    .replace(/y/g, "v");

/**
 * A name's six keys: as a person reads it, and by what it looks like, as
 * written, as written with its letter pairs, in lower case, where a capital
 * that looks like another letter is the small one, with what's written for
 * letters as those letters in any case (`digitShape`), and with every thin
 * stroke as one, as written (`strokeShape`). The pairs, the digits and the
 * strokes are keys of their own beside the written one, never in its place:
 * "daIe" with a capital I looks like "Dale" as written, though its d makes a
 * pair the capital D doesn't, and "luca5" looks like "Lucas" by its digits,
 * though its small l is a stroke the capital L isn't.
 *
 * @param {unknown} name
 * @returns {NameKeys}
 */
function keysOf(name) {
  const text = String(name ?? "");
  const written = nameSkeleton(text);

  return {
    digits: folded(digitShape(text)),
    lower: folded(nameSkeleton(text.toLowerCase())),
    paired: folded(paired(written)),
    same: folded(text),
    strokes: folded(strokeShape(text)),
    written: folded(written),
  };
}

/** The keys two names are alike by where they're the same: all but the digits', which `digitsAlike` compares. */
const KEYS = /** @type {const} */ (["same", "written", "paired", "lower", "strokes"]);

/**
 * @param {NameKeys} a
 * @param {NameKeys} b
 */
const alike = (a, b) => KEYS.some((key) => a[key] !== "" && a[key] === b[key]) || digitsAlike(a.digits, b.digits);

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export function sameName(a, b) {
  const x = folded(String(a ?? ""));

  return x !== "" && x === folded(String(b ?? ""));
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
export const looksAlike = (a, b) => alike(keysOf(a), keysOf(b));

/**
 * The names an entry goes by: its own, and a profile's verified .dusk name.
 *
 * @param {{ name?: unknown, duskName?: unknown } | undefined} entry
 * @param {"profile" | "contact"} kind
 * @returns {unknown[]}
 */
const namesOf = (entry, kind) => (kind === "profile" ? [entry?.name, entry?.duskName] : [entry?.name]).filter((each) => each !== undefined && each !== null && each !== "");

/**
 * @template {{ name?: unknown, duskName?: unknown }} P
 * @template {{ name?: unknown, id?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, except?: unknown }} [among]
 * @returns {{ kind: "profile", same: boolean, entry: P, name: string } | { kind: "contact", same: boolean, entry: C, name: string } | null}
 */
export function nameClash(name, { contacts = [], except, profiles = [] } = {}) {
  const keys = keysOf(name);
  const others = contacts.filter((contact) => except === undefined || except === null || contact?.id !== except);

  for (const [kind, list] of /** @type {const} */ ([["profile", profiles], ["contact", others]])) {
    // Each by every name it goes by, a profile by its .dusk name too.
    const named = list.flatMap((entry) => namesOf(entry, kind).map((each) => ({ entry, name: each })));
    const same = named.find((each) => sameName(name, each.name));
    const hit = same ?? named.find((each) => alike(keys, keysOf(each.name)));

    if (hit) return /** @type {any} */ ({ entry: hit.entry, kind, name: String(hit.name), same: Boolean(same) });
  }

  return null;
}

/**
 * The profiles and contacts that aren't the profile named: it, and a
 * contact saved with either of its addresses, are its own. With the profile
 * named, where it's among them (`self`).
 *
 * @template {{ account?: unknown, address?: unknown }} P
 * @template {{ account?: unknown, address?: unknown }} C
 * @param {{ profiles: ReadonlyArray<P>, contacts: ReadonlyArray<C>, self?: unknown }} among
 */
function othersThan({ contacts, profiles, self }) {
  const named = profiles.find((profile) => self !== undefined && self !== null && self !== "" && (profile?.account === self || profile?.address === self));
  const own = new Set([self, named?.account, named?.address].filter((id) => id !== undefined && id !== null && id !== ""));
  /** @param {{ account?: unknown, address?: unknown } | undefined} entry */
  const itself = (entry) => own.has(entry?.account) || own.has(entry?.address);

  return { contacts: contacts.filter((contact) => !itself(contact)), profiles: profiles.filter((profile) => profile !== named && !itself(profile)), self: named };
}

/**
 * @template {{ name?: unknown, duskName?: unknown, account?: unknown, address?: unknown }} P
 * @template {{ name?: unknown, address?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, self?: unknown }} [among]
 * @returns {{ kind: "profile", same: boolean, entry: P, name: string } | { kind: "contact", same: boolean, entry: C, name: string } | null}
 */
export function profileNameClash(name, { contacts = [], profiles = [], self } = {}) {
  return nameClash(name, othersThan({ contacts, profiles, self }));
}

/**
 * A name's words, as the look-alike rules read a name: without its case,
 * accents and what can't be seen, split at its spaces and punctuation.
 *
 * @param {string} text
 * @returns {string[]}
 */
const wordsOf = (text) =>
  text
    .normalize("NFD")
    .replace(UNSEEN, "")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * A name's words as a person reads them, and by what they look like, as
 * written, as written with its letter pairs, in lower case, with what's
 * written for letters as those letters, and with every thin stroke as one,
 * as `keysOf` reads the whole name.
 *
 * @param {unknown} name
 * @returns {string[][]}
 */
function wordKeys(name) {
  const text = String(name ?? "");
  const written = nameSkeleton(text);

  return [wordsOf(text), wordsOf(written), wordsOf(paired(written)), wordsOf(nameSkeleton(text.toLowerCase())), wordsOf(digitShape(text)), wordsOf(strokeShape(text))];
}

/** Which of `wordKeys`' lists is its digits', whose words are compared by `digitsAlike`. */
const DIGIT_WORDS = 4;

/**
 * Whether the words of one are the first words of the other, which has more:
 * each the same, or for the digits' words (`digits`), alike by `digitsAlike`.
 *
 * @param {string[]} short
 * @param {string[]} long
 * @param {boolean} [digits]
 */
const begins = (short, long, digits = false) =>
  short.length > 0 && short.length < long.length && short.every((word, i) => (digits ? digitsAlike(word, long[i]) : word === long[i]));

/**
 * @template {{ name?: unknown, duskName?: unknown, account?: unknown, address?: unknown }} P
 * @template {{ name?: unknown, address?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, self?: unknown }} [among]
 * @returns {{ kind: "profile", entry: P, name: string } | { kind: "contact", entry: C, name: string } | null}
 */
export function nameStarts(name, { contacts = [], profiles = [], self } = {}) {
  const keys = wordKeys(name);
  const others = othersThan({ contacts, profiles, self });

  for (const [kind, list] of /** @type {const} */ ([["profile", others.profiles], ["contact", others.contacts]])) {
    for (const entry of list) {
      for (const each of namesOf(entry, kind)) {
        const theirs = wordKeys(each);

        if (keys.some((words, i) => begins(words, theirs[i], i === DIGIT_WORDS) || begins(theirs[i], words, i === DIGIT_WORDS))) return /** @type {any} */ ({ entry, kind, name: String(each) });
      }
    }
  }

  return null;
}

/**
 * A name as the words of a check show it: what can't be seen in it as its
 * codes, so one kept from before can't read as another.
 *
 * @param {unknown} name
 */
const shown = (name) => (nameHides(name) ? displayText(name).text : String(name ?? ""));

// The end of a .dusk name, after at least one character of its own: what a word's keys end with to read as one;
// with the letter pairs, as a d looks like cl, .clusk.
const DUSK_ENDING = /[^.\s]\.dusk$/u;
const PAIRED_DUSK_ENDING = /[^.\s]\.clusk$/u;

/**
 * Whether a character is a letter or a digit, or a symbol styled as one, as
 * a circled ⓢ (`lettersOf`).
 *
 * @param {string} char
 */
const letterLike = (char) => /^[\p{L}\p{N}]$/u.test(char) || /^[\p{L}\p{N}]$/u.test(lettersOf(char));

/**
 * A word without what it starts or ends with that's no part of a name in
 * it: brackets, quotes and punctuation.
 *
 * @param {string} word
 */
function withoutEdges(word) {
  const chars = [...word];
  let start = 0;
  let end = chars.length;

  while (start < end && !letterLike(chars[start])) start += 1;
  while (end > start && !letterLike(chars[end - 1])) end -= 1;

  return chars.slice(start, end).join("");
}

/**
 * A skeleton as the look-alike checks compare one, its points and hyphens
 * kept: without what can't be seen or the marks over its letters, in lower
 * case, which a skeleton keeps where it gives a capital, as Unicode's has
 * "D" for a mathematical bold 𝐃.
 *
 * @param {string} shape
 */
const plainShape = (shape) => shape.normalize("NFD").replace(UNSEEN, "").replace(/\p{M}/gu, "").toLowerCase();

// What renders as nothing, which a name is read without; a control, as a line break, parts words.
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;

// What Unicode's table reads a full stop, a middle dot and an ideographic full stop as: ".", "·" and "˳".
const DOT_SHAPES = new Set([".", "\u00b7", "\u02f3"]);
// A raised dot and an Arabic full stop, which it reads as nothing else, and as a hyphen.
const DOTS_TOO = new Set(["\u2e33", "\u06d4"]);

/**
 * Whether a character reads as a point between a name's labels: a full stop,
 * a middle dot or an ideographic full stop, or what Unicode's table or NFKC
 * reads as one, as "．", "·", "•", "‧", "∙", "⋅", "・", "。" and "｡", and a
 * raised dot "⸳" and an Arabic full stop "۔".
 *
 * @param {string} char
 */
const dotLike = (char) => DOTS_TOO.has(char) || DOT_SHAPES.has(nameSkeleton(char)) || DOT_SHAPES.has(nameSkeleton(char.normalize("NFKC")));

/**
 * Text with each character that reads as a point (`dotLike`) as a point:
 * "sofiadesign·dusk" as "sofiadesign.dusk".
 *
 * @param {string} text
 */
const dotted = (text) => Array.from(text, (char) => (char !== "." && dotLike(char) ? "." : char)).join("");

/**
 * Whether a character can be part of a .dusk name as a person reads one: a
 * letter, a digit or a mark over one, or a symbol styled as a letter, as a
 * circled ⓢ (`lettersOf`), and a point or a hyphen, or what reads as one, as
 * a fullwidth point. Spaces and other punctuation part names, as the comma in
 * "alice.dusk,bob.dusk".
 *
 * @param {string} char
 */
const inDuskName = (char) => /^\p{M}$/u.test(char) || letterLike(char) || [lettersOf(char), nameSkeleton(char)].some((shape) => shape === "." || shape === "-");

/**
 * A name's words, parted at each character that can't be in one.
 *
 * @param {string} text
 * @param {(char: string) => boolean} inWord
 */
function wordsOfName(text, inWord) {
  /** @type {string[]} */
  const words = [];
  let word = "";

  for (const char of text) {
    if (inWord(char)) {
      word += char;
    } else {
      words.push(word);
      word = "";
    }
  }

  words.push(word);

  return words;
}

/**
 * The words of a name that read as .dusk names, as they're written, split
 * at what can't be in one and without the punctuation around them, by the
 * look-alike rules: in any case, in letters or points that look like a .dusk
 * name's, with marks over its letters, with the letter pairs that look like
 * one, and with digits for letters, as "SofiaDesign.DUSK", "ѕofia.dusk" with
 * a Cyrillic ѕ, "sofia．dusk" with a fullwidth point, "sofia·dusk" with a
 * middle dot or any other point (`dotLike`), "sofia.𝐃𝐔𝐒𝐊" in mathematical
 * bold, "sofia.dúsk", "sofia.clusk" or "sofia.du5k"; and each of
 * "alice.dusk,bob.dusk". A point that isn't a full stop parts words too, as
 * it did: "sofia.dusk·Diseño" holds sofia.dusk.
 *
 * @param {unknown} name
 * @returns {string[]}
 */
function duskNamesIn(name) {
  const text = String(name ?? "").replace(INVISIBLE, "");
  const words = [...wordsOfName(text, inDuskName), ...wordsOfName(text, (char) => inDuskName(char) || dotLike(char))];

  return [...new Set(words.map(withoutEdges))].filter((each) => {
    if (each === "") return false;

    const plain = dotted(each);
    const written = nameSkeleton(plain);

    return (
      [nameSkeleton(plain.toLowerCase()), written, digitShape(plain)].some((shape) => DUSK_ENDING.test(plainShape(shape))) ||
      PAIRED_DUSK_ENDING.test(plainShape(paired(written)))
    );
  });
}

/**
 * A .dusk name as the name service tells one from another: trimmed, its
 * ASCII capitals in lower case, all else as written, its points and hyphens
 * among it, so "ali-ce.dusk" and "al.ice.dusk" are other names than
 * "alice.dusk".
 *
 * @param {unknown} name
 */
const domainOf = (name) => String(name ?? "").trim().replace(/[A-Z]/g, (char) => char.toLowerCase());

// A .dusk name as the name service can register one, in lower case: labels of letters, digits and hyphens.
const REGISTRABLE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.dusk$/;

/**
 * A skeleton as a plain spelling compares it: without the marks over its
 * letters, in lower case.
 *
 * @param {string} shape
 */
const bare = (shape) => shape.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

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
const plainChar = (char) => {
  if (/^[\x21-\x7e]$/.test(char)) return char.toLowerCase();

  const shape = bare(nameSkeleton(char));

  return plainOf(shape) ?? (/^[a-z0-9.-]+$/.test(shape) ? shape : char);
};

/**
 * The .dusk name a word that reads as one reads as, in plain letters: its
 * styled letters as their ordinary ones (NFKC: mathematical bold, fullwidth),
 * each point as a full stop (`dotted`), then what's before its last point,
 * its look-alike letters and points as the ones they look like, and ".dusk",
 * as "ѕofiadesign.dusk" with a Cyrillic ѕ, "sofiadesign.clusk",
 * "sofiadesign·dusk" with a middle dot or "𝐬𝐨𝐟𝐢𝐚𝐝𝐞𝐬𝐢𝐠𝐧.dusk" is
 * sofiadesign.dusk; "" where it doesn't read as one the name service can
 * register.
 *
 * @param {string} word As `duskNamesIn` gives it
 */
function readingOf(word) {
  const chars = [...dotted(lettersOf(word)).normalize("NFD").replace(UNSEEN, "").replace(/\p{M}/gu, "")].map(plainChar);
  const point = chars.lastIndexOf(".");
  const reading = point > 0 ? `${chars.slice(0, point).join("")}.dusk` : "";

  return REGISTRABLE.test(reading) ? reading : "";
}

/**
 * Each .dusk name word of a name, as the name service names it (`written`),
 * and as it reads in plain letters (`reading`): "" for one it can't register.
 *
 * @param {unknown} name
 */
const duskWordsOf = (name) =>
  duskNamesIn(name).map((word) => {
    const written = domainOf(word);

    return { reading: readingOf(word), word, written: REGISTRABLE.test(written) ? written : "" };
  });

/**
 * @param {unknown} name
 * @returns {string[]}
 */
export function nameDuskNames(name) {
  /** @type {string[]} */
  const names = [];

  for (const { reading, written } of duskWordsOf(name)) {
    for (const each of [written, reading]) if (each && !names.includes(each)) names.push(each);
  }

  return names;
}

/**
 * @param {unknown} name
 * @param {unknown} [duskName]
 * @returns {boolean}
 */
export function passesForDuskName(name, duskName) {
  // In plain letters and points, so a .dusk in small capitals or circled letters, or after a fullwidth point or a
  // middle dot, ends it too.
  const typed = dotted(lettersOf(String(name ?? ""))).trim().toLowerCase().replace(/\.$/, "");

  return typed.endsWith(".dusk") && typed !== String(duskName ?? "").trim().toLowerCase();
}

/**
 * Whether one name's words are the first words of the other's, either way,
 * as the look-alike rules read them.
 *
 * @param {string[][]} keys `wordKeys` of one
 * @param {unknown} other
 */
const startsAs = (keys, other) => {
  const theirs = wordKeys(other);

  return keys.some((words, i) => begins(words, theirs[i], i === DIGIT_WORDS) || begins(theirs[i], words, i === DIGIT_WORDS));
};

/**
 * @template {{ name?: unknown, duskName?: unknown, account?: unknown, address?: unknown }} P
 * @template {{ name?: unknown, duskName?: unknown, address?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, self?: unknown, owners?: unknown }} [among]
 * @returns {import("./names.js").ProfileNameCheck<P, C> | null}
 */
export function profileNameCheck(name, { contacts = [], owners, profiles = [], self } = {}) {
  if (nameHides(name)) return { dusk: false, entry: null, kind: "hides", name: "", refused: true, words: NAME_HIDES };

  const clash = profileNameClash(name, { contacts, profiles, self });

  if (clash) {
    const other = shown(clash.name);
    const words =
      clash.kind === "profile"
        ? clash.same
          ? `Your other profile is called ${other}. Choose another name.`
          : `That looks like ${other}, one of your other profiles. Choose another name.`
        : clash.same
          ? `You have a contact called ${other}. Choose another name.`
          : `That looks like your contact ${other}. Choose another name.`;

    return /** @type {any} */ ({ dusk: clash.kind === "profile" && clash.name === String(clash.entry?.duskName ?? ""), entry: clash.entry, kind: clash.kind, name: clash.name, refused: true, words });
  }

  const others = othersThan({ contacts, profiles, self });
  /** @param {C} contact */
  const duskOf = (contact) => (contact?.duskName === undefined || contact.duskName === null || contact.duskName === "" ? "" : String(contact.duskName));
  // The profile's own: its verified .dusk name, that of a contact saved with its address, and those the name
  // service says are registered to it (`owners`), as each is written in the name.
  const mine = new Set([self, others.self?.account, others.self?.address].map((id) => String(id ?? "").trim()).filter(Boolean));
  const own = [others.self?.duskName, ...contacts.filter((each) => !others.contacts.includes(each)).map(duskOf)].filter((each) => each !== undefined && each !== null && each !== "");

  // A .dusk name in it the name service says is registered to another account, or one it looks like: refused,
  // as History would show this profile by that account's name.
  for (const { reading, written } of duskWordsOf(name)) {
    const writtenOwner = ownerOf(owners, written);

    if (writtenOwner && [...writtenOwner].some((id) => mine.has(id))) {
      own.push(written);
      continue;
    }

    for (const [dusk, owner] of /** @type {const} */ ([[written, writtenOwner], [reading, reading === written ? undefined : ownerOf(owners, reading)]])) {
      if (!owner || [...owner].some((id) => mine.has(id))) continue;

      const theirs = others.profiles.find((each) => owner.has(String(each?.account ?? "")) || owner.has(String(each?.address ?? "")));
      const known = theirs ? undefined : others.contacts.find((each) => owner.has(String(each?.address ?? "").trim()));
      const as = shown(dusk);
      const same = dusk === written;
      const words = theirs
        ? same
          ? `Your other profile is called ${as}. Choose another name.`
          : `That looks like ${as}, one of your other profiles. Choose another name.`
        : known
          ? same
            ? `You have a contact called ${shown(known.name)}, at ${as}. Choose another name.`
            : `That looks like ${as}, your contact ${shown(known.name)}'s. Choose another name.`
          : same
            ? `${as} belongs to another account. Choose another name.`
            : `That looks like ${as}, which belongs to another account. Choose another name.`;

      return /** @type {any} */ ({ dusk: true, entry: theirs ?? known ?? null, kind: theirs ? "profile" : known ? "contact" : "dusk", name: dusk, refused: true, words });
    }
  }

  /** @param {unknown} dusk */
  const isOwn = (dusk) => own.some((each) => domainOf(each) === domainOf(dusk));
  const keys = keysOf(name);
  const words = wordKeys(name);
  /** @param {C} contact @param {string} dusk */
  const contactAt = (contact, dusk) => /** @type {any} */ ({ dusk: true, entry: contact, kind: "contact", name: dusk, refused: false, words: `You have a contact called ${shown(contact.name)}, at ${shown(dusk)}. Is this someone else?` });
  /** @param {P} profile */
  const profileAt = (profile) => /** @type {any} */ ({ dusk: true, entry: profile, kind: "profile", name: String(profile.duskName), refused: false, words: `Your other profile is called ${shown(profile.duskName)}. Is this someone else?` });

  // A contact's .dusk name it is, or looks like: the contact it is, by name, as History shows that name for them.
  // Not one the profile's own: the name service says whose that is.
  const named = others.contacts.find((contact) => duskOf(contact) !== "" && !isOwn(duskOf(contact)) && alike(keys, keysOf(duskOf(contact))));

  if (named) return contactAt(named, duskOf(named));

  // A .dusk name it starts as, or that starts as it, word for word: another profile's, then a contact's.
  const profile = others.profiles.find((each) => each?.duskName && !isOwn(each.duskName) && startsAs(words, each.duskName));

  if (profile) return profileAt(profile);

  const at = others.contacts.find((contact) => duskOf(contact) !== "" && !isOwn(duskOf(contact)) && startsAs(words, duskOf(contact)));

  if (at) return contactAt(at, duskOf(at));

  // Any other .dusk name it holds, but the profile's own: whose it is where the wallet knows, else anyone's, as
  // History would show this profile by the name it shows that name's owner by.
  for (const dusk of duskNamesIn(name)) {
    if (isOwn(dusk)) continue;

    const theirs = keysOf(dusk);
    const other = others.profiles.find((each) => each?.duskName && alike(theirs, keysOf(each.duskName)));

    if (other) return profileAt(other);

    const known = others.contacts.find((each) => duskOf(each) !== "" && alike(theirs, keysOf(duskOf(each))));

    if (known) return contactAt(known, duskOf(known));

    return /** @type {any} */ ({ dusk: true, entry: null, kind: "dusk", name: dusk, refused: false, words: `${shown(dusk)} is a .dusk name. Is it this profile's?` });
  }

  // Then a contact's own name, as before.
  const contact = others.contacts.find((each) => namesOf(each, "contact").some((each) => startsAs(words, each)));

  return contact ? /** @type {any} */ ({ dusk: false, entry: contact, kind: "contact", name: String(contact.name), refused: false, words: `You have a contact called ${shown(contact.name)}. Is this someone else?` }) : null;
}

/**
 * Where a contact is, for the words of a check: ", at " and its address cut
 * short, as every Dusk app cuts it; "" for one without an address.
 *
 * @param {{ address?: unknown } | null | undefined} entry
 */
const atAddress = (entry) => {
  const address = String(entry?.address ?? "").trim();

  return address ? `, at ${shortAccount(address)}` : "";
};

/**
 * @template {{ name?: unknown, duskName?: unknown, account?: unknown, address?: unknown }} P
 * @template {{ name?: unknown, address?: unknown, id?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, except?: unknown, address?: unknown }} [among]
 * @returns {import("./names.js").ContactNameCheck<P, C> | null}
 */
export function contactNameCheck(name, { address, contacts = [], except, profiles = [] } = {}) {
  if (nameHides(name)) return { dusk: false, entry: null, kind: "hides", name: "", refused: true, words: NAME_HIDES };

  const saved = String(address ?? "").trim();
  // A profile takes nothing from a contact saved with its own address, and the contact changed nothing from itself.
  const own = profiles.filter((profile) => !saved || (String(profile?.account ?? "") !== saved && String(profile?.address ?? "") !== saved));
  const rest = contacts.filter((contact) => except === undefined || except === null || contact?.id !== except);
  /** @param {{ entry: P, name: string }} hit */
  const duskOf = (hit) => hit.name === String(hit.entry?.duskName ?? "");
  const clash = nameClash(name, { contacts: rest, profiles: own });

  // A profile's name, or its .dusk name, or one like it: refused, as Review would read the contact as that profile.
  if (clash?.kind === "profile") {
    const other = shown(clash.name);
    const words = clash.same ? `One of your profiles is called ${other}. Choose another name.` : `That looks like ${other}, one of your profiles. Choose another name.`;

    return /** @type {any} */ ({ dusk: duskOf(clash), entry: clash.entry, kind: "profile", name: clash.name, refused: true, words });
  }

  // Another contact's name, or one like it: asked, with that contact's address, as only it tells the two apart.
  if (clash) {
    const other = `${shown(clash.name)}${atAddress(clash.entry)}`;
    const words = clash.same ? `You have a contact called ${other}. Is this someone else?` : `That looks like your contact ${other}. Is this someone else?`;

    return /** @type {any} */ ({ dusk: false, entry: clash.entry, kind: "contact", name: clash.name, refused: false, words });
  }

  // A name a profile's or a contact's starts as, or that starts as theirs, word for word: asked.
  const starts = nameStarts(name, { contacts: rest, profiles: own });

  if (starts?.kind === "profile") return /** @type {any} */ ({ dusk: duskOf(starts), entry: starts.entry, kind: "profile", name: starts.name, refused: false, words: `One of your profiles is called ${shown(starts.name)}. Is this someone else?` });

  return starts
    ? /** @type {any} */ ({ dusk: false, entry: starts.entry, kind: "contact", name: starts.name, refused: false, words: `You have a contact called ${shown(starts.name)}${atAddress(starts.entry)}. Is this someone else?` })
    : null;
}

/**
 * @template {{ name?: unknown, address?: unknown }} T
 * @param {Iterable<T>} entries
 * @returns {Set<T>}
 */
export function lookAlikes(entries) {
  const list = [...entries].map((entry) => ({ address: String(entry?.address ?? ""), entry, keys: keysOf(entry?.name) }));
  /** @type {Set<T>} */
  const found = new Set();

  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      if (list[i].address !== list[j].address && alike(list[i].keys, list[j].keys)) {
        found.add(list[i].entry);
        found.add(list[j].entry);
      }
    }
  }

  return found;
}
