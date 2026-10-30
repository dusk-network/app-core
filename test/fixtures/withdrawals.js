// What the withdrawal tests start from: testnet's own withdrawal records,
// withdrawals built the way DuskEVM's bridge writes them, the Portal's and
// the dispute game factory's data drivers as the network's file pins them,
// and a chain whose contracts answer as a test says, read through one fetch
// that sends the reads one task starts as one query, as Multicall for Dusk
// does.

import { readFileSync } from "node:fs";

import { networks } from "@dusk-network/networks";
import { accountToRawKey } from "@dusk-network/networks/account";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi } from "viem";

import { DRIVERS_URL, DriverMismatchError, fetchDrivers } from "../../scripts/fetch-drivers.js";

export const TESTNET = networks.testnet;
export const NODE = "https://node.example.test";
export const PORTAL = TESTNET.duskEvm?.contracts.optimism_portal.contractId ?? "";
export const FACTORY = TESTNET.duskEvm?.contracts.dispute_game_factory.contractId ?? "";
export const REGISTRY = TESTNET.duskEvm?.contracts.anchor_state_registry.contractId ?? "";
export const HUB = "d5".repeat(32);

/** Testnet's tip on 28 Oct 2026: its contracts count Dusk block height × 10. */
export const TIP = Object.freeze({ height: 4_704_959n, timestamp: 1_793_156_989n });

export const USER2 =
  "21n5ncyuJkRr9JRoxvWRLMcqcWxmVSSLdefDMTwQeNyZZikU5dcXuawf9kNuG1CxFvz32oBM965PQ2PCcWrwX8YX9a7fqaaQ6fabDhxW5mveEyAt4LgdY3KLH9iKtSfMMLNz";
/** Whom testnet's 1,008 DUSK withdrawal pays. */
export const PAID =
  "213qXNRaEAXrgJTFxXsPMeFasiEtPVJwZ3x2wKgZog2kXtXE7ovGRFfn1spfKBU4AUitAS91nM5T7HSvwRiyYCHLRaTTnJQbZn1TKnDySEiKZxX8vyodtWorbMuybDV5JJ9Y";
/** Who sent it on DuskEVM. */
export const WITHDRAWER = "0x75685f9D88749B583732B40d56fe007cD404b72D";

/**
 * A number as 32 big-endian bytes, as the contracts' U256 are written.
 *
 * @param {bigint | number} value
 * @returns {number[]}
 */
