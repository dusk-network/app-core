// Test helpers: a Testnet archive node answering from the recorded history in
// activity-testnet.json the way the node does, and a store that keeps
// histories in memory the way the wallets' stores do.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { createArchive } from "../../src/history.js";

/** @param {string} name */
export const readFixture = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"));

export const fixture = readFixture("activity-testnet.json");

/**
 * Each key of `expected` in `actual`, compared deeply: the fields a test is about.
 *
 * @param {any} actual
 * @param {Record<string, unknown>} expected
 * @param {string} [message]
 */
export function like(actual, expected, message) {
  assert.ok(actual && typeof actual === "object", message ?? "an object");
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(actual[key], value, `${message ? `${message}: ` : ""}${key}`);
}

// A name contract on Testnet, as the recording has the first account's two
// calls of it: `commit`, then `register`, which paid it a deposit. The
// arguments these tests give the two calls are made up: the hook below
// reads them from a table, as an app's hook reads them its own way.
export const NAME_CONTRACT = "4e2de1ed4f1fd53de83f4809a75367301c7645a546030fa199aff804e6854199";
export const NAME_SENDER = Object.keys(fixture.accounts)[0];
export const NAME_CALLS = Object.freeze({
  commit: { args: "c0".repeat(32), hash: "5b092d248cc4ab029e80463d06bbdf8ac51aa19398bd173e940100ddf1bca849", height: 4658000 },
  register: { args: "e1".repeat(40), hash: "1553f874eb8df9187675f099bbb422c6266d23c5a682e92a06faac3dfeb34a24", height: 4658012 },
});
export const RESERVATION = "ab".repeat(32);

/**
 * `details` with the two name calls' arguments in their call data.
 *
 * @param {Record<string, any>} details
 * @param {Partial<Record<"commit" | "register", string>>} [args]
 */
export function withCallArgs(details, args = {}) {
  const out = structuredClone(details);

  for (const [fn, { args: given, hash }] of Object.entries(NAME_CALLS)) {
    out[hash].tx.callData.data = args[/** @type {"commit" | "register"} */ (fn)] ?? given;
  }

  return out;
}

/**
 * The hook an app passes for the name contract's calls, keeping what it
 * reads as the extension does: `reservation` for both calls, and
 * `registeredName` for the second. `log` hears each call it reads.
 *
 * @param {{ log?: any[] }} [options]
 * @returns {import("../../src/history.js").CallFacts}
 */
export function nameHook({ log = [] } = {}) {
  return {
    wants: (entry) =>
      [entry.contractId, entry.counterparty].includes(NAME_CONTRACT) &&
      [undefined, "commit", "register"].includes(entry.fnName) &&
      (entry.reservation === undefined || (entry.fnName === "register" && entry.registeredName === undefined)),
    read: (call, account) => {
      log.push({ account, call });

      if (call.contractId !== NAME_CONTRACT) return {};
      if (call.fnName === "commit") return { reservation: call.args === NAME_CALLS.commit.args ? RESERVATION : null };

      if (call.fnName === "register") {
        const reads = call.args === NAME_CALLS.register.args;

        return { registeredName: reads ? "shpongle.dusk" : null, reservation: reads && account === NAME_SENDER ? RESERVATION : null };
      }

      return {};
    },
  };
}

/**
 * The archive's `moonlightHistory` paging: heights up to toBlock, from the
 * first at fromBlock or above, then `maxCount` from page `pageCount`, oldest
 * first; null when empty.
 *
 * @param {any[]} list
 * @param {{ fromBlock?: number, toBlock?: number, maxCount?: number, pageCount?: number }} args
 */
export function page(list, { fromBlock = 0, toBlock, maxCount, pageCount = 1 }) {
  let items = list.filter((e) => toBlock === undefined || e.block_height <= toBlock);
  const lower = items.findIndex((e) => e.block_height >= fromBlock);

  items = lower < 0 ? [] : items.slice(lower);
  if (maxCount !== undefined) items = items.slice((pageCount - 1) * maxCount, pageCount * maxCount);

  return items.length ? { json: items } : null;
}

/**
 * A node holding the recorded history, and `details` by hash, whose call
 * arguments (`callData.data`) it gives only to a query that asks for them.
 * Change `finalized` (its last finalized block), `genesis`, `down` (every
 * request fails), `archive` (false: a node without the archive's fields) or
 * `before` (awaited with each query before its answer) as a test goes;
 * `log` keeps each query and its answer. `archiveClient()` is an archive
 * on it, by its `fetch`.
 *
 * @param {{ accounts?: Record<string, { sender: any[], receiver: any[] }>, details?: Record<string, any>, finalized?: number, genesis?: string, url?: string }} [options]
 */
