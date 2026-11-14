/**
 * Names a person gives, as a contact's or a profile's, for both wallets:
 * whether two read as the same name, or look alike though they're written in
 * other letters, by Unicode's confusables (UTS #39, version 18.0.0, kept in
 * the package as data), and whether one holds what can't be seen. For what a
 * person reads only: a payment goes to an address, and a name never stands
 * for one.
 *
 * @example
 * ```js
 * import { NAME_HIDES, NAME_SAVE_YES, contactNameCheck, lookAlikes, looksAlike, nameClash, nameDuskNames, nameHides, nameStarts, profileNameCheck, profileNameClash } from "@dusk/app-core/names";
 *
 * nameHides("\u202eecilA"); // true: it reads as "Alice". Refuse it, saying NAME_HIDES
 * looksAlike("Bob", "Bօb"); // true: an Armenian օ
 * looksAlike("Wendy", "VVendy"); // true: two v's for a w
 * looksAlike("David", "Dav1d"); // true: a 1 for an i
 * profileNameCheck("alice.dusk", { profiles, contacts: [{ name: "Wendy", duskName: "alice.dusk", address }], self });
 * // { refused: false, kind: "contact", dusk: true, name: "alice.dusk", entry, words: "You have a contact called Wendy, at alice.dusk. Is this someone else?" }:
 * // not saved until it's answered, with NAME_SAVE_YES
 * profileNameCheck("sofiadesign.dusk", { profiles, contacts, self });
 * // { refused: false, kind: "dusk", dusk: true, name: "sofiadesign.dusk", entry: null, words: "sofiadesign.dusk is a .dusk name. Is it this profile's?" }
 * // Looked up first, as Send looks a name up: refused where it's another account's.
 * nameDuskNames("sofiadesign.dusk"); // ["sofiadesign.dusk"]
 * profileNameCheck("sofiadesign.dusk", { profiles, contacts, self, owners: new Map([["sofiadesign.dusk", { account: sofias }]]) });
 * // { refused: true, kind: "dusk", dusk: true, name: "sofiadesign.dusk", entry: null, words: "sofiadesign.dusk belongs to another account. Choose another name." }
 * contactNameCheck("Lucas", { profiles, contacts: [{ id: "c1", name: "Lucas (petit-fils)", address }], address: other });
 * // { refused: false, kind: "contact", dusk: false, name: "Lucas (petit-fils)", entry, words: "You have a contact called Lucas (petit-fils), at 23zcbk…hjmd3E. Is this someone else?" }
 * nameClash("Profile 2", { profiles, contacts, except: editedId });
 * // { kind: "profile", same: true, entry: { name: "Profile 2", … }, name: "Profile 2" }: refuse it
 * profileNameClash("sofiadesign.dusk", { profiles: [{ account, name: "Profile 1", duskName: "sofiadesign.dusk" }, …], contacts, self: other });
 * // { kind: "profile", same: true, entry: { name: "Profile 1", … }, name: "sofiadesign.dusk" }: refuse it too
 * nameStarts("Lucas (petit-fils)", { profiles }); // { kind: "profile", entry: { name: "Lucas", … }, name: "Lucas" }: ask
 * lookAlikes([...profiles, ...contacts]); // the ones to show with their address
 * ```
 *
 * @module
 */

/**
 * A name by what it looks like, as UTS #39 makes its skeleton: decomposed
 * (NFD), without what renders as nothing, each character as the one it looks
 * like, and decomposed again. Case stays: a capital I looks like a small l.
 * Two names with the same skeleton look alike. Unicode's table has an m as
 * rn; the letter pairs `looksAlike` reads too, vv for a w and cl for a d,
 * aren't in it, so a search by it doesn't find every d in "cl".
 */
export declare function nameSkeleton(name: unknown): string;

/**
 * Whether two names read as the same name: whatever their case, accents,
 * spaces and punctuation, as "Estudio Marta" and "estudio marta." do, and
 * without what can't be seen in them (`nameHides`), as "Ali\u200bce" and
 * "Alice". False for a name of none of its letters or digits.
 */
export declare function sameName(a: unknown, b: unknown): boolean;

/**
 * Whether a name holds what can't be seen as it's shown, which can make it
 * read as another: a control that turns text around (U+202E makes
 * "\u202e2 eliforP" read as "Profile 2"), a character that renders as
 * nothing (a zero-width space or joiner, a soft hyphen, a Hangul filler, a
 * joiner between emoji, a variation selector on what it can't change the
 * look of, as U+FE0F after "Alice"), a line break, another control, or half a
 * character. What `displayText` of `/text` shows as codes; an emoji's own
 * selector, a keycap's and accents aren't. Refuse a new or changed contact's
 * or profile's name that does (`NAME_HIDES`), and show one kept from before
 * with `displayText(name).text`, which shows them as codes.
 */
