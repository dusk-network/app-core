/* @ts-self-types="./payment-links.d.ts" */
/**
 * Links that ask for a payment: a `dusk:` link for a wallet that reads them,
 * as in a QR code, and an https link to the web wallet's Send, which survives
 * email and chat. One function reads both, and a link is only made for what
 * Send will take.
 *
 * @module
 */

import { blockedReason, networkFor, networks } from "@dusk-network/networks";
import { decodeBase58, isAccount } from "@dusk-network/networks/account";

import { formatDuskPlain, parseDusk, readAmount } from "./amounts.js";

/** @typedef {import("./payment-links.js").PaymentLink} PaymentLink */
/** @typedef {import("./payment-links.js").PaymentRequest} PaymentRequest */
/** @typedef {import("./payment-links.js").MadePaymentLink} MadePaymentLink */
/** @typedef {import("./payment-links.js").LinkRead} LinkRead */
/** @typedef {import("@dusk-network/networks").Network} Network */

export const MAX_MEMO_BYTES = 512;

/** Where the web wallet's Send is, under the wallet's address. */
const SEND_PATH = "/dashboard/send";
const CHAIN_ID = /^dusk:(\d{1,32})$/i;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ACCOUNT_BYTES = 96;
const SHIELDED_BYTES = 64;
const MAX_U64 = (1n << 64n) - 1n;

/** What a link may say, each once: the recipient, what's asked, and the network. */
const SAID_ONCE = Object.freeze(["to", "amount", "amountLux", "memo", "label", "network"]);

/** Why a link fills in nothing, in the words both wallets use. */
export const LINK_UNREADABLE = "That link can't be read. Ask for a new one.";
export const LINK_TWO_AMOUNTS = "This link asks for two different amounts. Ask for a new one.";
const LINK_NO_RECIPIENT = "This link doesn't say who to pay. Ask for a new one.";
const LINK_USER_PART = "This link has something before the site's address. Ask for a new one.";
const LINK_NETWORK_UNREAD = "This link's network can't be read. Ask for a new one.";

/** A field a link says twice, as a refusal names it. */
const FIELD_WORDS = Object.freeze({ amount: "the amount", amountLux: "the amount", label: "the label", memo: "the memo", network: "the network", to: "the recipient" });

/** What the apps say of a recipient they won't send to, by the network file's reason. */
const BLOCKED = Object.freeze({
  compromised: "Transfer restricted: this recipient address has been reported as compromised.",
  scam: "Transfer restricted: this recipient address is associated with reported fraud/scam activity.",
});

/**
 * @param {unknown} value
 */
const textOf = (value) => String(value ?? "").trim();

/**
 * A chain ID as a link writes it, "dusk:2", from a network, its number or
 * that text: "" for anything else.
 *
 * @param {unknown} network
 * @returns {string}
 */
function chainIdOf(network) {
  if (network && typeof network === "object") return chainIdOf(/** @type {Network} */ (network).chainId);
  if (typeof network === "number" && Number.isSafeInteger(network) && network >= 0) return `dusk:${network}`;
  if (typeof network === "bigint" && network >= 0n) return `dusk:${network}`;

  const text = textOf(network);

  if (CHAIN_ID.test(text)) return text;
  if (/^\d{1,32}$/.test(text)) return `dusk:${text}`;

  const named = Object.values(networks).find((each) => each.name === text.toLowerCase());

  return named ? `dusk:${named.chainId}` : "";
}

/**
 * @param {unknown} chain
 * @returns {string}
 */
const referenceOf = (chain) => CHAIN_ID.exec(textOf(chain))?.[1] ?? "";

/**
 * A chain by its network's name: "Mainnet", "Local" for 0, "Chain 42" for one
 * there's no file for, and "" for what isn't a chain ID.
 *
 * @param {unknown} chain
 * @returns {string}
 */
export function chainLabel(chain) {
  const reference = referenceOf(chain);

  if (reference === "0") return "Local";

  return reference ? (networkFor(reference)?.label ?? `Chain ${reference}`) : "";
}

/**
 * @param {unknown} linkChain
 * @param {unknown} walletChain
 * @returns {string}
 */
