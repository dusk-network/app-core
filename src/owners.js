/**
 * What a wallet's lookup said of a .dusk name (`owners`, by the names
 * `nameDuskNames` of `/names` gives): the one rule `/names` and
 * `/payment-links` read it by. Not an entry point.
 *
 * @module
 */

/**
 * What `owners` says a .dusk name is registered to: the accounts and
 * addresses it resolves to; null where it isn't registered; undefined where
 * it says nothing, as for one that wasn't looked up, or whose lookup failed.
 *
 * @param {unknown} owners A `Map`, or an object, by the names `nameDuskNames` gives
 * @param {string} dusk
 * @returns {Set<string> | null | undefined}
 */
export function ownerOf(owners, dusk) {
  if (!dusk || !owners || typeof owners !== "object") return undefined;

  const map = /** @type {{ has?: unknown, get?: unknown }} */ (owners);
  /** @type {unknown} */
  let owner;

  if (typeof map.has === "function" && typeof map.get === "function") {
    if (!map.has(dusk)) return undefined;

    owner = map.get(dusk);
  } else {
    if (!Object.hasOwn(owners, dusk)) return undefined;

    owner = /** @type {Record<string, unknown>} */ (owners)[dusk];
  }

  if (owner === null) return null;

  const said = /** @type {{ account?: unknown, address?: unknown }} */ (owner);
  const ids = typeof owner === "string" ? [owner] : owner && typeof owner === "object" ? [said.account, said.address] : [];
  const found = new Set(ids.map((id) => String(id ?? "").trim()).filter(Boolean));

  return found.size ? found : undefined;
}
