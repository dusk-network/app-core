import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { PRICE_MAX_AGE_MS, PRICE_URL, duskPrice, inCurrency } from "../src/prices.js";
import { readFixture } from "./fixtures/helpers.js";

// CoinGecko's answer, as the web wallet read it on 13 November 2026.
const answer = readFixture("coingecko-dusk.json");
const AT = Date.parse("2026-11-13T11:03:59.000Z");

/**
 * A price source that answers `body` with `status`, and what it was asked.
 *
 * @param {unknown} [body]
 * @param {number} [status]
 */
function source(body = answer, status = 200) {
  /** @type {{ url: string, init: any }[]} */
  const asked = [];
  /** @type {import("../src/prices.js").FetchLike} */
  const fetch = async (url, init) => {
    asked.push({ init, url });

    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) };
  };

  return { asked, fetch };
}

describe("DUSK's price now", () => {
  it("is CoinGecko's on mainnet, in the currency asked, with its time: where both wallets read values in a currency", async () => {
    const { asked, fetch } = source();

    assert.deepEqual(await duskPrice({ currency: "EUR", fetch, network: "mainnet", now: AT + 60_000 }), { at: AT, currency: "EUR", price: 0.060722 });
    assert.deepEqual(asked.map(({ init, url }) => [url, init.method]), [[PRICE_URL, "GET"]]);
    // In any case, and on mainnet however the wallet names it.
    for (const network of [networks.mainnet, 1, 1n, "1", "dusk:1", "Mainnet"]) {
      assert.deepEqual(await duskPrice({ currency: "jpy", fetch, network }), { at: AT, currency: "JPY", price: 10.73 }, String(network));
    }
  });

  it("is none for test DUSK, which has no value, and asks for nothing", async () => {
    const { asked, fetch } = source();

    for (const network of ["testnet", networks.testnet, 2, "dusk:2", "devnet", networks.devnet, 3, 0, "dusk:0", "local", "dusk:42", null, undefined, ""]) {
      assert.equal(await duskPrice({ currency: "EUR", fetch, network }), null, String(network));
    }

    assert.equal(asked.length, 0);
  });

  it("is none where the source gives no price in that currency, or doesn't answer", async () => {
    for (const [fetch, why] of /** @type {const} */ ([
      [source(answer, 429).fetch, "too many requests"],
      [source(answer, 500).fetch, "an error"],
      [source("<html>", 200).fetch, "a page, not its answer"],
      [source({ market_data: { current_price: { eur: 0 } } }).fetch, "a price of 0"],
      [source({ market_data: { current_price: { eur: "0.06" } } }).fetch, "a price as text"],
      [source({}).fetch, "no market data"],
      [async () => Promise.reject(new TypeError("Failed to fetch")), "offline"],
    ])) {
      assert.equal(await duskPrice({ currency: "EUR", fetch, network: 1 }), null, why);
    }

    // A currency it doesn't give, or none.
    assert.equal(await duskPrice({ currency: "XYZ", fetch: source().fetch, network: 1 }), null);
    assert.equal(await duskPrice({ currency: "", fetch: source().fetch, network: 1 }), null);
  });

  it("gives up on a source that doesn't answer in time", async () => {
    /** @type {import("../src/prices.js").FetchLike} */
    const silent = (_, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));

    assert.equal(await duskPrice({ currency: "EUR", fetch: silent, network: 1, timeoutMs: 5 }), null);
  });

  it("takes the time it was read where the source gives none", async () => {
    const { fetch } = source({ market_data: { current_price: { eur: 0.060722 } } });

    assert.deepEqual(await duskPrice({ currency: "EUR", fetch, network: 1, now: AT + 1 }), { at: AT + 1, currency: "EUR", price: 0.060722 });
  });

  it("keeps a price read for 5 minutes in the app's cache, by currency", async () => {
    const { asked, fetch } = source();
    const cache = new Map();
    const first = await duskPrice({ cache, currency: "EUR", fetch, network: 1, now: AT });

    assert.deepEqual(await duskPrice({ cache, currency: "EUR", fetch, network: 1, now: AT + PRICE_MAX_AGE_MS - 1 }), first);
    assert.equal(asked.length, 1);

    // Another currency is asked for, and the same once it's old.
    assert.deepEqual(await duskPrice({ cache, currency: "USD", fetch, network: 1, now: AT }), { at: AT, currency: "USD", price: 0.067096 });
    await duskPrice({ cache, currency: "EUR", fetch, network: 1, now: AT + PRICE_MAX_AGE_MS });
    assert.equal(asked.length, 3);
    assert.equal(PRICE_MAX_AGE_MS, 300_000);
  });
});