export declare function nameHides(name: unknown): boolean;

/** "This name has hidden characters. Type it again without them." */
export declare const NAME_HIDES: "This name has hidden characters. Type it again without them.";

/**
 * "Yes, save it": what answers the question a name asks at Save
 * (`profileNameCheck`, `contactNameCheck`), in both wallets. A name asked
 * about isn't saved until it's answered so; changed, it's checked again.
 * Only a click or a tap on it answers it: the question and its button never
 * take the focus, and Enter in the name's field (or a second Save) asks
 * again, so a habit's Enter, Enter can't say yes.
 */
export declare const NAME_SAVE_YES: "Yes, save it";

/**
 * Whether two names look alike: they read as the same name, or have the same
 * skeleton once case, accents, spaces and punctuation are off, as written or
 * in lower case. "Bob" and "Bօb" (Armenian), "Sam" and "Ꮪam" (Cherokee),
 * "Kim" and "Kɪm" (a small capital I), "Ian" and "lan". As written, the
 * letter pairs that look like one letter in most fonts are that letter too,
 * beside the name as written, never in its place (so "daIe" still looks like
 * "Dale"):
 * "VVendy" looks like "Wendy", "Davicl" like "David", and "Ernma" like
 * "Emma", as Unicode's table has it; "Clara" and "Dara" don't, as their
 * capitals tell them apart. So do the digits that stand in for letters, a 1
 * for an i or an l, each 1 on its own, a 0 for an o and a 5 for an s, and a
 * small v for a y: "Dav1d" looks like "David", "A1ice" like "Alice",
 * "L11ian" like "Lilian", "Ro5a" like "Rosa" and "Wendv" like "Wendy"; "ian"
 * and "lan" don't, nor "Lilian" and "Liiian", nor "Yan" and "Van". The other
 * checks here read names so too.
 */
export declare function looksAlike(a: unknown, b: unknown): boolean;

/**
 * The name a new or changed contact's name takes, or looks like, of the
 * person's own profiles first, by the name each was given and by its
 * verified .dusk name (`duskName`), then of their other contacts: `except`
 * is the ID of the contact being changed. `name` is the name it takes, as
 * that entry goes by it, and `same` says it reads as that name, rather than
 * looking like it in other letters. A contact that takes a profile's name
 * would read as that profile wherever money is confirmed: refuse it. One that
 * takes a contact's can be saved, with the other's address beside it. Null
 * for none.
 */
export declare function nameClash<P extends { name?: unknown; duskName?: unknown }, C extends { name?: unknown; id?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; except?: unknown }
): { kind: "profile"; same: boolean; entry: P; name: string } | { kind: "contact"; same: boolean; entry: C; name: string } | null;

/**
 * The name a profile's new name takes, or looks like, as `nameClash` says it
 * for a contact's: of the person's other profiles first, by the name each
 * was given and by its verified .dusk name (`duskName`), as "sofiadesign.dusk"
 * of the wallet's other profile, then of their contacts. `self` is the
 * account or address of the profile named: it, its own .dusk name and a
 * contact saved with its address take nothing from it. Refuse both kinds: a
 * profile named like another, or like a contact, reads as that one in
 * History and on Review. Null for none.
 */
export declare function profileNameClash<P extends { name?: unknown; duskName?: unknown; account?: unknown; address?: unknown }, C extends { name?: unknown; address?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; self?: unknown }
): { kind: "profile"; same: boolean; entry: P; name: string } | { kind: "contact"; same: boolean; entry: C; name: string } | null;

/**
 * The profile, then the contact, whose name starts with this one's, word for
 * word, or is the start of it, as the look-alike rules read names (whatever
 * their case, accents, spaces, punctuation and what can't be seen, and in
 * letters that look alike): "Lucas" and "Lucas (petit-fils)", but not "Ann"
 * and "Anna". A profile's verified .dusk name (`duskName`) counts as one of
 * its names. For a question, not a refusal: the two read differently, but a
 * glance can take one for the other, as Send's "From Lucas … To Lucas
 * (petit-fils)". Pass what to check against: a contact's name against
 * `profiles` and the other contacts, a profile's against `contacts` (and
 * `self`, as `profileNameClash` takes it). The same name is `nameClash`'s,
 * not this. A name at Save is `profileNameCheck`'s or `contactNameCheck`'s,
 * which ask in the wallets' words. Null for none.
 */
