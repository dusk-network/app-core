#!/usr/bin/env node
/**
 * A read-only check of the history sync against testnet's archive, which CI
 * doesn't run: one run of a few windows for a testnet account, kept in
 * memory, with the details of the newest entries. Five requests at most.
 *
 *   node scripts/smoke-history.js [account]
 */

import { FINALITY_MARGIN, createArchive, createHistory } from "../src/history.js";

const NODE = "https://testnet.nodes.dusk.network";
// A testnet account with a few transfers and contract calls.
const ACCOUNT =
  process.argv[2] ??
  "26JfWKvhYdVY71bdSPVLNJ51Buy4GjimCT7zcsoxNQtydDbdoH2AwZaH8W7rjcAc9riAu39Vw9Lx1w7yrkBgotSjWmUdkSyQuaTKDZWVCKp9g1GxiEnnksv3W3onToB5NsNi";

/** @type {string[]} */
const asked = [];
const archive = createArchive({
  fetch: async (input, init) => {
    const text = String(init.body);
    const range = /fromBlock: (\d+)(?:, toBlock: (\d+))?/.exec(text);

    asked.push(
      text.includes("tx(hash:")
        ? `details of ${text.match(/tx\(hash:/g)?.length} transactions`
        : range
          ? `heights ${range[1]} to ${range[2] ?? "the top"}${text.includes("lastBlockPair") ? ", with the head" : ""}`
          : "the head"
    );

    return fetch(input, init);
  },
  url: NODE,
});

/** @type {import("../src/history.js").HistoryState | null} */
let state = null;
/** @type {Map<string, import("../src/history.js").KeptEntry>} */
const rows = new Map();
/** @type {import("../src/history.js").HistoryStore} */
const store = {
  clear: () => {
    state = null;
    rows.clear();
  },
  commit: (entries, update) => {
    state = update(state);
    for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...entry });

    return state;
  },
  getState: () => state,
  list: ({ before, limit }) =>
    [...rows.values()]
      .filter((row) => before === undefined || row.blockHeight < before)
      .sort((a, b) => b.blockHeight - a.blockHeight)
      .slice(0, limit),
  patch: (details) => {
    for (const [hash, found] of details) {
      const row = rows.get(hash);

      if (row) rows.set(hash, { ...row, ...found });
    }
  },
};

const history = createHistory({ account: ACCOUNT, archive, network: 2, store });
const started = Date.now();
const run = await history.sync({ maxDetailRequests: 1, maxRequests: 4 });
const { complete, coveredTo, entries } = await history.read();

console.log(`${asked.length} requests in ${Date.now() - started} ms:`);
for (const line of asked) console.log(`  ${line}`);
console.log(`finalized ${run.state.finalized}, covered down from ${run.state.finalized - FINALITY_MARGIN} to ${coveredTo}${complete ? " (all of it)" : ""}`);
console.log(`${entries.length} entries:`);

for (const entry of entries.slice(0, 10)) {
  const when = entry.timestamp ? new Date(entry.timestamp).toISOString() : "no details yet";
  const outcome = entry.success === null ? "" : entry.success ? ", went through" : `, failed: ${entry.error}`;

  console.log(`  ${entry.blockHeight} ${entry.hash.slice(0, 8)} ${entry.direction} ${entry.kind} ${entry.value} lux, ${when}${outcome}`);
}
