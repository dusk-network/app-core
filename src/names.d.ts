/**
 * Names a person gives, as a contact's or a profile's, for both wallets:
 * whether two read as the same name, or look alike though they're written in
 * other letters, by Unicode's confusables (UTS #39, version 18.0.0, kept in
 * the package as data). For what a person reads only: a payment goes to an
 * address, and a name never stands for one.
 *
 * @example
 * ```js
 * import { lookAlikes, looksAlike, nameClash } from "@dusk/app-core/names";
 *
 * looksAlike("Bob", "Bօb"); // true: an Armenian օ
 * nameClash("Profile 2", { profiles, contacts, except: editedId });
 * // { kind: "profile", same: true, entry: { name: "Profile 2", … } }: refuse it
 * lookAlikes([...profiles, ...contacts]); // the ones to show with their address
 * ```
 *
 * @module
 */

/**
 * A name by what it looks like, as UTS #39 makes its skeleton: decomposed
 * (NFD), without what renders as nothing, each character as the one it looks
 * like, and decomposed again. Case stays: a capital I looks like a small l.
 * Two names with the same skeleton look alike.
 */
export declare function nameSkeleton(name: unknown): string;

/**
 * Whether two names read as the same name: whatever their case, accents,
 * spaces and punctuation, as "Estudio Marta" and "estudio marta." do. False
 * for a name of none of its letters or digits.
 */
export declare function sameName(a: unknown, b: unknown): boolean;

/**
 * Whether two names look alike: they read as the same name, or have the same
 * skeleton once case, accents, spaces and punctuation are off, as written or
 * in lower case. "Bob" and "Bօb" (Armenian), "Sam" and "Ꮪam" (Cherokee),
 * "Kim" and "Kɪm" (a small capital I), "Ian" and "lan".
 */
export declare function looksAlike(a: unknown, b: unknown): boolean;

/**
 * The name a new or changed contact's name takes, or looks like, of the
 * person's own profiles first, then of their other contacts: `except` is the
 * ID of the contact being changed. `same` says it reads as that name, rather
 * than looking like it in other letters. A contact that takes a profile's name
 * would read as that profile wherever money is confirmed: refuse it. One that
 * takes a contact's can be saved, with the other's address beside it. Null
 * for none.
 */
export declare function nameClash<P extends { name?: unknown }, C extends { name?: unknown; id?: unknown }>(
  name: unknown,
  among?: { profiles?: ReadonlyArray<P>; contacts?: ReadonlyArray<C>; except?: unknown }
): { kind: "profile"; same: boolean; entry: P } | { kind: "contact"; same: boolean; entry: C } | null;

/**
 * The entries whose name looks like another's of another address, profiles
 * and contacts alike: a list or a picker shows each with its address, so two
 * that read the same can be told apart.
 */
export declare function lookAlikes<T extends { name?: unknown; address?: unknown }>(entries: Iterable<T>): Set<T>;
