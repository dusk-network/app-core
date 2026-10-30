// How each app's kept history reads through the package as it is kept now:
// sketches of the stores the apps pass, over their stored shapes, in memory.
// The public history first, then the shielded one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";
import { duskEvmContracts } from "@dusk-network/networks/duskevm";

import { FINALITY_MARGIN, createHistory, parseHistoryEntry } from "../src/history.js";
import { shieldedHistory } from "../src/shielded.js";
import { StaleError, fakeArchive, fixture, like, readFixture } from "./fixtures/helpers.js";
import { GROWN, MADE_LEAF_0, MADE_LEAF_1, SHIELD, UNSHIELD, blocksNode, noteTree, sentNotes, treeLeaves, valueOf } from "./fixtures/shielded.js";

const deposit = readFixture("duskevm-deposit-history.json");
const bridgeCalls = readFixture("bridge-calls-testnet.json");
const { bridge: BRIDGE, portal: PORTAL } = /** @type {NonNullable<ReturnType<typeof duskEvmContracts>>} */ (duskEvmContracts(2));
const OK = "8e247a33967153b229ce4f45f61e0f14808d8a417c4a4b37eabb269a8eb08e34";
const H = deposit.entry.block_height;

/** @param {any[]} rows @param {{ limit: number, before?: number }} options */
const newestFirst = (rows, { before, limit }) =>
  rows.filter((row) => before === undefined || row.blockHeight < before).sort((a, b) => b.blockHeight - a.blockHeight).slice(0, limit);

/** A state that covers every height up to the deposit's. */
const coveredState = (/** @type {string} */ account) => ({
  account,
  covered: [[0, H + 90]],
  crowded: null,
  finalized: H + 100,
  genesis: fixture.head.genesis,
  headAt: 1,
  target: H + 90,
  updatedAt: 1,
  window: 8_640,
});

// The extension keeps the history's fields as they are, a deposit's DuskEVM
// address as `bridgeTo`, and its hook's `registeredName` and `reservation`.
// Its store keeps `bridge` beside `bridgeTo`, and reads a row with
// `bridgeTo` alone as the deposit it names.
function extensionStore(/** @type {Map<string, any>} */ rows, /** @type {{ value: any }} */ meta) {
  /** @param {any} row */
  const toEntry = (row) => ({
    ...row,
    bridge:
      row.bridge !== undefined
        ? row.bridge
        : row.bridgeTo === undefined
          ? undefined
          : row.bridgeTo === null
            ? null
            : { amount: row.value, kind: "deposit", to: row.bridgeTo },
  });
  /** @param {any} fields */
  const toRow = (fields) =>
    "bridge" in fields ? { ...fields, bridgeTo: fields.bridge?.kind === "deposit" ? fields.bridge.to : fields.bridge === undefined ? undefined : null } : fields;

  /** @type {import("../src/history.js").HistoryStore} */
  const store = {
    clear: () => {
      rows.clear();
      meta.value = null;
    },
    commit: (entries, update) => {
      meta.value = { ...update(meta.value), ownerKey: "testnet::account" };
      for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...toRow(entry) });

      return meta.value;
    },
    getState: () => meta.value,
    list: (options) => newestFirst([...rows.values()], options).map(toEntry),
    patch: (details) => {
      for (const [hash, found] of details) if (rows.has(hash)) rows.set(hash, { ...rows.get(hash), ...toRow(found) });
    },
  };

  return store;
}

