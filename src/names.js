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

/** @typedef {{ same: string, written: string, paired: string, lower: string }} NameKeys */

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
 * A skeleton with each letter that two others look like as those two, as
 * the name is written: "Wendy" as "VVendy" and "David" as "Davicl", as
 * Unicode's own table has "Emma" as "Ernrna". As written only: "Dara" in
 * lower case looks like "clara", but "Dara" doesn't look like "Clara".
 *
 * @param {string} shape A skeleton
 */
const paired = (shape) => shape.replace(PAIRS, (char) => PAIRED[char]);

/**
 * A name's four keys: as a person reads it, and by what it looks like, as
 * written, as written with its letter pairs, and in lower case, where a
 * capital that looks like another letter is the small one. The pairs are a
 * key of their own beside the written one, never in its place: "daIe" with
 * a capital I looks like "Dale" as written, though its d makes a pair the
 * capital D doesn't.
 *
 * @param {unknown} name
 * @returns {NameKeys}
 */
function keysOf(name) {
  const text = String(name ?? "");
  const written = nameSkeleton(text);

  return { lower: folded(nameSkeleton(text.toLowerCase())), paired: folded(paired(written)), same: folded(text), written: folded(written) };
}

/**
 * @param {NameKeys} a
 * @param {NameKeys} b
 */
const alike = (a, b) =>
  (a.same !== "" && a.same === b.same) || (a.written !== "" && a.written === b.written) || (a.paired !== "" && a.paired === b.paired) || (a.lower !== "" && a.lower === b.lower);

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
 * written, as written with its letter pairs, and in lower case, as `keysOf`
 * reads the whole name.
 *
 * @param {unknown} name
 * @returns {string[][]}
 */
function wordKeys(name) {
  const text = String(name ?? "");
  const written = nameSkeleton(text);

  return [wordsOf(text), wordsOf(written), wordsOf(paired(written)), wordsOf(nameSkeleton(text.toLowerCase()))];
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
 * A name as the words of a check show it: what can't be seen in it as its
 * codes, so one kept from before can't read as another.
 *
 * @param {unknown} name
 */
const shown = (name) => (nameHides(name) ? displayText(name).text : String(name ?? ""));

/**
 * Whether one name's words are the first words of the other's, either way,
 * as the look-alike rules read them.
 *
 * @param {string[][]} keys `wordKeys` of one
 * @param {unknown} other
 */
const startsAs = (keys, other) => {
  const theirs = wordKeys(other);

  return keys.some((words, i) => begins(words, theirs[i]) || begins(theirs[i], words));
};

/**
 * @template {{ name?: unknown, duskName?: unknown, account?: unknown, address?: unknown }} P
 * @template {{ name?: unknown, duskName?: unknown, address?: unknown }} C
 * @param {unknown} name
 * @param {{ profiles?: ReadonlyArray<P>, contacts?: ReadonlyArray<C>, self?: unknown }} [among]
 * @returns {import("./names.js").ProfileNameCheck<P, C> | null}
 */
export function profileNameCheck(name, { contacts = [], profiles = [], self } = {}) {
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
  const keys = keysOf(name);
  const words = wordKeys(name);
  /** @param {C} contact */
  const duskOf = (contact) => (contact?.duskName === undefined || contact.duskName === null || contact.duskName === "" ? "" : String(contact.duskName));
  /** @param {C} contact @param {string} dusk */
  const contactAt = (contact, dusk) => /** @type {any} */ ({ dusk: true, entry: contact, kind: "contact", name: dusk, refused: false, words: `You have a contact called ${shown(contact.name)}, at ${shown(dusk)}. Is this someone else?` });

  // A contact's .dusk name it is, or looks like: the contact it is, by name, as History shows that name for them.
  const named = others.contacts.find((contact) => duskOf(contact) !== "" && alike(keys, keysOf(duskOf(contact))));

  if (named) return contactAt(named, duskOf(named));

  // A .dusk name it starts as, or that starts as it, word for word: another profile's, then a contact's.
  const profile = others.profiles.find((each) => each?.duskName && startsAs(words, each.duskName));

  if (profile) return /** @type {any} */ ({ dusk: true, entry: profile, kind: "profile", name: String(profile.duskName), refused: false, words: `Your other profile is called ${shown(profile.duskName)}. Is this someone else?` });

  const at = others.contacts.find((contact) => duskOf(contact) !== "" && startsAs(words, duskOf(contact)));

  if (at) return contactAt(at, duskOf(at));

  // Then a contact's own name, as before.
  const contact = others.contacts.find((each) => namesOf(each, "contact").some((each) => startsAs(words, each)));

  return contact ? /** @type {any} */ ({ dusk: false, entry: contact, kind: "contact", name: String(contact.name), refused: false, words: `You have a contact called ${shown(contact.name)}. Is this someone else?` }) : null;
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