export function u256(value) {
  let rest = BigInt(value);
  const out = Array(32).fill(0);

  for (let i = 31; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  return out;
}

/** @param {string} hex */
export const bytes = (hex) => Array.from(Buffer.from(hex.replace(/^0x/, ""), "hex"));

/** @param {ArrayLike<number>} array */
export const hexOf = (array) => `0x${Buffer.from(Uint8Array.from(array)).toString("hex")}`;

/** @param {number[]} address */
export const indexOfProxy = (address) => address[18] * 256 + address[19];

// ---------------------------------------------------------------------------
// Testnet's own records
// ---------------------------------------------------------------------------

/**
 * Testnet's 1,008 DUSK withdrawal 0x04a8a897… (nonce 42, DuskEVM block
 * 0x2f265d), to 213qXN…: its MessagePassed event, as its receipt gives it.
 */
export const LOG_1008 = Object.freeze({
  address: "0x4200000000000000000000000000000000000016",
  blockHash: "0x36661afd973d322d70bfb4e3af8ec32a944c9d39bccbae85187180100e3281ee",
  blockNumber: "0x2f265d",
  data: "0x000000000000000000000000000000000000000000000036a4cf636319c00000000000000000000000000000000000000000000000000000000000000007ed7600000000000000000000000000000000000000000000000000000000000000804b3472cff93e5bbf3231165ad48c0f302cf597c212b7d0e14dc671b49dc4101a0000000000000000000000000000000000000000000000000000000000000284d764ad0b000100000000000000000000000000000000000000000000000000000000002a00000000000000000000000042000000000000000000000000000000000000100000000000000000000000002d2e08c0e8d64381db56bf2c942bc825602e61c3000000000000000000000000000000000000000000000036a4cf636319c000000000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001841635f5fd00000000000000000000000075685f9d88749b583732b40d56fe007cd404b72d00000000000000000000000075685f9d88749b583732b40d56fe007cd404b72d000000000000000000000000000000000000000000000036a4cf636319c00000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c4020100e1347f1febd1eb38cb65b12f1f0487cd9c5eb39cddeab48116737e548b546d37b0eb6b696866a2e38d1c86be5a0d8814ecb0b1eef777121a3382fbf1da5ce11ac85c10b512250875c370fea63726c33b719fd3447056bdb56821192d7f6b5d1758340c277ba16a8746461a26a79cd53d37887431ec75dd8343bd5877fa51757c86d9151090d8f77fb1fa174fcc104b0c86bc21e64829e5a124f33d40628751dafbb1d0162d7a162e6db07b814eb82240648f9f6ee492800248c8f586ce78380e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  logIndex: "0x2",
  removed: false,
  topics: [
    "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054",
    "0x000100000000000000000000000000000000000000000000000000000000002a",
    "0x0000000000000000000000004200000000000000000000000000000000000007",
    "0x0000000000000000000000008b6aa15321d9656c91ad2d5fbc2ae8b750ad6f9a",
  ],
  transactionHash: "0x04a8a8977dd251da49bd8997cf4d063ddc385f8d29b437b119bb3c79c11b3213",
  transactionIndex: "0x1",
});
export const TX = LOG_1008.transactionHash;

/** Testnet's 10 DUSK withdrawal 0xa6aab6de… (nonce 39), which credits the Dusk contract ed7176a3…. */
export const LOG_CONTRACT_CREDIT = Object.freeze({
  address: "0x4200000000000000000000000000000000000016",
  blockHash: "0x256d2123b3ea586f354a82f2f90b14a60952ad278782e074ce757aaece734343",
  blockNumber: "0x275e9b",
  data: "0x0000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000007ed76000000000000000000000000000000000000000000000000000000000000008051ff59b7dadcd8fda691acd6e2812d258e9b0085ef98b736ccc875532195a9ba0000000000000000000000000000000000000000000000000000000000000284d764ad0b000100000000000000000000000000000000000000000000000000000000002700000000000000000000000042000000000000000000000000000000000000100000000000000000000000002d2e08c0e8d64381db56bf2c942bc825602e61c30000000000000000000000000000000000000000000000008ac7230489e800000000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001841635f5fd000000000000000000000000c11d5aab4234e255e214ac6e8c0ad61fa0836473000000000000000000000000baba1407b524d6eb071a6a9491bf4ee862cd9f0f0000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c32001ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af01b3361f2759a66e72a5f5583110b8da34d69ac33295d324054e64ecabca4fdb04994a34d9d706b734653ee62abef187d8e70de94567585c36f750fcf6270e2729a7ca16a99da87b7ea628976e18ecf7bc5cfb2ffc1ee9fb2966c927672779ca2d3010cc2aa539f0926073399784b82f6a0341551da9385e1668b0118e940e2bca03bf0cf8f38b3867e93d0e5f2a5df5e5a4c432522ea2c0f8e366492f22d08a7800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  logIndex: "0x2",
  removed: false,
  topics: [
    "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054",
    "0x0001000000000000000000000000000000000000000000000000000000000027",
    "0x0000000000000000000000004200000000000000000000000000000000000007",
    "0x0000000000000000000000008b6aa15321d9656c91ad2d5fbc2ae8b750ad6f9a",
  ],
  transactionHash: "0xa6aab6def93aacb94c0e902fcbdaa613416d0a39ecade5eb2588f8b7046e60ff",
  transactionIndex: "0x1",
});
export const CREDITED = "ed7176a3a7845a577732395887494965ae49c0daf29672d4370121b51844a0af";

/**
 * A MessagePassed shaped like the bridge's, but sent to 0x04ffbC4C…, not to
 * Dusk's messenger: a 10 DUSK message, as a test of the web wallet's had it.
 */
export const LOG_OFF_ROUTE = Object.freeze({
  address: "0x4200000000000000000000000000000000000016",
  blockHash: "0x5510dbadb5bce778c1b7b331d37fcc0c86f2fe55f7b60f83b6d678b60f7726e0",
  blockNumber: "0x3564",
  data: "0x0000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000007ed760000000000000000000000000000000000000000000000000000000000000080e78b3f4d6f313300774677027a3a41540ab6eeaed0c3464d5865d53553fc27860000000000000000000000000000000000000000000000000000000000000284d764ad0b00010000000000000000000000000000000000000000000000000000000000070000000000000000000000004200000000000000000000000000000000000010000000000000000000000000f44f202151ffb9742ad4391849c62be3fb441e720000000000000000000000000000000000000000000000008ac7230489e800000000000000000000000000000000000000000000000000000000000000030d4000000000000000000000000000000000000000000000000000000000000000c000000000000000000000000000000000000000000000000000000000000001841635f5fd000000000000000000000000eb9ea22334e679cdbc669cf9ad2d713b559708b1000000000000000000000000eb9ea22334e679cdbc669cf9ad2d713b559708b10000000000000000000000000000000000000000000000008ac7230489e80000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000c200fafd19fa981abfac15b121a37fabbf45d8e5630d79da8d13fae7c3c5dd03afb611f1c468c1b5961b5ecdfff7bc85c319b53a1d9979c7c041926e5b7cbf5e4dfe5adc1369895d5e341a7651079b25663c58909f2cf400d4cb70651413c5cd06185747ff4aac9dfe2d947fb6fdbf470562e3ee884afbf66427e4171dc95bc41ba64f5d97e6859cb85b307108b51f15c801d14c78437c13edef03ad3d455193020a6a1c99858112912522dace4683191ae1274ddfea6e686a9724eed4012029e913000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
  logIndex: "0x2",
  removed: false,
  topics: [
    "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054",
    "0x0001000000000000000000000000000000000000000000000000000000000007",
    "0x0000000000000000000000004200000000000000000000000000000000000007",
    "0x00000000000000000000000004ffbc4c863235f94f99ccc849de181a1ab74759",
  ],
  transactionHash: "0x57ac2440f740f3cdd4c90c758dcf28be7b35ed496d8b580958693d2e37883a57",
  transactionIndex: "0x1",
});

/**
 * A receipt with one log, as DuskEVM's RPC gives it.
 *
 * @param {any} log
 * @param {Record<string, unknown>} [fields]
 */
export const receiptOf = (log, fields = {}) => ({
  blockHash: log.blockHash,
  blockNumber: log.blockNumber,
  logs: [log],
  status: "0x1",
  transactionHash: log.transactionHash,
  ...fields,
});

// ---------------------------------------------------------------------------
// Withdrawals built as DuskEVM's bridge writes them
// ---------------------------------------------------------------------------

const MESSAGE_PASSED = parseAbi([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);
const BRIDGE_ABI = parseAbi([
  "function relayMessage(uint256 _nonce, address _sender, address _target, uint256 _value, uint256 _minGasLimit, bytes _message)",
  "function finalizeBridgeETH(address _from, address _to, uint256 _amount, bytes _extraData)",
  "function finalizeBridgeERC20(address _localToken, address _remoteToken, address _from, address _to, uint256 _amount, bytes _extraData)",
]);

/** DuskEVM testnet's bridge route: its messenger and bridge, and Dusk's. */
export const ROUTE = Object.freeze({
  l1Bridge: /** @type {`0x${string}`} */ (TESTNET.duskEvm?.contracts.l1_standard_bridge.evmAddress ?? "0x"),
  l1Messenger: /** @type {`0x${string}`} */ (TESTNET.duskEvm?.contracts.l1_cross_domain_messenger.evmAddress ?? "0x"),
  l2Bridge: /** @type {`0x${string}`} */ (TESTNET.duskEvm?.predeploys.l2StandardBridge ?? "0x"),
  l2Messenger: /** @type {`0x${string}`} */ (TESTNET.duskEvm?.predeploys.l2CrossDomainMessenger ?? "0x"),
});
export const USER = "0xeb9ea22334e679cdbc669cf9ad2d713b559708b1";

/**
 * The bridge's extra data for a Dusk account: tag 2, version 1, kind 0, its raw key.
 *
 * @param {string} account
 * @returns {`0x${string}`}
 */
export const paysAccount = (account) => /** @type {`0x${string}`} */ (hexOf([2, 1, 0, ...(accountToRawKey(account) ?? [])]));

/**
 * The bridge's extra data for a Dusk contract: tag 32, version 1, its ID.
 *
 * @param {string} contractId
 * @returns {`0x${string}`}
 */
export const paysContract = (contractId) => /** @type {`0x${string}`} */ (hexOf([32, 1, ...bytes(contractId)]));

/**
 * The withdrawal's hash, as the Portal keys it.
 *
 * @param {{ nonce: bigint, sender: string, target: string, value: bigint, gasLimit: bigint, data: `0x${string}` }} w
 */
export const hashOf = (w) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
      [w.nonce, /** @type {`0x${string}`} */ (w.sender), /** @type {`0x${string}`} */ (w.target), w.value, w.gasLimit, w.data]
    )
  );

