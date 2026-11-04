import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
  amountForField,
  amountLocale,
  decimalSeparator,
  formatDusk,
  formatDuskPlain,
  groupDigits,
  normalizeAmount,
  parseDusk,
  unclearAmount,
} from "../src/amounts.js";

describe("amounts", () => {
  it("shows at most 4 decimals, and 2 significant digits under 0.01", () => {
    assert.deepEqual(formatDusk(1_853_542n, { locale: "en" }), { exact: "0.001853542", text: "0.0019" });

    for (const [lux, text] of [
      [173_852_610_026n, "173.8526"],
      [99_999n, "0.0001"],
      [12_345n, "0.000012"],
      [1n, "0.000000001"],
      [9_999_999n, "0.01"],
      [10_000_000n, "0.01"],
      [1_500_000_000n, "1.5"],
      [0n, "0"],
      ["-500000000", "−0.5"],
    ]) {
      assert.equal(formatDusk(lux, { locale: "en" }).text, text, String(lux));
    }
  });

  it("rounds down for balances, up for fees, and to the nearest otherwise", () => {
    for (const [lux, round, text] of /** @type {const} */ ([
      [1_853_542n, "down", "0.0018"],
      [1_853_542n, "up", "0.0019"],
      [1_850_000n, undefined, "0.0019"],
      [99_999n, "down", "0.000099"],
      [173_852_650_000n, "down", "173.8526"],
      [173_852_610_001n, "up", "173.8527"],
    ])) {
      assert.equal(formatDusk(lux, { locale: "en", round }).text, text, `${lux} ${round}`);
    }
  });

  it("never shows an amount that isn't 0 as 0, nor past it the wrong way", () => {
    let seed = 7;
    const next = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed;
    };

    for (let i = 0; i < 3000; i++) {
      const lux = BigInt(next()) ** BigInt(1 + (i % 3)) / BigInt(1 + (next() % 1000));

      if (lux === 0n) continue;

      const exact = Number(formatDuskPlain(lux));
      const down = Number(formatDusk(lux, { locale: "en", round: "down" }).text.replaceAll(",", ""));
      const up = Number(formatDusk(lux, { locale: "en", round: "up" }).text.replaceAll(",", ""));

      assert.ok(down > 0 && up > 0, String(lux));
      assert.ok(down <= exact && up >= exact, String(lux));
    }
  });

  it("gives the exact amount too, all 9 decimals with the zeros trimmed", () => {
    assert.deepEqual(formatDusk(173_852_610_026n, { locale: "en", mode: "exact" }), {
      exact: "173.852610026",
      text: "173.852610026",
    });
    assert.equal(formatDusk(1_000_000_000n, { mode: "exact", locale: "en" }).text, "1");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "en" }).exact, "123,456,789.012345678");
  });

  it("writes the separators and digits of the locale", () => {
    assert.deepEqual(formatDusk(173_852_610_026n, { locale: "nl-NL" }), {
      exact: "173,852610026",
      text: "173,8526",
    });
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "de-DE" }).text, "123.456.789,0123");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "fr-FR" }).text, "123 456 789,0123");
    assert.equal(formatDusk(123_456_789_012_345_678n, { locale: "en-IN" }).text, "12,34,56,789.0123");
    assert.equal(formatDusk(1_853_542n, { locale: "ar-EG" }).text, "٠٫٠٠١٩");
  });

  it("writes a file's amount with a point and no grouping", () => {
    assert.equal(formatDuskPlain(173_852_610_026n), "173.852610026");
    assert.equal(formatDuskPlain(-1n), "-0.000000001");
    assert.equal(formatDuskPlain(1_234_000_000_000n), "1234");
    assert.equal(formatDuskPlain(0), "0");
  });

  it("refuses what isn't a whole number of lux", () => {
    for (const bad of [1.5, "1.5", "abc", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      assert.throws(() => formatDusk(/** @type {any} */ (bad)), TypeError);
    }
    assert.throws(() => formatDusk(1n, { mode: /** @type {any} */ ("long") }), RangeError);
    assert.throws(() => formatDusk(1n, { round: /** @type {any} */ ("half") }), RangeError);
  });
});

const realNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const inLanguage = (/** @type {string} */ language) =>
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language } });

