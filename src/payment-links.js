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

import { amountForField, decimalSeparator, formatDuskPlain, parseDusk, readAmount, unclearAmount } from "./amounts.js";
import { looksAlike, nameDuskNames, sameName } from "./names.js";
import { ownerOf } from "./owners.js";
import { bare, lettersOf, nameSkeleton } from "./plain.js";
import { displayText } from "./text.js";

/** @typedef {import("./payment-links.js").PaymentLink} PaymentLink */
/** @typedef {import("./payment-links.js").PaymentRequest} PaymentRequest */
/** @typedef {import("./payment-links.js").MadePaymentLink} MadePaymentLink */
/** @typedef {import("./payment-links.js").LinkRead} LinkRead */
/** @typedef {import("./payment-links.js").PastedLinkRead} PastedLinkRead */
/** @typedef {import("@dusk-network/networks").Network} Network */

export const MAX_MEMO_BYTES = 512;

/** Where the web wallet's Send is, under the wallet's address. */
const SEND_PATH = "/dashboard/send";
// A chain's number as it's written once: "dusk:02" isn't chain 2's.
const CHAIN_ID = /^dusk:(0|[1-9]\d{0,31})$/i;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// A .dusk name as it can be written: its labels' letters, digits and hyphens, which Send resolves or says more of.
const DUSK_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.dusk$/i;
const ACCOUNT_BYTES = 96;
const SHIELDED_BYTES = 64;
const MAX_U64 = (1n << 64n) - 1n;

/** What a link may say, each once: the recipient, what's asked, and the network. */
const SAID_ONCE = Object.freeze(["to", "amount", "amountLux", "memo", "label", "network"]);

/** Each field by its name in lower case: a field is read by its name in any case, as a reader that ignores case reads it. */
const FIELD_NAMED = new Map(SAID_ONCE.map((name) => [name.toLowerCase(), name]));

// A field's name as links write it, every field's among them: printable ASCII, no space.
const PLAIN_NAME = /^[\x21-\x7e]*$/;

// An amount as a link writes it, after its percent-encoding: digits, with decimals after one point or comma.
const PLAIN_AMOUNT = /^(\d+([.,]\d*)?|[.,]\d+)$/;
// An amount in lux: digits alone.
const PLAIN_LUX = /^\d+$/;
// A line break of any kind.
const LINE_BREAK = /[\n\v\f\r\u0085\u2028\u2029]/;

/** Why a link fills in nothing, in the words both wallets use. */
export const LINK_UNREADABLE = "That link can't be read. Ask for a new one.";
export const LINK_TWO_AMOUNTS = "This link asks for two different amounts. Ask for a new one.";
export const LINK_BAD_ADDRESS = "This link's address isn't valid. Ask for a new one.";
export const LINK_BAD_AMOUNT = "This link's amount can't be read. Ask for a new one.";
export const LINK_MEMO_LINE_BREAK = "This link's memo has a line break. Ask for a new one.";
/** Why pasted text fills in nothing, in the words both wallets use. */
export const LINK_SEVERAL = "That has more than one payment link. Paste just the one to pay.";
export const LINK_UNCLEAR = "The words after that link may be part of it. Paste the link alone.";
export const LINK_DISAGREES = "The message and its link don't agree.";
const LINK_NO_RECIPIENT = "This link doesn't say who to pay. Ask for a new one.";
const LINK_USER_PART = "This link has something before the site's address. Ask for a new one.";
const LINK_NETWORK_UNREAD = "This link's network can't be read. Ask for a new one.";
const LINK_SHIELDED_TO_PUBLIC = "This link asks for a shielded payment to a public account. Ask for a new one.";
const LINK_PUBLIC_TO_SHIELDED = "This link asks for a public payment to a shielded address. Ask for a new one.";

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
  if (CHAIN_ID.test(`dusk:${text}`)) return `dusk:${text}`;

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
 * A query with each field named as links write it, whatever its case: "To"
 * and "AMOUNT" are `to` and `amount`. A field said in two cases is said
 * twice, and one said once in another case is still that field, never left
 * out.
 *
 * @param {URLSearchParams} params
 */
function fieldsOf(params) {
  const named = new URLSearchParams();

  params.forEach((value, name) => named.append(FIELD_NAMED.get(name.toLowerCase()) ?? name, value));

  return named;
}

/**
 * Whether a query's names say what a reader won't read them as: one that
 * isn't printable ASCII, as every field's name is (what can't be seen, a
 * space or a control, which one reader reads past and another drops, as
 * `am\u200bount`, `to\u0000` or `to `, and letters of another script or
 * form, as fullwidth `\uff54\uff4f`, a small capital in `\u0274etwork` or a
 * Cyrillic `\u0442o`), and one in ASCII that looks like a field's name but
 * isn't one, as `amountIux` with a capital I for the l of `amountLux`, or
 * `Iabel`. A person reading the link would take either for a field no
 * reader reads as one.
 *
 * @param {URLSearchParams} params As given, before `fieldsOf`
 */
function namesHide(params) {
  let hides = false;

  params.forEach((_, name) => {
    hides ||= !PLAIN_NAME.test(name) || (!FIELD_NAMED.has(name.toLowerCase()) && SAID_ONCE.some((field) => looksAlike(name, field)));
  });

  return hides;
}

/**
 * Whether a link's recipient is one Send can pay, or says more of: an
 * account, a shielded address, a `.dusk` name or an EVM address. Anything
 * else is no one to pay, as two addresses in one, or one with a line break
 * or a hidden character in it, though a field that drops what's in the way
 * would leave an address to pay.
 *
 * @param {string} to
 */