/**
 * A MessagePassed log of a withdrawal built as DuskEVM's bridge writes one,
 * paying `extraData` (USER2's account by default), with the parts a case
 * changes.
 *
 * @param {{ amount?: bigint, blockNumber?: string, extraData?: `0x${string}`, gasLimit?: bigint, hash?: `0x${string}`, message?: `0x${string}`, nonce?: bigint, relaySender?: string, relayTarget?: string, relayValue?: bigint, sender?: string, target?: string, to?: string, tx?: string, value?: bigint }} [parts]
 */
export function passedLog({
  amount = 10n ** 19n,
  blockNumber = LOG_1008.blockNumber,
  extraData = paysAccount(USER2),
  gasLimit = 519_542n,
  hash,
  message,
  nonce = (1n << 240n) | 7n,
  relaySender = ROUTE.l2Bridge,
  relayTarget = ROUTE.l1Bridge,
  relayValue = amount,
  sender = ROUTE.l2Messenger,
  target = ROUTE.l1Messenger,
  to = USER,
  tx = TX,
  value = amount,
} = {}) {
  const data = encodeFunctionData({
    abi: BRIDGE_ABI,
    args: [
      nonce,
      /** @type {`0x${string}`} */ (relaySender),
      /** @type {`0x${string}`} */ (relayTarget),
      relayValue,
      200_000n,
      message ?? encodeFunctionData({ abi: BRIDGE_ABI, args: [USER, /** @type {`0x${string}`} */ (to), amount, extraData], functionName: "finalizeBridgeETH" }),
    ],
    functionName: "relayMessage",
  });
  const withdrawal = { data, gasLimit, nonce, sender, target, value };

  return {
    address: "0x4200000000000000000000000000000000000016",
    blockNumber,
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }],
      [value, gasLimit, data, hash ?? hashOf(withdrawal)]
    ),
    logIndex: "0x2",
    topics: encodeEventTopics({
      abi: MESSAGE_PASSED,
      args: { nonce, sender: /** @type {`0x${string}`} */ (sender), target: /** @type {`0x${string}`} */ (target) },
      eventName: "MessagePassed",
    }),
    transactionHash: tx,
  };
}