describe("reading amounts", () => {
  afterEach(() => {
    if (realNavigator) Object.defineProperty(globalThis, "navigator", realNavigator);
    else Reflect.deleteProperty(globalThis, "navigator");
  });

  const read = (/** @type {string} */ text, /** @type {string} */ decimal) => parseDusk(normalizeAmount(text, decimal));
  const DUSK = 1_000_000_000n;

  it("reads what a Dutch person writes", () => {
    assert.equal(read("1,5", ","), (15n * DUSK) / 10n);
    assert.equal(read("1,001", ","), 1_001_000_000n);
    assert.equal(read("1.001,5", ","), 1_001_500_000_000n);
    assert.equal(read("1.000.000", ","), 1_000_000n * DUSK);
    assert.equal(read(",5", ","), DUSK / 2n);
    assert.equal(read("1,", ","), DUSK);
  });

  it("reads what an English person writes", () => {
    assert.equal(read("1.5", "."), (15n * DUSK) / 10n);
    assert.equal(read("1.001", "."), 1_001_000_000n);
    assert.equal(read("1,001.5", "."), 1_001_500_000_000n);
    assert.equal(read("1,000,000", "."), 1_000_000n * DUSK);
    assert.equal(read(".5", "."), DUSK / 2n);
    assert.equal(read("1.", "."), DUSK);
  });

  it("takes either way of writing decimals where only one reading is possible", () => {
    assert.equal(read("1.5", ","), (15n * DUSK) / 10n);
    assert.equal(read("1,5", "."), (15n * DUSK) / 10n);
    assert.equal(read("0,123", "."), 123_000_000n);
    assert.equal(read("0.123", ","), 123_000_000n);
    assert.equal(read("1.000,5", "."), 1_000_500_000_000n);
    assert.equal(read("1,000.5", ","), 1_000_500_000_000n);
  });

  it("refuses what could mean a thousand or one, and says what it could mean", () => {
    assert.equal(read("1.001", ","), null);
    assert.deepEqual(unclearAmount("1.001", ","), { decimal: "1,001", grouped: "1001" });
    assert.equal(read("1,001", "."), null);
    assert.deepEqual(unclearAmount("1,001", "."), { decimal: "1.001", grouped: "1001" });

    for (const clear of ["1,001", "1.5", "1.25", "0.123", "1.0001", "1001", ""]) {
      assert.equal(unclearAmount(clear, ","), null, clear);
    }
  });

  it("refuses what isn't an amount, and more decimals than DUSK has", () => {
    for (const text of ["", " ", ".", ",", "abc", "1,2,3", "1.2.3", "-1", "1e3", "1 000", "0.1234567891"]) {
      assert.equal(read(text, "."), null, JSON.stringify(text));
    }
    assert.equal(read("1.000.000", "."), null);
    assert.equal(read("0,1234567891", ","), null);
    assert.equal(read("0.123456789", "."), 123_456_789n);
  });

  it("reads every amount it shows as that amount, or refuses it, in any language", () => {
    const amounts = [1n, 1_001_000_000n, 1_001_000_000_000n, 1_484_923_500_000n, 1_000_000n * DUSK, 12_345n, DUSK / 2n];

    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "fr-FR", "es-ES", "de-CH", "hi-IN", "ar-EG"]) {
      inLanguage(language);
      for (const lux of amounts) {
        const shown = formatDusk(lux, { locale: amountLocale(), mode: "exact" }).text;
        const back = read(shown, decimalSeparator());
        assert.ok(back === lux || back === null, `${language}: ${shown} read as ${back}`);

        // Max fills what's read back, whatever the language.
        assert.equal(read(amountForField(formatDuskPlain(lux)), decimalSeparator()), lux, `${language}: field`);
      }
    }
  });

  it("writes and reads in the same language, unless told otherwise", () => {
    inLanguage("de-DE");
    const shown = formatDusk(1001n * DUSK).text;
    assert.equal(shown, "1.001");
    assert.equal(read(shown, decimalSeparator()), null);

    // Arabic writes its own digits and separator only when asked to.
    inLanguage("ar-EG");
    assert.match(formatDusk(1_500_000_000n).text, /^[0-9.,]+$/);
    assert.match(formatDusk(1_500_000_000n, { locale: "ar-EG" }).text, /^[٠-٩٫٬]+$/);
    assert.equal(read(amountForField("1.5", decimalSeparator("ar-EG")), decimalSeparator("ar-EG")), 1_500_000_000n);
  });

  it("writes in the browser's language, in digits a person can type", () => {
    inLanguage("nl-NL");
    assert.equal(decimalSeparator(), ",");
    assert.equal(groupDigits(1484n), "1.484");
    assert.equal(amountForField("0.35"), "0,35");
    inLanguage("hi-IN");
    assert.equal(groupDigits(1234567n), "12,34,567");
    inLanguage("ar-EG");
    assert.match(groupDigits(1234567n), /^[0-9,.]+$/);
    inLanguage("not a language");
    assert.equal(amountLocale(), "en-US");
  });
});
