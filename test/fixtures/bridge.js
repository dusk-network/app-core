// Test helpers for /bridge: DuskEVM's explorer and an EVM chain's JSON-RPC,
// answering the way they do, from lists of calls, blocks and logs; and the
// Dusk archive's entries for the bridge's transfers.

import { createHash } from "node:crypto";

import { networks } from "@dusk-network/networks";
import { duskEvmContracts, encodeDepositArgs } from "@dusk-network/networks/duskevm";

import { ETH_BRIDGE_FINALIZED_TOPIC, TRANSFER_TOPIC } from "../../src/bridge.js";
import { TRANSFER_CONTRACT } from "../../src/history.js";

const evm = /** @type {NonNullable<typeof networks.testnet.duskEvm>} */ (networks.testnet.duskEvm);

export const EXPLORER_API = evm.blockscoutApiUrl;
export const DUSKEVM_RPC = evm.rpcUrl;
export const L2_BRIDGE = evm.predeploys.l2StandardBridge;
/** Testnet's DuskEVM bridge on Dusk, which deposits pay. */
export const BRIDGE = /** @type {NonNullable<ReturnType<typeof duskEvmContracts>>} */ (duskEvmContracts(2)).bridge;

/** @param {bigint | number} n */
export const hex = (n) => `0x${BigInt(n).toString(16)}`;

/** @param {bigint | number} n */
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

/** @param {string} address */
export const topicOf = (address) => `0x${address.slice(2).toLowerCase().padStart(64, "0")}`;

/** @param {string} text */
export const hexText = (text) => Buffer.from(text).toString("hex");

/** @param {unknown} body */
const json = (body) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

/**
 * A call DuskEVM's explorer lists among an address's incoming ones: from the
 * L2 bridge, of half a DUSK, unless said otherwise.
 *
 * @param {string} hash
 * @param {string} timestamp
 * @param {{ from?: string, success?: boolean, value?: string, block?: number, to?: string }} [fields]
 */
export const call = (hash, timestamp, { block = 1, from = L2_BRIDGE, success = true, to, value = "500000000000000000" } = {}) => ({
  block_number: block,
  from: { hash: from },
  success,
  timestamp,
  transaction_hash: hash,
  value,
  ...(to ? { to: { hash: to } } : {}),
});

/**
 * DuskEVM's explorer, answering an address's incoming calls a page at a
 * time, newest first: `pages` in order, each but the last saying where the
 * next starts (the last too, with `more`), in the parameters `next` gives.
 * `status` answers every request with that HTTP status instead. `urls`
 * keeps each request's URL, and `inits` its options.
 *
 * @param {any[][]} pages
 * @param {{ more?: boolean, status?: number, next?: (page: number) => Record<string, unknown> }} [options]
 */
export function fakeExplorer(pages, { more = false, next = (page) => ({ block_number: 99 - page, index: page + 1, items_count: 50 }), status = 200 } = {}) {
  /** @type {string[]} */
  const urls = [];
  /** @type {any[]} */
  const inits = [];

  return {
    /**
     * @param {string} url
     * @param {any} init
     */
    fetch: async (url, init) => {
      urls.push(String(url));
      inits.push(init);

      if (status !== 200) return new Response("", { status });

      const params = new URL(String(url)).searchParams;
      const page = Number(params.get("index") ?? params.get("page") ?? 0);

      return json({ items: pages[page] ?? [], next_page_params: page < pages.length - 1 || more ? next(page) : null });
    },
    inits,
    urls,
  };
}

/**
 * A log of the L2 bridge paying a deposit: `ETHBridgeFinalized(from, to,
 * amount, extraData)`.
 *
 * @param {{ from: string, to: string, wei: bigint, block: bigint | number, hash: string }} log
 */
export const bridgeFinalized = ({ block, from, hash, to, wei }) => ({
  address: L2_BRIDGE,
  block: BigInt(block),
  data: `0x${word(wei)}${word(64)}${word(0)}`,
  hash,
  topics: [ETH_BRIDGE_FINALIZED_TOPIC, topicOf(from), topicOf(to)],
});

/**
 * A token's `Transfer(from, to, value)`.
 *
 * @param {{ token: string, from: string, to: string, wei: bigint, block: bigint | number, hash: string }} log
 */
export const tokenTransfer = ({ block, from, hash, to, token, wei }) => ({
  address: token,
  block: BigInt(block),
  data: `0x${word(wei)}`,
  hash,
  topics: [TRANSFER_TOPIC, topicOf(from), topicOf(to)],
});