/** A token withdrawal through the same bridge and messenger. */
export const tokenMessage = () =>
  encodeFunctionData({ abi: BRIDGE_ABI, args: [USER, USER, USER, USER, 5n, "0x"], functionName: "finalizeBridgeERC20" });

// ---------------------------------------------------------------------------
// Drivers
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Why a test that runs the drivers skips: they weren't fetched before, and can't be now. */
export const DRIVERS_MISSING = `needs the network's pinned data drivers, which couldn't be fetched from ${DRIVERS_URL}: run \`npm run fetch:drivers\` with network access`;

/** @type {Promise<Record<string, URL> | null> | null} */
let drivers = null;

/**
 * The drivers' files, fetched once when they aren't kept; null when they
 * can't be fetched. One that isn't the pinned driver fails the run.
 */
const driverFiles = () =>
  (drivers ??= fetchDrivers().catch((error) => {
    if (error instanceof DriverMismatchError) throw error;

    return null;
  }));

/**
 * One of the network's data drivers, as its file pins it, its FFI as the
 * apps run it: JSON in, rkyv out, and back. Null when the drivers can't be
 * fetched: the tests that run it skip (`DRIVERS_MISSING`).
 *
 * @param {"optimismPortal" | "disputeGameFactory"} name
 */
export async function pinnedDriver(name) {
  const files = await driverFiles();

  if (!files) return null;

  const wasm = readFileSync(files[name]);
  const { instance } = await WebAssembly.instantiate(wasm, { env: {} });
  const ffi = /** @type {any} */ (instance.exports);
  const memory = () => /** @type {WebAssembly.Memory} */ (ffi.memory).buffer;
  /** @param {Uint8Array} data */
  const put = (data) => {
    const ptr = ffi.alloc(data.length);

    new Uint8Array(memory(), ptr, data.length).set(data);

    return ptr;
  };
  /** @param {(ptr: number, size: number) => number} run */
  const out = (run) => {
    const size = 1 << 21;
    const ptr = ffi.alloc(size);

    try {
      const code = run(ptr, size);
      const length = new DataView(memory(), ptr, 4).getUint32(0, true);
      const data = new Uint8Array(memory(), ptr + 4, length).slice();

      if (code !== 0) {
        const at = ffi.alloc(4096);

        ffi.get_last_error(at, 4096);

        throw new Error(decoder.decode(new Uint8Array(memory(), at + 4, new DataView(memory(), at, 4).getUint32(0, true))));
      }

      return data;
    } finally {
      ffi.dealloc(ptr, size);
    }
  };
  /** @param {string} fn @param {string} json @param {Uint8Array} b @param {string} exported */
  const two = (fn, exported, json, b = encoder.encode(json)) => {
    const name = encoder.encode(fn);
    const a = put(name);
    const c = put(b);

    try {
      return out((ptr, size) => ffi[exported](a, name.length, c, b.length, ptr, size));
    } finally {
      ffi.dealloc(a, name.length);
      ffi.dealloc(c, b.length);
    }
  };

  ffi.init?.();

  return Object.freeze({
    /** @param {string} fn @param {Uint8Array} b */
    decodeInputFn: (fn, b) => JSON.parse(decoder.decode(two(fn, "decode_input_fn", "", b))),
    /** @param {string} fn @param {Uint8Array} b */
    decodeOutputFn: (fn, b) => JSON.parse(decoder.decode(two(fn, "decode_output_fn", "", b))),
    /** @param {string} fn @param {string} json */
    encodeInputFn: (fn, json) => two(fn, "encode_input_fn", json),
  });
}

