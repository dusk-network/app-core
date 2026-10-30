import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NO_ARCHIVE_RETRY_MS, NoArchiveError, createArchive, historyArchiveUrl, historyRange } from "../src/history.js";
import { fakeArchive, fixture } from "./fixtures/helpers.js";

const TESTNET = "https://testnet.nodes.dusk.network";
const MAINNET = "https://nodes.dusk.network";

/**
 * A fetch that answers each request in turn from `answers`: a status and a
 * body, or a function of the request.
 *
 * @param {Array<{ status?: number, body: string } | ((url: string, init: any) => { status?: number, body: string })>} answers
 */
function answering(answers) {
  /** @type {{ url: string, init: any }[]} */
  const calls = [];
  /** @param {string} url @param {any} init */
  const fetch = async (url, init) => {
    calls.push({ init, url });

    const next = answers[Math.min(calls.length, answers.length) - 1];
    const { body, status = 200 } = typeof next === "function" ? next(url, init) : next;

    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };

  return { calls, fetch };
}

describe("the archive's GraphQL", () => {
  it("posts the query text itself to the node's /on/graphql/query, under its base path", async () => {
    const { calls, fetch } = answering([{ body: JSON.stringify({ data: { ok: true } }) }]);
    const archive = createArchive({ fetch, url: "https://node.example/rusk/" });

    assert.deepEqual(await archive.query("query { ok }"), { ok: true });
    assert.equal(calls[0].url, "https://node.example/rusk/on/graphql/query");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.body, "query { ok }");
    assert.equal(calls[0].init.headers["Content-Type"], "text/plain");
    assert.equal(archive.url, "https://node.example/rusk/");
  });

  it("keeps amounts past 2^53 exact, as text, and leaves everything else as JSON reads it", async () => {
    const body =
      '{"data":{"h":{"json":[{"block_height":4688278,"events":[{"data":{"value":12345678901234567891,"small":9007199254740991,"past":9007199254740993,"memo":"12345678901234567890 \\" 1"}}]}]},"d":0.12345678901234567890,"e":1.5e300,"n":-12345678901234567890}}';
    const archive = createArchive({ fetch: answering([{ body }]).fetch, url: TESTNET });
    const data = await archive.query("query { h }");
    const { data: event } = data.h.json[0].events[0];

    assert.equal(event.value, "12345678901234567891");
    assert.equal(event.small, 9_007_199_254_740_991);
    assert.equal(event.past, "9007199254740993");
    assert.equal(event.memo, '12345678901234567890 " 1');
    assert.equal(data.h.json[0].block_height, 4_688_278);
    assert.equal(data.d, 0.12345678901234568);
    assert.equal(data.e, 1.5e300);
    assert.equal(data.n, "-12345678901234567890");
  });

  it("gives the node's errors as its messages", async () => {
    const errors = [{ message: "Unknown field \"nope\"" }, { message: "and another" }];
    const archive = createArchive({ fetch: answering([{ body: JSON.stringify({ data: null, errors }) }]).fetch, url: TESTNET });

    await assert.rejects(archive.query("query { nope }"), { message: 'Unknown field "nope"; and another' });
  });

  it("reads the errors of an answer with an error status too, and says the status of one without", async () => {
    const refused = { errors: [{ message: 'Unknown field "moonlightHistory" on type "Query".' }] };
    const archive = createArchive({ fetch: answering([{ body: JSON.stringify(refused), status: 400 }]).fetch, url: TESTNET });

    await assert.rejects(archive.query("query { x }"), NoArchiveError);

    const plain = createArchive({ fetch: answering([{ body: "<html>Bad gateway</html>", status: 500 }]).fetch, url: TESTNET });

    await assert.rejects(plain.query("query { x }"), { message: "The archive answers with HTTP 500" });

    const odd = createArchive({ fetch: answering([{ body: "not json" }]).fetch, url: TESTNET });

    await assert.rejects(odd.query("query { x }"), { message: "The archive's answer isn't JSON" });
  });

  it("asks again after a busy or unavailable answer, twice at most", async () => {
    const busy = answering([{ body: "", status: 503 }, { body: "", status: 429 }, { body: JSON.stringify({ data: { ok: 1 } }) }]);

    assert.deepEqual(await createArchive({ fetch: busy.fetch, url: TESTNET }).query("query { ok }"), { ok: 1 });
    assert.equal(busy.calls.length, 3);

    const down = answering([{ body: "", status: 502 }]);

    await assert.rejects(createArchive({ fetch: down.fetch, url: TESTNET }).query("query { ok }"), { message: "The archive answers with HTTP 502" });
    assert.equal(down.calls.length, 3);

    // A request the node refuses isn't sent again.
    const refused = answering([{ body: "", status: 400 }]);

    await assert.rejects(createArchive({ fetch: refused.fetch, url: TESTNET }).query("query { ok }"));
    assert.equal(refused.calls.length, 1);
  });

  it("gives up on an answer that takes too long", async () => {
    /** @param {string} _url @param {{ signal: AbortSignal }} init */
    const fetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const archive = createArchive({ fetch, timeoutMs: 20, url: TESTNET });

    await assert.rejects(archive.query("query { ok }"), /^Error: The archive didn't answer within /);
    await assert.rejects(createArchive({ fetch, timeoutMs: 8_000, url: TESTNET }).query("query { ok }", { timeoutMs: 300 }), {
      message: "The archive didn't answer within 0.3 s",
    });
  });

  it("passes on a request that couldn't be sent", async () => {
    const node = fakeArchive();

    node.down = true;
    await assert.rejects(node.archiveClient().query("query { ok }"), { message: "fetch failed", name: "TypeError" });
  });

  it("uses the global fetch when none is given", async () => {
    const original = globalThis.fetch;
    const { calls, fetch } = answering([{ body: JSON.stringify({ data: { ok: true } }) }]);

    globalThis.fetch = /** @type {any} */ (fetch);

    try {
      const archive = createArchive({ url: TESTNET });

      assert.deepEqual(await archive.query("query { ok }"), { ok: true });
      assert.equal(calls.length, 1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("takes an http(s) URL, or any name with the app's own caller", () => {
    assert.throws(() => createArchive({ url: "nodes.dusk.network" }), TypeError);
    assert.throws(() => createArchive({ url: "" }), TypeError);
    assert.equal(createArchive({ query: async () => ({}), url: "testnet node" }).url, "testnet node");
  });

  it("asks through the app's own GraphQL caller, and knows its refusal by the node's message", async () => {
    /** @type {string[]} */
    const asked = [];
    const archive = createArchive({
      query: async (document) => {
        asked.push(document);
        if (document.includes("moonlightHistory")) throw new Error('Unknown field "moonlightHistory" on type "Query".');

        return { pair: { json: {} } };
      },
      url: TESTNET,
    });

    assert.deepEqual(await archive.query("query { pair: lastBlockPair { json } }"), { pair: { json: {} } });
    await assert.rejects(archive.query("query { out: moonlightHistory(sender: \"x\", fromBlock: 0) { json } }"), (error) => {
      assert.ok(error instanceof NoArchiveError);
      assert.equal(error.url, TESTNET);

      return true;
    });
    await assert.rejects(archive.assertArchive(), NoArchiveError);
    assert.equal(asked.length, 2);
  });
});

describe("a node without the archive", () => {
  const refusal = JSON.stringify({ data: null, errors: [{ message: 'Unknown field "contractEvents" on type "Query".' }] });

  it("is kept as refused for an hour, through the app's refusals", async () => {
    /** @type {Map<string, number>} */
    const kept = new Map();
    let now = 5_000;
    const refusals = { get: async (/** @type {string} */ url) => kept.get(url) ?? null, put: async (/** @type {string} */ url, /** @type {number} */ at) => void kept.set(url, at) };
    const archive = createArchive({ fetch: answering([{ body: refusal }]).fetch, now: () => now, refusals, url: TESTNET });

    await archive.assertArchive();
    await assert.rejects(archive.query("query { e: contractEvents(height: 1) { json } }"), NoArchiveError);
    assert.deepEqual([...kept], [[TESTNET, 5_000]]);
    await assert.rejects(archive.assertArchive(), NoArchiveError);

    // Another archive on the same storage knows it; another node doesn't.
    await assert.rejects(createArchive({ fetch: answering([]).fetch, now: () => now, refusals, url: TESTNET }).assertArchive(), NoArchiveError);
    await createArchive({ fetch: answering([]).fetch, now: () => now, refusals, url: "https://my.archive.example" }).assertArchive();

    now += NO_ARCHIVE_RETRY_MS;
    await archive.assertArchive();
  });

  it("is remembered by the archive alone when the app keeps no refusals, and a refusal from a clock set back doesn't count", async () => {
    let now = 5_000;
    const archive = createArchive({ fetch: answering([{ body: refusal }]).fetch, now: () => now, url: TESTNET });

    await assert.rejects(archive.query("query { e: contractEvents(height: 1) { json } }"), NoArchiveError);
    await assert.rejects(archive.assertArchive(), NoArchiveError);
    // A new archive object starts with none.
    await createArchive({ fetch: answering([]).fetch, url: TESTNET }).assertArchive();
    now = 4_000;
    await archive.assertArchive();
  });

  it("is asked again when its refusals can't be read or kept", async () => {
    const broken = {
      get: () => {
        throw new Error("storage");
      },
      put: () => {
        throw new Error("storage");
      },
    };
    const archive = createArchive({ fetch: answering([{ body: refusal }]).fetch, refusals: broken, url: TESTNET });

    await assert.rejects(archive.query("query { e: contractEvents(height: 1) { json } }"), NoArchiveError);
    await archive.assertArchive();
  });
});

describe("historyArchiveUrl", () => {
  it("reads a network's history from its own node when the archive is on another network", () => {
    assert.equal(historyArchiveUrl({ archiveUrl: MAINNET, nodeUrl: TESTNET }), TESTNET);
    assert.equal(historyArchiveUrl({ archiveUrl: MAINNET, nodeUrl: MAINNET }), MAINNET);
    assert.equal(historyArchiveUrl({ archiveUrl: "https://my.archive", nodeUrl: "https://my.node" }), "https://my.archive");
    assert.equal(historyArchiveUrl({ nodeUrl: TESTNET }), TESTNET);
    assert.equal(historyArchiveUrl({ archiveUrl: " ", nodeUrl: ` ${TESTNET} ` }), TESTNET);
  });

  it("knows a URL's chain as the app says, else by the network whose file lists it", () => {
    /** @type {Record<string, number>} */
    const chains = { "https://my.archive": 1, "https://my.node": 2 };
    const chainIdOf = (/** @type {string} */ url) => chains[url] ?? null;

    assert.equal(historyArchiveUrl({ archiveUrl: "https://my.archive", chainIdOf, nodeUrl: "https://my.node" }), "https://my.node");
    assert.equal(historyArchiveUrl({ archiveUrl: "https://my.archive", chainIdOf: () => undefined, nodeUrl: "https://my.node" }), "https://my.archive");
    assert.equal(historyArchiveUrl({ archiveUrl: `${MAINNET}/`, nodeUrl: `${TESTNET}/x` }), `${TESTNET}/x`);
  });
});

describe("historyRange", () => {
  const [, B] = Object.keys(fixture.accounts);
  const sent = fixture.accounts[B].sender;

  it("reads one direction a page at a time, until a page comes back short", async () => {
    const node = fakeArchive();
    const from = sent[0].block_height;
    const result = await historyRange(node.archiveClient(), { account: B, direction: "out", from, pages: 4 });

    assert.equal(result.complete, true);
    assert.equal(result.requests, 2);
    assert.equal(result.entries.length, new Set(sent.map((/** @type {any} */ e) => e.origin)).size);
    assert.match(node.log[0].query, new RegExp(`^query \\{ out: moonlightHistory\\(sender: "${B}", fromBlock: ${from}, maxCount: 50\\) \\{ json \\} \\}$`));
    assert.match(node.log[1].query, /maxCount: 50, pageCount: 2\)/);
    // Oldest first.
    assert.deepEqual(result.entries.map((e) => e.blockHeight), [...result.entries.map((e) => e.blockHeight)].sort((x, y) => x - y));
  });

  it("stops at its page limit, not complete, and carries on from the page after", async () => {
    const node = fakeArchive();
    const result = await historyRange(node.archiveClient(), { account: B, direction: "out", pages: 1, to: 4_700_000 });

    assert.deepEqual([result.complete, result.requests, result.entries.length], [false, 1, 50]);
    assert.match(node.log[0].query, /toBlock: 4700000/);

    const rest = await historyRange(node.archiveClient(), { account: B, direction: "out", page: 2, pages: 4, to: 4_700_000 });
    const whole = await historyRange(node.archiveClient(), { account: B, direction: "out", pages: 8, to: 4_700_000 });

    assert.match(node.log[1].query, /maxCount: 50, pageCount: 2\)/);
    assert.equal(rest.complete, true);
    assert.deepEqual([...result.entries, ...rest.entries].map((e) => e.hash), whole.entries.map((e) => e.hash));
  });

  it("reads both directions by default, each entry once", async () => {
    const node = fakeArchive();
    const result = await historyRange(node.archiveClient(), { account: B, from: 2_517_146, to: 2_517_146 });

    assert.match(node.log[0].query, /out: moonlightHistory\(sender: .* in: moonlightHistory\(receiver: /);
    assert.deepEqual(result.entries.map((e) => [e.blockHeight, e.direction]), [[2_517_146, "self"]]);
  });

  it("takes in, out or both", async () => {
    await assert.rejects(historyRange(fakeArchive().archiveClient(), { account: B, direction: /** @type {any} */ ("self") }), RangeError);
  });
});
