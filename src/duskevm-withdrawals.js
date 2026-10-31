/* @ts-self-types="./duskevm-withdrawals.d.ts" */
/**
 * A DuskEVM → Dusk withdrawal's life, signing aside: its start on DuskEVM,
 * finding it again, where it is on Dusk, the game its proof goes against,
 * and its proof's and claim's calls, checked before they're handed over.
 * The app passes its clients, the data drivers it loaded and its caches;
 * nothing is kept outside the objects the factory makes.
 *
 * @module
 */

import { networkFor } from "@dusk-network/networks";
import { accountToRawKey } from "@dusk-network/networks/account";
import {
  BRIDGE_FUNCTIONS,
  GAME_STATUS,
  claimFrom,
  claimReadiness,
  contractClock,
  contractNow,
  decodeBridgeCall,
  decodeWithdrawal,
  duskEvmContracts,
  duskRecipientOf,
  evmAddressOf,
  isCandidateGame,
  isEligibleGame,
  wallTime,
} from "@dusk-network/networks/duskevm";
import { formatEvmAddress } from "@dusk-network/networks/format";
import { withdrawalGasLimit } from "@dusk-network/networks/gas";
import {
  decodeAbiParameters,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionData,
  fromRlp,
  keccak256,
  pad,
  parseAbi,
  toHex,
  toRlp,
} from "viem";

import { addCoverage, topGap } from "./history.js";

/** @typedef {import("./duskevm-withdrawals.js").DataDriver} DataDriver */
/** @typedef {import("./duskevm-withdrawals.js").DriverSource} DriverSource */
/** @typedef {import("./duskevm-withdrawals.js").DuskEvmClient} DuskEvmClient */
/** @typedef {import("./duskevm-withdrawals.js").ExplorerWithdrawal} ExplorerWithdrawal */
/** @typedef {import("./duskevm-withdrawals.js").FactCache} FactCache */
/** @typedef {import("./duskevm-withdrawals.js").FoundWithdrawal} FoundWithdrawal */
/** @typedef {import("./duskevm-withdrawals.js").L2Withdrawal} L2Withdrawal */
/** @typedef {import("./duskevm-withdrawals.js").OutputProof} OutputProof */
/** @typedef {import("./duskevm-withdrawals.js").PortalCall} PortalCall */
/** @typedef {import("./duskevm-withdrawals.js").PreparedProof} PreparedProof */
/** @typedef {import("./duskevm-withdrawals.js").ReceiptWithdrawal} ReceiptWithdrawal */
/** @typedef {import("./duskevm-withdrawals.js").WaitReason} WaitReason */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalCallInput} WithdrawalCallInput */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalClaim} WithdrawalClaim */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalErrorCode} WithdrawalErrorCode */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalScan} WithdrawalScan */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalStage} WithdrawalStage */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalStatus} WithdrawalStatus */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalTiming} WithdrawalTiming */
/** @typedef {import("./duskevm-withdrawals.js").WithdrawalsOptions} WithdrawalsOptions */
/** @typedef {import("@dusk-network/networks").Network} Network */
/** @typedef {import("@dusk-network/networks").NetworkRef} NetworkRef */
/** @typedef {import("@dusk-network/networks/duskevm").ClaimDate} ClaimDate */
/** @typedef {import("@dusk-network/networks/duskevm").DuskRecipient} DuskRecipient */
/** @typedef {import("@dusk-network/networks/duskevm").DuskTip} DuskTip */
/** @typedef {import("@dusk-network/networks/duskevm").GameRules} GameRules */
/** @typedef {import("@dusk-network/networks/duskevm").WithdrawalFacts} WithdrawalFacts */
/**
 * What the Portal and the factory said of a withdrawal, in one query.
 *
 * @typedef {{
 *   ahead: { game: string, reads: Promise<Array<{ value?: any, error?: Error }>> } | null,
 *   delays: { disputeGameFinalityDelaySeconds: bigint, proofMaturityDelaySeconds: bigint },
 *   finalized: boolean,
 *   gameCount: bigint,
 *   gameType: number,
 *   proofSubmitterCount: bigint,
 *   proven: { disputeGameProxy: `0x${string}`, timestamp: bigint },
 *   tip: Promise<DuskTip> | null,
 * }} Snapshot
 */

export const GAME_SEARCH_DEPTH = 64;
export const RESOLVED_PAGE = 32;
export const RESOLVED_PAGES = 3;
export const RESOLVER_LAG_SECONDS = 3_600;
export const MAX_BATCH = 32;
export const GAS_LIMIT_UPPER = 1_000_000_000n;
export const WITHDRAWAL_MIN_GAS_LIMIT = 200_000;
export const L2_WINDOW = 100_000;
export const L2_RUN_REQUESTS = 8;
export const UNFINALIZED_MARGIN = 1_800;
export const EXPLORER_PAGES = 10;
export const EXPLORER_ITEMS = 12;
export const MESSAGE_PASSED_TOPIC = "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054";
export const ETH_BRIDGE_INITIATED_TOPIC = "0x2849b43074093a05396b6f2a937dee8565b15a48a7b3d4bffb732a5017380af5";

export const STAGE = Object.freeze({
  WAITING_FOR_OUTPUT: "waiting_for_output",
  READY_TO_PROVE: "ready_to_prove",
  PROVEN_WAITING: "proven_waiting",
  READY_TO_FINALIZE: "ready_to_finalize",
  FINALIZED: "finalized",
});

/** The latest games read for how often outputs come: five gaps. */
const OUTPUT_SAMPLE = 6n;
/** Games a scan for the newest covering game reads at once. */
const SCAN_PAGE = 32n;
/** Other accounts' proofs looked at, at most. */
const OTHER_PROOFS = 8n;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** @type {`0x${string}`} */
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";
const MESSAGE_PASSER = "0x4200000000000000000000000000000000000016";
const WEI_PER_LUX = 1_000_000_000n;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = (1n << 32n) - 1n;
/** The low 240 bits of a withdrawal's nonce: its count, under its version. */
const NONCE_COUNT = (1n << 240n) - 1n;

// The newest final blocks a sync reads again on each run, the new ones
// among them, and how long after it first covered all the final blocks it
// reads them all again: each pass after waits as long again as it has been
// since.
const L2_OVERLAP = 50_000;
const L2_RECHECK_MS = 60 * 60_000;
// Answers a read is sent again for, a quarter second, then half a second later.
const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const ATTEMPTS = 3;
const RETRY_MS = 250;

const PROVE = BRIDGE_FUNCTIONS.prove;
const CLAIM = BRIDGE_FUNCTIONS.claim;
/**
 * A proof's archived arguments end with their root: the output root proof
 * (version, state root, message passer storage root, block hash: 32 bytes
 * each), the game's index (32), the withdrawal (144), and its proof's
 * nodes, a Vec<Vec<u8>> (8), as the Portal's data driver writes them.
 */
const PROVE_ROOT = 312;
const PROOF_NODES_AT = 304;

const MESSAGE_PASSED = parseAbi([
  "event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)",
]);
const BRIDGE_ETH_TO = parseAbi(["function bridgeETHTo(address _to, uint32 _minGasLimit, bytes _extraData)"]);
const BRIDGE_ETH_TO_SELECTOR = "0xe11013dd";

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** @type {Record<WithdrawalErrorCode, string>} */
const REFUSALS = {
  "bad-hash": "Not a DuskEVM transaction hash",
  "not-found": "DuskEVM has no receipt of this transaction",
  failed: "The transaction failed on DuskEVM",
  "not-a-withdrawal": "Not a DUSK withdrawal on the bridge's route",
  gas: "The withdrawal's proof and claim need more gas than the bound",
  claimed: "The withdrawal is claimed already",
  proven: "This account has proved the withdrawal already",
  "no-proof": "No dispute game covers the withdrawal yet",
  "not-ready": "The withdrawal isn't ready to claim",
  "bad-call": "The encoded call doesn't read back as what it was built from",
};

export class WithdrawalError extends Error {
  /**
   * @param {WithdrawalErrorCode} code
   * @param {string} [message]
   * @param {{ status?: WithdrawalStatus | null, reason?: WaitReason | null, cause?: unknown }} [options]
   */
  constructor(code, message, { cause, reason, status = null } = {}) {
    super(message ?? REFUSALS[code] ?? String(code), cause === undefined ? undefined : { cause });
    this.name = "WithdrawalError";
    /** @type {WithdrawalErrorCode} */
    this.code = code;
    /** @type {WithdrawalStatus | null} */
    this.status = status;
    /** @type {WaitReason | null} */
    this.reason = reason ?? status?.reason ?? null;
  }
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * @param {unknown} error
 * @returns {Error}
 */
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));

/**
 * @template T
 * @param {Promise<T> | T} promise
 * @returns {Promise<{ value?: T, error?: Error }>}
 */
const settle = (promise) =>
  Promise.resolve(promise).then(
    (value) => ({ value }),
    (error) => ({ error: asError(error) })
  );

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bytes as a driver gives or takes them: 0x hex, a Uint8Array, an
 * ArrayBuffer, or an array of numbers.
 *
 * @param {unknown} value
 * @returns {number[]}
 */
function bytesOf(value) {
  if (typeof value === "string") {
    if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError("Expected 0x-prefixed byte hex");

    return Array.from({ length: (value.length - 2) / 2 }, (_, i) => parseInt(value.slice(2 + 2 * i, 4 + 2 * i), 16));
  }

  if (value instanceof Uint8Array) return Array.from(value);
  if (value instanceof ArrayBuffer) return Array.from(new Uint8Array(value));

  if (Array.isArray(value)) {
    return value.map((byte) => {
      const n = Number(byte);

      if (!Number.isInteger(n) || n < 0 || n > 255) throw new TypeError("Expected bytes");

      return n;
    });
  }

  throw new TypeError("Expected bytes or byte hex");
}

/**
 * @param {unknown} value
 * @param {number} length
 * @returns {number[]}
 */
function fixedBytes(value, length) {
  const bytes = bytesOf(value);

  if (bytes.length !== length) throw new RangeError(`Expected ${length} bytes, got ${bytes.length}`);

  return bytes;
}

/**
 * @param {ArrayLike<number>} bytes
 * @returns {`0x${string}`}
 */
const hexOf = (bytes) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;

/**
 * A U256 as the contracts take it: 32 bytes, big-endian.
 *
 * @param {bigint} value
 * @returns {number[]}
 */
function u256Bytes(value) {
  let rest = BigInt(value);

  if (rest < 0n || rest >= 1n << 256n) throw new RangeError("Not a U256");

  const out = new Array(32).fill(0);

  for (let i = 31; i >= 0; i--) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  return out;
}

/**
 * A number as a driver gives it: a bigint, a number, its text, or a U256's 32 bytes.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function bigOf(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" || typeof value === "string") return BigInt(value);

  return fixedBytes(value, 32).reduce((n, byte) => (n << 8n) | BigInt(byte), 0n);
}

/**
 * A struct's field, as a driver gives it by name or as a tuple by position.
 *
 * @param {any} value
 * @param {string} key
 * @param {number} index
 */
const tupleValue = (value, key, index) => value?.[key] ?? value?.[index];

/**
 * An address as the reads give it, 20 bytes or their hex, in lower case.
 *
 * @param {unknown} value
 * @returns {`0x${string}`}
 */
const addressHex = (value) => hexOf(fixedBytes(value, 20));

/**
 * @param {string} address
 * @returns {number[]}
 */
const addressBytes = (address) => fixedBytes(address.toLowerCase(), 20);

/**
 * A contract ID as a read gives it, 32 bytes or their hex, as lower-case hex.
 *
 * @param {unknown} value
 * @returns {string}
 */
function contractIdHex(value) {
  const id =
    typeof value === "string"
      ? value.replace(/^0x/, "").toLowerCase()
      : value instanceof Uint8Array || Array.isArray(value)
        ? hexOf(fixedBytes(value, 32)).slice(2)
        : "";

  if (!/^[0-9a-f]{64}$/.test(id)) throw new RangeError("Expected a 32-byte contract ID");

  return id;
}

