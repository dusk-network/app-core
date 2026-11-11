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
import { displayText } from "./text.js";

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
// What can't be seen: what renders as nothing, and controls, which turn text
// around or break it. A name is read without them.
const UNSEEN = /[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/gu;
// What a name is read by: its letters and digits.
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;

/** What an app says of a name it refuses for what can't be seen in it. */
export const NAME_HIDES = "This name has hidden characters. Type it again without them.";

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
 * contact saved with either of its addresses, are its own.
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

  return { contacts: contacts.filter((contact) => !itself(contact)), profiles: profiles.filter((profile) => profile !== named && !itself(profile)) };
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
 * written and in lower case, as `keysOf` reads the whole name.
 *
 * @param {unknown} name
 * @returns {string[][]}
 */
function wordKeys(name) {
  const text = String(name ?? "");

  return [wordsOf(text), wordsOf(nameSkeleton(text)), wordsOf(nameSkeleton(text.toLowerCase()))];
}

/**
 * Whether the words of one are the first words of the other, which has more.
 *
 * @param {string[]} short
 * @param {string[]} long
 */
const begins = (short, long) => short.length > 0 && short.length < long.length && short.every((word, i) => word === long[i]);

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

        if (keys.some((words, i) => begins(words, theirs[i]) || begins(theirs[i], words))) return /** @type {any} */ ({ entry, kind, name: String(each) });
      }
    }
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