export function networkMismatch(linkChain, walletChain) {
  const want = referenceOf(chainIdOf(linkChain));
  const have = referenceOf(chainIdOf(walletChain));

  if (!want || !have || want === have) return "";

  return `This request is for ${chainLabel(`dusk:${want}`)}. You are on ${chainLabel(`dusk:${have}`)}.`;
}

/**
 * @param {unknown} recipient
 * @returns {"public" | "shielded" | "unknown"}
 */
export function recipientKind(recipient) {
  const length = decodeBase58(textOf(recipient))?.length;

  return length === ACCOUNT_BYTES ? "public" : length === SHIELDED_BYTES ? "shielded" : "unknown";
}

/**
 * The amounts a link's query says: an exact amount in lux decides, and the
 * amount in DUSK is what it comes to.
 *
 * @param {URLSearchParams} params
 */
function amountsOf(params) {
  const amountLux = textOf(params.get("amountLux"));
  const amount = textOf(params.get("amount"));
  const amountDusk = /^\d+$/.test(amountLux) ? formatDuskPlain(amountLux) : amount || amountLux;

  return { amountDusk, amountLux, lux: parseDusk(amountDusk) };
}

/**
 * Why a query can't be read: a field it says more than once, as the link
 * could be read two ways. "" for none.
 *
 * @param {URLSearchParams} params
 * @returns {string}
 */
function saidTwice(params) {
  const field = SAID_ONCE.find((name) => params.getAll(name).length > 1);

  return field ? `This link says ${FIELD_WORDS[/** @type {keyof typeof FIELD_WORDS} */ (field)]} twice. Ask for a new one.` : "";
}

/**
 * @param {string} a A chain ID, "dusk:1"
 * @param {string} b
 */
const twoNetworks = (a, b) => `This link names two networks, ${chainLabel(a)} and ${chainLabel(b)}. Ask for a new one.`;

/**
 * A `dusk:` link: `dusk:public-<recipient>[@dusk:<chain>][?amount=…&memo=…&network=…]`,
 * or `shielded-`, with `//` after the scheme or not, and its query, its
 * network after the `@` or in its query, as an https link's; why it's
 * refused where it names two networks, one that can't be read, says a field
 * twice or no recipient; and null for any other.
 *
 * @param {string} raw
 * @returns {{ link: PaymentLink, params: URLSearchParams } | { problem: string } | null}
 */
function duskForm(raw) {
  const rest = raw.replace(/^dusk:/i, "").replace(/^\/+/, "");
  const q = rest.indexOf("?");
  const params = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
  let head = (q >= 0 ? rest.slice(0, q) : rest).trim();
  let atChain = "";
  const at = head.lastIndexOf("@");

  if (at > 0) {
    atChain = head.slice(at + 1).trim();
    head = head.slice(0, at).trim();
  }

  const kind = /^public-/i.test(head) ? "public" : /^shielded-/i.test(head) ? "shielded" : null;

  if (!kind) return null;

  const twice = saidTwice(params);
  const named = textOf(params.get("network"));
  const queryChain = chainIdOf(named);

  if (twice) return { problem: twice };
  if ((atChain && !referenceOf(atChain)) || (named && !queryChain)) return { problem: LINK_NETWORK_UNREAD };
  if (atChain && queryChain && referenceOf(atChain) !== referenceOf(queryChain)) return { problem: twoNetworks(atChain, queryChain) };

  const encoded = head.slice(kind.length + 1);
  let to = encoded;

  try {
    to = decodeURIComponent(encoded);
  } catch {
    // Not percent-encoding after all: as it is.
  }

  to = to.trim();

  if (!to) return { problem: LINK_NO_RECIPIENT };

  return { link: { ...amountsOf(params), chainId: atChain || queryChain, form: "dusk", kind, label: textOf(params.get("label")), memo: textOf(params.get("memo")), raw, to }, params };
}

/**
 * An address without its trailing slashes.
 *
 * @param {string} url
 */
const trimmed = (url) => url.replace(/\/+$/, "");