describe("the extension's kept history", () => {
  const parsed = /** @type {NonNullable<ReturnType<typeof parseHistoryEntry>>} */ (parseHistoryEntry(deposit.account, deposit.entry));
  // As the extension keeps the deposit now: with its details and `bridgeTo`.
  const kept = {
    ...parsed,
    blockHash: "aa".repeat(32),
    bridgeTo: deposit.recipient,
    contractId: BRIDGE,
    detailsAt: 1,
    fee: "1",
    fnName: "depositETHToWithValue",
    gasLimit: "1",
    gasPrice: "1",
    gasSpent: "1",
    id: `testnet::${deposit.account}::${parsed.hash}`,
    ownerKey: `testnet::${deposit.account}`,
    success: true,
    timestamp: 1,
    value: String(parsed.value),
  };

  it("reads a deposit kept with `bridgeTo` as read, asking nothing more of it", async () => {
    const rows = new Map([[kept.hash, structuredClone(kept)]]);
    const node = fakeArchive({ accounts: { [deposit.account]: { receiver: [], sender: [deposit.entry] } }, details: deposit.details, finalized: H + 100 });
    const history = createHistory({ account: deposit.account, archive: node.archiveClient(), network: 2, store: extensionStore(rows, { value: coveredState(deposit.account) }) });

    assert.equal(history.needsDetails(extensionStore(rows, { value: null }).list({ limit: 1 }).at(0)), false);
    await history.sync();
    assert.equal(node.detailQueries().length, 0);

    const [entry] = (await history.read()).entries;

    like(entry, { bridge: { amount: kept.value, kind: "deposit", to: deposit.recipient }, bridgeTo: deposit.recipient, ownerKey: kept.ownerKey });
  });

  it("reads a call to the Portal kept before once, keeping what it did beside a `bridgeTo` of null", async () => {
    const hash = "c1".repeat(32);
    const proof = { ...kept, bridgeTo: undefined, contractId: PORTAL, counterparty: null, fnName: "proveWithdrawalTransaction", hash, value: "0" };
    const rows = new Map([[hash, proof]]);
    const node = fakeArchive({
      accounts: {},
      details: {
        [hash]: {
          ...fixture.details[OK],
          tx: { ...fixture.details[OK].tx, callData: { contractId: PORTAL, data: bridgeCalls.calls.find((/** @type {any} */ c) => c.name === "prove-account").args, fnName: "proveWithdrawalTransaction" } },
        },
      },
    });
    const store = extensionStore(rows, { value: coveredState(deposit.account) });
    const history = createHistory({ account: deposit.account, archive: node.archiveClient(), network: 2, store });

    await history.fillDetails(await store.list({ limit: 10 }));
    like(rows.get(hash), { bridgeTo: null });
    like(rows.get(hash).bridge, { amount: "1008000000000", kind: "prove" });
    assert.equal(history.needsDetails((await store.list({ limit: 1 }))[0]), false);
  });
});

// The web wallet keeps the history's own fields, `bridge` as the package
// reads it, and its hook's `nameCommit` and `registeredName`: its store is
// the package's shape.
describe("the web wallet's kept history", () => {
  it("keeps what its hook read through a sync that reads the entry again", async () => {
    const [A] = Object.keys(fixture.accounts);
    // 4658012 is above the second run's target: kept, and read again by the third.
    const node = fakeArchive({ finalized: 4_658_000 });
    /** @type {Map<string, any>} */
    const rows = new Map();
    const meta = { value: /** @type {any} */ (null) };
    /** @type {import("../src/history.js").HistoryStore} */
    const store = {
      clear: () => rows.clear(),
      commit: (entries, update) => {
        meta.value = update(meta.value);
        for (const entry of entries) rows.set(entry.hash, { ...rows.get(entry.hash), ...entry });

        return meta.value;
      },
      getState: () => meta.value,
      list: (options) => newestFirst([...rows.values()], options),
      patch: (details) => {
        for (const [hash, found] of details) if (rows.has(hash)) rows.set(hash, { ...rows.get(hash), ...found });
      },
    };
    const history = createHistory({ account: A, archive: node.archiveClient(), network: 2, store });
    const register = "1553f874eb8df9187675f099bbb422c6266d23c5a682e92a06faac3dfeb34a24";

    await history.sync();
    node.finalized = 4_658_020;
    await history.sync();
    assert.ok(rows.get(register).blockHeight > meta.value.target);
    // What the web wallet's hook keeps of the call.
    rows.set(register, { ...rows.get(register), nameCommit: { kind: "registration", reservation: "ab", role: "store" }, registeredName: "shpongle.dusk" });

    node.finalized = fixture.head.last_finalized_block[0];

    const asked = node.historyQueries().length;

    await history.sync();
    assert.ok(node.historyQueries().slice(asked).some((l) => l.data.out?.json?.some((/** @type {any} */ e) => e.origin === register)));
    like(rows.get(register), { fnName: "register", nameCommit: { kind: "registration", reservation: "ab", role: "store" }, registeredName: "shpongle.dusk" });
    assert.equal(meta.value.target, fixture.head.last_finalized_block[0] - FINALITY_MARGIN);
  });
});