/** The Portal's calls a wallet signs. */
const CALLS = new Set(["proveWithdrawalTransaction", "finalizeWithdrawalTransaction"]);

/**
 * A driver for a chain whose reads a test answers in JSON: reads in and out
 * as JSON text, and the Portal's two calls encoded by `real`, as a wallet
 * signs them.
 *
 * @param {{ encodeInputFn(fn: string, json: string): Uint8Array } | null} [real]
 */
export const jsonDriver = (real = null) =>
  Object.freeze({
    /** @param {string} _fn @param {Uint8Array} b */
    decodeOutputFn: (_fn, b) => JSON.parse(decoder.decode(b)),
    /** @param {string} fn @param {string} json */
    encodeInputFn: (fn, json) => (real && CALLS.has(fn) ? real.encodeInputFn(fn, json) : encoder.encode(json)),
  });

// ---------------------------------------------------------------------------
// A chain a test sets
// ---------------------------------------------------------------------------

/**
 * @param {bigint | number} value
 * @returns {Uint8Array}
 */
function u64Le(value) {
  const out = new Uint8Array(8);

  new DataView(out.buffer).setBigUint64(0, BigInt(value), true);

  return out;
}

/**
 * An answer as JSON: none (a check that passes, `()`) as null.
 *
 * @param {unknown} value
 */
const jsonBytes = (value) =>
  encoder.encode(
    value === undefined
      ? "null"
      : JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? (Number.isSafeInteger(Number(item)) ? Number(item) : item.toString()) : item))
  );

/**
 * @typedef {Record<string, (args: any) => unknown>} Handlers
 *   A contract's answers, by function: the arguments in, the answer out; a
 *   handler that throws is a refusal, its message the contract's.
 */