describe("an amount in the person's currency", () => {
  const quote = { at: AT, currency: "EUR", price: 0.060722 };

  it("is Sofía's request beside its DUSK, in her euros, with the price's time on her clock", () => {
    // 30 DUSK at 0.060722 € is 1.82166 €.
    assert.deepEqual(inCurrency(30_000_000_000n, quote, { language: "es-ES", now: AT + 60_000, timeZone: "Europe/Madrid" }), {
      text: "≈ 1,82 € · price at 12:03",
      value: "≈ 1,82 €",
    });
    // Her client's Send, in his language and money: 30 DUSK at 0.067096 $ is 2.01288 $.
    assert.deepEqual(inCurrency(30_000_000_000n, { at: AT, currency: "USD", price: 0.067096 }, { language: "en-US", now: AT, timeZone: "America/New_York" }), {
      text: "≈ $2.01 · price at 06:03 AM",
      value: "≈ $2.01",
    });
    // Each currency to its own smallest coin.
    assert.equal(inCurrency(1_000_000_000_000n, { at: AT, currency: "KWD", price: 0.02089638 }, { language: "en-US", now: AT })?.value, "≈ KWD 20.896");
    assert.equal(inCurrency(1_000_000_000_000n, { at: AT, currency: "JPY", price: 10.73 }, { language: "en-US", now: AT })?.value, "≈ ¥10,730");
  });

  it("is never 0: under the currency's smallest coin, as for a test request's 0.03 DUSK", () => {
    assert.equal(inCurrency(30_000_000n, quote, { language: "es-ES", now: AT })?.value, "under 0,01 €");
    assert.equal(inCurrency(30_000_000n, { at: AT, currency: "JPY", price: 10.73 }, { language: "en-US", now: AT })?.value, "under ¥1");
    assert.equal(inCurrency(30_000_000n, { at: AT, currency: "KWD", price: 0.02089638 }, { language: "en-US", now: AT })?.value, "under KWD 0.001");
    // One lux, at any price, is worth something.
    assert.equal(inCurrency(1n, quote, { language: "en-GB", now: AT })?.value, "under €0.01");
  });

  it("is worked out exactly and rounded once, so no cent moves: 50 DUSK at 0.0201 € is 1.005 €", () => {
    assert.equal(inCurrency(50_000_000_000n, { at: AT, currency: "EUR", price: 0.0201 }, { language: "en-GB", now: AT })?.value, "≈ €1.01");
    // A price the source writes with an exponent, as JSON can.
    assert.equal(inCurrency(1_000_000_000_000_000_000n, { at: AT, currency: "EUR", price: 6e-8 }, { language: "en-GB", now: AT })?.value, "≈ €60.00");
  });

  it("says the day of a price that isn't today's", () => {
    assert.equal(inCurrency(30_000_000_000n, quote, { language: "es-ES", now: AT + 86_400_000, timeZone: "Europe/Madrid" })?.text, "≈ 1,82 € · price at 13 nov, 12:03");
  });

  it("is nothing to show without a price or an amount: on testnet, or for a request of any amount", () => {
    assert.equal(inCurrency(30_000_000_000n, null), null);
    assert.equal(inCurrency(null, quote), null);
    assert.equal(inCurrency(undefined, quote), null);
    assert.equal(inCurrency(0n, quote), null);
    assert.equal(inCurrency("x", quote), null);
    assert.equal(inCurrency(1n, { ...quote, price: 0 }), null);
    // As text, as a request keeps its amount.
    assert.equal(inCurrency("30000000000", quote, { language: "es-ES", now: AT })?.value, "≈ 1,82 €");
  });
});