// The bridge site keeps one JSON per account: its coverage, and the
// bridge's transfers alone, as its records (`deposit`, `service`,
// `payout`). Its store reads a record as the entry it was, and keeps an
// entry only when it's one of the bridge's.
function bridgeSiteStore(/** @type {Map<string, string>} */ storage, /** @type {string} */ key) {
  const net = networks.testnet;
  const service = net.routes.services[0].account;
  const load = () => JSON.parse(storage.get(key) ?? "null");
  /** @param {any} state */
  const save = (state) => storage.set(key, JSON.stringify(state));
  /** @param {any} record */
  const read = (record) => record.sourceAt ?? record.payoutAt;
  /** @param {any} r */
  const toEntry = (r) => ({
    blockHeight: r.blockHeight,
    hash: r.hash,
    value: r.amountLux,
    ...(r.kind === "deposit"
      ? { bridge: r.destination ? { amount: r.amountLux, kind: "deposit", to: r.destination } : undefined, counterparty: BRIDGE, direction: "out", kind: "contract_call", memo: "", payer: true }
      : r.kind === "service"
        ? { counterparty: service, direction: "out", kind: "transfer", memo: r.destination ?? "", payer: true }
        : { counterparty: r.payer, direction: "in", kind: "transfer", memo: r.sourceHash, payer: false }),
    ...(read(r) === undefined ? {} : { detailsAt: 1, success: true, timestamp: read(r) }),
  });
  /** @param {any} e @returns {any} */
  const toRecord = (e) => {
    const base = { amountLux: e.value, blockHeight: e.blockHeight, hash: e.hash };

    if (e.direction === "out" && e.kind === "contract_call" && e.counterparty === BRIDGE) return { ...base, destination: null, kind: "deposit" };
    if (e.direction === "out" && e.kind === "transfer" && e.counterparty === service) return { ...base, destination: e.memo.trim() || null, kind: "service" };
    if (e.direction === "in" && /^0x[0-9a-f]{64}$/i.test(e.memo)) return { ...base, kind: "payout", payer: e.counterparty, sourceHash: e.memo.toLowerCase() };

    return null;
  };

  /** @type {import("../src/history.js").HistoryStore} */
  const store = {
    clear: () => void storage.delete(key),
    commit: (entries, update) => {
      const kept = load();
      const next = { ...update(kept), entries: { ...(kept?.entries ?? {}) } };

      for (const entry of entries) {
        const record = toRecord(entry);

        if (record) next.entries[entry.hash] = { ...next.entries[entry.hash], ...record };
      }

      save(next);

      return next;
    },
    getState: () => load(),
    list: (options) => newestFirst(Object.values(load()?.entries ?? {}).map(toEntry), options),
    patch: (details) => {
      const state = load();

      for (const [hash, found] of details) {
        const record = state?.entries?.[hash];

        if (!record) continue;
        if (record.kind === "payout") record.payoutAt = found.timestamp;
        else record.sourceAt = found.timestamp;
        if (found.bridge?.kind === "deposit") record.destination = found.bridge.to;
      }

      save(state);
    },
  };

  return store;
}