/**
 * A chain the test sets: the Portal and the factory answer as `portal` and
 * `dgf` say (in JSON), each game's hub and the registry as `hub` and
 * `registry` say (raw, as theirs are read), DuskEVM as `l2` says. The reads
 * one task starts go as one query (`queries` keeps each one's function
 * names); `calls` keeps every read, `hubs` the hubs read, `rpc` the
 * DuskEVM requests and `tips` how often the latest block was read.
 *
 * @param {{ portal?: Handlers, dgf?: Handlers, hub?: Handlers, registry?: Handlers, l2?: Handlers, tip?: { height: bigint, timestamp: bigint } | (() => any), drivers?: any }} options
 */
export function fakeChain({ dgf = {}, drivers = { disputeGameFactory: jsonDriver(), optimismPortal: jsonDriver() }, hub = {}, l2 = {}, portal = {}, registry = {}, tip = TIP }) {
  /** @type {string[][]} */
  const queries = [];
  /** @type {{ contract: string, fn: string, args: any }[]} */
  const calls = [];
  /** @type {string[]} */
  const hubs = [];
  /** @type {{ method: string, params: any[] }[]} */
  const rpc = [];
  const counts = { tips: 0 };
  /** @type {Array<() => void>} */
  let queue = [];
  /** @type {string[]} */
  let names = [];

  /**
   * @param {string} id
   * @param {string} fn
   * @param {Uint8Array} body
   * @returns {Promise<Response>}
   */
  async function answer(id, fn, body) {
    const raw = id !== PORTAL && id !== FACTORY;
    const table = id === PORTAL ? portal : id === FACTORY ? dgf : id === REGISTRY ? registry : hub;
    const args = raw ? Array.from(body) : JSON.parse(decoder.decode(body));

    if (id !== PORTAL && id !== FACTORY && id !== REGISTRY) hubs.push(id);

    calls.push({ args, contract: id === PORTAL ? "portal" : id === FACTORY ? "dgf" : id === REGISTRY ? "registry" : "hub", fn });

    const handler = table[fn];

    if (!handler) return new Response(`${fn} isn't answered here`, { status: 500 });

    try {
      const value = await handler(args);

      if (!raw) return new Response(jsonBytes(value));
      if (value instanceof Uint8Array) return new Response(value);
      if (typeof value === "boolean") return new Response(Uint8Array.of(value ? 1 : 0));
      if (fn === "statusForGame") return new Response(Uint8Array.of(Number(value)));

      return new Response(u64Le(/** @type {bigint} */ (value)));
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 500 });
    }
  }

  /**
   * @param {string} url
   * @param {any} init
   * @returns {Promise<Response>}
   */
  const fetch = (url, init) => {
    const read = /\/on\/contracts:([0-9a-f]{64})\/(\w+)$/.exec(String(url));

    if (!read) return Promise.reject(new Error(`Not a read: ${url}`));

    return new Promise((resolve) => {
      if (!queue.length) {
        // The reads one task starts go together, as Multicall for Dusk sends them.
        setTimeout(() => {
          const batch = queue;

          queries.push(names);
          queue = [];
          names = [];
          for (const run of batch) run();
        }, 0);
      }

      names.push(read[2]);
      queue.push(() => resolve(answer(read[1], read[2], new Uint8Array(init.body))));
    });
  };

  return {
    calls,
    counts,
    /** @param {string} fn @param {string} [contract] */
    callsOf: (fn, contract) => calls.filter((call) => call.fn === fn && (!contract || call.contract === contract)),
    drivers,
    duskEvm: {
      /** @param {{ method: string, params: any[] }} request */
      request: async ({ method, params }) => {
        rpc.push({ method, params });

        const handler = l2[method];

        if (!handler) throw new Error(`${method} isn't answered here`);

        return handler(params);
      },
    },
    fetch: /** @type {typeof globalThis.fetch} */ (/** @type {unknown} */ (fetch)),
    hubs,
    latestBlock: async () => {
      counts.tips += 1;

      return typeof tip === "function" ? tip() : tip;
    },
    queries,
    rpc,
  };
}

/**
 * The options `createWithdrawals` takes for a fake chain.
 *
 * @param {ReturnType<typeof fakeChain>} chain
 * @param {Record<string, unknown>} [more]
 */
export const withdrawalsOn = (chain, more = {}) => ({
  drivers: chain.drivers,
  duskEvm: chain.duskEvm,
  fetch: chain.fetch,
  latestBlock: chain.latestBlock,
  network: TESTNET,
  nodeUrl: NODE,
  ...more,
});