/**
 * An EVM address in lower case; a TypeError for anything else, and for a
 * mixed-case one whose checksum is wrong.
 *
 * @param {unknown} value
 * @param {string} what
 * @returns {`0x${string}`}
 */
function evmAddress(value, what) {
  const text = typeof value === "string" ? value.trim() : "";

  if (!/^0x[0-9a-fA-F]{40}$/.test(text)) throw new TypeError(`${what} isn't an EVM address`);

  const digits = text.slice(2);

  if (digits !== digits.toLowerCase() && digits !== digits.toUpperCase() && formatEvmAddress(text) !== text) {
    throw new TypeError(`${what}'s checksum is wrong`);
  }

  return /** @type {`0x${string}`} */ (text.toLowerCase());
}

/**
 * The Portal's address of the account whose proofs count: an EVM address,
 * or the one DuskEVM gives a Dusk account; null for none.
 *
 * @param {unknown} value
 * @returns {`0x${string}` | null}
 */
function submitterOf(value) {
  if (value === null || value === undefined || value === "") return null;

  const text = typeof value === "string" ? value.trim() : "";

  if (/^0x[0-9a-fA-F]{40}$/.test(text)) return evmAddress(text, "The submitter");
  if (!accountToRawKey(text)) throw new TypeError("The submitter isn't a Dusk account or an EVM address");

  return /** @type {`0x${string}`} */ (evmAddressOf(text).toLowerCase());
}

/**
 * @param {unknown} value
 * @returns {`0x${string}`}
 */
function requireSubmitter(value) {
  const submitter = submitterOf(value);

  if (!submitter) throw new TypeError("A proof or a claim is for one account: pass its submitter");

  return submitter;
}

/**
 * The Portal's address of the account a withdrawal pays, which proves and
 * claims it by default; null for a contract.
 *
 * @param {WithdrawalFacts} facts
 * @returns {`0x${string}` | null}
 */
const recipientSubmitter = (facts) =>
  facts.recipient.kind === "account" ? /** @type {`0x${string}`} */ (evmAddressOf(facts.recipient.account).toLowerCase()) : null;

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {bigint}
 */
function wholeOf(value, what) {
  if (typeof value === "bigint") return value;

  if ((typeof value === "number" && Number.isSafeInteger(value)) || (typeof value === "string" && /^\s*\d+\s*$/.test(value))) {
    return BigInt(value);
  }

  throw new TypeError(`${what} is a whole number`);
}

/**
 * The network a reference names; a TypeError for one there's no file for.
 *
 * @param {NetworkRef} network
 * @returns {Network}
 */
function networkOf(network) {
  const net = network && typeof network === "object" ? network : networkFor(/** @type {number | bigint | string} */ (network));

  if (!net || typeof net.chainId !== "number") throw new TypeError("Not one of the networks");

  return net;
}

/**
 * A data driver's input, as JSON: big integers as their text.
 *
 * @param {unknown} args
 * @returns {string}
 */
const driverJson = (args) =>
  args === undefined || args === null ? "null" : JSON.stringify(args, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

// ---------------------------------------------------------------------------
// A withdrawal, as DuskEVM recorded it
// ---------------------------------------------------------------------------

/**
 * @param {NetworkRef} network
 * @param {any} receipt
 * @returns {ReceiptWithdrawal}
 */
export function parseWithdrawalReceipt(network, receipt) {
  const net = networkOf(network);

  if (!receipt) throw new WithdrawalError("not-found");
  if (receipt.status === "0x0" || receipt.status === 0 || receipt.status === "reverted") throw new WithdrawalError("failed");

  const passer = String(net.duskEvm?.predeploys?.l2ToL1MessagePasser ?? MESSAGE_PASSER).toLowerCase();

  // The first MessagePassed of DuskEVM's message passer is the withdrawal.
  for (const log of Array.isArray(receipt.logs) ? receipt.logs : []) {
    if (String(log?.address ?? "").toLowerCase() !== passer) continue;
    if (String(log?.topics?.[0] ?? "").toLowerCase() !== MESSAGE_PASSED_TOPIC) continue;

    /** @type {any} */
    let args;

    try {
      args = decodeEventLog({ abi: MESSAGE_PASSED, data: log.data, topics: log.topics }).args;
    } catch (cause) {
      throw new WithdrawalError("not-a-withdrawal", "Its MessagePassed event doesn't decode", { cause });
    }

    /** @type {L2Withdrawal} */
    const withdrawal = {
      data: /** @type {`0x${string}`} */ (String(args.data).toLowerCase()),
      gasLimit: args.gasLimit,
      nonce: args.nonce,
      sender: args.sender,
      target: args.target,
      value: args.value,
    };
    const facts = decodeWithdrawal(net, withdrawal);

    if (!facts) throw new WithdrawalError("not-a-withdrawal");

    // The event names its own hash: one that isn't the withdrawal's isn't its record.
    if (facts.hash !== String(args.withdrawalHash).toLowerCase()) {
      throw new WithdrawalError("not-a-withdrawal", "Its MessagePassed event's hash isn't the withdrawal's");
    }

    const block = log.blockNumber ?? receipt.blockNumber;
    const hash = String(log.transactionHash ?? receipt.transactionHash ?? "").toLowerCase();

    if (block === undefined || block === null) throw new WithdrawalError("not-a-withdrawal", "Its receipt has no DuskEVM block");

    return {
      blockNumber: BigInt(block),
      facts,
      transactionHash: /** @type {`0x${string}`} */ (hash),
      withdrawal,
      withdrawalHash: facts.hash,
    };
  }

  throw new WithdrawalError("not-a-withdrawal", "It records no MessagePassed event");
}

/**
 * The withdrawal as the Portal's data driver takes it: its fields as bytes,
 * the numbers as 32 big-endian bytes.
 *
 * @param {L2Withdrawal} withdrawal
 */
const withdrawalInput = (withdrawal) => ({
  data: bytesOf(withdrawal.data),
  ["gas_limit"]: u256Bytes(withdrawal.gasLimit),
  nonce: u256Bytes(withdrawal.nonce),
  sender: addressBytes(withdrawal.sender),
  target: addressBytes(withdrawal.target),
  value: u256Bytes(withdrawal.value),
});

/**
 * A proof's arguments: the withdrawal, the game's index, the output root
 * proof and the proof's nodes.
 *
 * @param {L2Withdrawal} withdrawal
 * @param {OutputProof} proof
 */
const proveInput = (withdrawal, proof) => [
  withdrawalInput(withdrawal),
  u256Bytes(proof.disputeGameIndex),
  {
    ["latest_blockhash"]: fixedBytes(proof.outputRootProof.latestBlockhash, 32),
    ["message_passer_storage_root"]: fixedBytes(proof.outputRootProof.messagePasserStorageRoot, 32),
    ["state_root"]: fixedBytes(proof.outputRootProof.stateRoot, 32),
    version: fixedBytes(proof.outputRootProof.version, 32),
  },
  proof.withdrawalProof.map((node) => bytesOf(node)),
];

// ---------------------------------------------------------------------------
// Proofs
// ---------------------------------------------------------------------------

/**
 * Where the message passer keeps a withdrawal: its `sentMessages` slot.
 *
 * @param {`0x${string}`} withdrawalHash
 * @returns {`0x${string}`}
 */
const storageKey = (withdrawalHash) =>
  keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [withdrawalHash, 0n]));

/**
 * An output's root: the hash of its version, state root, message passer
 * storage root and block hash.
 *
 * @param {OutputProof["outputRootProof"]} proof
 * @returns {`0x${string}`}
 */
const outputRootOf = (proof) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }],
      [proof.version, proof.stateRoot, proof.messagePasserStorageRoot, proof.latestBlockhash]
    )
  );

/**
 * @param {any} item
 * @returns {{ node: any[], rlp: `0x${string}` } | null}
 */
function embeddedNode(item) {
  if (Array.isArray(item)) return { node: item, rlp: toRlp(item) };
  if (typeof item !== "string" || !item.startsWith("0x") || item === "0x") return null;

  try {
    const decoded = fromRlp(/** @type {`0x${string}`} */ (item));

    return Array.isArray(decoded) ? { node: decoded, rlp: /** @type {`0x${string}`} */ (item) } : null;
  } catch {
    return null;
  }
}

/**
 * A storage proof that ends in a branch node gets the terminal node the
 * branch embeds for the key appended, as OP Stack clients do: the Portal's
 * verifier walks the same trie.
 *
 * @param {`0x${string}`} path The hashed key
 * @param {ReadonlyArray<`0x${string}`>} proof
 * @returns {`0x${string}`[]}
 */
function withEmbeddedNode(path, proof) {
  const last = fromRlp(proof[proof.length - 1]);

  if (!Array.isArray(last) || last.length !== 17) return [...proof];

  const nodes = [...proof];

  for (const item of last) {
    const embedded = embeddedNode(item);
    const suffix = embedded && typeof embedded.node[0] === "string" ? embedded.node[0].slice(3) : null;

    if (embedded && suffix !== null && path.endsWith(suffix)) nodes.push(embedded.rlp);
  }

  return nodes;
}

/**
 * @param {unknown} extraData
 * @returns {bigint}
 */
function l2SequenceOf(extraData) {
  const bytes = bytesOf(extraData);

  return bytes.length < 32 ? 0n : bigOf(bytes.slice(0, 32));
}

/**
 * The DuskEVM block a game's metadata says its output is of.
 *
 * @param {any} metadata
 * @returns {bigint}
 */
function gameL2Block(metadata) {
  const explicit = tupleValue(metadata, "l2SequenceNumber", 2);

  return bigOf(explicit) === 0n ? l2SequenceOf(tupleValue(metadata, "extraData", 3)) : bigOf(explicit);
}

/**
 * A game as a search of the factory lists it: its index, creation time,
 * address, root claim and DuskEVM block.
 *
 * @param {any} result
 */
function searchedGame(result) {
  const metadata = fixedBytes(tupleValue(result, "metadata", 1), 32);

  return {
    createdAt: BigInt(tupleValue(result, "timestamp", 2)),
    index: bigOf(tupleValue(result, "index", 0)),
    l2BlockNumber: l2SequenceOf(tupleValue(result, "extra_data", 4)),
    // A game ID packs its type, its creation time, then its address.
    proxy: hexOf(metadata.slice(12)),
    rootClaim: hexOf(fixedBytes(tupleValue(result, "root_claim", 3), 32)),
  };
}

/**
 * An archived Vec at `at`: a relative pointer and a length, its items
 * before `end`, where the driver put them.
 *
 * @param {Uint8Array} bytes
 * @param {number} at
 * @param {number} end
 * @param {number} itemSize
 */
function archivedVec(bytes, at, end, itemSize) {
  if (at < 0 || at + 8 > bytes.length) throw new WithdrawalError("bad-call");

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const start = at + view.getInt32(at, true);
  const length = view.getUint32(at + 4, true);

  if (start < 0 || start + length * itemSize > end) throw new WithdrawalError("bad-call");

  return { length, start };
}

/**
 * @param {DuskRecipient} a
 * @param {DuskRecipient} b
 */
const sameRecipient = (a, b) =>
  a.kind === b.kind && (a.kind === "account" ? a.account === /** @type {any} */ (b).account : a.contractId === /** @type {any} */ (b).contractId);

/**
 * What a Portal call's arguments say, as Dusk Wallet reads them: the
 * withdrawal they were built from, by its hash, on the bridge's route, and
 * for a proof the game, the output root proof and the proof's nodes too.
 * Anything else is no call to sign.
 *
 * @param {Network} net
 * @param {string} portal
 * @param {string} fnName
 * @param {Uint8Array} fnArgs
 * @param {{ facts: WithdrawalFacts, proof: OutputProof | null }} built
 */