/**
 * An EVM chain's JSON-RPC: blocks up to `head`, block n made at `timeAt(n)`
 * (seconds), and `logs`, which eth_getLogs gives as a node does: in the
 * blocks asked, from the contract asked, matching the topics asked (null
 * matching any); with their block's time when `stamps` (as DuskEVM's RPC
 * gives it). It refuses to search more than `maxRange` blocks at once, as
 * some RPCs do. `calls` keeps each call.
 *
 * @param {{ head: bigint | number, timeAt?: (n: bigint) => number, logs?: any[], maxRange?: bigint, stamps?: boolean, url?: string }} options
 */
export function fakeChain({ head, logs = [], maxRange, stamps = false, timeAt = (n) => 1_792_980_000 + Number(n), url }) {
  const chain = {
    /** @type {{ method: string, params: any[], url: string }[]} */
    calls: [],
    head: BigInt(head),
    logs,
    /** @param {string} input @param {any} init */
    fetch: async (input, init) => {
      if (url) assertUrl(String(input), url);

      const { id, method, params } = JSON.parse(init.body);

      chain.calls.push({ method, params, url: String(input) });

      if (method === "eth_blockNumber") return json({ id, jsonrpc: "2.0", result: hex(chain.head) });

      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? chain.head : BigInt(params[0]);

        return json({ id, jsonrpc: "2.0", result: n > chain.head ? null : { number: hex(n), timestamp: hex(timeAt(n)) } });
      }

      if (method === "eth_getLogs") {
        const [filter] = params;
        const from = BigInt(filter.fromBlock);
        const to = BigInt(filter.toBlock);

        if (maxRange !== undefined && to - from + 1n > maxRange) {
          return json({ error: { code: -32005, message: `query exceeds max block range ${maxRange}` }, id, jsonrpc: "2.0" });
        }

        const result = chain.logs
          .filter(
            (log) =>
              log.block >= from &&
              log.block <= to &&
              log.address.toLowerCase() === String(filter.address).toLowerCase() &&
              filter.topics.every((/** @type {string | null} */ topic, /** @type {number} */ i) => topic === null || log.topics[i] === topic)
          )
          .map((log) => ({
            address: log.address.toLowerCase(),
            blockNumber: hex(log.block),
            data: log.data,
            logIndex: "0x0",
            removed: false,
            topics: log.topics,
            transactionHash: log.hash,
            ...(stamps ? { blockTimestamp: hex(timeAt(log.block)) } : {}),
          }));

        return json({ id, jsonrpc: "2.0", result });
      }

      return json({ error: { code: -32601, message: `the method ${method} does not exist` }, id, jsonrpc: "2.0" });
    },
    /** The methods called, in order. */
    methods: () => chain.calls.map((c) => c.method),
    /** The ranges eth_getLogs was asked for. */
    ranges: () => chain.calls.filter((c) => c.method === "eth_getLogs").map((c) => [BigInt(c.params[0].fromBlock), BigInt(c.params[0].toBlock)]),
  };

  return chain;
}

/**
 * A chain's `fetch` whose eth_getLogs answers come back without their logs:
 * `rate` of them at random, the same ones for the same `seed`, and the next
 * `times` answers for ranges holding a block `held` names (each answer left
 * without its logs counts for every such block in its range). A refusal
 * stays a refusal. `emptied` counts the answers left without their logs.
 *
 * @param {(input: string, init: any) => Promise<Response>} fetch
 * @param {{ rate?: number, seed?: number }} [options]
 */
export function emptying(fetch, { rate = 1 / 3, seed = 1 } = {}) {
  let drawn = 0;
  // Each draw from a hash of the seed and its count: nearby seeds' draws are
  // as unrelated as any others'.
  const random = () => createHash("sha256").update(`${seed}:${(drawn += 1)}`).digest().readUInt32BE(0) / 4_294_967_296;
  const rpc = {
    emptied: 0,
    /** @type {{ block: bigint, times: number }[]} */
    held: [],
    /** @param {string} input @param {any} init */
    fetch: async (input, init) => {
      const { id, method, params } = JSON.parse(init.body);
      const answer = await fetch(input, init);

      if (method !== "eth_getLogs") return answer;

      const [{ fromBlock, toBlock }] = params;
      const held = rpc.held.filter(({ block, times }) => times > 0 && block >= BigInt(fromBlock) && block <= BigInt(toBlock));
      const empty = random() < rate;
      const body = await answer.json();

      if (body.error || (!held.length && !empty)) return json(body);
      for (const each of held) each.times -= 1;
      rpc.emptied += 1;

      return json({ id, jsonrpc: "2.0", result: [] });
    },
  };

  return rpc;
}

/**
 * Asks as an app does while it waits: again with the scans the last results
 * gave, until one arrives with `hash`, or `calls` calls. The last results.
 *
 * @param {(scans: Map<string, any>) => Promise<{ arrivals: Map<string, any> }>} ask
 * @param {string} hash
 * @param {number} [calls]
 */