function payable(to) {
  const kind = recipientKind(to);

  return kind === "public" ? isAccount(to) : kind === "shielded" || DUSK_NAME.test(to) || EVM_ADDRESS.test(to);
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
 * Why a query can't be read: a field it says more than once, in any case
 * (`fieldsOf`), as the link could be read two ways. "" for none.
 *
 * @param {URLSearchParams} params
 * @returns {string}
 */
function saidTwice(params) {
  const field = SAID_ONCE.find((name) => params.getAll(name).length > 1);

  return field ? twiceWords(/** @type {keyof typeof FIELD_WORDS} */ (field)) : "";
}

/** @param {keyof typeof FIELD_WORDS} field */
const twiceWords = (field) => `This link says ${FIELD_WORDS[field]} twice. Ask for a new one.`;

/**
 * @param {string} a A chain ID, "dusk:1"
 * @param {string} b
 */
const twoNetworks = (a, b) => `This link names two networks, ${chainLabel(a)} and ${chainLabel(b)}. Ask for a new one.`;

/**
 * A `dusk:` link: `dusk:public-<recipient>[@dusk:<chain>][?amount=…&memo=…&network=…]`,
 * or `shielded-`, or `dusk:<recipient>` with an account or a shielded
 * address as it is, with `//` after the scheme or not, and its query, its
 * network after the `@` or in its query, as an https link's; why it's
 * refused where it names two networks, one that can't be read, says a field
 * twice (a recipient in its query too) or no recipient, asks for one kind of
 * payment to the other kind's recipient, or has a `#`; and null for any other.
 *
 * @param {string} raw
 * @returns {{ link: PaymentLink, params: URLSearchParams } | { problem: string } | null}
 */
function duskForm(raw) {
  // Readers differ on what follows a #, a fragment to leave out or more of the query: it's read as neither.
  if (raw.includes("#")) return { problem: LINK_UNREADABLE };

  const rest = raw.replace(/^dusk:/i, "").replace(/^\/+/, "");
  const q = rest.indexOf("?");
  const given = new URLSearchParams(q >= 0 ? rest.slice(q + 1) : "");
  const params = fieldsOf(given);
  let head = (q >= 0 ? rest.slice(0, q) : rest).trim();
  let atChain = "";
  const at = head.lastIndexOf("@");

  if (at > 0) {
    atChain = head.slice(at + 1).trim();
    head = head.slice(0, at).trim();
  }

  const named = /^public-/i.test(head) ? "public" : /^shielded-/i.test(head) ? "shielded" : null;
  // Without its kind, the recipient is all there is: an account or a shielded address, as it's written.
  const bare = named ? null : recipientKind(head);
  const kind = named ?? (bare === "unknown" ? null : bare);

  if (!kind) return null;

  // The link names its recipient already: one in its query says it twice.
  const twice = saidTwice(params) || (params.has("to") ? twiceWords("to") : "");
  const network = textOf(params.get("network"));
  const queryChain = chainIdOf(network);

  if (twice) return { problem: twice };
  if (namesHide(given)) return { problem: LINK_UNREADABLE };
  if ((atChain && !referenceOf(atChain)) || (network && !queryChain)) return { problem: LINK_NETWORK_UNREAD };
  if (atChain && queryChain && referenceOf(atChain) !== referenceOf(queryChain)) return { problem: twoNetworks(atChain, queryChain) };

  let to = named ? head.slice(named.length + 1) : head;

  try {
    if (named) to = decodeURIComponent(to);
  } catch {
    // Not percent-encoding after all: as it is.
  }

  to = to.trim();

  if (!to) return { problem: LINK_NO_RECIPIENT };

  // The kind it names is the payment it asks for: a recipient of the other kind would be paid the other way.
  const actual = recipientKind(to);

  if (named === "shielded" && actual === "public") return { problem: LINK_SHIELDED_TO_PUBLIC };
  if (named === "public" && actual === "shielded") return { problem: LINK_PUBLIC_TO_SHIELDED };

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

  // Its fragment is the browser's: the page it opens leaves it out, and so does this.
  const params = fieldsOf(url.searchParams);
  const said = textOf(params.get("network"));
  const chainId = chainIdOf(said);
  const to = textOf(params.get("to"));
  const twice = saidTwice(params);

  if (url.username || url.password) return { problem: LINK_USER_PART };
  if (twice) return { problem: twice };
  if (namesHide(url.searchParams)) return { problem: LINK_UNREADABLE };
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

// A tab or a line break, which the URL parser drops from anywhere in a link.
const DROPPED = /[\t\n\r]/g;
// A control or a space at either end of a link, which the URL parser drops too.
const LINK_ENDS = /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g;

/**
 * A link's query as it's written, its fields named in any case: all after
 * its first `?` up to its first `#`, which a `dusk:` link's reading refuses
 * and an https link's fragment is. An https link's is read as the URL parser
 * reads it, but for the tabs and line breaks in its values, which it drops,
 * so joining what's around them: an amount of "0.001", a tab and "5" is
 * 0.0015 to it, and here it's as written. Its fields' names are the
 * parser's, what it drops dropped before they're decoded, so a name it reads
 * as a field's, as "%6", a tab and "1mount" for `amount`, is that field's
 * here too.
 *
 * @param {string} raw
 */
function queryOf(raw) {
  const dusk = /^dusk:/i.test(raw);
  const [link] = (dusk ? raw : raw.replace(LINK_ENDS, "")).split("#");
  const q = link.indexOf("?");
  const query = q >= 0 ? link.slice(q + 1) : "";

  if (dusk) return fieldsOf(new URLSearchParams(query));

  // Each field's name without what the parser drops; the tabs and line breaks in its value kept, encoded.
  const written = query
    .split("&")
    .map((field) => {
      const is = field.indexOf("=");

      return is < 0 ? field.replace(DROPPED, "") : `${field.slice(0, is).replace(DROPPED, "")}=${field.slice(is + 1).replace(DROPPED, encodeURIComponent)}`;
    })
    .join("&");

  // An empty fragment after it, so the parser keeps what's at the query's end, as in the link it's read from.
  return fieldsOf(new URL(`https://link.invalid/?${written}#`).searchParams);
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
 * Whether a link's amount, as its percent-encoding gives it, is no plain
 * number: anything in it or around it but digits and one point or comma,
 * as a `#` it encodes (`%23`), what can't be seen or a space. A field that
 * drops what's in the way would show an amount the link doesn't say.
 *
 * @param {URLSearchParams} params
 */
const amountUnread = (params) => params.getAll("amount").some((text) => text !== "" && !PLAIN_AMOUNT.test(text)) || params.getAll("amountLux").some((text) => text !== "" && !PLAIN_LUX.test(text));

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
  const query = queryOf(raw);

  if (amountUnread(query)) return said({ chainId, link: null, problem: LINK_BAD_AMOUNT, reason: "unreadable" });
  if (amountsDiffer(query)) return said({ chainId, link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" });
  if (!link) return said({ chainId, link: null, problem: (read && "problem" in read && read.problem) || LINK_UNREADABLE, reason: "unreadable" });
  // A recipient that can't be paid on any network, before which network the link is for.
  if (!payable(link.to)) return said({ chainId, link: null, problem: LINK_BAD_ADDRESS, reason: "unreadable" });
  // A memo is one line, as both wallets' requests write it: one with a line break would be read one way by one and another by the other.
  if (LINE_BREAK.test(link.memo)) return said({ chainId, link: null, problem: LINK_MEMO_LINE_BREAK, reason: "unreadable" });

  const otherNetwork = networkMismatch(chainId, network);

  return said(otherNetwork ? { chainId, link: null, problem: otherNetwork, reason: "other-network" } : { chainId, link, problem: "", reason: "" });
}

// A space or a line break of any kind, which ends a link in text, as a chat ends one: a next line (U+0085) among
// them, which `\s` leaves out.
const SPACES = /[\s\u0085]+/;
const SPACE = /^[\s\u0085]$/;
// A line break of any kind, Windows' among them.
const LINES = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/;
// "dusk:" with nothing after it but punctuation, as "Please pay 0.002 DUSK:" ends: a word, no link.
const NO_LINK = /^dusk:[\p{P}\p{S}]*$/iu;
// The isolates a line sets right-to-left words apart with (`displayText`), which a chat may drop.
const ISOLATES = /[\u2066-\u2069]/g;
// The overrides and embeddings, which turn what's shown around, as "200" shown as "002": the wallets' own messages
// hold none, showing one in a name or a memo as its code (`displayText`).
const TURNED = /[\u202a-\u202e]/;
// What a reader reads past, as it renders as nothing: format characters, controls, and what's ignorable.
const UNSEEN = /^[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]$/u;
const MARK = /^\p{M}$/u;
const DIGIT = /^\p{Nd}$/u;
// "You're", as a request's line starts without a name, with an apostrophe of any kind, or none.
const YOURE = new Set(["you're", "youre"]);

/**
 * Text without the spaces and line breaks of any kind at its ends.
 *
 * @param {string} text
 */
function withinSpaces(text) {
  let start = 0;
  let end = text.length;

  while (start < end && SPACE.test(text[start])) start += 1;
  while (end > start && SPACE.test(text[end - 1])) end -= 1;

  return text.slice(start, end);
}

/**
 * A link read from what was pasted, with the link as it's written there.
 *
 * @param {LinkRead | null} read
 * @param {string} text
 * @returns {PastedLinkRead | null}
 */
const readFrom = (read, text) => read && { ...read, text };

/**
 * What pasted text refused for `problem` fills in: nothing, from no link.
 *
 * @param {string} problem
 * @param {"several-links" | "words-after" | "disagrees"} reason
 * @returns {PastedLinkRead}
 */
const pasteRefused = (problem, reason) => ({ chainId: "", link: null, network: "", problem, reason, text: "" });

/**
 * Pasted text's one payment link, its last word, as it's written there, and
 * the words before it; why it's refused, with two links or more, or with
 * words after its one, which a space or a line break of any kind parts from
 * it, as a chat parts them; null for none.
 *
 * @param {unknown} input
 * @param {{ walletUrl?: string }} options
 * @returns {{ before: string, link: string } | { refused: PastedLinkRead } | null}
 */
function pastedParts(input, { walletUrl }) {
  const pasted = textOf(input);
  const words = pasted.split(SPACES).filter(Boolean);
  const links = words.filter((word) => !NO_LINK.test(word) && readPaymentLink(word, { walletUrl }));

  // Two links, wherever they are: read whole, one would carry the other in its memo.
  if (links.length > 1) return { refused: pasteRefused(LINK_SEVERAL, "several-links") };
  if (!links.length) return null;
  // A link ends at a space: what's after it may be part of it, or words that aren't, never its memo's or its network's.
  if (words[words.length - 1] !== links[0]) return { refused: pasteRefused(LINK_UNCLEAR, "words-after") };

  return { before: pasted.slice(0, pasted.lastIndexOf(links[0])), link: links[0] };
}

/**
 * Text without "Pay here:" at its end, as a shared request has it before its
 * link (`requestMessage`), in any case and spacing: "Pay", a space or a line
 * break of any kind, "here", and a colon, a space before it or not; and
 * without the spaces before it.
 *
 * @param {string} text Without spaces at its end
 */
function withoutPayHere(text) {
  let end = text.length - 1;

  if (text[end] !== ":") return text;

  while (end > 0 && SPACE.test(text[end - 1])) end -= 1;

  let at = end - 4;

  if (at < 0 || text.slice(at, end).toLowerCase() !== "here") return text;

  const here = at;

  while (at > 0 && SPACE.test(text[at - 1])) at -= 1;

  return at < here && at >= 3 && text.slice(at - 3, at).toLowerCase() === "pay" ? withinSpaces(text.slice(0, at - 3)) : text;
}

/**
 * A character as the plain one a reader takes it for: ASCII as it is, in
 * lower case; another as the ASCII Unicode's table reads it as, where it
 * reads as that alone, so a Cyrillic о is an o, a К a k and a typographic
 * apostrophe a straight one; else as it is.
 *
 * @param {string} char
 */
function plainOf(char) {
  if (/^[\x20-\x7e]$/.test(char)) return char.toLowerCase();

  const shape = bare(nameSkeleton(char));

  return /^[\x21-\x7e]+$/.test(shape) ? shape : char;
}

/**
 * A word as a reader reads it, for the wallet's words and what a message
 * states to be told by: its styled letters as theirs, as `/names` reads them
 * (`lettersOf`: fullwidth, mathematical, small capitals), each character as the
 * plain one it looks like (`plainOf`), without the marks over them or what
 * can't be seen, in lower case: "DUSК" with a Cyrillic К is "dusk", and
 * "You're" with a zero-width space after it "you're". With where what can't
 * be seen was, between its characters, which an amount may not hold; and for
 * each of its characters, whether it's the one written, but for its style
 * (NFKC, as a fullwidth or a mathematical digit), not one it looks like, as
 * an Arabic-Indic zero is a point to Unicode's table, nor with a mark over it
 * (`written`), and whether
 * a digit of any script is written there (`digit`): an amount is read from
 * the digits written, never from what they look like.
 *
 * @param {string} word
 * @returns {{ text: string, unseen: number[], written: boolean[], digit: boolean[] }}
 */
function readAs(word) {
  let text = "";
  /** @type {number[]} */
  const unseen = [];
  /** @type {boolean[]} */
  const written = [];
  /** @type {boolean[]} */
  const digit = [];

  // Whether a mark came first, over nothing of the word's.
  let marked = false;

  for (const char of word) {
    if (UNSEEN.test(char)) {
      unseen.push(text.length);
      continue;
    }

    for (const each of lettersOf(char).normalize("NFD")) {
      // A mark is read past in words, but what it's over is no longer the character written: "0̣" is no 0.
      if (MARK.test(each)) {
        if (written.length) written[written.length - 1] = false;
        else marked = true;
        continue;
      }

      const plain = plainOf(each);

      text += plain;
      // Each of its UTF-16 units, as the text is read by them.
      for (let unit = 0; unit < plain.length; unit += 1) {
        written.push(plain === each && !marked);
        digit.push(DIGIT.test(char));
      }
      marked = false;
    }
  }

  return { digit, text, unseen, written };
}

/**
 * @typedef {{ words: string[], said: string[], unseen: number[][], written: boolean[][], digit: boolean[][] }} Line
 * A line's words as written, without the isolates that set right-to-left
 * words apart; as a reader reads them (`readAs`); where what can't be seen
 * is in each; and which of their characters are as written, and digits.
 */

/**
 * A line's words (`Line`), without those of nothing a reader sees.
 *
 * @param {string} text
 * @returns {Line}
 */
function lineOf(text) {
  /** @type {Line} */
  const line = { digit: [], said: [], unseen: [], words: [], written: [] };

  for (const word of text.normalize("NFC").split(SPACES)) {
    const read = readAs(word);

    if (!read.text.trim()) continue;

    line.words.push(word.replace(ISOLATES, ""));
    line.said.push(read.text);
    line.unseen.push(read.unseen);
    line.written.push(read.written);
    line.digit.push(read.digit);
  }

  return line;
}

// How many ways a line can be the wallet's own for its link: a name holding "asks you to pay … DUSK on …" makes
// one more each time it does. A line read in more ways than this is no line the wallet writes.
const READINGS = 4;
// How many words a known network's name has at most: "Testnet", "Chain 2". A longer one names no network known.
const NAMED_WORDS = Math.max(2, ...Object.values(networks).flatMap((net) => [net.label, net.name].map((name) => String(name).trim().split(/\s+/).length)));
// The known networks' names and labels, as a reader reads them: "mainnet", "testnet".
const NETWORK_NAMES = [...new Set(Object.values(networks).flatMap((net) => [net.label, net.name].map((name) => String(name).trim().toLowerCase().replace(/\s+/g, " "))))];

/**
 * Whether a line's words are a request's as both wallets share it, or are
 * worded as one, read in any of the ways they can be: "<name> asks you to
 * pay <amount> DUSK" or "<name> asks you for a payment in DUSK", "You're
 * asked …" or "You are asked …" without a name, or "Pay <amount> DUSK" or
 * "Please pay <amount> DUSK", then " on <network>" and " · <memo>" where it
 * says them, in any case and spacing, as a reader reads its words
 * (`readAs`). A name or a memo may hold any of those words: "Alice asks you
 * to pay asks you to pay 0.03 DUSK" is one, from a profile named "Alice asks
 * you to pay".
 *
 * @param {Line} line
 */
function isShaped({ said, words }) {
  const count = said.length;
  // What may follow what's asked: nothing, a network, or a memo.
  const ends = (/** @type {number} */ at) => at >= count || words[at] === "\u00b7" || (said[at] === "on" && at + 1 < count && words[at + 1] !== "\u00b7");
  // Whether a "DUSK" at or after a word ends what's asked, for each word.
  const duskFrom = Array.from({ length: count + 2 }, () => false);

  for (let at = count - 1; at >= 0; at -= 1) duskFrom[at] = duskFrom[at + 1] || (said[at] === "dusk" && ends(at + 1));

  /** @param {number} at */
  const asks = (at) => (said[at] === "to" && said[at + 1] === "pay" && duskFrom[at + 3]) || (["for", "a", "payment", "in", "dusk"].every((word, i) => said[at + i] === word) && ends(at + 5));
  /** @param {number} at */
  const pays = (at) => said[at] === "pay" && /\d/.test(said[at + 1] ?? "") && said[at + 2] === "dusk" && ends(at + 3);

  return (
    (YOURE.has(said[0]) && said[1] === "asked" && asks(2)) ||
    (said[0] === "you" && said[1] === "are" && said[2] === "asked" && asks(3)) ||
    said.some((word, at) => at > 0 && word === "asks" && said[at + 1] === "you" && asks(at + 2)) ||
    pays(0) ||
    (said[0] === "please" && pays(1))
  );
}

/**
 * @typedef {[number, number]} Span Where words are in a line: from the first, up to the last
 */

/**
 * The ways a line's words are the wallet's own line for a link, read from
 * its end: its memo as the line shows it, its last words; the network it's
 * paid on, by its name, or none, before; and its amount, or any amount,
 * before that. Each reading is where its name is, before "asks you", none
 * for "You're asked", "You are asked" and "Please pay", and where the
 * network's name is; none where no reading says what the link does, and
 * more than `READINGS` where it can be read in more ways than the wallet's
 * own line is.
 *
 * @param {Line} line
 * @param {PaymentLink} link
 * @param {string} paidOn The chain it's paid on, "dusk:2", or ""
 * @returns {{ name: Span, net: Span }[]}
 */
function readingsOf(line, link, paidOn) {
  const { said, words } = line;
  const shown = shownAs(displayText(link.memo, { isolate: true }).text);
  const memo = shown ? shown.split(" ") : [];
  const end = memo.length ? words.length - memo.length - 1 : words.length;

  if (end < 0 || (memo.length && (words[end] !== "\u00b7" || memo.some((word, i) => words[end + 1 + i] !== word)))) return [];

  const asked = askedOf(link);
  /** @type {{ name: Span, net: Span }[]} */
  const readings = [];

  // Where what's asked ends: at the memo, or before " on " and a network's name, of any length, with no " · " in it.
  for (let on = end; on >= 1; on -= 1) {
    if (on < end && words[on] === "\u00b7") break;
    if ((on < end && (said[on] !== "on" || on + 1 === end)) || said[on - 1] !== "dusk") continue;
    if (on < end && end - on - 1 <= NAMED_WORDS && otherNetwork(said.slice(on + 1, end).join(" "), paidOn)) continue;

    /** @type {Span} */
    const net = on < end ? [on + 1, end] : [end, end];
    /** @param {number} from Where "to pay" or "for a payment in" is */
    const heads = (from) => {
      if (from === 2 && YOURE.has(said[0]) && said[1] === "asked") readings.push({ name: [0, 0], net });
      if (from === 3 && said[0] === "you" && said[1] === "are" && said[2] === "asked") readings.push({ name: [0, 0], net });
      if (from >= 3 && said[from - 2] === "asks" && said[from - 1] === "you") readings.push({ name: [0, from - 2], net });
    };

    // Where its amount starts: groups of thousands parted by spaces are one amount, "1 234,5".
    let amount = on - 2;

    while (amount >= 1 && /^\d{1,3}$/.test(said[amount - 1]) && /^\d{3}(?:[.,]\d*)?$/.test(said[amount])) amount -= 1;

    // "to pay <amount> DUSK", "Pay <amount> DUSK" or "Please pay <amount> DUSK"; or "for a payment in DUSK", any amount.
    if (amount >= 1 && said[amount - 1] === "pay" && sameAmount(amountOf(line, amount, on - 1), asked)) {
      const pay = amount - 1;

      if (said[pay - 1] === "to") heads(pay - 1);
      if (pay === 0 || (pay === 1 && said[0] === "please")) readings.push({ name: [0, 0], net });
    }
    if (on >= 5 && ["for", "a", "payment", "in"].every((word, i) => said[on - 5 + i] === word) && asked.length === 0) heads(on - 5);
    if (readings.length > READINGS) return readings;
  }

  return readings;
}

/**
 * The amounts in lux a link asks: one, two where its amount could be either
 * (`amountsIn`), or none for any amount.
 *
 * @param {PaymentLink} link
 */
const askedOf = (link) => (PLAIN_LUX.test(link.amountLux) ? [BigInt(link.amountLux)] : link.amountDusk ? amountsIn(link.amountDusk) : []);

/**
 * The amounts in lux an amount as it's written can be: one, or two where a
 * lone point or comma could mark decimals or part thousands, as "1.000"
 * (`unclearAmount`); null for one that isn't a plain amount.
 *
 * @param {string} text
 * @returns {(bigint | null)[]}
 */
function amountsIn(text) {
  const plain = textOf(text);

  if (!PLAIN_AMOUNT.test(plain)) return [null];

  const either = unclearAmount(plain, ".");

  return either ? [parseDusk(either.grouped), parseDusk(either.decimal)] : [parseDusk(plain.replace(",", "."))];
}

/**
 * The amounts in lux an amount a message states can be, as `amountsIn` reads
 * it, and in groups of thousands, by a point, a comma, an apostrophe or a
 * space, its decimals after the other mark: "1,000.5", "1.000,5", "1'000",
 * "1 234,5"; null for one that's anything else.
 *
 * @param {string} text As a reader reads it (`readAs`)
 * @returns {(bigint | null)[]}
 */
function amountReadings(text) {
  if (PLAIN_AMOUNT.test(text)) return amountsIn(text);

  const grouped = /^([1-9]\d{0,2})(([,.' ])\d{3}(?:\3\d{3})*)(?:([.,])(\d*))?$/.exec(text);

  if (!grouped || grouped[4] === grouped[3]) return [null];

  return [parseDusk(`${grouped[1]}${grouped[2].split(grouped[3]).join("")}${grouped[4] ? `.${grouped[5]}` : ""}`)];
}

/**
 * The amounts words of a line can be, as one amount (`amountReadings`), its
 * groups parted by spaces: null for words that hold what can't be seen
 * between their characters, as marks or isolates set digits apart to show
 * them turned around, or a character that isn't the one written, as an
 * Arabic-Indic zero read as the point it looks like.
 *
 * @param {Line} line
 * @param {number} from
 * @param {number} to
 * @returns {(bigint | null)[]}
 */
function amountOf(line, from, to) {
  for (let at = from; at < to; at += 1) {
    if (line.unseen[at].some((place) => place > 0 && place < line.said[at].length) || !line.written[at].every(Boolean)) return [null];
  }

  return amountReadings(line.said.slice(from, to).join(" "));
}

/**
 * Whether two lists of amounts (`amountsIn`) say one and the same amount, or
 * both none.
 *
 * @param {(bigint | null)[]} a
 * @param {(bigint | null)[]} b
 */
const sameAmount = (a, b) => (a.length === 0 && b.length === 0) || (a.length === 1 && b.length === 1 && a[0] !== null && a[0] === b[0]);

// What's part of an amount as it's written, or of a word around it.
const NUMBERISH = /[\p{L}\p{N}.,']/u;
// What joins a word to the one before or after it, as in a name or an address.
const JOINED = /[\p{L}\p{N}_@/\\-]/u;

/**
 * Whether a word found in a reader's text stands alone, no part of another
 * word, a .dusk name or an address: "testnet" in "on testnet." does, in
 * "apps.testnet.dusk.network" it doesn't. A "dusk" may follow digits at
 * once: "0.002dusk".
 *
 * @param {string} plain
 * @param {number} start
 * @param {number} end
 * @param {boolean} [afterDigits]
 */
function alone(plain, start, end, afterDigits = false) {
  const before = plain[start - 1] ?? " ";
  const after = plain[end] ?? " ";

  return ((!JOINED.test(before) && before !== ".") || (afterDigits && /\d/.test(before))) && !JOINED.test(after) && !(after === "." && /[\p{L}\p{N}]/u.test(plain[end + 1] ?? " "));
}

/**
 * @typedef {{ amounts: (bigint | null)[][], chains: string[], dusk: string[] }} Stated
 * What words state: the amounts, each as it can be read (`amountReadings`),
 * the networks, by their chains, "2" for Testnet, and the .dusk names.
 */

/**
 * What a line's words state (`Stated`), as a reader reads them (`readAs`):
 * an amount before or after "DUSK", or after "pay", "send" or "transfer",
 * "me" or "us" between or not, as "0.002 DUSK" or "Pay 0.002", in groups of
 * thousands parted by spaces too, "1 234.5", where it starts with a digit of
 * any script, or beside "DUSK" is all letters a digit looks like, as "lO";
 * not a word that's a .dusk name, as "oliver2.dusk", nor one starting with
 * another letter, as "Li". Written with such letters, as "2OO", with digits
 * of another script, as "1٠5" with an Arabic-Indic zero, which looks like
 * a point, or with what can't be seen between its digits, it's one that
 * can't be read. A network by its name or label, as "Testnet", or "Chain
 * 2". And the .dusk names, as `nameDuskNames` of `/names` reads them:
 * "alice·dusk" is alice.dusk.
 *
 * @param {Line} line
 * @param {Span} span
 * @returns {Stated}
 */
function statedIn(line, [from, to]) {
  let plain = "";
  /** @type {number[]} */
  const unseen = [];
  /** @type {boolean[]} */
  const written = [];
  /** @type {boolean[]} */
  const digit = [];
  // Where each word starts in `plain`.
  /** @type {number[]} */
  const starts = [];

  for (let at = from; at < to; at += 1) {
    if (plain) {
      plain += " ";
      written.push(true);
      digit.push(false);
    }
    starts.push(plain.length);
    for (const place of line.unseen[at]) unseen.push(plain.length + place);
    plain += line.said[at];
    // One by one: a word may be longer than a call takes arguments.
    for (const each of line.written[at]) written.push(each);
    for (const each of line.digit[at]) digit.push(each);
  }

  /** @type {Stated} */
  const stated = { amounts: [], chains: [], dusk: nameDuskNames(line.words.slice(from, to).join(" ")) };

  /**
   * An amount found at a place, with its groups of thousands parted by
   * spaces either side of it: before, a group of one to three digits, no part
   * of a word, before one of three; after, groups of three, the last with
   * its decimals.
   *
   * @param {number} start
   * @param {number} end
   * @returns {[number, number]}
   */
  const grouped = (start, end) => {
    let first = start;
    let last = end;

    while (/^\d{3}(?!\d)/.test(plain.slice(first, last)) && plain[first - 1] === " ") {
      let at = first - 1;

      while (at > 0 && /\d/.test(plain[at - 1])) at -= 1;
      if (first - 1 - at < 1 || first - 1 - at > 3 || (at > 0 && NUMBERISH.test(plain[at - 1]))) break;
      first = at;
    }

    while (/^\d{1,3}(?: \d{3})*$/.test(plain.slice(first, last)) && plain[last] === " ") {
      let at = last + 1;

      while (at < plain.length && NUMBERISH.test(plain[at])) at += 1;
      if (!/^\d{3}(?:[.,]\d+)?[.,']*$/.test(plain.slice(last + 1, at))) break;
      last = at;
    }

    return [first, last];
  };

  /**
   * The amount at a place, if it's one: a word that's a .dusk name is none, and so is one that doesn't start with
   * a digit, but beside "DUSK" one all of letters a digit looks like (`letters`).
   *
   * @param {number} start
   * @param {number} end
   * @param {boolean} [letters]
   */
  const amountAt = (start, end, letters = false) => {
    const [first, stop] = grouped(start, end);
    let last = stop;
    let word = stop;

    // Without the point or comma after it that ends a sentence.
    while (last > first && /[.,']/.test(plain[last - 1]) && !digit[last - 1]) last -= 1;
    while (word < plain.length && plain[word] !== " ") word += 1;
    if (/[^\p{L}\p{N}]dusk$/u.test(plain.slice(first, word).replace(/\p{P}+$/u, ""))) return;

    let lead = first;

    while (lead < last && /[.,']/.test(plain[lead]) && !digit[lead]) lead += 1;

    const places = Array.from({ length: last - first }, (_, i) => first + i);
    const numeric = lead < last && (digit[lead] || /\d/.test(plain[lead]) || (letters && /[oil]/.test(plain[lead]) && places.every((at) => digit[at] || /[0-9oil.,' ]/.test(plain[at]))));

    if (!numeric) return;

    const text = plain.slice(first, last);
    const readable = !unseen.some((place) => place > first && place < last) && places.every((at) => written[at]) && /^[0-9.,' ]+$/.test(text);

    stated.amounts.push(readable ? amountReadings(text) : [null]);
  };

  for (const { 0: word, index } of plain.matchAll(/t?dusk/g)) {
    if (!alone(plain, index, index + word.length, true)) continue;

    let end = index;
    let start = index + word.length;

    while (end > 0 && plain[end - 1] === " ") end -= 1;
    while (start < plain.length && /[ :=]/.test(plain[start])) start += 1;

    let first = end;
    let last = start;

    while (first > 0 && NUMBERISH.test(plain[first - 1])) first -= 1;
    while (last < plain.length && NUMBERISH.test(plain[last])) last += 1;

    amountAt(first, end, true);
    amountAt(start, last, true);
  }

  for (const { 0: words, index } of plain.matchAll(/(?:pay|send|transfer)(?: (?:me|us))? +/g)) {
    if (index > 0 && JOINED.test(plain[index - 1])) continue;

    const start = index + words.length;
    let last = start;

    while (last < plain.length && NUMBERISH.test(plain[last])) last += 1;

    amountAt(start, last);
  }

  /**
   * Whether a network's name at a place in `plain` is a label of a .dusk name, as `nameDuskNames` of `/names`
   * reads them, with a point of any kind, or spaces around one: "testnet·dusk" names no network. It is where the
   * words around it give a .dusk name with that label that they don't give with another word in its place.
   *
   * @param {number} place
   * @param {string} label
   */
  const inName = (place, label) => {
    let at = starts.length - 1;

    while (at > 0 && starts[at] > place) at -= 1;

    const word = from + at;
    const around = line.words.slice(Math.max(from, word - 2), Math.min(to, word + 3));
    const mine = word - Math.max(from, word - 2);
    /** @param {string[]} words */
    const named = (words) => nameDuskNames(words.join(" ")).filter((name) => name.split(".").slice(0, -1).includes(label));
    const there = named(around);

    if (!there.length) return false;

    const elsewhere = named(around.map((each, i) => (i === mine ? "x" : each)));

    return there.some((name) => !elsewhere.includes(name));
  };

  for (const name of NETWORK_NAMES) {
    for (let at = plain.indexOf(name); at >= 0; at = plain.indexOf(name, at + 1)) {
      if (alone(plain, at, at + name.length) && !inName(at, name)) stated.chains.push(chainNamed(name));
    }
  }

  for (const { 0: words, 1: chain, index } of plain.matchAll(/chain (0|[1-9]\d{0,31})/g)) if (alone(plain, index, index + words.length)) stated.chains.push(chain);

  return stated;
}

/**
 * Whether what words state (`Stated`) agrees with a link: each amount the
 * one it asks, and none where it asks any, and each network the one it's
 * paid on, where that's known.
 *
 * @param {Stated} stated
 * @param {(bigint | null)[]} asked `askedOf` the link
 * @param {string} paidOn The chain it's paid on, "dusk:2", or ""
 */
function statedAgrees({ amounts, chains }, asked, paidOn) {
  const chain = referenceOf(paidOn);

  return amounts.every((amount) => sameAmount(amount, asked)) && chains.every((each) => chain === "" || each === chain);
}

/**
 * Text as a line of a shared request shows it, for comparing: in NFC,
 * without the isolates that set right-to-left words apart, its spaces as one.
 *
 * @param {string} text
 */
const shownAs = (text) => text.normalize("NFC").replace(ISOLATES, "").replace(/[\s\u0085]+/g, " ").trim();

/**
 * The chain a network's name in a line names, "2" for "Testnet", by a
 * network's own name or label, "Local" or "Chain 2", in any case; "" for a
 * name of no network known, as a node's.
 *
 * @param {string} said
 */
function chainNamed(said) {
  const named = said.trim().toLowerCase();
  const net = Object.values(networks).find((each) => each.label.toLowerCase() === named || each.name.toLowerCase() === named);

  return net ? String(net.chainId) : named === "local" ? "0" : (/^chain (0|[1-9]\d{0,31})$/.exec(named)?.[1] ?? "");
}

/**
 * Whether a line names another network than the one it's paid on: the
 * link's, or for a link that names none, the wallet's, by which network it
 * is, not what it's called: "Chain 2" is Testnet. A name of no network
 * known says nothing, and nor does a network not known to be paid on.
 *
 * @param {string} said
 * @param {string} chainId Where it's paid, "dusk:2"
 */
function otherNetwork(said, chainId) {
  const named = chainNamed(said);
  const paidOn = referenceOf(chainId);

  return named !== "" && paidOn !== "" && named !== paidOn;
}

/**
 * @typedef {{ free: string[], lines: { name: string, dusk: string[] }[][] }} Said
 * What a message's words say of who asks, where nothing else they say is
 * another than its link: the .dusk names of the words that aren't a
 * request's line, and for each request's line, each reading that agrees
 * with the link, its name and its .dusk names.
 */

/**
 * What the words before a link in pasted text say (`Said`), read whole, line
 * by line, as a reader reads them (`readAs`): null where they turn what's
 * shown around (`TURNED`), or say another amount or network than the link
 * (`statedIn`) anywhere; where a line is worded as a request's (`isShaped`),
 * where it isn't the wallet's own for the link in any reading
 * (`readingsOf`), its name and network's name saying nothing else than the
 * link either, or is in more readings than `READINGS`.
 *
 * @param {string} before
 * @param {PaymentLink} link
 * @param {string} paidOn The chain it's paid on, "dusk:2", or ""
 * @returns {Said | null}
 */
function messageSays(before, link, paidOn) {
  if (TURNED.test(before)) return null;

  const asked = askedOf(link);
  /** @type {Said} */
  const said = { free: [], lines: [] };

  for (const text of withoutPayHere(withinSpaces(before)).split(LINES)) {
    const line = lineOf(text);

    if (!line.words.length) continue;

    if (!isShaped(line)) {
      const stated = statedIn(line, [0, line.words.length]);

      if (!statedAgrees(stated, asked, paidOn)) return null;

      for (const dusk of stated.dusk) said.free.push(dusk);
      continue;
    }

    const readings = readingsOf(line, link, paidOn);

    if (readings.length > READINGS) return null;

    /** @type {{ name: string, dusk: string[] }[]} */
    const agreeing = [];

    for (const { name, net } of readings) {
      const stated = [statedIn(line, name), statedIn(line, net)];

      if (stated.every((each) => statedAgrees(each, asked, paidOn))) agreeing.push({ dusk: [...new Set(stated.flatMap((each) => each.dusk))], name: line.words.slice(...name).join(" ") });
    }

    if (!agreeing.length) return null;

    said.lines.push(agreeing);
  }

  return said;
}

/**
 * Whether a request's line names another than its link's label, as written
 * or in any case, spacing or accents (`sameName` of `/names`): a name
 * that's none, or a link with none, says nothing.
 *
 * @param {string} name
 * @param {PaymentLink} link
 */
function otherLabel(name, link) {
  const said = shownAs(name);
  const label = shownAs(displayText(link.label, { isolate: true }).text);

  // As written, though it has no letters or digits to compare, as an emoji's; else as the look-alike rules read it.
  return Boolean(said && label && said !== label && !sameName(said, label));
}

/**
 * Whether a .dusk name a message gives is its link's recipient's: the .dusk
 * name it pays; for an account or a shielded address it pays, as the name
 * service says whose the name is (`owners`): not another account's or
 * address's of that kind, nor no one's. A name not looked up, as one whose
 * lookup failed, is held to the link's label, where it has one, and says
 * nothing where it hasn't; nor does one with no account or address of the
 * link's kind.
 *
 * @param {string} dusk
 * @param {PaymentLink} link
 * @param {unknown} owners
 */
function nameAgrees(dusk, link, owners) {
  if (DUSK_NAME.test(link.to)) return dusk === link.to.toLowerCase();

  const owner = ownerOf(owners, dusk);

  if (owner === undefined) return !link.label || nameDuskNames(link.label).includes(dusk);
  if (owner === null) return false;

  const kind = recipientKind(link.to);
  // What it resolves to of the link's recipient's kind: a shielded address for a shielded one.
  const same = [...owner].filter((id) => recipientKind(id) === kind);

  return same.length === 0 || same.includes(link.to);
}

/**
 * The link pasted text's words are checked against: the one it fills in, or
 * one for another network, which the wallet of that network would; null for
 * one the link alone refuses.
 *
 * @param {LinkRead | null} read
 * @param {string} text The link
 * @param {string | undefined} walletUrl
 */
const linkSaid = (read, text, walletUrl) => read?.link ?? (read?.reason === "other-network" ? parsePaymentLink(text, { walletUrl }) : null);

// How long the words before a link may be: far longer than any message the wallets write, a memo's 512 bytes
// shown as their codes among it. Longer words aren't read, and agree with no link.
const MAX_MESSAGE = 8192;

/**
 * What pasted text's words before its link say, as `messageSays` reads them
 * against the link they're checked against (`linkSaid`): null for words
 * longer than any message the wallets write (`MAX_MESSAGE`), which agree
 * with no link; undefined for text with no link to check, or no words
 * before it.
 *
 * @param {{ before: string, link: string }} parts
 * @param {LinkRead | null} read
 * @param {{ network?: unknown, walletUrl?: string }} options
 */
function pastedSays(parts, read, { network, walletUrl }) {
  const link = linkSaid(read, parts.link, walletUrl);

  if (!link || !parts.before) return undefined;

  return { link, said: parts.before.length > MAX_MESSAGE ? null : messageSays(parts.before, link, link.chainId || chainIdOf(network)) };
}

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string, owners?: unknown }} [options]
 * @returns {PastedLinkRead | null}
 */
export function readPastedLink(input, { network, owners, walletUrl } = {}) {
  const parts = pastedParts(input, { walletUrl });

  if (!parts || "refused" in parts) return parts?.refused ?? null;

  const read = readPaymentLink(parts.link, { network, walletUrl });
  // What the link alone refuses, it refuses as the link alone says it; one that can be paid, here or on its own
  // network's wallet, only where the words before it state no other amount, network or .dusk name, and a request's
  // line among them is the wallet's own for it.
  const says = pastedSays(parts, read, { network, walletUrl });
  const agrees = (/** @type {string} */ dusk) => !says || nameAgrees(dusk, says.link, owners);
  const disagrees =
    says && (says.said === null || !says.said.free.every(agrees) || !says.said.lines.every((readings) => readings.some(({ dusk, name }) => !otherLabel(name, says.link) && dusk.every(agrees))));

  return disagrees ? pasteRefused(LINK_DISAGREES, "disagrees") : readFrom(read, parts.link);
}

/**
 * @param {unknown} input
 * @param {{ network?: unknown, walletUrl?: string }} [options]
 * @returns {string[]}
 */
export function pastedDuskNames(input, { network, walletUrl } = {}) {
  const parts = pastedParts(input, { walletUrl });

  if (!parts || "refused" in parts) return [];

  const said = pastedSays(parts, readPaymentLink(parts.link, { network, walletUrl }), { network, walletUrl })?.said;

  return said ? [...new Set([...said.free, ...said.lines.flat().flatMap(({ dusk }) => dusk)])] : [];
}

/**
 * @param {PaymentLink | null | undefined} link
 * @param {string} [language] The browser's, unless given
 * @returns {{ field: string } & import("./amounts.js").AmountRead}
 */
export function linkAmount(link, language) {
  const decimal = decimalSeparator(language);
  // As Send's field holds it once filled in from the link, and reads it back, as typing reads it: an amount in DUSK as
  // the link writes it, its point the language's mark, so "2.125" asks as typed 2.125 does; an exact one in lux as
  // the amount it is, which a fourth decimal keeps from asking.
  const field = !link?.amountDusk ? "" : PLAIN_LUX.test(textOf(link.amountLux)) ? amountForField(link.amountDusk, decimal) : link.amountDusk.replace(".", decimal);

  return { field, ...readAmount(field, language) };
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
  // A link's memo is one line, as Send reads one (`readPaymentLink`).
  else if (LINE_BREAK.test(message)) problems.memo = "Write the memo on one line.";

  if (Object.keys(problems).length) return { dusk: "", https: null, lux: read.lux, ok: false, problems };

  /** @type {[string, string][]} */
  const asked = [
    // Read as typing reads it, as Send reads a link's: three decimals have a fourth, a zero, so 2.125 isn't asked about.
    ["amount", read.lux === null ? "" : amountForField(formatDuskPlain(read.lux), ".")],
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

/**
 * @param {{ link: string, name?: string | null, lux?: bigint | number | string | null, memo?: string | null, network?: string | null, language?: string }} request
 * @returns {string}
 */
export function requestMessage({ language, link, lux, memo, name, network }) {
  const amount = typeof lux === "bigint" || (typeof lux === "number" && Number.isSafeInteger(lux)) || (typeof lux === "string" && /^\d+$/.test(lux.trim())) ? BigInt(typeof lux === "string" ? lux.trim() : lux) : null;
  // As a field writes it, which every reader reads as that amount: no groups, and three decimals with a fourth, a zero.
  const asked = amount !== null && amount > 0n ? `${amountForField(formatDuskPlain(amount), decimalSeparator(language))} DUSK` : "";
  // Right-to-left words set apart, and what can't be seen as its codes, as on a screen.
  const who = displayText(textOf(name), { isolate: true }).text;
  const on = textOf(network) ? ` on ${textOf(network)}` : "";
  const asks = who ? (asked ? `${who} asks you to pay ${asked}` : `${who} asks you for a payment in DUSK`) : asked ? `You're asked to pay ${asked}` : "You're asked for a payment in DUSK";
  const words = textOf(memo) ? ` · ${displayText(textOf(memo), { isolate: true }).text}` : "";

  return `${asks}${on}${words}\nPay here: ${textOf(link)}`;
}