function checkedCall(net, portal, fnName, fnArgs, { facts, proof }) {
  const call = decodeBridgeCall(net, { args: fnArgs, contractId: portal, fnName });

  if (
    !call ||
    call.kind !== (proof ? "prove" : "claim") ||
    call.hash !== facts.hash ||
    call.nonce !== facts.nonce ||
    call.amountWei !== facts.amountWei ||
    call.gasLimit !== facts.gasLimit ||
    call.from !== facts.from ||
    call.target !== facts.target ||
    !sameRecipient(call.recipient, facts.recipient) ||
    "proofSubmitter" in call
  ) {
    throw new WithdrawalError("bad-call");
  }

  if (proof) {
    if (call.kind !== "prove" || call.disputeGameIndex !== proof.disputeGameIndex || call.proofNodes !== proof.withdrawalProof.length) {
      throw new WithdrawalError("bad-call");
    }

    const root = fnArgs.length - PROVE_ROOT;
    const { latestBlockhash, messagePasserStorageRoot, stateRoot, version } = proof.outputRootProof;

    [version, stateRoot, messagePasserStorageRoot, latestBlockhash].forEach((word, i) => {
      if (hexOf(fnArgs.subarray(root + 32 * i, root + 32 * (i + 1))) !== word.toLowerCase()) throw new WithdrawalError("bad-call");
    });

    const nodes = archivedVec(fnArgs, root + PROOF_NODES_AT, root, 8);

    proof.withdrawalProof.forEach((node, i) => {
      const { length, start } = archivedVec(fnArgs, nodes.start + 8 * i, root, 1);

      if (hexOf(fnArgs.subarray(start, start + length)) !== node.toLowerCase()) throw new WithdrawalError("bad-call");
    });
  }

  return call;
}

// ---------------------------------------------------------------------------
// DuskEVM's RPC
// ---------------------------------------------------------------------------

/**
 * @param {DuskEvmClient | null | undefined} client
 * @param {Network | null} net
 * @returns {(method: string, params?: unknown[]) => Promise<any>}
 */
function evmRpc(client, net) {
  if (client && "request" in client && typeof client.request === "function") {
    const viem = client;

    return (method, params = []) => viem.request({ method, params });
  }

  const url = (client && "url" in client ? client.url : null) ?? net?.duskEvm?.rpcUrl;

  if (!url) throw new TypeError("No DuskEVM RPC to read");

  const send = (client && "fetch" in client ? client.fetch : null) ?? ((input, init) => globalThis.fetch(input, init));

  return async (method, params = []) => {
    const response = await send(url, {
      body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);

    const body = await response.json();

    if (body?.error) throw Object.assign(new Error(body.error.message ?? `${method} failed`), { code: body.error.code });

    return body?.result;
  };
}

/**
 * A block number as DuskEVM's RPC gives it, a hex quantity, or as a whole
 * number; null for anything else.
 *
 * @param {unknown} value
 * @returns {bigint | null}
 */
function blockNumberOf(value) {
  if (typeof value === "bigint") return value >= 0n ? value : null;
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;

  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value) ? BigInt(value) : null;
}

// ---------------------------------------------------------------------------
// The bridge's contracts on Dusk
// ---------------------------------------------------------------------------

/**
 * A u64 as a contract returns it: 8 bytes, little-endian.
 *
 * @param {Uint8Array} bytes
 * @returns {bigint}
 */
function u64Le(bytes) {
  if (bytes.length < 8) throw new RangeError("Expected an 8-byte u64");

  let value = 0n;

  for (let i = 7; i >= 0; i--) value = (value << 8n) | BigInt(bytes[i]);

  return value;
}

/**
 * A dispute game hub's views, read raw: a game's 20-byte address in
 * (nothing for `maxClockDuration`), a u64, little-endian, or the game's
 * status byte out.
 *
 * @type {DataDriver}
 */
const HUB_CODEC = Object.freeze({
  /**
   * @param {string} fnName
   * @param {Uint8Array} bytes
   */
  decodeOutputFn(fnName, bytes) {
    if (fnName !== "statusForGame") return u64Le(bytes);
    if (!bytes.length) throw new RangeError("Expected the game's status byte");

    return bytes[0];
  },
  /**
   * @param {string} fnName
   * @param {string} json
   */
  encodeInputFn: (fnName, json) => (fnName === "maxClockDuration" ? new Uint8Array(0) : Uint8Array.from(JSON.parse(json))),
});

/**
 * The anchor state registry's views, read raw: a game's 20-byte address
 * in, yes or no out; `respectedGameTypeUpdatedAt` takes nothing and gives
 * a u64.
 *
 * @type {DataDriver}
 */
const REGISTRY_CODEC = Object.freeze({
  /**
   * @param {string} fnName
   * @param {Uint8Array} bytes
   */
  decodeOutputFn(fnName, bytes) {
    if (fnName === "respectedGameTypeUpdatedAt") return u64Le(bytes);
    if (bytes.length !== 1 || bytes[0] > 1) throw new RangeError(`Expected ${fnName}'s yes or no`);

    return bytes[0] === 1;
  },
  /**
   * @param {string} fnName
   * @param {string} json
   */
  encodeInputFn: (fnName, json) => (fnName === "respectedGameTypeUpdatedAt" ? new Uint8Array(0) : Uint8Array.from(JSON.parse(json))),
});

/**
 * A driver, loaded once; one that failed to load is loaded again next time.
 *
 * @param {DriverSource | undefined} source
 * @param {string} what
 * @returns {() => Promise<DataDriver>}
 */
function driverOf(source, what) {
  if (!source) throw new TypeError(`The ${what} data driver is needed`);

  /** @type {Promise<DataDriver> | null} */
  let pending = null;

  return () => {
    if (!pending) {
      const loading = Promise.resolve(typeof source === "function" ? source() : source).then((driver) => {
        if (typeof driver?.encodeInputFn !== "function" || typeof driver?.decodeOutputFn !== "function") {
          throw new TypeError(`The ${what} data driver encodes and decodes nothing`);
        }

        return driver;
      });

      pending = loading;
      loading.catch(() => {
        if (pending === loading) pending = null;
      });
    }

    return pending;
  };
}

/**
 * A read kept once it succeeded, in the app's cache as text; one that
 * failed is read again next time.
 *
 * @param {FactCache} cache
 * @param {Map<string, Promise<string>>} inflight
 * @param {string} key
 * @param {() => Promise<string>} load
 * @returns {Promise<string>}
 */
function known(cache, inflight, key, load) {
  const kept = cache.get(key);

  if (typeof kept === "string" && kept) return Promise.resolve(kept);

  let pending = inflight.get(key);

  if (!pending) {
    const reading = load().then((value) => {
      cache.set(key, value);

      return value;
    });

    pending = reading;
    inflight.set(key, reading);
    reading.then(
      () => inflight.delete(key),
      () => inflight.delete(key)
    );
  }

  return pending;
}

/**
 * @param {Pick<WithdrawalsOptions, "drivers" | "fetch" | "maxBatch" | "nodeUrl"> & { cache: FactCache, contracts: { portal: string, disputeGameFactory: string, anchorStateRegistry: string | null } }} options
 */