describe("the bridge site's kept history", () => {
  const ACCOUNT = deposit.account;
  const SERVICE = networks.testnet.routes.services[0].account;
  const h = (/** @type {number} */ n) => n.toString(16).padStart(64, "0");
  // As the site keeps it now: no genesis or head, its records by hash.
  const stored = {
    covered: [[0, H - 10]],
    crowded: null,
    entries: {
      [h(1)]: { amountLux: "100000000", blockHeight: H - 500, destination: "0x3e5b8223e638cb414bef8cf95393460ca1c3a11d", hash: h(1), kind: "deposit", sourceAt: 1_792_980_000_000 },
      [h(2)]: { amountLux: "50000000000", blockHeight: H - 400, destination: "0xeE1b68ED496712cda857ada41d326d357049E51C", hash: h(2), kind: "service" },
      [h(3)]: { amountLux: "1000000000000", blockHeight: H - 300, hash: h(3), kind: "payout", payer: SERVICE, payoutAt: 1_792_990_000_000, routeId: "ethereum-to-dusk", sender: "0xabc", sourceHash: `0x${"ab".repeat(32)}` },
    },
    target: H - 10,
    updatedAt: 1,
    window: 8_640,
  };

  it("reads its records as the entries they were, and asks only for what they lack", async () => {
    const storage = new Map([["dusk-bridge:discovery:v1:testnet:dusk:account", JSON.stringify(stored)]]);
    const store = bridgeSiteStore(storage, "dusk-bridge:discovery:v1:testnet:dusk:account");
    const node = fakeArchive({
      accounts: { [ACCOUNT]: { receiver: [], sender: [deposit.entry] } },
      details: { ...deposit.details, [h(2)]: fixture.details[OK] },
      finalized: H + 100,
    });
    const history = createHistory({ account: ACCOUNT, archive: node.archiveClient(), network: 2, store });
    const before = await history.read();

    assert.deepEqual(before.entries.map((e) => [e.hash, e.kind, e.direction]), [
      [h(3), "transfer", "in"],
      [h(2), "transfer", "out"],
      [h(1), "contract_call", "out"],
    ]);
    assert.equal(before.entries[1].route?.id, "dusk-to-ethereum");
    assert.deepEqual(before.entries.map((e) => history.needsDetails(e)), [false, true, false]);

    // A visit: the deposit above, and the transfer to the bridge's account's time.
    await history.sync();

    const after = JSON.parse(/** @type {string} */ (storage.get("dusk-bridge:discovery:v1:testnet:dusk:account")));

    assert.equal(after.genesis, fixture.head.genesis);
    assert.deepEqual(Object.keys(after.entries).sort(), [h(1), h(2), h(3), deposit.entry.origin].sort());
    like(after.entries[deposit.entry.origin], { destination: deposit.recipient, kind: "deposit", sourceAt: 1_793_080_299_000 });
    like(after.entries[h(2)], { kind: "service", sourceAt: 1_792_665_841_000 });
    // What the site keeps of its own stays.
    like(after.entries[h(3)], { routeId: "ethereum-to-dusk", sender: "0xabc" });
    assert.equal(node.detailQueries().length, 1);
  });
});

