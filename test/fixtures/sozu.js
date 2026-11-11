// Test helpers for what `/sozu` reads of the chain at a moment: an archive
// answering from mainnet's recording around the 2026 new year, as the node
// does: a block's height and time, the tip, the pool's transactions in a
// range of blocks, and a block's events.

import assert from "node:assert/strict";

import { readFixture } from "./helpers.js";

export const newYear = readFixture("sozu-new-year.json");

/** The pool's figures the recording read at a stake's block, an unstake's, the tip (`rates`), or a new year (`newYear`). */
export const figures = (/** @type {{ stake: string, supply: string }} */ { stake, supply }) => ({ stake: BigInt(stake), supply: BigInt(supply) });

/**
 * An archive answering from `chain`: a block's time as the recording has
 * it, or where the recorded blocks on either side put it, at 10 seconds a
 * block before the first; none past the tip. `queries` keeps each query.
 *
 * @param {any} chain
 */
export function chainArchive(chain) {
  const known = [...Object.entries(chain.headers).map(([height, timestamp]) => [Number(height), Number(timestamp)]), [chain.tip.height, chain.tip.timestamp]].sort((a, b) => a[0] - b[0]);
  /** @param {number} height */
  const timeOf = (height) => {
    if (height < 0 || height > chain.tip.height) return null;

    const next = known.findIndex(([h]) => h >= height);
    const [h1, t1] = known[next];
    const [h0, t0] = next > 0 ? known[next - 1] : [height, t1 - (h1 - height) * 10];

    return h1 === height ? t1 : Math.round(t0 + ((height - h0) * (t1 - t0)) / (h1 - h0));
  };
  /** @type {string[]} */
  const queries = [];

  return {
    queries,
    query: async (/** @type {string} */ query) => {
      queries.push(query);

      /** @type {Record<string, any>} */
      const data = {};

      for (const [, alias, asked] of query.matchAll(/(\w+): block\(height: (-?\d+)\) \{ header \{ height timestamp \} \}/g)) {
        const height = asked === "-1" ? chain.tip.height : Number(asked);
        const timestamp = timeOf(height);

        data[alias] = timestamp === null ? null : { header: { height, timestamp } };
      }
      for (const [, alias, from, to, contract] of query.matchAll(/(\w+): blockTxs\(range: \[(\d+), (\d+)\], contract: "([0-9a-f]+)"\)/g)) {
        assert.ok(Number(to) - Number(from) < 200, "the archive lists 200 blocks at most");
        data[alias] = contract === chain.pool ? chain.txs.filter((/** @type {any} */ tx) => tx.blockHeight >= Number(from) && tx.blockHeight <= Number(to)) : [];
      }
      for (const [, alias, height] of query.matchAll(/(\w+): contractEvents\(height: (\d+)\)/g)) data[alias] = { json: chain.events[height] ?? [] };

      return data;
    },
  };
}
