/* @ts-self-types="./names.d.ts" */
/**
 * Names a person gives, as a contact's or a profile's: whether two read as
 * the same name, or look alike though they're written differently, by
 * Unicode's confusables (UTS #39). Only for what a person reads: a name never
 * stands for an address.
 *
 * @module
 */

import { CONFUSABLES } from "./confusables.js";

/** @typedef {{ same: string, written: string, lower: string }} NameKeys */

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
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;

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
 * punctuation are off.
 *
 * @param {string} text
 */
const folded = (text) => text.normalize("NFD").replace(NOT_LETTER_OR_DIGIT, "").toLowerCase();

/**
 * A name's three keys: as a person reads it, and by what it looks like, as
 * written and in lower case, where a capital that looks like another letter
 * is the small one.
 *
 * @param {unknown} name
 * @returns {NameKeys}
 */
function keysOf(name) {
  const text = String(name ?? "");

  return { lower: folded(nameSkeleton(text.toLowerCase())), same: folded(text), written: folded(nameSkeleton(text)) };
}

/**
 * @param {NameKeys} a
 * @param {NameKeys} b
 */
const alike = (a, b) => (a.same !== "" && a.same === b.same) || (a.written !== "" && a.written === b.written) || (a.lower !== "" && a.lower === b.lower);

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
 * @template {{ name?: unknown }} P
 * @template {{ name?: unknown, id?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, except?: unknown }} [among]
 * @returns {{ kind: "profile", same: boolean, entry: P } | { kind: "contact", same: boolean, entry: C } | null}
 */
export function nameClash(name, { contacts = [], except, profiles = [] } = {}) {
  const keys = keysOf(name);
  const others = contacts.filter((contact) => except === undefined || except === null || contact?.id !== except);

  for (const [kind, list] of /** @type {const} */ ([["profile", profiles], ["contact", others]])) {
    const same = list.find((entry) => sameName(name, entry?.name));
    const entry = same ?? list.find((each) => alike(keys, keysOf(each?.name)));

    if (entry) return /** @type {any} */ ({ entry, kind, same: Boolean(same) });
  }

  return null;
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