/**
 * An https link to the web wallet's Send, and its query: `undefined` when it's
 * no such link; why it's refused where it has a user part before its host,
 * which makes it read as another address than the one it goes to, says a
 * field more than once, names a network that can't be read or another than
 * its wallet's, or no recipient.
 *
 * @param {string} raw
 * @param {string | undefined} walletUrl
 * @returns {{ link: PaymentLink, params: URLSearchParams } | { problem: string } | undefined}
 */
function walletForm(raw, walletUrl) {
  /** @type {URL} */
  let url;

  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }

  const page = `${url.origin}${trimmed(url.pathname)}`;
  const ours = Object.values(networks).find((net) => net.apps.wallet && `${trimmed(net.apps.wallet)}${SEND_PATH}` === page);

  if (!ours && (!walletUrl || `${trimmed(walletUrl)}${SEND_PATH}` !== page)) return undefined;

  const params = url.searchParams;
  const said = textOf(params.get("network"));
  const chainId = chainIdOf(said);
  const to = textOf(params.get("to"));
  const twice = saidTwice(params);

  if (url.username || url.password) return { problem: LINK_USER_PART };
  if (twice) return { problem: twice };
  if (said && !chainId) return { problem: LINK_NETWORK_UNREAD };
  // A link that says one network, on another network's wallet.
  if (ours && chainId && referenceOf(chainId) !== String(ours.chainId)) return { problem: twoNetworks(`dusk:${ours.chainId}`, chainId) };
  if (!to) return { problem: LINK_NO_RECIPIENT };

  return {
    link: {
      ...amountsOf(params),
      chainId: chainId || (ours ? `dusk:${ours.chainId}` : ""),
      form: "https",
      kind: recipientKind(to),
      label: textOf(params.get("label")),
      memo: textOf(params.get("memo")),
      raw,
      to,
    },
    params,
  };
}

/**
 * A link and its query, as given, or why it's refused: null for nothing, and
 * for a `dusk:` link of no form a payment's has; a recipient as it is with no
 * query.
 *
 * @param {string} raw
 * @param {string | undefined} walletUrl
 * @returns {{ link: PaymentLink, params: URLSearchParams | null } | { problem: string } | null}
 */
function readLink(raw, walletUrl) {
  if (!raw) return null;
  if (/^dusk:/i.test(raw)) return duskForm(raw);

  const https = walletForm(raw, walletUrl);

  // Anything else may be a recipient, as a QR code holds just the address.
  return https === undefined ? { link: { amountDusk: "", amountLux: "", chainId: "", form: "raw", kind: "unknown", label: "", lux: null, memo: "", raw, to: raw }, params: null } : https;
}

/**
 * @param {unknown} input
 * @param {{ walletUrl?: string }} [options]
 * @returns {PaymentLink | null}
 */
export function parsePaymentLink(input, { walletUrl } = {}) {
  const read = readLink(textOf(input), walletUrl);

  return read && "link" in read ? read.link : null;
}

/**
 * A link's query, as its form reads it: all after the `?` of a `dusk:` link,
 * an https link's search.
 *
 * @param {string} raw
 */
function queryOf(raw) {
  if (/^dusk:/i.test(raw)) {
    const q = raw.indexOf("?");

    return new URLSearchParams(q >= 0 ? raw.slice(q + 1) : "");
  }

  try {
    return new URL(raw).searchParams;
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Whether a link says amounts that differ: in DUSK and in lux, or one of them
 * twice. The one in lux would be paid, unlike what's read.
 *
 * @param {URLSearchParams} params
 */
function amountsDiffer(params) {
  const lux = [
    ...params.getAll("amount").map((text) => parseDusk(textOf(text))),
    ...params.getAll("amountLux").map((text) => (/^\d+$/.test(textOf(text)) ? BigInt(textOf(text)) : null)),
  ];

  return new Set(lux.map(String)).size > 1;
}

/**
 * A link read, with the name of the network it's for.
 *
 * @param {Omit<LinkRead, "network">} read
 * @returns {LinkRead}
 */
const said = (read) => ({ ...read, network: chainLabel(read.chainId) });

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string }} [options]
 * @returns {LinkRead | null}
 */