export async function untilArrived(ask, hash, calls = 10) {
  /** @type {Map<string, any>} */
  const scans = new Map();
  /** @type {{ arrivals: Map<string, any> }} */
  let result = { arrivals: new Map() };

  for (let call = 0; call < calls && result.arrivals.get(hash)?.state !== "arrived"; call += 1) {
    result = await ask(scans);

    for (const [each, arrival] of result.arrivals) if (arrival.scan) scans.set(each, arrival.scan);
  }

  return result;
}

/**
 * @param {string} input
 * @param {string} url
 */
function assertUrl(input, url) {
  if (input !== url) throw new Error(`asked ${input}, not ${url}`);
}

/**
 * A public transfer as the archive lists it: `value` lux from `sender` to
 * `receiver`, with `memo` as text.
 *
 * @param {{ hash: string, height: number, sender: string, receiver: string, value: bigint | number | string, memo?: string, refund?: [string, bigint | number] }} transfer
 */
export const moonlight = ({ hash, height, memo = "", receiver, refund, sender, value }) => ({
  block_height: height,
  events: [
    {
      data: { gas_spent: "1000", memo: hexText(memo), receiver, refund_info: refund ? [refund[0], String(refund[1])] : null, sender, value: String(value) },
      reverted: false,
      target: TRANSFER_CONTRACT,
      topic: "moonlight",
    },
  ],
  origin: hash,
});

/**
 * A deposit to DuskEVM as the archive lists it in its sender's history: the
 * deposit it paid the bridge, and the call's gas, refunded to `refundTo`
 * when given.
 *
 * @param {{ hash: string, height: number, sender: string, value: bigint | number | string, refundTo?: string }} deposit
 */
export const depositEntry = ({ hash, height, refundTo, sender, value }) => ({
  block_height: height,
  events: [
    { data: { receiver: BRIDGE, sender, value: String(value) }, reverted: false, target: TRANSFER_CONTRACT, topic: "deposit" },
    {
      data: { gas_spent: "1985878", memo: "", receiver: null, refund_info: refundTo ? [refundTo, "500"] : null, sender, value: "0" },
      reverted: false,
      target: TRANSFER_CONTRACT,
      topic: "moonlight",
    },
  ],
  origin: hash,
});

/**
 * A transaction's details as the archive gives them, sent at `seconds`,
 * with its call: a deposit's when `deposit` says what it pays.
 *
 * @param {number} seconds
 * @param {{ deposit?: { amountLux: bigint, to: string }, err?: string | null }} [options]
 */
export const details = (seconds, { deposit, err = null } = {}) => ({
  blockHash: "5c".repeat(32),
  blockTimestamp: seconds,
  err,
  gasSpent: 1985878,
  tx: {
    callData: deposit
      ? { contractId: BRIDGE, data: Buffer.from(encodeDepositArgs({ amountLux: deposit.amountLux, to: deposit.to })).toString("hex"), fnName: "depositETHToWithValue" }
      : null,
    gasLimit: 5000000,
    gasPrice: 1,
  },
});

/**
 * A public transfer as `tx(hash) { blockHeight blockTimestamp err tx { memo
 * json } }` gives it: `value` lux from `sender` to `receiver`, with `memo` as
 * text, in a block of `height` made at `seconds`; `refundTo` where the
 * unspent gas went.
 *
 * @param {{ height: number, seconds: number, sender: string, receiver: string, value: bigint | number | string, memo?: string, err?: string | null, refundTo?: string }} transfer
 */
export const transferTx = ({ err = null, height, memo = "", receiver, refundTo, seconds, sender, value }) => ({
  blockHeight: height,
  blockTimestamp: seconds,
  err,
  tx: {
    // As the node writes it: a u64 as a bare number.
    json: `{"type":"moonlight","sender":"${sender}","receiver":"${receiver}","value":${value},"nonce":1,"deposit":0,"fee":{"gas_limit":"500000000","gas_price":"1","refund_address":"${refundTo ?? sender}"},"call":null,"is_deploy":false,"memo":"${hexText(memo)}"}`,
    memo: hexText(memo),
  },
});

/**
 * A network's file with some of its routes changed, as a test needs them:
 * `migrations` and `services` merged into the routes with those IDs.
 *
 * @param {import("@dusk-network/networks").Network} net
 * @param {{ migrations?: Record<string, object>, services?: Record<string, object> }} changes
 * @returns {import("@dusk-network/networks").Network}
 */
export function withRoutes(net, { migrations = {}, services = {} }) {
  const copy = structuredClone(net);

  return {
    ...copy,
    routes: {
      ...copy.routes,
      migrations: copy.routes.migrations.map((route) => ({ ...route, ...(migrations[route.id] ?? {}) })),
      services: copy.routes.services.map((route) => ({ ...route, ...(services[route.id] ?? {}) })),
    },
  };
}