export declare function nameStarts<P extends { name?: unknown; duskName?: unknown; account?: unknown; address?: unknown }, C extends { name?: unknown; address?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; self?: unknown }
): { kind: "profile"; entry: P; name: string } | { kind: "contact"; entry: C; name: string } | null;

/**
 * What a profile's new name says at Save, in the words both wallets show on
 * the form, or null for nothing: `refused` (it isn't saved) or a question
 * (it isn't saved until it's answered, `NAME_SAVE_YES`; the question shows
 * under the field), the profile or contact it's about (`entry`, `kind`), the
 * name of theirs it takes or starts as (`name`), and whether that's a .dusk
 * name (`dusk`). In this order:
 *
 * - one that hides what can't be seen (`nameHides`): refused, `NAME_HIDES`;
 * - one that is, or looks like, another profile's name or .dusk name, or a
 *   contact's name (`profileNameClash`): refused, "Your other profile is
 *   called sofiadesign.dusk. Choose another name.", "That looks like Profile
 *   1, one of your other profiles. Choose another name.", "You have a contact
 *   called Alice. Choose another name." or "That looks like your contact
 *   Alice. Choose another name.";
 * - one with a .dusk name in it that the name service says is registered to
 *   another account (`owners`), as written or as it reads in plain letters
 *   (`nameDuskNames`): refused, as Marek's Profile 2 named
 *   "sofiadesign.dusk", Sofía's, which History then showed his own transfers
 *   by: "sofiadesign.dusk belongs to another account. Choose another name.",
 *   or written in look-alike letters, as with a Cyrillic ѕ, "That looks like
 *   sofiadesign.dusk, which belongs to another account. Choose another
 *   name."; naming whose where the wallet knows (`kind` "profile" or
 *   "contact", `entry` that one): "Your other profile is called
 *   sofiadesign.dusk. Choose another name.", "You have a contact called
 *   Sofía, at sofiadesign.dusk. Choose another name.", "That looks like
 *   sofiadesign.dusk, your contact Sofía's. Choose another name."; and one
 *   it says is registered to this profile (to `self`, or to its account or
 *   shielded address) is its own, as its verified .dusk name is, and asks
 *   nothing;
 * - one that is, or looks like, a contact's .dusk name (`duskName`, the name
 *   a contact was saved from), as Marek's profile named "alice.dusk", his
 *   contact Wendy's: asked, naming the contact it is, "You have a contact
 *   called Wendy, at alice.dusk. Is this someone else?", as History shows
 *   Wendy's payments by that name;
 * - one that starts as another profile's .dusk name, or is the start of it,
 *   word for word, as Sofía's "sofiadesign.dusk cliente" or "sofiadesign":
 *   asked, "Your other profile is called sofiadesign.dusk. Is this someone
 *   else?"; then a contact's .dusk name so, as above;
 * - one with any other .dusk name in it, a word that reads as one by the
 *   look-alike rules, in any case, in letters that look like one's, with
 *   marks over them, or in the letter pairs that look like one ("sofia.𝐃𝐔𝐒𝐊",
 *   "sofia.dúsk", "sofia.clusk") (`kind` "dusk", `entry` null), as Marek's
 *   profile named "sofiadesign.dusk", the name of someone he paid and History
 *   shows by it, where the name service doesn't say whose it is (not looked
 *   up, the lookup failed, or not registered): asked, "sofiadesign.dusk is a
 *   .dusk name. Is it this profile's?"; where it's another profile's .dusk
 *   name or a contact's, as above, naming them;
 * - one that starts as a contact's name, or is the start of it: asked, "You
 *   have a contact called Lucas (petit-fils). Is this someone else?".
 *
 * `self` is the account or address of the profile named, as
 * `profileNameClash` takes it: its own .dusk name, and a contact saved with
 * its address, ask nothing: its own as the name service tells names apart,
 * in any case, so "ali-ce.dusk" or "al.ice.dusk" for a profile that is
 * "alice.dusk" asks. The names in the words show what can't be seen in them
 * as codes.
 *
 * `owners` is what the wallet's name lookup said of each name
 * `nameDuskNames` gives for this one, by that name (a `Map`, or an object):
 * what it resolves to, its public account and shielded address
 * (`{ account, address }`, or the account alone, as text), or null where it
 * isn't registered (absent or expired). Leave out a name whose lookup
 * failed, or that has no address: it's asked about, as without `owners`.
 */
export declare function profileNameCheck<P extends { name?: unknown; duskName?: unknown; account?: unknown; address?: unknown }, C extends { name?: unknown; duskName?: unknown; address?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; self?: unknown; owners?: DuskNameOwners }
): ProfileNameCheck<P, C> | null;

/** What a wallet's name lookup said of a .dusk name: what it resolves to, or null where it isn't registered. */
export type DuskNameOwner = { account?: string | null; address?: string | null } | string | null;