export function readPaymentLink(input, { network, walletUrl } = {}) {
  const raw = textOf(input);
  const read = readLink(raw, walletUrl);
  const link = read && "link" in read ? read.link : null;

  if (!raw || link?.form === "raw") return null;

  const chainId = link?.chainId ?? "";

  if (amountsDiffer(queryOf(raw))) return said({ chainId, link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" });
  if (!link) return said({ chainId, link: null, problem: (read && "problem" in read && read.problem) || LINK_UNREADABLE, reason: "unreadable" });

  const otherNetwork = networkMismatch(chainId, network);

  return said(otherNetwork ? { chainId, link: null, problem: otherNetwork, reason: "other-network" } : { chainId, link, problem: "", reason: "" });
}

/**
 * An amount given in lux, as `readAmount` reads a typed one.
 *
 * @param {bigint | number | string} amount
 * @returns {{ lux: bigint | null, problem: string | null }}
 */
function readLux(amount) {
  // A number past the safe integers has already lost its last digits.
  if (typeof amount === "number" && !Number.isSafeInteger(amount)) return { lux: null, problem: "That amount is too large." };

  const text = String(amount).trim();
  const lux = /^\d+$/.test(text) ? BigInt(text) : null;

  if (lux === null || lux === 0n) return { lux: null, problem: "Enter an amount greater than 0." };

  return lux > MAX_U64 ? { lux: null, problem: "That amount is too large." } : { lux, problem: null };
}

/**
 * What's wrong with a recipient a link would pay, in the words of Send.
 *
 * @param {string} to
 * @param {Network | null} net
 * @returns {string | null}
 */
function recipientProblem(to, net) {
  if (EVM_ADDRESS.test(to)) return "That's an EVM address, not a Dusk account.";

  const kind = recipientKind(to);

  if (kind === "unknown" || (kind === "public" && !isAccount(to))) return "Not a valid address. Check it and try again.";

  const blocked = kind === "public" ? (net ? [net] : Object.values(networks)).map((each) => blockedReason(each, to)).find(Boolean) : null;

  return blocked ? BLOCKED[blocked] : null;
}

/**
 * @param {PaymentRequest} request
 * @returns {MadePaymentLink}
 */
export function makePaymentLink({ amount, amountLux, label, language, memo, network, to, walletUrl }) {
  const recipient = textOf(to);
  const chainId = chainIdOf(network);
  const reference = referenceOf(chainId);
  const net = reference ? networkFor(reference) : null;
  const message = textOf(memo);
  const read = amountLux === undefined || amountLux === null || amountLux === "" ? readAmount(String(amount ?? ""), language) : readLux(amountLux);
  /** @type {MadePaymentLink["problems"]} */
  const problems = {};
  const toProblem = recipientProblem(recipient, net);

  if (toProblem) problems.to = toProblem;
  if (read.problem) problems.amount = read.problem;
  if (new TextEncoder().encode(message).length > MAX_MEMO_BYTES) problems.memo = `That memo is too long: ${MAX_MEMO_BYTES} bytes at most.`;

  if (Object.keys(problems).length) return { dusk: "", https: null, lux: read.lux, ok: false, problems };

  /** @type {[string, string][]} */
  const asked = [
    ["amount", read.lux === null ? "" : formatDuskPlain(read.lux)],
    ["memo", message],
    ["label", textOf(label)],
  ];
  const says = asked.filter(([, value]) => value);
  const tail = new URLSearchParams(says).toString();
  const dusk = `dusk:${recipientKind(recipient)}-${encodeURIComponent(recipient)}${chainId ? `@${chainId}` : ""}${tail ? `?${tail}` : ""}`;
  const walletAt = walletUrl ?? net?.apps.wallet ?? null;
  // The network last, so a link cut at its last punctuation still reads whole.
  const wallet = new URLSearchParams([["to", recipient], ...says, ["network", net?.name ?? chainId]]);

  return { dusk, https: walletAt && chainId ? `${trimmed(walletAt)}${SEND_PATH}?${wallet}` : null, lux: read.lux, ok: true, problems };
}
