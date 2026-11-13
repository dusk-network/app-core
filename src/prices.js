/* @ts-self-types="./prices.d.ts" */
/**
 * What one DUSK is worth now in a person's currency, from the price source
 * both wallets use, CoinGecko, and what an amount of DUSK comes to at it,
 * with the time of that price. Test DUSK has no price.
 *
 * @module
 */

import { networkFor, networks } from "@dusk-network/networks";

import { amountLocale } from "./amounts.js";

/** @typedef {import("./prices.js").DuskPrice} DuskPrice */
/** @typedef {import("./prices.js").FactCache} FactCache */
/** @typedef {import("./prices.js").FetchLike} FetchLike */

/** Where both wallets read DUSK's price now: CoinGecko's coin, its market data alone. */
export const PRICE_URL =
  "https://api.coingecko.com/api/v3/coins/dusk-network?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false";

/** How long a price read is kept in `cache`: 5 minutes, in milliseconds. */
export const PRICE_MAX_AGE_MS = 300_000;

/** How long the price source has to answer: 15 seconds, in milliseconds. */
const TIMEOUT_MS = 15_000;

const LUX_DECIMALS = 9;
const CACHE_KEY = "dusk-price:";

/**
 * Whether a network's DUSK has a price: mainnet's alone, by the network, its
 * chain ID ("dusk:1", 1) or its name.
 *
 * @param {unknown} network
 */
function priced(network) {
  const { mainnet } = networks;

  if (network && typeof network === "object") return /** @type {{ chainId?: unknown }} */ (network).chainId === mainnet.chainId;
  if (String(network ?? "").trim().toLowerCase() === mainnet.name) return true;

  return (typeof network === "number" || typeof network === "bigint" || typeof network === "string") && networkFor(network)?.chainId === mainnet.chainId;
}

/**
 * A price kept in the cache, or null for what isn't one.
 *
 * @param {unknown} text
 * @returns {{ at: number, price: number, readAt: number } | null}
 */
function keptPrice(text) {
  try {
    const kept = JSON.parse(String(text ?? ""));

    return Number.isFinite(kept?.at) && Number.isFinite(kept?.readAt) && Number.isFinite(kept?.price) && kept.price > 0 ? kept : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ currency: string, network: unknown, fetch?: FetchLike, cache?: FactCache, maxAgeMs?: number, now?: number, timeoutMs?: number }} options
 * @returns {Promise<DuskPrice | null>}
 */
export async function duskPrice({ cache, currency, fetch: fetchFn = /** @type {FetchLike} */ (globalThis.fetch), maxAgeMs = PRICE_MAX_AGE_MS, network, now = Date.now(), timeoutMs = TIMEOUT_MS }) {
  const code = String(currency ?? "").trim().toUpperCase();

  if (!/^[A-Z]{3}$/.test(code) || !priced(network)) return null;

  const key = `${CACHE_KEY}${code}`;
  const kept = keptPrice(cache?.get(key));

  if (kept && now - kept.readAt >= 0 && now - kept.readAt < maxAgeMs) return { at: kept.at, currency: code, price: kept.price };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(PRICE_URL, { headers: { Accept: "application/json" }, method: "GET", signal: controller.signal });

    if (!response?.ok) return null;

    const data = JSON.parse(await response.text());
    const price = data?.market_data?.current_price?.[code.toLowerCase()];

    if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) return null;

    // The time the source gives its price, else the time it was read.
    const stamped = Date.parse(String(data?.market_data?.last_updated ?? data?.last_updated ?? ""));
    const at = Number.isFinite(stamped) ? stamped : now;

    cache?.set(key, JSON.stringify({ at, price, readAt: now }));

    return { at, currency: code, price };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A number as the plain decimal it's written as, without an exponent:
 * 6.0722e-2 is "0.060722", as the source wrote it.
 *
 * @param {number} number Finite, more than 0
 */
function plainOf(number) {
  const [mantissa, exponent = "0"] = String(number).toLowerCase().split("e");
  const [whole, fraction = ""] = mantissa.split(".");
  const digits = `${whole}${fraction}`;
  const point = whole.length + Number(exponent);

  if (point <= 0) return `0.${"0".repeat(-point)}${digits}`;

  return point >= digits.length ? `${digits}${"0".repeat(point - digits.length)}` : `${digits.slice(0, point)}.${digits.slice(point)}`;
}

/**
 * A price as digits, as the source wrote it, or null for what isn't a price.
 *
 * @param {unknown} price
 * @returns {{ digits: bigint, places: number } | null}
 */
function digitsOf(price) {
  const text = typeof price === "number" ? (Number.isFinite(price) && price > 0 ? plainOf(price) : "") : String(price ?? "").trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(text);

  if (!match) return null;

  const fraction = match[2] ?? "";
  const digits = BigInt(`${match[1]}${fraction}`);

  return digits > 0n ? { digits, places: fraction.length } : null;
}

/**
 * Units of `scale` decimals as a plain decimal, exactly: what Intl rounds once.
 *
 * @param {bigint} units
 * @param {number} scale
 */
const decimalOf = (units, scale) => {
  const step = 10n ** BigInt(scale);

  return `${units / step}.${(units % step).toString().padStart(scale, "0")}`;
};

/**
 * @param {bigint | number | string | null | undefined} lux
 * @param {DuskPrice | null | undefined} quote
 * @param {{ language?: string, timeZone?: string, now?: number }} [options]
 * @returns {{ value: string, text: string } | null}
 */
export function inCurrency(lux, quote, { language, now = Date.now(), timeZone } = {}) {
  if (lux === null || lux === undefined || !quote) return null;

  const amount = typeof lux === "bigint" ? lux : /^\s*\d+\s*$/.test(String(lux)) ? BigInt(String(lux).trim()) : null;
  const price = digitsOf(quote.price);

  if (amount === null || amount <= 0n || !price || !/^[A-Z]{3}$/i.test(String(quote.currency ?? ""))) return null;

  const locale = amountLocale(language);
  const money = new Intl.NumberFormat(locale, { currency: String(quote.currency).toUpperCase(), style: "currency" });
  const places = money.resolvedOptions().maximumFractionDigits ?? 2;
  // What it comes to, exactly, in units of `scale` decimals.
  const scale = LUX_DECIMALS + price.places;
  const units = amount * price.digits;
  // Less than the currency's smallest coin is under it, never 0.
  const value =
    units * 10n ** BigInt(places) < 10n ** BigInt(scale)
      ? `under ${money.format(/** @type {any} */ (places ? `0.${"1".padStart(places, "0")}` : "1"))}`
      : `≈ ${money.format(/** @type {any} */ (decimalOf(units, scale)))}`;

  if (!Number.isFinite(quote.at)) return { text: value, value };

  // The price's time: the hour, or the day and hour where it isn't today's.
  const day = new Intl.DateTimeFormat("en-CA", { day: "2-digit", month: "2-digit", timeZone, year: "numeric" });
  const today = day.format(quote.at) === day.format(now);
  const when = new Intl.DateTimeFormat(locale, today ? { hour: "2-digit", minute: "2-digit", timeZone } : { day: "numeric", hour: "2-digit", minute: "2-digit", month: "short", timeZone }).format(quote.at);

  return { text: `${value} · price at ${when}`, value };
}