/** `DuskNameOwner`s by the names `nameDuskNames` gives: one left out wasn't looked up, or its lookup failed. */
export type DuskNameOwners = ReadonlyMap<string, DuskNameOwner> | Readonly<Record<string, DuskNameOwner>>;

/**
 * The .dusk names a profile's name holds, to look up before
 * `profileNameCheck` says whose they are (`owners`), as the name service
 * names them: each that reads as one, parted from the rest at spaces and at
 * punctuation that can't be in one ("alice.dusk,bob.dusk" holds two), as
 * it's written, in lower case, where the name service could register it
 * ("SofiaDesign.DUSK" is "sofiadesign.dusk"), and as it reads in plain
 * letters, where it's written in styled letters or in letters or points
 * that look like others ("E𝐦𝐦a.dusk" in mathematical bold is "emma.dusk";
 * "ѕofiadesign.dusk" with a Cyrillic ѕ, "sofiadesign.clusk" and
 * "sofiadesign.du5k" are "sofiadesign.dusk"). Each once; none for a name
 * without one.
 */
export declare function nameDuskNames(name: unknown): string[];

/** What `profileNameCheck` says of a profile's name: refused or asked, in words, and whose name it's about. */
export type ProfileNameCheck<P, C> =
  | { refused: true; words: "This name has hidden characters. Type it again without them."; kind: "hides"; entry: null; name: ""; dusk: false }
  | { refused: boolean; words: string; kind: "dusk"; entry: null; name: string; dusk: true }
  | { refused: boolean; words: string; kind: "profile"; entry: P; name: string; dusk: boolean }
  | { refused: boolean; words: string; kind: "contact"; entry: C; name: string; dusk: boolean };

/**
 * What a contact's new or changed name says at Save, in the words both
 * wallets show on the form, or null for nothing, as `profileNameCheck` says
 * it of a profile's: `refused` (it isn't saved) or a question (it isn't
 * saved until it's answered, `NAME_SAVE_YES`), and whose name it's about
 * (`entry`, `kind`, `name`, `dusk`). In this order:
 *
 * - one that hides what can't be seen (`nameHides`): refused, `NAME_HIDES`;
 * - one that is, or looks like, a profile's name or verified .dusk name
 *   (`nameClash`): refused, "One of your profiles is called Profile 1.
 *   Choose another name." or "That looks like Profile 1, one of your
 *   profiles. Choose another name.", as Review would read the contact as
 *   that profile;
 * - one that is, or looks like, another contact's name: asked, with that
 *   contact's address cut short, "You have a contact called Lucas, at
 *   23zcbk…hjmd3E. Is this someone else?" or "That looks like your contact
 *   Lucas, at 23zcbk…hjmd3E. Is this someone else?", as only the address
 *   tells the two apart;
 * - one that starts as a profile's name, or is the start of it, word for
 *   word (`nameStarts`): asked, "One of your profiles is called Lucas. Is
 *   this someone else?";
 * - one that starts as another contact's name, or is the start of it, as
 *   Amélie's new "Lucas" beside "Lucas (petit-fils)", the "new phone, new
 *   account" trick: asked, "You have a contact called Lucas (petit-fils), at
 *   23zcbk…hjmd3E. Is this someone else?".
 *
 * `except` is the ID of the contact changed, which takes nothing from its
 * own name. `address` is the address the contact is saved with: the profile
 * whose own account or shielded address it is takes nothing from it either.
 * A name that looks like a .dusk name the contact isn't saved from is each
 * wallet's own rule, before this. The names in the words show what can't be
 * seen in them as codes.
 */
export declare function contactNameCheck<P extends { name?: unknown; duskName?: unknown; account?: unknown; address?: unknown }, C extends { name?: unknown; address?: unknown; id?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; except?: unknown; address?: unknown }
): ContactNameCheck<P, C> | null;

/** What `contactNameCheck` says of a contact's name: refused or asked, in words, and whose name it's about. */
export type ContactNameCheck<P, C> =
  | { refused: true; words: "This name has hidden characters. Type it again without them."; kind: "hides"; entry: null; name: ""; dusk: false }
  | { refused: boolean; words: string; kind: "profile"; entry: P; name: string; dusk: boolean }
  | { refused: false; words: string; kind: "contact"; entry: C; name: string; dusk: false };

/**
 * The entries whose name looks like another's of another address, profiles
 * and contacts alike: a list or a picker shows each with its address, so two
 * that read the same can be told apart.
 */
export declare function lookAlikes<T extends { name?: unknown; address?: unknown }>(entries: Iterable<T>): Set<T>;
