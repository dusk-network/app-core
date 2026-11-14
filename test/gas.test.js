import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { BLOCK_GAS, BLOCK_TRANSACTIONS, GAS_PRICE_BUSY, GAS_PRICE_CEILING_TIMES, GAS_PRICE_MINIMUM, defaultGasPrice } from "../src/gas.js";

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

  it("is the minimum while what waits fits in the next block: Lena's unstake, read with Sozu's own activation waiting alone", () => {
    // On testnet, Sozu's operator sends stake_activate at gas price 2, limit 6,000,000, a block or two after every
    // stake (blocks 4,849,930 and 4,849,999 after Lena's stakes in 4,849,928 and 4,849,997). The extension read the
    // median at its unstake's Review while that waited alone, and paid 2; the web wallet had read its price before
    // the stake, and paid 1. Both read it now as a block that takes it, and every transaction at 1, would.
    const activation = { gasLimit: 6_000_000, gasPrice: 2 };

    assert.deepEqual(defaultGasPrice({ mempool: [activation], minimum: 1n }), { busy: false, ceiling: 5n, median: 2n, minimum: 1n, price: 1n });
    assert.deepEqual(defaultGasPrice({ mempool: [], minimum: 1n }), { busy: false, ceiling: 5n, median: null, minimum: 1n, price: 1n });
    // Marek's: a few transactions at a high price, far from a block's worth, can't raise every default fee.
    const spam = Array.from({ length: BLOCK_TRANSACTIONS - 1 }, () => ({ gasLimit: 2_500_000, gasPrice: 1_000_000 }));

    assert.deepEqual(defaultGasPrice({ mempool: spam }), { busy: false, ceiling: 5n, median: 1_000_000n, minimum: 1n, price: 1n });
    assert.deepEqual([BLOCK_TRANSACTIONS, BLOCK_GAS], [1000, 3_000_000_000n]);
  });

  it("follows the median of what waits once more waits than a block takes, by count or by gas, up to the ceiling", () => {
    const many = (/** @type {number} */ count, /** @type {number} */ gasPrice, gasLimit = 2_500_000) => Array.from({ length: count }, () => ({ gasLimit, gasPrice }));

    // A block's thousand transactions.
    assert.deepEqual(defaultGasPrice({ mempool: many(1000, 3) }), { busy: false, ceiling: 5n, median: 3n, minimum: 1n, price: 3n });
    // A block's gas: 61 shielded sends of 50,000,000 each.
    assert.deepEqual(defaultGasPrice({ mempool: many(61, 4, 50_000_000) }), { busy: false, ceiling: 5n, median: 4n, minimum: 1n, price: 4n });
    assert.equal(defaultGasPrice({ mempool: many(59, 4, 50_000_000) }).price, 1n);
    // Over the ceiling: the ceiling, and Review says the network is busy.
    assert.deepEqual(defaultGasPrice({ mempool: many(1000, 1_000_000) }), { busy: true, ceiling: 5n, median: 1_000_000n, minimum: 1n, price: 5n });
    // The node's own median: the middle one, or the mean of the two middle ones, rounded down.
    assert.equal(defaultGasPrice({ mempool: [...many(500, 2), ...many(500, 5)] }).median, 3n);
    assert.equal(defaultGasPrice({ mempool: [...many(500, 2), ...many(501, 5)] }).median, 5n);
    // As a node's GraphQL gives each, a number, or as text or a bigint; one without a price still takes room in the block.
    assert.equal(defaultGasPrice({ mempool: [...many(999, 3), { gasLimit: "2500000", gasPrice: "3" }] }).price, 3n);
    assert.equal(defaultGasPrice({ mempool: [...many(998, 4), { gasLimit: 2_500_000n, gasPrice: 4n }, { gasLimit: 1 }] }).price, 4n);
  });
});
