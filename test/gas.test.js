import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GAS_PRICE_BUSY, GAS_PRICE_CEILING_TIMES, GAS_PRICE_MINIMUM, defaultGasPrice } from "../src/gas.js";

describe("the default gas price", () => {
  it("follows the mempool's median, from the network's minimum up to its ceiling", () => {
    assert.deepEqual(defaultGasPrice({ median: 1n, minimum: 1n }), { busy: false, ceiling: 5n, median: 1n, minimum: 1n, price: 1n });
    // Lena's: an unstake while the median was 2, at 2 in both wallets alike, the network not called busy.
    assert.deepEqual(defaultGasPrice({ median: 2n }), { busy: false, ceiling: 5n, median: 2n, minimum: 1n, price: 2n });
    assert.deepEqual(defaultGasPrice({ median: 5n }), { busy: false, ceiling: 5n, median: 5n, minimum: 1n, price: 5n });
  });

  it("stops at the ceiling, which a mempool filled at a high price can't push past, and says the network is busy", () => {
    // Marek's: the median of a spammed mempool raised every default fee.
    assert.deepEqual(defaultGasPrice({ median: 1_000_000n }), { busy: true, ceiling: 5n, median: 1_000_000n, minimum: 1n, price: 5n });
    assert.deepEqual(defaultGasPrice({ median: 6n }), { busy: true, ceiling: 5n, median: 6n, minimum: 1n, price: 5n });
    assert.equal(GAS_PRICE_BUSY, "The network is busy. You can raise the gas price for it to go out sooner.");
  });

  it("takes a network's own settings: its minimum, and the ceiling it says, else a small multiple of its minimum", () => {
    assert.deepEqual([GAS_PRICE_MINIMUM, GAS_PRICE_CEILING_TIMES], [1n, 5n]);
    assert.deepEqual(defaultGasPrice({ median: 30n, minimum: 2n }), { busy: true, ceiling: 10n, median: 30n, minimum: 2n, price: 10n });
    assert.deepEqual(defaultGasPrice({ ceiling: 20n, median: 30n }), { busy: true, ceiling: 20n, median: 30n, minimum: 1n, price: 20n });
    assert.deepEqual(defaultGasPrice({ ceiling: "40", median: 30n }), { busy: false, ceiling: 40n, median: 30n, minimum: 1n, price: 30n });
    // A ceiling under the minimum is the minimum.
    assert.deepEqual(defaultGasPrice({ ceiling: 1n, median: 30n, minimum: 3n }), { busy: true, ceiling: 3n, median: 30n, minimum: 3n, price: 3n });
  });

  it("is never under the minimum, nor 0, which no transaction can pay", () => {
    assert.equal(defaultGasPrice({ median: 0n }).price, 1n);
    assert.equal(defaultGasPrice({ median: 1n, minimum: 3n }).price, 3n);
    assert.equal(defaultGasPrice({ median: 2n, minimum: 0n }).price, 2n);
    assert.equal(defaultGasPrice({ median: 0n, minimum: 0n }).price, 1n);
    assert.equal(defaultGasPrice({ median: 0n, minimum: -4 }).minimum, 1n);
  });

  it("is the minimum until the node answers, or where its answer isn't a price", () => {
    for (const median of [null, undefined, "", "x", -1, 1.5, Number.MAX_SAFE_INTEGER + 2, "-2"]) {
      assert.deepEqual(defaultGasPrice({ median: /** @type {any} */ (median) }), { busy: false, ceiling: 5n, median: null, minimum: 1n, price: 1n }, String(median));
    }

    assert.deepEqual(defaultGasPrice(), { busy: false, ceiling: 5n, median: null, minimum: 1n, price: 1n });
  });

  it("is the same in both wallets for the same answer, as each reads the node's: a bigint in the web wallet, digits in the extension", () => {
    // The web wallet's w3sper gives the node's answer as bigints; the extension's engine as text.
    const web = { average: 3n, max: 9n, median: 2n, min: 1n };
    const extension = { average: "3", max: "9", median: "2", min: "1" };

    for (const [a, b] of [
      [web, extension],
      [{ ...web, median: 7n }, { ...extension, median: "7" }],
      [{ ...web, median: 1n }, { ...extension, median: "1" }],
    ]) {
      assert.deepEqual(defaultGasPrice({ median: a.median, minimum: 1n }), defaultGasPrice({ median: b.median, minimum: "1" }));
    }

    assert.deepEqual(defaultGasPrice({ median: 2 }), defaultGasPrice({ median: "2" }));
  });
});