export function fakeArchive({
  accounts = fixture.accounts,
  details = fixture.details,
  finalized = fixture.head.last_finalized_block[0],
  genesis = fixture.head.genesis,
  url = fixture.nodeUrl,
} = {}) {
  const node = {
    archive: true,
    /** @type {((query: string) => Promise<void>) | null} */
    before: null,
    down: false,
    finalized,
    genesis,
    /** @type {{ query: string, data: any }[]} */
    log: [],
    url,
    /**
     * @param {string} endpoint
     * @param {{ body: string }} init
     */
    fetch: async (endpoint, init) => {
      assert.equal(String(endpoint), `${url}/on/graphql/query`);
      if (node.down) throw new TypeError("fetch failed");

      const query = String(init.body);

      await node.before?.(query);

      // The node refuses a whole query with a field its schema lacks.
      const missing = query.match(/\b(moonlightHistory|contractEvents)\(/);

      if (!node.archive && missing) {
        const errors = [{ locations: [{ column: 9, line: 1 }], message: `Unknown field "${missing[1]}" on type "Query".` }];

        node.log.push({ data: null, query });

        return { ok: true, status: 200, text: async () => JSON.stringify({ data: null, errors }) };
      }

      /** @type {Record<string, any>} */
      const data = {};

      if (query.includes("pair: lastBlockPair { json }")) {
        data.pair = { json: { last_block: [node.finalized + 1, "aa"], last_finalized_block: [node.finalized, "bb"] } };
      }

      if (query.includes("genesis: block(height: 0) { header { hash } }")) data.genesis = { header: { hash: node.genesis } };

      for (const m of query.matchAll(/(\w+): moonlightHistory\((sender|receiver): "([^"]+)"((?:, \w+: \d+)*)\) \{ json \}/g)) {
        const args = Object.fromEntries([...m[4].matchAll(/(\w+): (\d+)/g)].map(([, k, v]) => [k, Number(v)]));
        // The archive has finalized blocks only.
        const list = (accounts[m[3]]?.[/** @type {"sender" | "receiver"} */ (m[2])] ?? []).filter((e) => e.block_height <= node.finalized);

        data[m[1]] = page(list, args);
      }

      for (const m of query.matchAll(/(t\d+): tx\(hash: "([0-9a-f]{64})"\) \{[^{]*\{[^{]*\{([^}]*)\}/g)) {
        const tx = structuredClone(details[m[2]] ?? null);

        if (tx?.tx?.callData && !/\bdata\b/.test(m[3])) delete tx.tx.callData.data;
        data[m[1]] = tx;
      }

      node.log.push({ data, query });

      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    },
    historyQueries: () => node.log.filter((l) => l.query.includes("moonlightHistory")),
    detailQueries: () => node.log.filter((l) => l.query.includes("tx(hash:")),
    /** @param {Partial<import("../../src/history.js").ArchiveOptions>} [options] */
    archiveClient: (options = {}) => createArchive({ fetch: node.fetch, url, ...options }),
  };

  return node;
}

/** A write refused because the wallet was reset since its work began. */
export class StaleError extends Error {
  constructor() {
    super("The wallet was reset since this work began");
    this.name = "StaleError";
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Histories kept in memory, by key, as the wallets keep them: the sync
 * state, and the entries by hash, an entry read again keeping what it had.
 * `reset()` forgets everything and counts the reset: a store made before it
 * writes nothing after it.
 */
export function memoryDatabase() {
  const db = {
    clears: 0,
    epoch: 0,
    /** @type {Map<string, Map<string, any>>} */
    rows: new Map(),
    /** @type {Map<string, any>} */
    states: new Map(),
  };

  return {
    db,
    reset() {
      db.epoch += 1;
      db.states.clear();
      db.rows.clear();
    },
    /**
     * @param {string} key
     * @param {any} [state]
     */
    seed(key, state) {
      db.states.set(key, structuredClone(state));
    },
    /**
     * The store of one history, bound to the reset count when it's made.
     *
     * @param {string} key
     * @returns {import("../../src/history.js").HistoryStore & { rows(): any[] }}
     */
    storeFor(key) {
      const epoch = db.epoch;
      const guard = () => {
        if (db.epoch !== epoch) throw new StaleError();
      };
      const rowsOf = () => {
        if (!db.rows.has(key)) db.rows.set(key, new Map());

        return /** @type {Map<string, any>} */ (db.rows.get(key));
      };

      return {
        async getState() {
          await tick();

          return db.states.has(key) ? structuredClone(db.states.get(key)) : null;
        },
        async commit(entries, update) {
          await tick();
          guard();

          const next = { ...update(db.states.has(key) ? structuredClone(db.states.get(key)) : null), key };
          const rows = rowsOf();

          db.states.set(key, next);
          for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...structuredClone(entry) });

          return structuredClone(next);
        },
        async patch(details) {
          await tick();
          guard();

          const rows = rowsOf();

          for (const [hash, patch] of details) if (rows.has(hash)) rows.set(hash, { ...rows.get(hash), ...structuredClone(patch) });
        },
        async list({ limit, before }) {
          await tick();

          return [...rowsOf().values()]
            .filter((row) => before === undefined || row.blockHeight < before)
            .sort((a, b) => b.blockHeight - a.blockHeight || (a.hash < b.hash ? 1 : -1))
            .slice(0, limit)
            .map((row) => structuredClone(row));
        },
        async clear() {
          await tick();
          guard();
          db.clears += 1;
          db.states.delete(key);
          db.rows.delete(key);
        },
        rows: () => [...rowsOf().values()],
      };
    },
  };
}