// Both wallets keep a profile's shielded history as one record, by profile
// and network: the notes it was worked out from, the decoys, and its rows
// as they show them (`amount`, `feePaid`, `status`, `privacy`, `source`),
// with the network's tree heights beside it. Their stores read the rows as
// entries and keep entries as rows, and pass over a history they can't keep
// unless the wallet was reset since.
describe("the wallets' kept shielded history", () => {
  /** @param {import("../src/shielded.js").ShieldedEntry} e */
  const toRow = (e) => ({
    amount: e.direction === "self" ? undefined : e.value,
    blockHeight: e.blockHeight,
    direction: e.direction,
    error: e.error,
    feePaid: e.fee ?? undefined,
    hash: e.hash,
    kind: e.kind,
    privacy: "shielded",
    source: "shielded",
    status: e.success ? "executed" : "failed",
    timestamp: e.timestamp ?? undefined,
  });
  /** @param {any} row @returns {import("../src/shielded.js").ShieldedEntry} */
  const toEntry = (row) => ({
    blockHeight: row.blockHeight,
    direction: row.direction,
    ...(row.error ? { error: row.error } : {}),
    fee: row.feePaid ?? null,
    hash: row.hash,
    kind: row.kind,
    success: row.status !== "failed",
    timestamp: row.timestamp ?? null,
    value: row.amount ?? "0",
  });

  // The rows the wallets keep for the profile that made the unshield.
  const ROWS = [
    {
      amount: "2000000000",
      blockHeight: 3861643,
      direction: "in",
      error: undefined,
      feePaid: undefined,
      hash: SHIELD,
      kind: "shield",
      privacy: "shielded",
      source: "shielded",
      status: "executed",
      timestamp: 1_784_723_688_000,
    },
    {
      amount: String(10_500_000_000n - 1_012_000_000n - 12_429_102n),
      blockHeight: 3602438,
      direction: "out",
      error: undefined,
      feePaid: "12429102",
      hash: UNSHIELD,
      kind: "unshield",
      privacy: "shielded",
      source: "shielded",
      status: "executed",
      timestamp: 1_782_131_528_000,
    },
    // The notes it spent, as it received them.
    ...[
      { amount: "500000000", blockHeight: 226951, hash: MADE_LEAF_1, timestamp: 1_747_065_974_000 },
      { amount: "10000000000", blockHeight: 184423, hash: MADE_LEAF_0, timestamp: 1_746_640_694_000 },
    ].map((row) => ({ ...row, direction: "in", error: undefined, feePaid: undefined, kind: "shield", privacy: "shielded", source: "shielded", status: "executed" })),
  ];
  const KEY = "testnet::profile";

  /**
   * A wallet's two stores over its records, as IndexedDB keeps them, bound
   * to the reset count when they're made.
   *
   * @param {{ records: Map<string, any>, pools: Map<string, any>, resets: number }} db
   */
  function walletStores(db) {
    const resets = db.resets;

    return {
      /** @type {import("../src/shielded.js").ShieldedStore} */
      store: {
        get: () => {
          const kept = db.records.get(KEY);

          return kept ? { ...structuredClone(kept), entries: kept.entries.map(toEntry) } : null;
        },
        put: async (record) => {
          try {
            if (db.resets !== resets) throw new StaleError();
            if (db.full && record.entries.length) throw new Error("The store is full");
            db.records.set(KEY, { ...structuredClone(record), at: 1, entries: record.entries.map(toRow), ownerKey: KEY });
          } catch (error) {
            // Asked again next time, unless the wallet was reset since.
            if (error instanceof StaleError) throw error;
          }
        },
      },
      /** @type {import("../src/shielded.js").TreeHeightsStore} */
      treeHeights: {
        get: () => db.pools.get("testnet") ?? null,
        put: (kept) => void db.pools.set("testnet", { ...kept, at: 1, network: "testnet" }),
      },
    };
  }

  /** @param {any} db */
  const options = (db) => ({
    ...walletStores(db),
    archive: blocksNode().client,
    notes: sentNotes,
    synced: true,
    tree: noteTree(treeLeaves()).tree,
    valueOf,
  });

  it("reads a history kept before as its entries, asking nothing", async () => {
    const db = { full: false, pools: new Map(), records: new Map([[KEY, { at: 1, decoys: [234329, 234369, GROWN, 3577762], entries: ROWS, fingerprint: "0s,1s,493,494,495", ownerKey: KEY }]]), resets: 0 };
    const node = blocksNode();
    const { entries, pending } = await shieldedHistory({ ...options(db), archive: node.client });

    assert.equal(pending, false);
    assert.equal(node.queries.length, 0);
    assert.deepEqual(entries.map(toRow), ROWS);
  });

  it("keeps what it works out as the rows the wallets keep", async () => {
    const db = { full: false, pools: new Map(), records: new Map(), resets: 0 };

    await shieldedHistory(options(db));
    like(db.records.get(KEY), { entries: ROWS, fingerprint: "0s,1s,493,494,495", ownerKey: KEY });
    like(db.pools.get("testnet"), { network: "testnet", notes: 496 });
  });

  it("shows a history its store couldn't keep, and keeps nothing of one the wallet was reset under", async () => {
    const full = { full: true, pools: new Map(), records: new Map(), resets: 0 };

    assert.deepEqual((await shieldedHistory(options(full))).entries.map(toRow), ROWS);
    assert.deepEqual(full.records.get(KEY).entries, []);

    const reset = { full: false, pools: new Map(), records: new Map(), resets: 0 };
    const stores = options(reset);
    const node = blocksNode();

    node.before = () => {
      reset.resets += 1;
      reset.records.clear();
    };
    await assert.rejects(shieldedHistory({ ...stores, archive: node.client }), StaleError);
    assert.equal(reset.records.size, 0);
  });
});