function createReads({ cache, contracts, drivers, fetch, nodeUrl }) {
  const base = String(nodeUrl ?? "").trim().replace(/\/+$/, "");

  if (!/^https?:\/\//i.test(base)) throw new TypeError("The node's URL is an http(s) URL");

  const send = fetch ?? ((input, init) => globalThis.fetch(input, init));
  const portalDriver = driverOf(drivers?.optimismPortal, "Portal's");
  const factoryDriver = driverOf(drivers?.disputeGameFactory, "dispute game factory's");
  // Both drivers load before any read goes out, so the reads one task starts go together.
  const loaded = () => Promise.all([portalDriver(), factoryDriver()]);

  /**
   * @param {(drivers: DataDriver[]) => DataDriver} pick
   * @param {string} id
   * @param {string} fnName
   * @param {unknown} [args]
   * @returns {Promise<any>}
   */
  async function read(pick, id, fnName, args) {
    const driver = pick(await loaded());
    const body = driver.encodeInputFn(fnName, driverJson(args));

    for (let attempt = 1; ; attempt += 1) {
      const response = await send(`${base}/on/contracts:${id}/${fnName}`, {
        body: /** @type {BodyInit} */ (/** @type {unknown} */ (body)),
        headers: { "Content-Type": "application/octet-stream" },
        method: "POST",
      });

      if (response.ok) return driver.decodeOutputFn(fnName, new Uint8Array(await response.arrayBuffer()));

      if (attempt >= ATTEMPTS || !RETRY_STATUSES.has(response.status)) {
        // A refusal carries the contract's own words, as a check's does.
        const refusal = await response.text().catch(() => "");

        throw new Error(refusal || `The ${fnName} read failed with HTTP ${response.status}`);
      }

      await sleep(RETRY_MS * 2 ** (attempt - 1));
    }
  }

  /** @param {string} fnName @param {unknown} [args] */
  const portal = (fnName, args) => read(([driver]) => driver, contracts.portal, fnName, args);
  /** @param {string} fnName @param {unknown} [args] */
  const factory = (fnName, args) => read(([, driver]) => driver, contracts.disputeGameFactory, fnName, args);
  /**
   * A game hub's reads.
   *
   * @param {string} hubId
   * @returns {(fnName: string, args?: unknown) => Promise<any>}
   */
  const hub = (hubId) => (fnName, args) => read(() => HUB_CODEC, hubId, fnName, args);
  const registryId = contracts.anchorStateRegistry;
  /** @type {((fnName: string, args?: unknown) => Promise<any>) | null} */
  const registry = registryId ? (fnName, args) => read(() => REGISTRY_CODEC, registryId, fnName, args) : null;

  /** @type {Map<string, Promise<string>>} */
  const inflight = new Map();
  /** @param {string} proxy */
  const gameKey = (proxy) => `hub:${contracts.disputeGameFactory}:${proxy.toLowerCase()}`;

  /**
   * The hub a game is on, as the Portal reads it: the factory names it, as
   * it was the game type's when the game was made. A type's hub can change
   * since; its games stay where they were. None, and nothing kept, for a
   * game the factory didn't make.
   *
   * @param {string} proxy
   * @returns {Promise<string>}
   */
  const hubOfGame = (proxy) =>
    known(cache, inflight, gameKey(proxy), () =>
      factory("gameContractId", addressBytes(proxy)).then((value) => {
        const hubId = contractIdHex(value);

        if (/^0+$/.test(hubId)) throw new Error("The factory names no hub for the game");

        return hubId;
      })
    );

  /**
   * A game's hub, if it was read before: a check can then read the game in
   * the same query as the Portal.
   *
   * @param {string} proxy
   * @returns {string | null}
   */
  const knownHubOf = (proxy) => {
    const kept = cache.get(gameKey(proxy));

    return typeof kept === "string" && kept ? kept : null;
  };

  /**
   * The hub that holds a game type's games.
   *
   * @param {number} gameType
   * @returns {Promise<string>}
   */
  const hubOfType = (gameType) =>
    known(cache, inflight, `type:${contracts.disputeGameFactory}:${gameType}`, () =>
      factory("virtualGameHubId", gameType).then(contractIdHex)
    );

  /**
   * A hub's clock limit, `maxClockDuration`, in seconds.
   *
   * @param {string} hubId
   * @returns {Promise<bigint>}
   */
  const hubClock = (hubId) =>
    known(cache, inflight, `clock:${hubId}`, () => hub(hubId)("maxClockDuration").then((seconds) => BigInt(seconds).toString())).then(
      BigInt
    );

  /**
   * A game's reads on its hub, started together so they go in one query.
   *
   * @param {string} hubId
   * @param {string} proxy
   */
  const gameReads = (hubId, proxy) => {
    const address = addressBytes(proxy);
    const reads = hub(hubId);

    return [reads("createdAtForGame", address), reads("resolvedAtForGame", address), reads("statusForGame", address), hubClock(hubId)];
  };

  /**
   * @param {[unknown, unknown, unknown, unknown]} values
   * @returns {{ createdAt: bigint, maxClockDuration: bigint, resolvedAt: bigint, status: number }}
   */
  const asGame = ([createdAt, resolvedAt, status, maxClockDuration]) => ({
    createdAt: BigInt(/** @type {bigint} */ (createdAt)),
    maxClockDuration: BigInt(/** @type {bigint} */ (maxClockDuration)),
    resolvedAt: BigInt(/** @type {bigint} */ (resolvedAt)),
    status: Number(status),
  });

  /**
   * A game as its hub gives it, with the hub's clock limit.
   *
   * @param {string} hubId
   * @param {string} proxy
   */
  const readGame = (hubId, proxy) => Promise.all(gameReads(hubId, proxy)).then((values) => asGame(/** @type {any} */ (values)));

  return {
    asGame,
    base,
    factory,
    gameReads,
    hub,
    hubClock,
    hubOfGame,
    hubOfType,
    knownHubOf,
    loaded,
    portal,
    readGame,
    registry,
    send,
  };
}

// ---------------------------------------------------------------------------
// Withdrawals on Dusk
// ---------------------------------------------------------------------------

/**
 * A positive whole number of games, or the default.
 *
 * @param {unknown} value
 * @returns {bigint}
 */
function searchDepthOf(value) {
  const n = Number(value ?? GAME_SEARCH_DEPTH);

  return Number.isSafeInteger(n) && n > 0 ? BigInt(n) : BigInt(GAME_SEARCH_DEPTH);
}

/**
 * The proof's or the claim's gas limit, refused over the bound: less gas
 * could leave the withdrawal's own call short.
 *
 * @param {bigint} withdrawalGas
 * @param {bigint | number | undefined} upper
 * @returns {bigint}
 */
function gasFor(withdrawalGas, upper) {
  const limit = withdrawalGasLimit(withdrawalGas);

  if (limit > wholeOf(upper ?? GAS_LIMIT_UPPER, "The gas bound")) throw new WithdrawalError("gas");

  return limit;
}

/**
 * What the chain says of a game a proof went, or would go, against: its
 * status on its hub, whether the Portal blacklisted it, and whether the
 * anchor state registry calls it proper (registered, not blacklisted, not
 * retired) and respected, true for those two where the network names no
 * registry. Null where a read failed.
 *
 * @typedef {{ status: number | null, blacklisted: boolean | null, proper: boolean | null, respected: boolean | null }} Standing
 */

/**
 * Known to be refused: the Portal takes no proof against such a game, and
 * no claim with one. Whatever its own check says, which may take just the
 * proof and the game's registration.
 *
 * @param {Standing} game
 */
const isRefused = ({ blacklisted, proper, respected, status }) =>
  blacklisted === true || proper === false || respected === false || status === GAME_STATUS.CHALLENGER_WINS;

/**
 * Known to be taken: every read answered, and none of them refuses it.
 *
 * @param {Standing} game
 */
const isTaken = (game) => !isRefused(game) && game.blacklisted === false && game.proper === true && game.respected === true && game.status !== null;

/**
 * @param {WithdrawalsOptions} options
 */
export function createWithdrawals(options) {
  const net = networkOf(options?.network);
  const found = duskEvmContracts(net);

  if (!found?.disputeGameFactory) throw new TypeError("The network has no DuskEVM Portal and dispute game factory");

  const contracts = { anchorStateRegistry: found.anchorStateRegistry, disputeGameFactory: found.disputeGameFactory, portal: found.portal };

  const cache = options.cache ?? new Map();
  const now = options.now ?? Date.now;
  const searchDepth = searchDepthOf(options.gameSearchDepth);
  // Four reads a game checked: its status, the Portal's blacklist, the registry's two answers.
  const perQuery = Math.max(1, Math.floor(Number(options.maxBatch ?? MAX_BATCH) / 4) || 1);
  const rpc = evmRpc(options.duskEvm, net);
  const passer = net.duskEvm?.predeploys?.l2ToL1MessagePasser ?? MESSAGE_PASSER;
  const reads = createReads({
    cache,
    contracts,
    drivers: options.drivers,
    fetch: options.fetch,
    nodeUrl: options.nodeUrl,
  });
  const { factory, hub, portal, registry } = reads;

  /**
   * Dusk's latest block, from the node's GraphQL.
   *
   * @returns {Promise<DuskTip>}
   */
  async function nodeTip() {
    const response = await reads.send(`${reads.base}/on/graphql/query`, {
      body: "query { block(height: -1) { header { height timestamp } } }",
      headers: { "Content-Type": "text/plain" },
      method: "POST",
    });

    if (!response.ok) throw new Error(`The latest block's read failed with HTTP ${response.status}`);

    const body = await response.json();
    const header = (body && typeof body === "object" && "data" in body ? body.data : body)?.block?.header;

    if (header?.height === undefined || header?.height === null || header?.timestamp === undefined || header?.timestamp === null) {
      throw new Error("The latest block is unavailable");
    }

    return { height: BigInt(header.height), timestamp: BigInt(header.timestamp) };
  }

  const latestBlock = options.latestBlock ?? nodeTip;

  /**
   * Whether the registry calls a game proper and respected, where the
   * network names one; yes for both where it doesn't.
   *
   * @param {string} proxy
   * @returns {[Promise<boolean> | boolean, Promise<boolean> | boolean]}
   */
  const registryReads = (proxy) =>
    registry
      ? [registry("isGameProper", addressBytes(proxy)).then(Boolean), registry("isGameRespected", addressBytes(proxy)).then(Boolean)]
      : [true, true];

  /**
   * A game's standing: its status on its own hub, which the factory names
   * (a type's hub answers for a game it doesn't hold as in progress), with
   * the Portal's blacklist and the registry's two answers. Those don't wait
   * for the hub: they go in one query with it, or with the status once the
   * hub was read.
   *
   * @param {string} proxy
   * @returns {Promise<Standing>}
   */
  const standingOf = (proxy) =>
    Promise.all([
      reads.hubOfGame(proxy).then((hubId) => hub(hubId)("statusForGame", addressBytes(proxy))).then(Number, () => null),
      portal("disputeGameBlacklist", addressBytes(proxy)).then(Boolean, () => null),
      ...registryReads(proxy).map((read) => Promise.resolve(read).catch(() => null)),
    ]).then(([status, blacklisted, proper, respected]) => ({ blacklisted, proper, respected, status }));

  /**
   * Where a final receipt is kept: by the network, its Portal and the
   * transaction's hash, so another network's or deployment's stays apart.
   *
   * @param {string} hash - 0x and 64 lower-case hex digits
   */
  const receiptKey = (hash) => `receipt:${net.chainId}:${contracts.portal}:${hash}`;

  /** @type {Promise<bigint | null> | null} */
  let finalizing = null;

  /**
   * DuskEVM's finalized block's height, or null where it can't be read;
   * the receipts read at the same time share one read.
   *
   * @returns {Promise<bigint | null>}
   */
  function finalizedHeight() {
    if (!finalizing) {
      const reading = Promise.resolve()
        .then(() => rpc("eth_getBlockByNumber", ["finalized", false]))
        .then(
          (block) => blockNumberOf(block?.number),
          () => null
        );

      finalizing = reading;
      reading.then(() => {
        if (finalizing === reading) finalizing = null;
      });
    }

    return finalizing;
  }

  /** @type {Map<string, Promise<any>>} */
  const receiptReads = new Map();

  /**
   * The withdrawal a kept receipt records, as when it was kept; null when
   * none is kept, or what is kept isn't this transaction's withdrawal.
   *
   * @param {string} hash
   * @returns {ReceiptWithdrawal | null}
   */
  function keptReceipt(hash) {
    try {
      const text = cache.get(receiptKey(hash));

      if (typeof text !== "string" || !text) return null;

      const withdrawal = parseWithdrawalReceipt(net, JSON.parse(text));

      return withdrawal.transactionHash === hash ? withdrawal : null;
    } catch {
      return null;
    }
  }

  /**
   * Keeps a receipt that can't change any more: a withdrawal's, of this
   * transaction, in a block at or under `final`, the finalized height read
   * before the receipt was. A failed or missing receipt, or one that isn't
   * a withdrawal's, isn't kept. Kept as the RPC gave it, once its text
   * reads back as the same withdrawal.
   *
   * @param {string} hash
   * @param {any} raw
   * @param {bigint} final
   */
  function keepIfFinal(hash, raw, final) {
    try {
      const withdrawal = parseWithdrawalReceipt(net, raw);
      const block = blockNumberOf(raw?.blockNumber);

      if (block === null || block !== withdrawal.blockNumber || block > final || withdrawal.transactionHash !== hash) return;

      const text = JSON.stringify(raw);
      const again = parseWithdrawalReceipt(net, JSON.parse(text));

      if (again.withdrawalHash !== withdrawal.withdrawalHash || again.blockNumber !== block || again.transactionHash !== hash) return;

      cache.set(receiptKey(hash), text);
    } catch {
      // Not kept: it's read again next time.
    }
  }

  /**
   * A transaction's receipt as DuskEVM gives it, read after DuskEVM's
   * finalized block: a receipt read once its block is final is the final
   * chain's, and is kept. The callers asking for one receipt at the same
   * time share one read.
   *
   * @param {string} hash
   * @returns {Promise<any>}
   */
  function readReceipt(hash) {
    let reading = receiptReads.get(hash);

    if (!reading) {
      reading = (async () => {
        const final = await finalizedHeight();
        const raw = await rpc("eth_getTransactionReceipt", [hash]);

        if (final !== null) keepIfFinal(hash, raw, final);

        return raw;
      })();
      receiptReads.set(hash, reading);
      reading.then(
        () => receiptReads.delete(hash),
        () => receiptReads.delete(hash)
      );
    }

    return reading;
  }

  /**
   * A transaction's withdrawal, from its receipt: the one kept once its
   * block was final, else the one DuskEVM gives now.
   *
   * @param {string} txHash
   * @returns {Promise<ReceiptWithdrawal>}
   */
  async function receipt(txHash) {
    if (typeof txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new WithdrawalError("bad-hash");

    const hash = txHash.toLowerCase();

    return keptReceipt(hash) ?? parseWithdrawalReceipt(net, await readReceipt(hash));
  }

  /**
   * The withdrawal's proof against the output of DuskEVM block `l2Block`:
   * the block, and the message passer's storage proof of it there.
   *
   * @param {`0x${string}`} withdrawalHash
   * @param {bigint} l2Block
   */
  async function outputProof(withdrawalHash, l2Block) {
    const key = storageKey(withdrawalHash);
    const [block, proof] = await Promise.all([
      rpc("eth_getBlockByNumber", [toHex(l2Block), false]),
      rpc("eth_getProof", [passer, [key], toHex(l2Block)]),
    ]);

    if (!block) throw new Error(`DuskEVM block ${l2Block} isn't available`);

    const nodes = proof?.storageProof?.[0]?.proof;

    if (!proof?.storageHash || !Array.isArray(nodes) || !nodes.length) throw new Error("The withdrawal's storage proof isn't available");

    const outputRootProof = {
      latestBlockhash: block.hash,
      messagePasserStorageRoot: proof.storageHash,
      stateRoot: block.stateRoot,
      version: ZERO_HASH,
    };

    return { outputRoot: outputRootOf(outputRootProof), outputRootProof, withdrawalProof: withEmbeddedNode(keccak256(key), nodes) };
  }

  /**
   * The first of a page of games that covers the withdrawal, whose root
   * claim is its output's, and that the Portal takes a proof against, with
   * its proof, and whether any covered it. The page's metadata goes in one
   * query.
   *
   * @param {any[]} games
   * @param {ReceiptWithdrawal} withdrawal
   * @returns {Promise<{ proof: OutputProof | null, lastError: Error | null, covered: boolean }>}
   */
  async function proofInGames(games, withdrawal) {
    /** @type {Error | null} */
    let lastError = null;
    let covered = false;
    const indexes = games.map((game) => bigOf(tupleValue(game, "index", 0)));
    const metadata = await Promise.all(indexes.map((index) => settle(factory("gameMetadataAtIndex", u256Bytes(index)))));

    for (const [position, index] of indexes.entries()) {
      try {
        const { error, value } = metadata[position];

        if (error) throw error;

        const rootClaim = hexOf(fixedBytes(tupleValue(value, "rootClaim", 0), 32));
        const l2BlockNumber = gameL2Block(value);

        if (l2BlockNumber < withdrawal.blockNumber) continue;

        covered = true;

        const proof = await outputProof(withdrawal.withdrawalHash, l2BlockNumber);

        if (proof.outputRoot.toLowerCase() !== rootClaim) continue;

        const disputeGameProxy = addressHex(tupleValue(await factory("gameAtIndex", u256Bytes(index)), "gameProxy", 2));
        const standing = await standingOf(disputeGameProxy);

        // Not one blacklisted, retired, no longer respected, or won by the
        // challenger: the Portal takes no proof against it. Nor one whose
        // standing can't be read. An older game that covers the withdrawal
        // may do.
        if (!isTaken(standing)) {
          if (!isRefused(standing)) lastError = new Error(`Whether the Portal takes a proof against game ${index} can't be read`);

          continue;
        }

        return { covered, lastError, proof: { ...proof, disputeGameIndex: index, disputeGameProxy, l2BlockNumber } };
      } catch (error) {
        lastError = asError(error);
      }
    }

    return { covered, lastError, proof: null };
  }

  /**
   * The newest game of the Portal's type that covers the withdrawal and
   * that the Portal takes a proof against, among the newest `searchDepth`,
   * a page at a time.
   *
   * @param {{ gameType: number, start: bigint, withdrawal: ReceiptWithdrawal }} search
   */
  async function scanGames({ gameType, start, withdrawal }) {
    let from = start;
    let remaining = searchDepth;
    /** @type {Error | null} */
    let lastError = null;
    let covered = false;

    while (remaining > 0n) {
      const games = await factory("findLatestGames", [gameType, u256Bytes(from), u256Bytes(remaining > SCAN_PAGE ? SCAN_PAGE : remaining)]);

      if (!Array.isArray(games) || !games.length) break;

      const found = await proofInGames(games, withdrawal);

      if (found.proof) return found;

      lastError = found.lastError ?? lastError;
      covered ||= found.covered;

      const oldest = bigOf(tupleValue(games[games.length - 1], "index", 0));

      if (oldest === 0n) break;

      from = oldest - 1n;
      remaining -= BigInt(games.length);
    }

    return { covered, lastError, proof: null };
  }

  /**
   * The first of `games` that covers the withdrawal, has resolved for its
   * proposal, and that the Portal would take a proof against, with the
   * withdrawal's proof against it. Each game's standing (`standingOf`) goes
   * to the node a batch at a time, newest first, until one passes. `stop`
   * when DuskEVM no longer gives a block's proof: an older game's won't
   * come either.
   *
   * @param {ReturnType<typeof searchedGame>[]} games
   * @param {{ rules: GameRules, withdrawal: ReceiptWithdrawal }} search
   * @returns {Promise<{ proof?: OutputProof, stop?: boolean }>}
   */
  async function resolvedIn(games, { rules, withdrawal }) {
    for (let from = 0; from < games.length; from += perQuery) {
      const batch = games.slice(from, from + perQuery);
      const checked = await Promise.all(batch.map((game) => standingOf(game.proxy).then((standing) => ({ ...game, ...standing }))));

      for (const game of checked.filter((each) => isEligibleGame(each, rules) && isTaken(each))) {
        try {
          const proof = await outputProof(withdrawal.withdrawalHash, game.l2BlockNumber);

          if (proof.outputRoot.toLowerCase() === game.rootClaim) {
            return { proof: { ...proof, disputeGameIndex: game.index, disputeGameProxy: game.proxy, l2BlockNumber: game.l2BlockNumber } };
          }
        } catch {
          return { stop: true };
        }
      }
    }

    return {};
  }

  /**
   * A game covering the withdrawal that has already resolved for its
   * proposal, and that the Portal would take a proof against: a proof
   * against it can be claimed exactly its maturity delay later. Games come
   * at a steady pace, so the search starts about where games are old enough
   * to have resolved, and goes back a few pages; other game types share the
   * factory's index. Null when none covers the withdrawal yet, none of them
   * has resolved and passes, or the anchor state registry isn't known.
   *
   * @param {{ gameCount: bigint, gameType: number, tip: DuskTip, withdrawal: ReceiptWithdrawal }} search
   * @returns {Promise<OutputProof | null>}
   */
  async function resolvedProof({ gameCount, gameType, tip, withdrawal }) {
    if (!registry) return null;

    /** @param {bigint} from */
    const page = async (from) =>
      /** @type {any[]} */ (await factory("findLatestGames", [gameType, u256Bytes(from), u256Bytes(BigInt(RESOLVED_PAGE))])).map(searchedGame);
    // In one query: the type's hub, whose clock says which games are old
    // enough to have resolved, the newest games, and when the respected game
    // type last changed. Games created then or before are retired.
    const [hubId, newest, updatedAt] = await Promise.all([
      reads.hubOfType(gameType),
      page(gameCount - 1n),
      registry("respectedGameTypeUpdatedAt").then(BigInt),
    ]);

    if (newest.length < 2) return null;

    // Its clock ran out, and its resolver's usual lag has passed.
    const cutoff = contractNow(contractClock(newest[0].createdAt, tip), tip) - (await reads.hubClock(hubId)) - BigInt(RESOLVER_LAG_SECONDS);
    const first = newest[0];
    const last = newest[newest.length - 1];
    const pace = (first.createdAt - last.createdAt) / (first.index - last.index || 1n) || 1n;
    const back = first.createdAt > cutoff ? (first.createdAt - cutoff + pace - 1n) / pace : 0n;
    let from = first.index > back ? first.index - back : 0n;
    const rules = { respectedGameTypeUpdatedAt: updatedAt, withdrawalBlockNumber: withdrawal.blockNumber };

    for (let pages = 0; pages < RESOLVED_PAGES; pages += 1) {
      const games = await page(from);
      const old = games.filter((game) => game.createdAt <= cutoff);

      // The newest of them doesn't cover the withdrawal: none does.
      if (old.length && old[0].l2BlockNumber < withdrawal.blockNumber) return null;

      const found = await resolvedIn(
        old.filter((game) => isCandidateGame(game, rules)),
        { rules, withdrawal }
      );

      if (found.proof || found.stop) return found.proof ?? null;
      if (!games.length || games[games.length - 1].index === 0n) break;

      from = games[games.length - 1].index - 1n;
    }

    return null;
  }

  /**
   * The game to prove the withdrawal against, with its proof: the newest
   * game covering it, or with `tip`, one that has already resolved where
   * there is one.
   *
   * @param {{ snapshot: Snapshot, withdrawal: ReceiptWithdrawal, tip?: DuskTip | null }} search
   * @returns {Promise<{ proof: OutputProof | null, reason: WaitReason | null, error: Error | null, covered: boolean }>}
   */
  async function findProof({ snapshot, tip = null, withdrawal }) {
    const { gameCount, gameType } = snapshot;

    if (gameCount === 0n) return { covered: false, error: null, proof: null, reason: "no-games" };

    if (tip) {
      const resolved = await resolvedProof({ gameCount, gameType, tip, withdrawal }).catch(() => null);

      if (resolved) return { covered: true, error: null, proof: resolved, reason: null };
    }

    const found = await scanGames({ gameType, start: gameCount - 1n, withdrawal });

    return found.proof
      ? { covered: true, error: null, proof: found.proof, reason: null }
      : { covered: found.covered, error: found.lastError, proof: null, reason: "no-output" };
  }

  /**
   * The game a status says a proof would go against now: the newest the
   * Portal takes, among the newest `searchDepth`; where none of those
   * covering the withdrawal is one (`covered`: a proof went against one),
   * one that has resolved, as `prepareProof` finds it. A status then offers
   * a proof wherever one can be prepared.
   *
   * @param {{ snapshot: Snapshot, withdrawal: ReceiptWithdrawal, tip?: Promise<DuskTip> | DuskTip | null, covered?: boolean }} search
   */
  async function provableProof({ covered = false, snapshot, tip = null, withdrawal }) {
    const found = await findProof({ snapshot, withdrawal });

    if (found.proof || snapshot.gameCount === 0n || !(covered || found.covered)) return found;

    const resolved = await Promise.resolve(tip ?? latestBlock())
      .then((at) => resolvedProof({ gameCount: snapshot.gameCount, gameType: snapshot.gameType, tip: at, withdrawal }))
      .catch(() => null);

    return resolved ? { covered: true, error: null, proof: resolved, reason: null } : found;
  }

  /**
   * What a proven withdrawal's stage and date need beyond the Portal's
   * record: its game on its hub, whether the Portal blacklisted it, the
   * Portal's own check, and whether the registry calls it proper and
   * respected. Started together, so they go in one query.
   *
   * @param {string} hubId
   * @param {number[]} id
   * @param {string} proxy
   * @param {string} submitter
   */
  const provenReads = (hubId, id, proxy, submitter) =>
    Promise.all(
      [
        ...reads.gameReads(hubId, proxy),
        portal("disputeGameBlacklist", addressBytes(proxy)),
        portal("checkWithdrawal", [id, addressBytes(submitter)]),
        ...registryReads(proxy),
      ].map(settle)
    );

  /**
   * The Portal's and the factory's values a status needs, in one query: the
   * record of `submitter`'s proof, the delays, the game type and count. The
   * game the last check found the proof against (`game`) goes in the same
   * query, once its hub was read.
   *
   * @param {`0x${string}`} withdrawalHash
   * @param {`0x${string}` | null} submitter
   * @param {{ game?: string | null, tip?: Promise<DuskTip> | null }} [extra]
   * @returns {Promise<Snapshot>}
   */
  async function readSnapshot(withdrawalHash, submitter, { game = null, tip = null } = {}) {
    const id = fixedBytes(withdrawalHash, 32);
    const proxy = game ? evmAddress(game, "The proof's game") : null;
    const hubId = proxy && submitter ? reads.knownHubOf(proxy) : null;
    const ahead = proxy && hubId && submitter ? { game: proxy, reads: provenReads(hubId, id, proxy, submitter) } : null;
    const [finalized, count, proven, maturity, finality, gameType, gameCount] = await Promise.all([
      portal("finalizedWithdrawals", id),
      portal("numProofSubmitters", id),
      submitter ? portal("provenWithdrawals", [id, addressBytes(submitter)]) : null,
      portal("proofMaturityDelaySeconds"),
      portal("disputeGameFinalityDelaySeconds"),
      portal("respectedGameType"),
      factory("gameCount"),
    ]);

    return {
      ahead,
      delays: { disputeGameFinalityDelaySeconds: bigOf(finality), proofMaturityDelaySeconds: bigOf(maturity) },
      finalized: Boolean(finalized),
      gameCount: bigOf(gameCount),
      gameType: Number(gameType),
      proofSubmitterCount: bigOf(count),
      proven: proven
        ? { disputeGameProxy: addressHex(tupleValue(proven, "disputeGameProxy", 0)), timestamp: BigInt(tupleValue(proven, "timestamp", 1)) }
        : { disputeGameProxy: ZERO_ADDRESS, timestamp: 0n },
      tip,
    };
  }

  /**
   * Whether another account holds a proof that still stands. A game known
   * to be refused never stands: blacklisted, retired, not respected, or won
   * by the challenger, whatever the Portal's check says. Otherwise the
   * Portal's own check decides first: it passes, or fails only on maturity,
   * for a proof that stands; else a game read and not refused stands, and
   * an unreadable one doesn't count. The Portal only lets the account that
   * proved claim with that proof.
   *
   * @param {`0x${string}`} withdrawalHash
   * @param {`0x${string}` | null} own
   * @param {bigint} count
   */
  async function provenByOther(withdrawalHash, own, count) {
    const n = Number(count > OTHER_PROOFS ? OTHER_PROOFS : count);

    if (n === 0) return false;

    const id = fixedBytes(withdrawalHash, 32);
    const submitters = (
      await Promise.all(Array.from({ length: n }, (_, index) => portal("proofSubmitters", [id, u256Bytes(BigInt(index))])))
    )
      .map(addressHex)
      .filter((address) => address !== own);

    if (!submitters.length) return false;

    const proofs = await Promise.all(submitters.map((address) => portal("provenWithdrawals", [id, addressBytes(address)])));
    const standing = proofs
      .map((proof, index) => ({
        address: submitters[index],
        proxy: addressHex(tupleValue(proof, "disputeGameProxy", 0)),
        timestamp: BigInt(tupleValue(proof, "timestamp", 1)),
      }))
      .filter(({ proxy, timestamp }) => timestamp !== 0n && proxy !== ZERO_ADDRESS);
    // Read together, so a multicall carries each check's own refusal.
    const checks = await Promise.all(
      standing.map(({ address, proxy }) =>
        Promise.all([
          portal("checkWithdrawal", [id, addressBytes(address)]).then(
            () => "ready",
            (error) => asError(error).message
          ),
          standingOf(proxy),
        ])
      )
    );

    for (const [check, game] of checks) {
      if (isRefused(game)) continue;
      if (check === "ready" || /maturity delay not met/i.test(check)) return true;
      if (game.status !== null) return true;
    }

    return false;
  }

  /**
   * A withdrawal no proof of the account's covers yet: ready to prove once
   * a game covers it.
   *
   * @param {WithdrawalStatus} base
   * @param {Snapshot} snapshot
   * @returns {Promise<WithdrawalStatus>}
   */
  async function unproven(base, snapshot) {
    const found = await provableProof({ snapshot, tip: snapshot.tip, withdrawal: base });

    if (!found.proof) {
      return { ...base, ...(found.error ? { error: found.error } : {}), reason: found.reason, stage: STAGE.WAITING_FOR_OUTPUT };
    }

    return {
      ...base,
      disputeGameIndex: found.proof.disputeGameIndex,
      proofL2BlockNumber: found.proof.l2BlockNumber,
      provenByOther: await provenByOther(base.withdrawalHash, base.proofSubmitter, snapshot.proofSubmitterCount),
      stage: STAGE.READY_TO_PROVE,
    };
  }

  /**
   * A proof the Portal won't take: proved again against another game it
   * takes, where there is one, as `prepareProof` would find it.
   *
   * @param {WithdrawalStatus} base
   * @param {Snapshot} snapshot
   * @param {string} proxy The game of the proof refused
   * @param {DuskTip} tip
   */
  async function replacement(base, snapshot, proxy, tip) {
    const found = await provableProof({ covered: true, snapshot, tip, withdrawal: base });

    if (found.proof && found.proof.disputeGameProxy !== proxy) {
      return {
        disputeGameIndex: found.proof.disputeGameIndex,
        proofL2BlockNumber: found.proof.l2BlockNumber,
        proofRejected: false,
        reason: /** @type {WaitReason} */ ("proof-rejected"),
        stage: STAGE.READY_TO_PROVE,
      };
    }

    return { proofRejected: true, reason: /** @type {WaitReason} */ ("proof-rejected"), stage: STAGE.PROVEN_WAITING };
  }

  /**
   * A proven withdrawal's stage and claim date. The proof's game is read on
   * its own hub, as the Portal reads it, with whether the Portal blacklisted
   * it, whether the registry calls it proper and respected, and the Portal's
   * own check; Dusk's latest block gives the contracts' time. A proof time
   * on testnet's height clock is converted, not dropped. A game the Portal
   * refuses makes the proof one to make again, whatever its check says. A
   * game, or its standing, that can't be read leaves the date known so far
   * (no `readyAt`), and nothing to claim; a date past while the Portal still
   * refuses the claim says nothing more. A claim is ready from its date
   * only, its game resolved for the defender: a Portal whose check takes
   * just the proof and its game says yes before it, and refuses the claim
   * itself.
   *
   * @param {WithdrawalStatus} base
   * @param {Snapshot} snapshot
   * @returns {Promise<WithdrawalStatus>}
   */
  async function proven(base, snapshot) {
    const { disputeGameProxy: proxy, timestamp } = snapshot.proven;
    const submitter = /** @type {`0x${string}`} */ (base.proofSubmitter);
    const id = fixedBytes(base.withdrawalHash, 32);
    const read =
      snapshot.ahead?.game === proxy
        ? snapshot.ahead.reads
        : (() => {
            // The Portal's and the registry's don't wait for the game's hub.
            const portalReads = Promise.all(
              [portal("disputeGameBlacklist", addressBytes(proxy)), portal("checkWithdrawal", [id, addressBytes(submitter)]), ...registryReads(proxy)].map(
                settle
              )
            );
            /** @type {Promise<Array<{ value?: any, error?: Error }>>} */
            const gameRead = reads.hubOfGame(proxy).then(
              (hubId) => Promise.all(reads.gameReads(hubId, proxy).map(settle)),
              (error) => Array.from({ length: 4 }, () => ({ error: asError(error) }))
            );

            return Promise.all([gameRead, portalReads]).then(([game, portalRead]) => [...game, ...portalRead]);
          })();
    const [tip, values] = await Promise.all([snapshot.tip ?? latestBlock(), read]);
    const clock = contractClock(timestamp, tip);
    const provenAt = BigInt(wallTime(timestamp, clock, tip) / 1_000);
    const [blacklisted, check, proper, respected] = values.slice(4);
    const gameValues = values.slice(0, 4);
    const game = gameValues.every((item) => !item.error) ? reads.asGame(/** @type {any} */ (gameValues.map((item) => item.value))) : null;
    /** @type {Standing} */
    const standing = {
      blacklisted: blacklisted.error ? null : blacklisted.value === true,
      proper: proper.error ? null : Boolean(proper.value),
      respected: respected.error ? null : Boolean(respected.value),
      status: values[2].error ? null : Number(values[2].value),
    };
    const record = { ...base, disputeGameProxy: proxy, provenAt };

    // A proof whose game the Portal refuses is made again, whatever the
    // Portal's own check says: it may take just the proof and its game.
    if (isRefused(standing)) {
      return { ...record, claimOverdue: false, readyAt: null, readyAtExact: false, ...(await replacement(base, snapshot, proxy, tip)) };
    }

    // Nothing is ready, nor dated, before all of that is read.
    if (!game || game.createdAt === 0n || !isTaken(standing)) return { ...record, reason: "game-unreadable", stage: STAGE.PROVEN_WAITING };

    const claim = claimFrom({ clock, game, portal: snapshot.delays, provenAt: timestamp, tip });
    const { claimOverdue, ready, readyAt, readyAtExact, refused } = claimReadiness({ claim, portalAccepts: !check.error, tip });

    // Ready once the Portal takes the claim and its date has come, its game
    // resolved for the defender: before, the date is only the earliest.
    if (ready && claim.exact) return { ...record, claimOverdue, readyAt, readyAtExact, stage: STAGE.READY_TO_FINALIZE };

    return {
      ...record,
      // Not ready while its game hasn't resolved, however long it's late.
      claimOverdue: ready ? claim.overdue : claimOverdue,
      readyAt,
      readyAtExact,
      // Past its date and still refused: the date says nothing more.
      reason: refused ? "portal-refuses" : game.status === GAME_STATUS.IN_PROGRESS ? "game-in-progress" : "game-not-final",
      stage: STAGE.PROVEN_WAITING,
    };
  }

  /**
   * @param {ReceiptWithdrawal} withdrawal
   * @param {`0x${string}` | null} submitter
   * @param {Snapshot} snapshot
   * @returns {Promise<WithdrawalStatus>}
   */
  async function statusOf(withdrawal, submitter, snapshot) {
    /** @type {WithdrawalStatus} */
    const base = {
      ...withdrawal,
      proofRejected: false,
      proofSubmitter: submitter,
      proofSubmitterCount: snapshot.proofSubmitterCount,
      reason: null,
      stage: STAGE.WAITING_FOR_OUTPUT,
    };

    if (snapshot.finalized) return { ...base, stage: STAGE.FINALIZED };

    const { disputeGameProxy, timestamp } = snapshot.proven;

    if (!submitter || snapshot.proofSubmitterCount === 0n || timestamp === 0n || disputeGameProxy === ZERO_ADDRESS) {
      return unproven(base, snapshot);
    }

    return proven(base, snapshot);
  }

  /**
   * @param {string} txHash
   * @param {{ submitter?: string | null, proofGame?: string | null }} [options]
   * @returns {Promise<WithdrawalStatus>}
   */
  async function status(txHash, { proofGame = null, submitter = null } = {}) {
    const withdrawal = await receipt(txHash);
    const owner = submitterOf(submitter) ?? recipientSubmitter(withdrawal.facts);
    // With the proof's game known from the last check, the latest block is
    // read alongside: the proof's claim date needs it.
    const tip = proofGame ? latestBlock() : null;

    tip?.catch(() => {});

    return statusOf(withdrawal, owner, await readSnapshot(withdrawal.withdrawalHash, owner, { game: proofGame, tip }));
  }

  /**
   * A call to the Portal, encoded by its driver and read back.
   *
   * @param {string} fnName
   * @param {unknown} args
   * @param {bigint} gasLimit
   * @param {{ facts: WithdrawalFacts, proof: OutputProof | null }} built
   * @returns {Promise<PortalCall>}
   */
  async function portalCall(fnName, args, gasLimit, built) {
    const [driver] = await reads.loaded();
    const fnArgs = Uint8Array.from(driver.encodeInputFn(fnName, driverJson(args)));
    const decoded = checkedCall(net, contracts.portal, fnName, fnArgs, built);

    return {
      args,
      contractId: contracts.portal,
      decoded,
      deposit: 0n,
      fnArgs,
      fnName: /** @type {PortalCall["fnName"]} */ (fnName),
      gasLimit,
    };
  }

  /**
   * When a proof made now against `proof`'s game can be claimed: exact when
   * the game has resolved, the earliest otherwise; null when that can't be
   * read.
   *
   * @param {Snapshot} snapshot
   * @param {OutputProof} proof
   * @param {DuskTip} tip
   * @returns {Promise<ClaimDate | null>}
   */
  async function claimIfProvedNow(snapshot, proof, tip) {
    try {
      const game = await reads.readGame(await reads.hubOfGame(proof.disputeGameProxy), proof.disputeGameProxy);
      const claim = claimFrom({ game, portal: snapshot.delays, tip });

      return claim.at === null ? null : claim;
    } catch {
      return null;
    }
  }

  /**
   * @param {string} txHash
   * @param {{ submitter: string, gasLimitUpper?: bigint | number }} options
   * @returns {Promise<PreparedProof>}
   */
  async function prepareProof(txHash, { gasLimitUpper, submitter } = /** @type {any} */ ({})) {
    const owner = requireSubmitter(submitter);
    const withdrawal = await receipt(txHash);
    // A withdrawal whose claim couldn't be sent isn't proved either: they take the same gas.
    const gasLimit = gasFor(withdrawal.facts.gasLimit, gasLimitUpper);
    const tipRead = latestBlock();

    tipRead.catch(() => {});

    const snapshot = await readSnapshot(withdrawal.withdrawalHash, owner, { tip: tipRead });

    // A proof of a claimed withdrawal, or one this account has already,
    // costs its fee for nothing. Only a proof the Portal rejected is made
    // again, where its status found a game to make it against.
    /** @type {WithdrawalStatus | null} */
    let current = null;

    if (snapshot.finalized || (snapshot.proven.timestamp !== 0n && snapshot.proven.disputeGameProxy !== ZERO_ADDRESS)) {
      current = await statusOf(withdrawal, owner, snapshot);

      if (current.stage === STAGE.FINALIZED) throw new WithdrawalError("claimed", undefined, { status: current });
      if (current.stage !== STAGE.READY_TO_PROVE) throw new WithdrawalError("proven", undefined, { status: current });
    }

    const tip = await tipRead;
    const found = await findProof({ snapshot, tip, withdrawal });

    if (!found.proof) throw new WithdrawalError("no-proof", undefined, { cause: found.error ?? undefined, reason: found.reason });
    // Never again against the game the Portal refuses the account's proof against.
    if (current && found.proof.disputeGameProxy === snapshot.proven.disputeGameProxy) throw new WithdrawalError("proven", undefined, { status: current });

    const [claim, call] = await Promise.all([
      claimIfProvedNow(snapshot, found.proof, tip),
      portalCall(PROVE, proveInput(withdrawal.withdrawal, found.proof), gasLimit, { facts: withdrawal.facts, proof: found.proof }),
    ]);

    return { at: now(), call, claim, proof: found.proof, receipt: withdrawal };
  }

  /**
   * @param {string} txHash
   * @param {{ submitter: string, gasLimitUpper?: bigint | number, proofGame?: string | null }} options
   * @returns {Promise<PortalCall>}
   */
  async function claimCall(txHash, { gasLimitUpper, proofGame = null, submitter } = /** @type {any} */ ({})) {
    const owner = requireSubmitter(submitter);
    const current = await status(txHash, { proofGame, submitter: owner });

    if (current.stage !== STAGE.READY_TO_FINALIZE) throw new WithdrawalError("not-ready", undefined, { status: current });

    const gasLimit = gasFor(current.facts.gasLimit, gasLimitUpper);

    return portalCall(CLAIM, withdrawalInput(current.withdrawal), gasLimit, { facts: current.facts, proof: null });
  }

  /**
   * The games of the proofs still waiting, each on its hub, with whether
   * the Portal blacklisted it and whether the registry calls it proper and
   * respected, in one query. A game any of that can't be read of is null.
   *
   * @param {Array<{ claimed: boolean, provenAt: bigint, proxy: `0x${string}`, ready: boolean }>} records
   */
  async function proofGames(records) {
    const proxies = [
      ...new Set(records.filter((record) => !record.claimed && record.provenAt !== 0n && record.proxy !== ZERO_ADDRESS).map((record) => record.proxy)),
    ];
    const hubs = await Promise.all(proxies.map((proxy) => reads.hubOfGame(proxy).catch(() => null)));
    const games = await Promise.all(
      proxies.map((proxy, at) => {
        const hubId = hubs[at];

        return hubId
          ? Promise.all([reads.readGame(hubId, proxy), portal("disputeGameBlacklist", addressBytes(proxy)).then(Boolean), ...registryReads(proxy)])
              .then(([game, blacklisted, proper, respected]) => ({ ...game, blacklisted, proper, respected }))
              .catch(() => null)
          : null;
      })
    );

    return new Map(proxies.map((proxy, at) => [proxy, games[at]]));
  }

  /**
   * @param {ReadonlyArray<string>} hashes
   * @param {{ submitter: string }} options
   * @returns {Promise<Map<string, WithdrawalClaim>>}
   */
  async function claims(hashes, { submitter } = /** @type {any} */ ({})) {
    const account = addressBytes(requireSubmitter(submitter));
    const ids = hashes.map((hash) => fixedBytes(hash, 32));
    const tip = settle(latestBlock());
    const [maturity, finality, ...records] = await Promise.all([
      portal("proofMaturityDelaySeconds"),
      portal("disputeGameFinalityDelaySeconds"),
      ...ids.map((id) =>
        Promise.all([portal("finalizedWithdrawals", id), portal("provenWithdrawals", [id, account]), settle(portal("checkWithdrawal", [id, account]))]).then(
          ([finalized, proof, check]) => ({
            claimed: Boolean(finalized),
            provenAt: BigInt(tupleValue(proof, "timestamp", 1)),
            proxy: addressHex(tupleValue(proof, "disputeGameProxy", 0)),
            ready: !check.error,
          })
        )
      ),
    ]);
    const games = await proofGames(records);
    const latest = (await tip).value ?? null;
    const delays = { disputeGameFinalityDelaySeconds: bigOf(finality), proofMaturityDelaySeconds: bigOf(maturity) };

    return new Map(
      hashes.map((hash, at) => {
        const record = records[at];
        const game = record.claimed ? null : (games.get(record.proxy) ?? null);
        // The Portal takes no claim of a proof whose game was blacklisted,
        // retired or is no longer respected, or that the challenger won,
        // whatever its own check says: it must be made again.
        const reprove = Boolean(game && isRefused(game));
        const claim =
          game && latest && !reprove
            ? claimFrom({ clock: contractClock(record.provenAt, latest), game, portal: delays, provenAt: record.provenAt, tip: latest })
            : { at: null, exact: false, overdue: false };
        // Ready once the Portal takes the claim and its date has come, its
        // game resolved for the defender: all of it read, never on the
        // Portal's check alone.
        const ready = Boolean(
          !record.claimed &&
            game &&
            latest &&
            isTaken(game) &&
            claim.exact &&
            claimReadiness({ claim, portalAccepts: record.ready, tip: latest }).ready
        );

        return [hash.toLowerCase(), { ...claim, claimed: record.claimed, ready, reprove }];
      })
    );
  }

  /** @returns {Promise<WithdrawalTiming>} */
  async function timing() {
    const [maturity, finality, gameType, count] = await Promise.all([
      portal("proofMaturityDelaySeconds"),
      portal("disputeGameFinalityDelaySeconds"),
      portal("respectedGameType"),
      factory("gameCount"),
    ]);
    const total = bigOf(count);
    /** @type {any[]} */
    const games =
      total > 1n
        ? await factory("findLatestGames", [Number(gameType), u256Bytes(total - 1n), u256Bytes(total < OUTPUT_SAMPLE ? total : OUTPUT_SAMPLE)])
        : [];
    const times = games.map((game) => Number(tupleValue(game, "timestamp", 2))).sort((a, b) => b - a);
    const gaps = times
      .slice(1)
      .map((time, index) => times[index] - time)
      .filter((gap) => gap > 0)
      .sort((a, b) => a - b);

    return {
      finalitySeconds: Number(bigOf(finality)),
      maturitySeconds: Number(bigOf(maturity)),
      outputSeconds: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
    };
  }

  return Object.freeze({ claimCall, claims, network: net, prepareProof, receipt, status, timing });
}

// ---------------------------------------------------------------------------
// The start on DuskEVM
// ---------------------------------------------------------------------------

/**
 * @param {NetworkRef} network
 * @param {WithdrawalCallInput} withdrawal
 * @returns {{ to: `0x${string}`, data: `0x${string}`, value: bigint }}
 */
export function withdrawalCall(network, { amountWei, minGasLimit = WITHDRAWAL_MIN_GAS_LIMIT, sender, to } = /** @type {any} */ ({})) {
  const net = networkOf(network);
  const bridge = net.duskEvm?.predeploys?.l2StandardBridge;

  if (!bridge) throw new TypeError("The network has no DuskEVM bridge");

  const value = wholeOf(amountWei, "The amount");

  // Dusk holds whole lux, and its L1 bridge pays out no more than a u64 of them.
  if (value <= 0n || value % WEI_PER_LUX !== 0n || value / WEI_PER_LUX > U64_MAX) {
    throw new RangeError("The amount is whole lux, more than 0 and at most a u64 of lux");
  }

  const account = typeof to === "string" ? to.trim() : "";
  const raw = accountToRawKey(account);

  if (!raw) throw new TypeError("The recipient isn't a Dusk account");

  const from = evmAddress(sender, "The sender");
  const gas = wholeOf(minGasLimit, "The minimum gas limit");

  if (gas < 0n || gas > U32_MAX) throw new RangeError("The minimum gas limit fits in a u32");

  // The recipient as Dusk's bridge reads it: tag 2, version 1, an account, its raw key.
  const extraData = hexOf([2, 1, 0, ...raw]);
  const paid = duskRecipientOf(extraData);

  if (paid?.kind !== "account" || paid.account !== account) throw new TypeError("The recipient isn't a Dusk account");

  return {
    data: encodeFunctionData({ abi: BRIDGE_ETH_TO, args: [from, Number(gas), extraData], functionName: "bridgeETHTo" }),
    to: /** @type {`0x${string}`} */ (bridge),
    value,
  };
}

// ---------------------------------------------------------------------------
// Finding an account's withdrawals
// ---------------------------------------------------------------------------

/**
 * Whom a withdrawal pays on Dusk, as the wallets keep it: an account, or a
 * contract's ID; null for neither.
 *
 * @param {DuskRecipient | null} recipient
 * @returns {string | null}
 */
const destinationOf = (recipient) => (recipient ? (recipient.kind === "account" ? recipient.account : recipient.contractId) : null);

/**
 * The withdrawal a bridge log records, with whom it pays on Dusk, or null.
 *
 * @param {any} log
 * @returns {FoundWithdrawal | null}
 */
function withdrawalFromLog(log) {
  try {
    const [amount, extraData] = decodeAbiParameters([{ type: "uint256" }, { type: "bytes" }], log.data);

    return {
      amountWei: amount.toString(),
      blockNumber: Number(BigInt(log.blockNumber)),
      destination: destinationOf(duskRecipientOf(extraData)),
      hash: /** @type {`0x${string}`} */ (String(log.transactionHash).toLowerCase()),
    };
  } catch {
    return null;
  }
}

/** @param {unknown} error */
const tooWide = (error) => /range|limit|too many|exceed/i.test(asError(error).message);

/**
 * The highest DuskEVM block that can't be reorged away, the requests it
 * took, and how many blocks under it the next run reads again (`open`):
 * none under the RPC's finalized block. Where the RPC has none, the head is
 * the latest less a margin, and the margin's blocks under it are read
 * again, as a deeper reorg could still change them.
 *
 * @param {(method: string, params?: unknown[]) => Promise<any>} rpc
 * @returns {Promise<{ head: number, open: number, requests: number }>}
 */
async function finalHead(rpc) {
  try {
    const block = await rpc("eth_getBlockByNumber", ["finalized", false]);

    if (block?.number) return { head: Number(BigInt(block.number)), open: 0, requests: 1 };
  } catch {
    // An RPC without "finalized": the latest block, less a margin.
  }

  return { head: Math.max(0, Number(BigInt(await rpc("eth_blockNumber", []))) - UNFINALIZED_MARGIN), open: UNFINALIZED_MARGIN, requests: 2 };
}

/**
 * A sync's passes over the blocks it covered, as a state gave them, the one
 * under way no higher than `target`; null for anything else.
 *
 * @param {unknown} value
 * @param {number} target
 * @returns {NonNullable<WithdrawalScan["recheck"]> | null}
 */
function recheckOf(value, target) {
  const kept = /** @type {any} */ (value);
  /** @param {unknown} ms */
  const time = (ms) => typeof ms === "number" && Number.isFinite(ms);

  if (!kept || !time(kept.at) || !time(kept.since)) return null;
  if (kept.from !== null && !(Number.isSafeInteger(kept.from) && kept.from >= 0)) return null;

  return { at: kept.at, from: kept.from === null ? null : Math.min(kept.from, target), since: kept.since };
}

/**
 * @param {{ address: string, duskEvm: DuskEvmClient, network?: NetworkRef, bridge?: string, state?: WithdrawalScan | null, maxRequests?: number, now?: () => number }} options
 * @returns {Promise<{ found: FoundWithdrawal[], requests: number, state: WithdrawalScan }>}
 */
export async function syncWithdrawals({ address, bridge, duskEvm, maxRequests = L2_RUN_REQUESTS, network, now = Date.now, state } = /** @type {any} */ ({})) {
  const net = network === undefined || network === null ? null : networkOf(network);
  const sender = evmAddress(address, "The address");
  const contract = bridge ?? net?.duskEvm?.predeploys?.l2StandardBridge;

  if (!contract) throw new TypeError("No DuskEVM bridge to read");

  const rpc = evmRpc(duskEvm, net);
  const { head: target, open, requests: asked } = await finalHead(rpc);
  const time = now();
  // Coverage kept above the final head, as an older run read the latest, is
  // read again, and what was found there is dropped with it: it may have
  // been reorged away, or into another block.
  let covered = (state?.covered ?? []).map(([lo, hi]) => [lo, Math.min(hi, target)]).filter(([lo, hi]) => hi >= lo);
  let window = Number(state?.window) || L2_WINDOW;
  /** @type {Record<string, FoundWithdrawal>} */
  const entries = Object.fromEntries(Object.entries(state?.entries ?? {}).filter(([, entry]) => Number(entry?.blockNumber) <= target));
  /** @type {FoundWithdrawal[]} */
  const found = [];
  let requests = asked;
  let recheck = recheckOf(state?.recheck, target);
  const topics = [ETH_BRIDGE_INITIATED_TOPIC, pad(sender)];

  /**
   * The address's withdrawals in blocks `lo` to `hi`, those blocks covered;
   * false where the RPC asks for a narrower window, which it then is.
   *
   * @param {number} lo
   * @param {number} hi
   */
  const read = async (lo, hi) => {
    /** @type {any[]} */
    let logs;

    requests += 1;

    try {
      logs = await rpc("eth_getLogs", [{ address: contract, fromBlock: toHex(lo), toBlock: toHex(hi), topics }]);
    } catch (error) {
      if (window > 1_000 && tooWide(error)) {
        window = Math.floor(window / 4);
        return false;
      }

      throw error;
    }

    for (const log of logs ?? []) {
      // One found before, read again, is kept as it was.
      if (entries[String(log?.transactionHash).toLowerCase()]) continue;

      const entry = withdrawalFromLog(log);

      if (!entry) continue;

      entries[entry.hash] = entry;
      found.push(entry);
    }

    covered = addCoverage(covered, lo, hi);

    return true;
  };

  // The newest final blocks, read again on each run, from the newest down,
  // so the new ones first: in as many windows as they take, though no more
  // than half the requests the run has left (one at least, where nothing
  // else is to be read). While older blocks are still to be read, a run
  // under the same final head as the last leaves them all to those.
  const lowest = Math.max(0, target - L2_OVERLAP + 1);
  const due = recheck !== null && (recheck.from !== null || time >= recheck.at);
  const older = topGap(addCoverage(covered, lowest, target), target) !== null;
  const half = Math.floor((maxRequests - requests) / 2);
  const share = older && state?.target === target ? 0 : older || due ? half : Math.max(1, half);
  let top = target;

  for (let windows = 0; windows < share && top >= lowest && requests < maxRequests; windows += 1) {
    const lo = Math.max(0, top - window + 1);

    if (await read(lo, top)) top = lo - 1;
  }

  while (requests < maxRequests) {
    const gap = topGap(covered, target);

    if (gap) {
      const [a, b] = gap;

      await read(Math.max(a, b - window + 1), b);
      continue;
    }

    // All the final blocks covered: they're read again, a pass at a time,
    // from the newest down, with what a run has left.
    if (recheck === null) recheck = { at: time + L2_RECHECK_MS, from: null, since: time };
    if (recheck.from === null && time < recheck.at) break;

    const from = recheck.from ?? target;
    const lo = Math.max(0, from - window + 1);

    if (!(await read(lo, from))) continue;

    recheck = lo > 0 ? { ...recheck, from: lo - 1 } : { at: time + Math.max(L2_RECHECK_MS, time - recheck.since), from: null, since: recheck.since };
  }

  if (recheck === null && !topGap(covered, target)) recheck = { at: time + L2_RECHECK_MS, from: null, since: time };

  // Under a head the RPC didn't call final, the last blocks read stay open,
  // and the next run reads them again: a reorg deeper than the margin could
  // still change them. What was found there is kept, and found once.
  const kept = open ? covered.map(([lo, hi]) => [lo, Math.min(hi, target - open)]).filter(([lo, hi]) => hi >= lo) : covered;

  return { found, requests, state: { covered: kept, entries, ...(recheck ? { recheck } : {}), target, updatedAt: now(), window } };
}

/**
 * The explorer's API for the network, without a trailing slash.
 *
 * @param {Network} net
 * @param {string | undefined} url
 */
function explorerApi(net, url) {
  const api = String(url ?? net.duskEvm?.blockscoutApiUrl ?? "").trim().replace(/\/+$/, "");

  if (!/^https?:\/\//i.test(api)) throw new TypeError("No DuskEVM explorer to read");

  return api;
}

/**
 * @param {typeof fetch} send
 * @param {string} api
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 */
async function explorerJson(send, api, path, params = {}) {
  const url = new URL(`${api}/${path}`);

  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, String(value));
  }

  const response = await send(url.href, { headers: { accept: "application/json" } });

  if (!response.ok) throw new Error(`DuskEVM's explorer answered with HTTP ${response.status}`);

  return response.json();
}

/**
 * @param {unknown} value
 * @returns {`0x${string}` | null}
 */
function listedAddress(value) {
  const hash = typeof value === "string" ? value : value && typeof value === "object" && "hash" in value ? /** @type {any} */ (value).hash : null;

  return typeof hash === "string" && /^0x[0-9a-fA-F]{40}$/.test(hash) ? /** @type {`0x${string}`} */ (hash.toLowerCase()) : null;
}

/**
 * @param {unknown} value
 * @returns {`0x${string}` | null}
 */
const listedHash = (value) =>
  typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) ? /** @type {`0x${string}`} */ (value.toLowerCase()) : null;

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function listedTime(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;

  const date = new Date(value);

  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
const listedText = (value) => (typeof value === "string" || typeof value === "number" || typeof value === "bigint" ? String(value) : null);

/**
 * Whom a `bridgeETHTo` call pays on Dusk, from its input; null for any other call.
 *
 * @param {unknown} input
 * @returns {string | null}
 */
function callDestination(input) {
  try {
    const { args } = decodeFunctionData({ abi: BRIDGE_ETH_TO, data: /** @type {`0x${string}`} */ (`0x${String(input).replace(/^0x/i, "")}`) });

    return destinationOf(duskRecipientOf(args[2]));
  } catch {
    return null;
  }
}

/**
 * A transaction an address's list gives, as a withdrawal.
 *
 * @param {any} transaction
 * @returns {ExplorerWithdrawal | null}
 */
function listedTransaction(transaction) {
  const hash = listedHash(transaction?.hash);

  if (!hash) return null;

  return {
    amountWei: listedText(transaction?.value),
    blockNumber: listedText(transaction?.block_number),
    destination: callDestination(transaction?.raw_input ?? transaction?.input),
    explorerStatus: null,
    from: listedAddress(transaction?.from),
    hash,
    l1TransactionHash: null,
    timestamp: listedTime(transaction?.timestamp),
  };
}

/**
 * A transaction's details, with what the explorer says of its withdrawal.
 *
 * @param {any} details
 * @returns {ExplorerWithdrawal | null}
 */
function detailedTransaction(details) {
  const listed = listedTransaction(details);

  if (!listed) return null;

  const withdrawal = Array.isArray(details?.op_withdrawals) ? details.op_withdrawals[0] : null;

  return {
    ...listed,
    amountWei: listedText(withdrawal?.msg_value) ?? listed.amountWei,
    explorerStatus: typeof withdrawal?.status === "string" ? withdrawal.status : null,
    l1TransactionHash: listedHash(withdrawal?.l1_transaction_hash),
    timestamp: listedTime(withdrawal?.l2_timestamp) ?? listed.timestamp,
  };
}

/**
 * @param {{ network: NetworkRef, address: string, fetch?: typeof fetch, url?: string, maxPages?: number, maxItems?: number }} options
 * @returns {Promise<ExplorerWithdrawal[]>}
 */
export async function explorerWithdrawals({
  address,
  fetch,
  maxItems = EXPLORER_ITEMS,
  maxPages = EXPLORER_PAGES,
  network,
  url,
} = /** @type {any} */ ({})) {
  const net = networkOf(network);
  const account = evmAddress(address, "The address");
  const bridge = String(net.duskEvm?.predeploys?.l2StandardBridge ?? "").toLowerCase();

  if (!bridge) throw new TypeError("The network has no DuskEVM bridge");

  const api = explorerApi(net, url);
  const send = fetch ?? ((input, init) => globalThis.fetch(input, init));
  /** @type {any[]} */
  const candidates = [];
  /** @type {Record<string, unknown>} */
  let pageParams = { filter: "from" };

  for (let page = 0; page < maxPages; page += 1) {
    const body = await explorerJson(send, api, `addresses/${account}/transactions`, pageParams);
    const transactions = Array.isArray(body?.items) ? body.items : [];

    for (const transaction of transactions) {
      const input = typeof transaction?.raw_input === "string" ? transaction.raw_input : transaction?.input;
      // Its own call of the bridge's withdrawal that went through.
      const isWithdrawal =
        typeof input === "string" && input.length >= 10 ? input.slice(0, 10).toLowerCase() === BRIDGE_ETH_TO_SELECTOR : transaction?.method === "bridgeETHTo";

      if (
        listedHash(transaction?.hash) &&
        listedAddress(transaction?.from) === account &&
        listedAddress(transaction?.to) === bridge &&
        isWithdrawal &&
        transaction?.status !== "error"
      ) {
        candidates.push(transaction);
      }
    }

    if (candidates.length >= maxItems || !body?.next_page_params || !transactions.length) break;

    pageParams = { ...body.next_page_params, filter: "from" };
  }

  const items = await Promise.all(
    candidates.slice(0, maxItems).map(async (transaction) => {
      try {
        return detailedTransaction(await explorerJson(send, api, `transactions/${String(transaction.hash).toLowerCase()}`));
      } catch {
        return listedTransaction(transaction);
      }
    })
  );

  return items.filter((item) => item !== null);
}

/**
 * @param {{ network: NetworkRef, nonces: ReadonlyArray<bigint>, fetch?: typeof fetch, url?: string, maxPages?: number }} options
 * @returns {Promise<Map<string, ExplorerWithdrawal>>}
 */
export async function withdrawalsByNonce({ fetch, maxPages = EXPLORER_PAGES, network, nonces, url } = /** @type {any} */ ({})) {
  const net = networkOf(network);
  const api = explorerApi(net, url);
  const send = fetch ?? ((input, init) => globalThis.fetch(input, init));
  const wanted = new Set(nonces.map(String));
  const oldest = nonces.reduce((low, nonce) => ((BigInt(nonce) & NONCE_COUNT) < low ? BigInt(nonce) & NONCE_COUNT : low), NONCE_COUNT);
  /** @type {Map<string, ExplorerWithdrawal>} */
  const found = new Map();
  /** @type {Record<string, unknown> | null} */
  let pageParams = {};

  for (let page = 0; pageParams && page < maxPages && wanted.size; page += 1) {
    const body = await explorerJson(send, api, "optimism/withdrawals", pageParams);
    const withdrawals = Array.isArray(body?.items) ? body.items : [];

    for (const withdrawal of withdrawals) {
      const nonce = listedText(withdrawal?.msg_nonce_raw);
      const hash = listedHash(withdrawal?.l2_transaction_hash);

      if (nonce && wanted.delete(nonce) && hash) {
        found.set(nonce, {
          amountWei: listedText(withdrawal?.msg_value),
          blockNumber: null,
          destination: null,
          explorerStatus: typeof withdrawal?.status === "string" ? withdrawal.status : null,
          from: listedAddress(withdrawal?.from),
          hash,
          l1TransactionHash: listedHash(withdrawal?.l1_transaction_hash),
          timestamp: listedTime(withdrawal?.l2_timestamp),
        });
      }
    }

    const last = withdrawals[withdrawals.length - 1];

    // Newest first: past the oldest asked for, none is left to find.
    pageParams = body?.next_page_params && last && BigInt(listedText(last.msg_nonce) ?? 0) > oldest ? body.next_page_params : null;
  }

  return found;
}

/**
 * @param {string | null | undefined} status
 * @returns {WithdrawalStage | null}
 */
export function explorerStage(status) {
  switch (String(status ?? "").trim().toLowerCase()) {
    case "waiting for state root":
      return STAGE.WAITING_FOR_OUTPUT;
    case "ready to prove":
      return STAGE.READY_TO_PROVE;
    case "waiting a game to resolve":
    case "in challenge period":
    case "proven":
      return STAGE.PROVEN_WAITING;
    case "ready for relay":
      return STAGE.READY_TO_FINALIZE;
    case "relayed":
      return STAGE.FINALIZED;
    default:
      return null;
  }
}
