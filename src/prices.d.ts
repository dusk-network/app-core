/**
 * What one DUSK is worth now in a person's currency, for both wallets: read
 * from the price source they use, CoinGecko, on mainnet alone, as test DUSK
 * has no price; and what an amount of DUSK comes to at it, beside the DUSK,
 * with the time of that price. A request's link stays in DUSK: this is for
 * what a person reads.
 *
 * @example
 * ```js
 * import { duskPrice, inCurrency } from "@dusk/app-core/prices";
 *
 * const quote = await duskPrice({ currency: "EUR", network: "mainnet", fetch, cache });
 * // { currency: "EUR", price: 0.060722, at: 1763031839000 }; null on testnet, or where CoinGecko doesn't answer
 * inCurrency(30_000_000_000n, quote, { language: "es-ES" });
 * // { value: "≈ 1,82 €", text: "≈ 1,82 € · price at 12:03" }
 * inCurrency(30_000_000n, quote, { language: "es-ES" });
 * // { value: "under 0,01 €", text: "under 0,01 € · price at 12:03" }
 * inCurrency(30_000_000_000n, null); // null: nothing to show
 * ```
 *
 * @module
 */

import type { NetworkRef } from "@dusk-network/networks";

/** Where both wallets read DUSK's price now: CoinGecko's coin, its market data alone. */
export declare const PRICE_URL: "https://api.coingecko.com/api/v3/coins/dusk-network?community_data=false&developer_data=false&localization=false&market_data=true&sparkline=false&tickers=false";

/** How long a price read is kept in `cache`: 5 minutes, in milliseconds. */
export declare const PRICE_MAX_AGE_MS: 300000;

/** The app's cache, as text: a Map does. */
export type FactCache = { get(key: string): string | null | undefined; set(key: string, value: string): unknown };

/** A `fetch`, as the price's request uses it: a GET, and the answer's status and text. */
export type FetchLike = (
  input: string,
  init: { method: "GET"; headers: Record<string, string>; signal: AbortSignal }
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** What one DUSK was worth in a currency, and when, as the price source said it. */
export type DuskPrice = {
  /** Its code, in capitals: "EUR". */
  currency: string;
  /** What one DUSK was worth in it. */
  price: number;
  /** When the source last set it, in milliseconds: else when it was read. */
  at: number;
};

/**
 * What one DUSK is worth now in `currency` (a code the price source gives,
 * as `PRICE_CURRENCIES` of `/amounts` lists them, any case), from
 * `PRICE_URL`, the source both wallets read their values in a currency
 * from, with its time. Null off mainnet, as test DUSK has no price, and
 * where the source doesn't answer within `timeoutMs` (15 s), answers with
 * an error, or gives no price in that currency: then show none. `network`
 * is the wallet's: a network, its chain ID ("dusk:1", 1) or its name. With
 * `cache`, a `Map` of text does, a price read is kept for `maxAgeMs`
 * (`PRICE_MAX_AGE_MS`), by currency: one request a currency in that time.
 */
export declare function duskPrice(options: {
  currency: string;
  network: NetworkRef | null | undefined;
  /** The `fetch` to read it with; `globalThis.fetch` when not given. */
  fetch?: FetchLike;
  cache?: FactCache;
  maxAgeMs?: number;
  /** The clock, in milliseconds. */
  now?: number;
  timeoutMs?: number;
}): Promise<DuskPrice | null>;

/**
 * What an amount of DUSK, in lux, comes to at a price, in its currency, in
 * the words both wallets show beside the DUSK: `value`, "≈ 1,82 €", in the
 * person's language (`language`, the browser's unless given), rounded to the
 * currency's smallest coin, or "under 0,01 €" below it, never 0; and `text`,
 * the same with the price's time, "≈ 1,82 € · price at 12:03", its day too
 * where it isn't today's on the clock of `timeZone` (the device's, unless
 * given): "≈ 1,82 € · price at 12 nov, 12:03". Null where there's nothing to
 * show: no price (`duskPrice`'s null, as on testnet), or no amount, as a
 * request of any amount.
 */
export declare function inCurrency(
  lux: bigint | number | string | null | undefined,
  quote: DuskPrice | null | undefined,
  options?: { language?: string; timeZone?: string; now?: number }
): { value: string; text: string } | null;
