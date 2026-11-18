import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { networks } from "@dusk-network/networks";

import { activityRows } from "../src/activity.js";
import { amountForField, parseDusk, normalizeAmount, decimalSeparator, readAmount } from "../src/amounts.js";
import { LINK_BAD_ADDRESS, LINK_BAD_AMOUNT, LINK_DISAGREES, LINK_SEVERAL, LINK_TWO_AMOUNTS, LINK_UNCLEAR, LINK_UNREADABLE, MAX_MEMO_BYTES, chainLabel, linkAmount, makePaymentLink, networkMismatch, parsePaymentLink, pastedDuskNames, readPastedLink, readPaymentLink, recipientKind, requestMessage } from "../src/payment-links.js";
import { A, B, recorded } from "./fixtures/activity.js";
import { like } from "./fixtures/helpers.js";

/**
 * What Send's field holds of a link's amount and what it says of it, without the readings to choose from.
 *
 * @param {{ field: string, lux: bigint | null, problem: string | null }} read
 */
const said = ({ field, lux, problem }) => ({ field, lux, problem });

// A real shielded address, as a shield of the recording names it.
const SHIELDED = /** @type {string} */ (activityRows({ public: [recorded(B, 2517213)], account: B, network: 2 })[0].counterparty);

describe("an amount given in lux", () => {
  it("refuses a number that has already lost its last digits", () => {
    const made = makePaymentLink({ amountLux: 18_100_000_000_000_008, network: "mainnet", to: "public-abc" });

    assert.equal(made.ok, false);
    assert.equal(made.problems.amount, "That amount is too large.");
    assert.ok(makePaymentLink({ amountLux: 18_100_000_000_000_008n, network: "mainnet", to: "public-abc" }).lux === 18_100_000_000_000_008n);
  });
});

describe("a dusk: link, as wallets have read them", () => {
  it("reads a public link", () => {
    like(parsePaymentLink("dusk:public-abc123"), { amountDusk: "", chainId: "", form: "dusk", kind: "public", memo: "", to: "abc123" });
  });

  it("reads a shielded link", () => {
    like(parsePaymentLink("dusk:shielded-xyz789"), { kind: "shielded", to: "xyz789" });
  });

  it("reads its chain, and refuses one that isn't", () => {
    like(parsePaymentLink("dusk:public-abc@dusk:2"), { chainId: "dusk:2", kind: "public", to: "abc" });
    assert.equal(parsePaymentLink("dusk:public-abc@dusk:abc"), null);
    assert.equal(parsePaymentLink("dusk:public-abc@eip155:1"), null);
  });

  it("reads the network its query names, as an https link's, and refuses one naming two", () => {
    for (const named of ["testnet", "Testnet", "dusk:2", "2"]) {
      like(parsePaymentLink(`dusk:public-abc?amount=0.001&network=${named}`), { chainId: "dusk:2", form: "dusk", to: "abc" }, named);
    }

    like(parsePaymentLink("dusk:public-abc@dusk:2?network=testnet"), { chainId: "dusk:2" });
    assert.equal(parsePaymentLink("dusk:public-abc@dusk:1?network=testnet"), null);
    assert.equal(parsePaymentLink("dusk:public-abc?network=nowhere"), null);
  });

  it("reads its query", () => {
    like(parsePaymentLink("dusk:public-abc?amount=1.5&memo=Hello&label=Alice"), { amountDusk: "1.5", label: "Alice", lux: 1_500_000_000n, memo: "Hello", to: "abc" });
    like(parsePaymentLink("dusk:public-abc?memo=Payment+for+coffee"), { memo: "Payment for coffee" });
  });

  it("reads an exact amount in lux, which decides what the link asks", () => {
    like(parsePaymentLink("dusk:public-abc?amountLux=1500000000"), { amountDusk: "1.5", amountLux: "1500000000", lux: 1_500_000_000n });
    like(parsePaymentLink("dusk:public-abc?amount=99&amountLux=1500000000"), { amountDusk: "1.5", lux: 1_500_000_000n });
    like(parsePaymentLink("dusk:public-abc?amountLux=abc"), { amountDusk: "abc", lux: null });
  });

  it("takes a recipient as it is", () => {
    like(parsePaymentLink("someBase58Address"), { form: "raw", kind: "unknown", raw: "someBase58Address", to: "someBase58Address" });
    like(parsePaymentLink(`  ${A}\n`), { form: "raw", kind: "unknown", to: A });
  });

  it("reads nothing as nothing, and no other dusk: link", () => {
    assert.equal(parsePaymentLink(""), null);
    assert.equal(parsePaymentLink(null), null);
    assert.equal(parsePaymentLink("dusk:invalid-format"), null);
    assert.equal(parsePaymentLink("dusk:"), null);
    assert.equal(parsePaymentLink("dusk:public-"), null);
  });

  it("reads the scheme and the kind in any case, and with // after the scheme", () => {
    like(parsePaymentLink("DUSK:public-abc123"), { kind: "public", to: "abc123" });
    like(parsePaymentLink("dusk:PUBLIC-abc123"), { kind: "public", to: "abc123" });
    like(parsePaymentLink("dusk://public-abc123"), { to: "abc123" });
  });

  it("decodes a recipient, and keeps one that isn't encoded as it is", () => {
    like(parsePaymentLink("dusk:public-abc%2Fdef"), { to: "abc/def" });
    like(parsePaymentLink("dusk:public-%E0%A4"), { kind: "public", to: "%E0%A4" });
  });

  it("reads a plain dusk:<address> link, Sofia's, by its address alone: an account or a shielded address, as written", () => {
    like(parsePaymentLink(`dusk:${A}?amount=0.03&memo=Invoice%202026-114`), { amountDusk: "0.03", chainId: "", form: "dusk", kind: "public", lux: 30_000_000n, memo: "Invoice 2026-114", to: A });
    like(parsePaymentLink(`dusk://${A}?amount=0,01`), { amountDusk: "0,01", kind: "public", to: A });
    like(parsePaymentLink(`dusk:${SHIELDED}`), { kind: "shielded", to: SHIELDED });
    // Its network as the other shape's.
    like(parsePaymentLink(`dusk:${A}?amount=0.03&network=testnet`), { chainId: "dusk:2", to: A });
    like(parsePaymentLink(`dusk:${A}@dusk:1`), { chainId: "dusk:1", to: A });
    assert.equal(parsePaymentLink(`dusk:${A}@dusk:1?network=testnet`), null);
    // Nothing else is read as an address: no guessing at what a link means.
    for (const other of [`dusk:send?to=${A}`, `dusk:public:${A}`, `dusk:pay?to=${A}&amount=1`, "dusk:test", `dusk:${A}x`, `dusk:${encodeURIComponent(` ${A}`)}`]) {
      assert.equal(parsePaymentLink(other), null, other);
    }
  });
});

describe("a link to the web wallet's Send", () => {
  it("is on each network's own wallet, and says which network it's for", () => {
    for (const [name, chain] of /** @type {const} */ ([["mainnet", 1], ["testnet", 2], ["devnet", 3]])) {
      const { https } = makePaymentLink({ amount: "1.5", memo: "Factura 33", network: chain, to: A, language: "en-GB" });

      assert.equal(https, `${networks[name].apps.wallet}/dashboard/send?to=${A}&amount=1.5&memo=Factura+33&network=${name}`);
    }
  });

  it("reads as what it was made from, by the same function as a dusk: link", () => {
    const made = makePaymentLink({ amount: "0,15", label: "Estudio", memo: "Factura 33", network: 1, to: A, language: "es-ES" });
    const expected = { amountDusk: "0.15", chainId: "dusk:1", kind: "public", label: "Estudio", lux: 150_000_000n, memo: "Factura 33", to: A };

    like(parsePaymentLink(made.https), { ...expected, form: "https" });
    like(parsePaymentLink(made.dusk), { ...expected, form: "dusk" });
    // It fills the payer's amount field, in the payer's language.
    assert.equal(amountForField(/** @type {any} */ (parsePaymentLink(made.https)).amountDusk, ","), "0,15");
    assert.equal(parseDusk(normalizeAmount("0,15", ",")), 150_000_000n);
  });

  it("carries a memo through email and chat, whatever's on its line", () => {
    for (const memo of ["Factura 33, \"abril\" & mayo", "a+b=c?d#e%f", "Línea 1 · Línea 2", "€ 12,50 🧾", "ends with a dot.", "gnp.exe \u202E"]) {
      const made = makePaymentLink({ memo, network: 1, to: A });
      const link = /** @type {string} */ (made.https);

      // One unbroken link, which no mail or chat client ends early.
      assert.doesNotMatch(link, /[\s"<>]/, memo);
      assert.match(link, /&network=mainnet$/, memo);
      assert.equal(/** @type {any} */ (parsePaymentLink(link)).memo, memo.trim(), memo);
      assert.equal(/** @type {any} */ (parsePaymentLink(made.dusk)).memo, memo.trim(), memo);
    }
  });

  it("reads a link whose network its wallet's address says, and refuses one saying two", () => {
    const wallet = networks.testnet.apps.wallet;

    like(parsePaymentLink(`${wallet}/dashboard/send?to=${A}`), { chainId: "dusk:2", form: "https", kind: "public", to: A });
    like(parsePaymentLink(`${wallet}/dashboard/send/?to=${A}&network=testnet`), { chainId: "dusk:2" });
    like(parsePaymentLink(`HTTPS://APPS.TESTNET.DUSK.NETWORK/wallet/dashboard/send?to=${A}`), { chainId: "dusk:2", form: "https" });
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=mainnet`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=dusk:1`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?to=${A}&network=nowhere`), null);
    assert.equal(parsePaymentLink(`${wallet}/dashboard/send?amount=1`), null);
  });

  it("reads no one else's page as one: it stays a recipient, which Send refuses", () => {
    for (const elsewhere of [
      `https://evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network.evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network@evil.example/wallet/dashboard/send?to=${A}&amount=1`,
      `https://apps.dusk.network/elsewhere?to=${A}&amount=1`,
      `http://apps.dusk.network/wallet/dashboard/send?to=${A}&amount=1`,
    ]) {
      like(parsePaymentLink(elsewhere), { form: "raw", kind: "unknown", lux: null, memo: "", to: elsewhere }, elsewhere);
      assert.ok(makePaymentLink({ to: elsewhere }).problems.to, elsewhere);
    }
  });

  it("reads the app's own address where it's told it, and makes a link for it", () => {
    const walletUrl = "http://localhost:5173/";
    const made = makePaymentLink({ amount: "2", language: "en-GB", network: "testnet", to: A, walletUrl });

    assert.equal(made.https, `http://localhost:5173/dashboard/send?to=${A}&amount=2&network=testnet`);
    like(parsePaymentLink(made.https, { walletUrl }), { chainId: "dusk:2", form: "https", lux: 2_000_000_000n, to: A });
    assert.equal(/** @type {any} */ (parsePaymentLink(made.https)).form, "raw");
  });

  it("has no https link without a wallet to open or a network to name, though a dusk: link is made", () => {
    const local = makePaymentLink({ network: "dusk:0", to: A });

    assert.equal(local.https, null);
    assert.equal(local.dusk, `dusk:public-${A}@dusk:0`);
    assert.equal(makePaymentLink({ to: A, walletUrl: "https://wallet.example" }).https, null);
    like(makePaymentLink({ to: A }), { dusk: `dusk:public-${A}`, https: null, ok: true });
    // A custom node's chain, with the wallet's address given, is named as it is.
    const custom = makePaymentLink({ network: "dusk:3735928559", to: A, walletUrl: "https://wallet.example" });

    assert.equal(custom.https, `https://wallet.example/dashboard/send?to=${A}&network=dusk%3A3735928559`);
    like(parsePaymentLink(custom.https, { walletUrl: "https://wallet.example" }), { chainId: "dusk:3735928559", form: "https" });
  });
});

describe("a link as Send reads it, pasted, scanned or opened", () => {
  const testnetSend = `${networks.testnet.apps.wallet}/dashboard/send`;
  const mainnetSend = `${networks.mainnet.apps.wallet}/dashboard/send`;

  it("says at once that a request is for another network, the same as a QR code's dusk: link as pasted", () => {
    // Nandini's and Chen's: a mainnet request, on testnet.
    const made = makePaymentLink({ amount: "0.0013", language: "en-GB", memo: "Order 1044", network: 1, to: A });
    const refused = { chainId: "dusk:1", link: null, network: "Mainnet", problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network" };

    assert.deepEqual(readPaymentLink(made.https, { network: 2 }), refused);
    assert.deepEqual(readPaymentLink(made.dusk, { network: "testnet" }), refused);
  });

  it("fills in a request for the wallet's network, and says which that is", () => {
    const made = makePaymentLink({ amount: "0.0013", language: "en-GB", memo: "Order 1044", network: 2, to: A });
    const read = /** @type {any} */ (readPaymentLink(made.https, { network: networks.testnet }));

    like(read, { chainId: "dusk:2", network: "Testnet", problem: "", reason: "" });
    assert.deepEqual(read.link, parsePaymentLink(made.https));
    like(readPaymentLink(made.dusk, { network: 2 })?.link, { amountDusk: "0.0013", form: "dusk", memo: "Order 1044", to: A });
    // A dusk: link that names no network fills in on any.
    like(readPaymentLink(`dusk:public-${A}?amount=1`, { network: 1 }), { chainId: "", network: "", reason: "" });
  });

  it("refuses a link that says a field twice, saying which: it could be read two ways", () => {
    // Marek's, and Sofia's: the same amount twice, and the memo twice.
    for (const [twice, what] of [
      [`to=${A}&amount=0.001&network=testnet&network=mainnet`, "the network"],
      [`to=${A}&to=${B}&amount=0.001`, "the recipient"],
      [`to=${A}&memo=One&memo=Two`, "the memo"],
      [`to=${A}&label=A&label=B`, "the label"],
      [`to=${A}&amount=0.001&amount=0.001`, "the amount"],
      [`to=${A}&amountLux=1000000&amountLux=1000000`, "the amount"],
    ]) {
      const link = `${testnetSend}?${twice}`;

      assert.equal(parsePaymentLink(link), null, twice);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: `This link says ${what} twice. Ask for a new one.`, reason: "unreadable" }, twice);
    }

    assert.equal(parsePaymentLink(`dusk:public-${A}?memo=One&memo=Two`), null);
    like(readPaymentLink(`dusk:public-${A}?memo=One&memo=Two`, { network: 2 }), { problem: "This link says the memo twice. Ask for a new one.", reason: "unreadable" });
  });

  it("refuses a field said twice in two cases, in every shape: Marek's To= beside to=, and Amount= beside amount=", () => {
    // Each was filled in with the field in its own case, the other dropped without a word: a reader that
    // ignores case would have paid the other recipient, or 0.15.
    for (const [twice, problem] of [
      [`To=${B}&to=${A}&amount=0.001`, "This link says the recipient twice. Ask for a new one."],
      [`to=${A}&TO=${B}`, "This link says the recipient twice. Ask for a new one."],
      [`to=${A}&amount=0.001&Amount=0.15`, LINK_TWO_AMOUNTS],
      [`to=${A}&amount=0.001&amountlux=150000000`, LINK_TWO_AMOUNTS],
      [`to=${A}&amount=0.001&AMOUNT=0.001`, "This link says the amount twice. Ask for a new one."],
      [`to=${A}&memo=One&Memo=One`, "This link says the memo twice. Ask for a new one."],
      [`to=${A}&label=A&LABEL=B`, "This link says the label twice. Ask for a new one."],
      // A Kelvin sign is a K in lower case, as any reader that ignores case reads it.
      [`to=${A}&network=testnet&NETWOR%E2%84%AA=mainnet`, "This link says the network twice. Ask for a new one."],
    ]) {
      const link = `${testnetSend}?${twice}`;
      const reason = problem === LINK_TWO_AMOUNTS ? "two-amounts" : "unreadable";

      if (reason === "unreadable") assert.equal(parsePaymentLink(link), null, twice);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem, reason }, twice);
    }

    for (const [link, problem] of [
      [`dusk:public-${A}?To=${B}`, "This link says the recipient twice. Ask for a new one."],
      [`dusk:${A}?amount=0.001&Amount=0.15`, LINK_TWO_AMOUNTS],
      [`dusk:${A}?amount=0.001&AMOUNTLUX=150000000`, LINK_TWO_AMOUNTS],
      [`dusk:shielded-${SHIELDED}?memo=One&MEMO=Two`, "This link says the memo twice. Ask for a new one."],
      [`dusk://public-${A}@dusk:2?network=testnet&Network=testnet`, "This link says the network twice. Ask for a new one."],
    ]) {
      like(readPaymentLink(link, { network: 2 }), { link: null, problem }, link);
    }

    // Said once, in any case, it's that field: nothing a link says is dropped.
    like(readPaymentLink(`${testnetSend}?To=${A}&Amount=0.15&MEMO=Factura+33`, { network: 2 })?.link, { amountDusk: "0.15", lux: 150_000_000n, memo: "Factura 33", to: A });
    like(readPaymentLink(`dusk:${A}?AmountLux=1500000000&Network=testnet`, { network: 2 })?.link, { chainId: "dusk:2", lux: 1_500_000_000n });
    like(readPaymentLink(`${testnetSend}?to=${A}&Network=mainnet`, { network: 2 }), { link: null, problem: "This link names two networks, Testnet and Mainnet. Ask for a new one." });
  });

  it("refuses a link whose recipient is no address, as the web wallet does: a second address in it, a line break, a hidden character", () => {
    // Marek's: the extension filled these into To, under "Filled in from the link", one backspace from paying.
    const badAddress = { link: null, problem: "This link's address isn't valid. Ask for a new one.", reason: "unreadable" };

    for (const to of [
      `${A},${B}`,
      `${A}%2C${B}`,
      `${A}%20${B}`,
      `${A}+${B}`,
      `${A};${B}`,
      `${A}%00`,
      `${A.slice(0, 40)}%0A${A.slice(40)}`,
      `${A.slice(0, 40)}%0D${A.slice(40)}`,
      `${A.slice(0, 40)}%E2%80%AE${A.slice(40)}`,
      `${A}%E2%80%8B`,
      `${A}%EF%B8%8F`,
      A.slice(0, -6),
      "1".repeat(96),
      "Wendy",
      "ali%E2%80%8Bce.dusk",
      "alice.dusk%0Abob.dusk",
    ]) {
      const link = `${testnetSend}?to=${to}&amount=0.001&network=testnet`;

      like(readPaymentLink(link, { network: 2 }), { ...badAddress, chainId: "dusk:2" }, to);
      // On any network: what can't be paid anywhere says so before which network it's for.
      like(readPaymentLink(link, { network: 1 }), badAddress, to);
      like(readPaymentLink(link), badAddress, to);
    }

    like(readPaymentLink(`dusk:public-${A}%2C${B}?amount=0.001`, { network: 2 }), badAddress);
    like(readPaymentLink(`dusk:shielded-${SHIELDED}%E2%80%8B`, { network: 2 }), badAddress);

    // What Send takes, or says more of: an account, a shielded address, a .dusk name and an EVM address; the
    // ends' spaces and line breaks aren't the address's.
    for (const to of [A, SHIELDED, "alice.dusk", "Shop-2.Alice.dusk", "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F", `%0A${A}%20`]) {
      like(readPaymentLink(`${testnetSend}?to=${to}&amount=0.001`, { network: 2 }), { problem: "", reason: "" }, to);
    }

    // Read as a link, its form alone, it still is one: Send's reading is the one that refuses.
    like(parsePaymentLink(`${testnetSend}?to=${A},${B}`), { form: "https", to: `${A},${B}` });
  });

  it("refuses an amount that isn't a plain number once decoded: Marek's %23 and hidden characters, and anything else", () => {
    // Marek's: '%23' inside amount= filled Amount with '0.001#to=…', a whole other address; a zero-width space
    // in it made the page say 'Any amount' and the extension show '0.01' with a generic error.
    const badAmount = { link: null, problem: "This link's amount can't be read. Ask for a new one.", reason: "unreadable" };

    for (const amount of ["0.001%23to=" + B, "0.001%23", "0.0%E2%80%8B1", "0.01%E2%80%8B", "%E2%80%8F0.01", "0.01%00", "0.01%20", "%200.01", "0.01+", "0.01%0A", "0.01%EF%BB%BF", "1%C2%A0000", "1e3", "-1", "0x10", "1.2.3", "0,0,1", "١٢", "abc", ".", ","]) {
      for (const link of [`${testnetSend}?to=${A}&amount=${amount}&network=testnet`, `dusk:public-${A}@dusk:2?amount=${amount}`, `dusk:${A}?amount=${amount}`]) {
        like(readPaymentLink(link, { network: 2 }), badAmount, link);
      }
    }

    for (const amountLux of ["10000000%E2%80%8B", "1.5", "%2010000000", "1e7"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amountLux=${amountLux}`, { network: 2 }), badAmount, amountLux);
    }

    // What a link writes, or a person: digits with one point or comma, and no amount at all, for Send to read as it reads a typed one.
    for (const amount of ["0.001", "0,01", "1,000", "1.000", ".5", "5.", "12", ""]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amount=${amount}`, { network: 2 }), { problem: "", reason: "" }, amount);
      like(readPaymentLink(`dusk:${A}?amount=${amount}`, { network: 2 })?.link, { amountDusk: amount, to: A }, amount);
    }
  });

  it("refuses any space in a link's amount as it's written, a tab or a line break too, which a browser's reading of the link drops: Marek's 0.001, a tab, 5", () => {
    // Marek's: '0.001' + tab + '5' filled 0.0015 in both wallets, as the URL parser drops tabs and line breaks.
    const badAmount = { link: null, problem: LINK_BAD_AMOUNT, reason: "unreadable" };
    // Pasted, a space ends the link, and what's after it is words after it.
    const wordsAfter = { link: null, problem: LINK_UNCLEAR, reason: "words-after" };

    for (const space of ["\t", "\n", "\r", "\r\n", " ", "\u00a0", "\u202f", "\u2009", "\u3000", "\u2028", "\u0085", "\ufeff", "\u1680", "\u205f"]) {
      for (const amount of [`0.001${space}5`, `1${space}000`, `0.03${space}`, `${space}0.03`]) {
        for (const link of [`${testnetSend}?to=${A}&memo=x&amount=${amount}&network=testnet`, `${testnetSend}?to=${A}&amount=${amount}&memo=x`, `dusk:public-${A}@dusk:2?amount=${amount}&memo=x`]) {
          like(readPaymentLink(link, { network: 2 }), badAmount, JSON.stringify(link));
          like(readPastedLink(link, { network: 2 }), wordsAfter, JSON.stringify(link));
        }
      }

      // An exact amount in lux, and an amount whose field's name has a tab in it too, which the browser drops from it.
      like(readPaymentLink(`${testnetSend}?to=${A}&amountLux=1000${space}000&memo=x`, { network: 2 }), badAmount, JSON.stringify(space));
      like(readPaymentLink(`${testnetSend}?to=${A}&am\tount=0.0${space}3&memo=x`, { network: 2 }), badAmount, JSON.stringify(space));
    }

    // What comes after the link's # is the browser's, as it always was; a space around the whole link isn't the amount's.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.03#amount=1\t000`, { network: 2 })?.link, { amountDusk: "0.03" });
    like(readPaymentLink(`\t${testnetSend}?to=${A}&memo=x&amount=0.03\r\n`, { network: 2 })?.link, { amountDusk: "0.03" });
  });

  it("names an https link's fields as a browser does, dropping its tabs and line breaks before it decodes them: Astra's %6, a tab, 1mount beside amountLux says two amounts", () => {
    const twoAmounts = { link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" };

    for (const query of [
      "%6\t1mount=0.001&amountLux=1000000000000",
      "%6\n1mount=0.001&amountLux=1000000000000",
      "amount%4\tCux=1000000000000&amount=0.001",
      "am\tount=0.001&amountLux=1000000000000",
      // At the link's end, a control a browser drops with the spaces around a link: a bare amount beside amountLux.
      "amountLux=1000000000000&amount\u0001",
    ]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&${query}`, { network: 2 }), twoAmounts, JSON.stringify(query));
    }

    // Its value as it's written all the same: a tab in it is refused, its name read either way.
    like(readPaymentLink(`${testnetSend}?to=${A}&%6\t1mount=0.0\t01`, { network: 2 }), { link: null, problem: LINK_BAD_AMOUNT, reason: "unreadable" });
  });

  it("refuses a link whose field names hide something, or read as a field they aren't, rather than dropping them", () => {
    // Marek's: am‏ount=0.15 beside amount=0.001 filled in 0.001; a person reading the link sees both.
    for (const query of [
      `to=${B}&am%E2%80%8Fount=0.15&amount=0.001`,
      `to=${B}&amount%00=0.15&amount=0.001`,
      `to%20=${A}&to=${B}`,
      `%20to=${A}&to=${B}`,
      `+to=${A}&to=${B}`,
      `to=${B}&amount=0.001&memo%E2%80%8B=Order%201`,
      `to=${B}&am%E2%80%8Bount=0.15`,
      // Fullwidth ｔｏ, and a Cyrillic а in amount: they read as fields, and no reader reads them so.
      `to=${B}&%EF%BD%94%EF%BD%8F=${A}`,
      `to=${B}&%D0%B0mount=0.15&amount=0.001`,
      `to=${B}&net%E2%80%8Bwork=mainnet`,
      `to=${B}&ref%E2%80%8B=x`,
      `to=${B}&utm%20source=x`,
      // The review's: small capitals and Cyrillic letters Unicode's table takes for other small capitals, and marks
      // on a field's name, none of them ASCII as every field's name is.
      `to=${A}&${encodeURIComponent("ᴛo")}=${B}&amount=0.001`,
      `to=${A}&${encodeURIComponent("тo")}=${B}&amount=0.001`,
      `to=${A}&${encodeURIComponent("ᴀmount")}=5&amount=0.001`,
      `to=${A}&amount=1000&${encodeURIComponent("ɴetwork")}=mainnet`,
      `to=${A}&${encodeURIComponent("meмo")}=x`,
      `to=${A}&amount%CC%85=5&amount=0.001`,
      `to=${A}&amount%E2%81%84=5`,
      `to=${A}&caf%C3%A9=1`,
      // And names in ASCII that look like a field's: a capital I for the l of amountLux or label, rn, vv, a zero.
      `to=${A}&amount=5&amountIux=1000000`,
      `to=${A}&Iabel=Alice&amount=0.001`,
      `to=${A}&arnount=5&amount=0.001`,
      `to=${A}&amount=1000&netvvork=mainnet`,
      `to=${A}&t0=${B}`,
      `to=${A}&memo_=x`,
    ]) {
      const https = `${testnetSend}?${query}`;

      assert.equal(parsePaymentLink(https), null, query);
      like(readPaymentLink(https, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" }, query);
    }

    like(readPaymentLink(`dusk:public-${A}@dusk:2?am%E2%80%8Fount=0.15&amount=0.001`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });
    like(readPaymentLink(`dusk:${A}?%EF%BD%8D%EF%BD%85%EF%BD%8D%EF%BD%8F=x`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });
    like(readPaymentLink(`dusk:${A}?amount=5&amountIux=1000000`, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" });

    // The review's: on mainnet's wallet, a network= in other letters would have filled 1000 DUSK on Mainnet; named as written, it's two networks.
    const mainnetSend = `${networks.mainnet.apps.wallet.replace(/\/+$/, "")}/dashboard/send`;

    like(readPaymentLink(`${mainnetSend}?to=${A}&amount=1000&${encodeURIComponent("ɴetwork")}=testnet`, { network: 1 }), { link: null, problem: LINK_UNREADABLE });
    like(readPaymentLink(`${mainnetSend}?to=${A}&amount=1000&network=testnet`, { network: 1 }), { link: null, problem: "This link names two networks, Mainnet and Testnet. Ask for a new one." });

    // Other fields than a link's are the browser's or a sender's: left out, as before. A field in another case is that field.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&utm_source=chat&ref=abc&fbclid=x1&=5&%25=1`, { network: 2 })?.link, { amountDusk: "0.001", to: A });
    like(readPaymentLink(`${testnetSend}?to=${A}&AMOUNT=0.001&Memo=x&LABEL=Shop&amountlux=1000000`, { network: 2 })?.link, { amountDusk: "0.001", amountLux: "1000000", label: "Shop", memo: "x", to: A });
  });

  it("refuses a link whose memo has a line break, as both wallets read it alike, and makes none", () => {
    // Marek's: the web wallet filled in 'line one\nline two', the extension refused it.
    const lineBreak = { link: null, problem: "This link's memo has a line break. Ask for a new one.", reason: "unreadable" };

    for (const memo of ["line%20one%0Aline%20two", "a%0Db", "a%0D%0Ab", "a%E2%80%A8b", "a%E2%80%A9b", "a%C2%85b", "a%0Bb", "a%0Cb"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&memo=${memo}`, { network: 2 }), { ...lineBreak, chainId: "dusk:2" }, memo);
      like(readPaymentLink(`dusk:${A}?amount=0.001&memo=${memo}`, { network: 2 }), lineBreak, memo);
    }

    // Spaces and line breaks at its ends aren't the memo's, as a field's aren't.
    like(readPaymentLink(`${testnetSend}?to=${A}&memo=Order%201%0A`, { network: 2 })?.link, { memo: "Order 1" });
    // And a request's memo goes on one line.
    assert.deepEqual(makePaymentLink({ memo: "line one\nline two", network: 2, to: A }).problems, { memo: "Write the memo on one line." });
    assert.equal(makePaymentLink({ memo: "line one\u2028line two", network: 2, to: A }).https, null);
  });

  it("gives nothing of a refused link to fill in or show: no recipient, no amount, only why and its network", () => {
    // Marek's: the locked 'Payment request' preview of a refused link showed a To made of two addresses.
    for (const link of [`${testnetSend}?to=${B},${A}&amount=0.001&network=testnet`, `${testnetSend}?to=${A}&amount=0.0%E2%80%8B1&network=testnet`, `${testnetSend}?to=${A}&am%E2%80%8Fount=0.15&amount=0.001&network=testnet`, `${testnetSend}?to=${A}&amount=0.001&memo=a%0Ab&network=testnet`]) {
      const read = /** @type {any} */ (readPaymentLink(link, { network: 2 }));

      assert.equal(read.link, null, link);
      assert.notEqual(read.problem, "", link);
      assert.deepEqual(Object.keys(read).sort(), ["chainId", "link", "network", "problem", "reason"], link);
    }
  });

  it("reads a link's amount as Send does, for a preview to say the same: Marek's 1.000 asks, never 1 DUSK", () => {
    // Marek's: the locked 'Payment request' card said '1 DUSK' and '10 DUSK' while Send asked which was meant.
    for (const [amount, problem] of [
      ["1.000", "Is that 1 or 1000? Write the one you mean."],
      ["10.000", "Is that 10 or 10000? Write the one you mean."],
      ["1,000", "Is that 1 or 1000? Write the one you mean."],
    ]) {
      const link = /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}&amount=${amount}&network=testnet`, { network: 2 })).link;

      // The link's own lux is a plain number's, 1 DUSK of "1.000": not what Send reads.
      assert.equal(link.lux, parseDusk(amount));
      assert.deepEqual(said(linkAmount(link, "en-GB")), { field: amount, lux: null, problem }, amount);
    }

    // In Polish, where 1.000 is a thousand: the field has the language's mark, and asks the same.
    const polish = /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}&amount=1.000&network=testnet`, { network: 2 })).link;

    assert.deepEqual(said(linkAmount(polish, "pl-PL")), { field: "1,000", lux: null, problem: "Is that 1 or 1000? Write the one you mean." });
  });

  it("reads a link's amount as typing reads it: Chen's and Nandini's 2.125 asks as typed 2.125 does, with the two to choose from", () => {
    /** @param {string} query */
    const linkOf = (query) => /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}${query}&network=testnet`, { network: 2 })).link;
    const choices = [
      { field: "2.1250", lux: 2_125_000_000n },
      { field: "2125", lux: 2_125_000_000_000n },
    ];

    // Chen's: the link's 2.125 was filled in as 2.1250 without a word, while typing 2.125 asked.
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "en-SG"), { field: "2.125", ...readAmount("2.125", "en-SG") });
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "en-SG"), { choices, field: "2.125", lux: null, problem: "Is that 2.1250 or 2125? Write the one you mean.", question: "Is that 2.1250 or 2125?" });
    assert.deepEqual(linkAmount(linkOf("&amount=2.125"), "de-DE").choices, [{ field: "2,1250", lux: 2_125_000_000n }, choices[1]]);

    // A link a wallet makes for 2.125 DUSK, as Request reads it once the question's first choice fills its field, says
    // 2.1250, which reads as that amount without a question, in every language.
    const typed = /** @type {NonNullable<ReturnType<typeof readAmount>["choices"]>} */ (readAmount("2,125", "de-DE").choices)[0].field;
    const made = makePaymentLink({ amount: typed, language: "de-DE", network: 2, to: A });

    assert.equal(typed, "2,1250");
    assert.deepEqual(makePaymentLink({ amountLux: 2_125_000_000n, network: 2, to: A }), made);

    assert.match(String(made.https), /&amount=2\.1250&/);
    assert.match(made.dusk, /\?amount=2\.1250$/);

    for (const language of ["en-GB", "de-DE", "fr-FR", "pl-PL"]) {
      for (const link of [made.https, made.dusk]) assert.deepEqual(said(linkAmount(/** @type {any} */ (readPaymentLink(link, { network: 2 })).link, language)).lux, 2_125_000_000n, `${language}: ${link}`);
    }

    // So does one in lux, which is exact.
    assert.deepEqual(linkAmount(linkOf("&amountLux=2125000000"), "en-GB"), { field: "2.1250", lux: 2_125_000_000n, problem: null });
    // A link's amount and the one typed are read alike: none asks that the other doesn't.
    for (const amount of ["0.5", "1.25", "1.2345", "1234.567", "1.000", "12.050", "0,5", "2,125"]) {
      const { field, ...read } = linkAmount(linkOf(`&amount=${encodeURIComponent(amount)}`), "en-GB");

      assert.deepEqual(read, readAmount(amount, "en-GB"), amount);
      assert.equal(field, amount, amount);
    }
  });

  it("gives the amount Send fills in and reads, in the person's language, and any amount for none", () => {
    /** @param {string} query */
    const linkOf = (query) => /** @type {any} */ (readPaymentLink(`${testnetSend}?to=${A}${query}&network=testnet`, { network: 2 })).link;

    // As a wallet writes 2.125 DUSK: Send fills it in so it reads back as it is, without a question.
    assert.deepEqual(linkAmount(linkOf("&amount=2.1250"), "en-GB"), { field: "2.1250", lux: 2_125_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amount=2.1250"), "de-DE"), { field: "2,1250", lux: 2_125_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amount=0.15"), "es-ES"), { field: "0,15", lux: 150_000_000n, problem: null });
    assert.deepEqual(linkAmount(linkOf("&amountLux=1000000000"), "en-GB"), { field: "1", lux: 1_000_000_000n, problem: null });
    // What Send won't take, it says: as the field would.
    assert.deepEqual(linkAmount(linkOf("&amount=0"), "en-GB"), { field: "0", lux: null, problem: "Enter an amount greater than 0." });
    // No amount asked: any.
    assert.deepEqual(linkAmount(linkOf(""), "en-GB"), { field: "", lux: null, problem: null });
    assert.deepEqual(linkAmount(null, "en-GB"), { field: "", lux: null, problem: null });
    // The language's mark, as each wallet fills a field.
    assert.equal(linkAmount(linkOf("&amount=1.5"), "fr-FR").field, amountForField("1.5", decimalSeparator("fr-FR")));
  });

  it("refuses a dusk: link that asks for a shielded payment to a public account, or a public one to a shielded address", () => {
    // Marek's: dusk:shielded- with his public account filled in a public send, without a word of what it asked.
    like(readPaymentLink(`dusk:shielded-${A}?amount=0.001`, { network: 2 }), {
      link: null,
      problem: "This link asks for a shielded payment to a public account. Ask for a new one.",
      reason: "unreadable",
    });
    like(readPaymentLink(`dusk:public-${SHIELDED}@dusk:2?amount=0.001`, { network: 2 }), {
      link: null,
      problem: "This link asks for a public payment to a shielded address. Ask for a new one.",
      reason: "unreadable",
    });
    assert.equal(parsePaymentLink(`dusk:shielded-${A}`), null);
    assert.equal(parsePaymentLink(`DUSK:SHIELDED-${A}`), null);
    // Each to its own kind, as it asks.
    like(readPaymentLink(`dusk:shielded-${SHIELDED}?amount=0.001`, { network: 2 })?.link, { kind: "shielded", to: SHIELDED });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001`, { network: 2 })?.link, { kind: "public", to: A });
  });

  it("refuses a dusk: link with a # in it, rather than reading what follows it into a field", () => {
    // Marek's: a second recipient after the # landed in Amount.
    for (const link of [`dusk:${A}?amount=0.001#to=${B}`, `dusk:public-${A}?amount=0.001#`, `dusk:public-${A}#amount=5`, `dusk:${A}?amount=0.001#&amount=0.15`, `dusk:public-${A}@dusk:2#x`]) {
      assert.equal(parsePaymentLink(link), null, link);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: LINK_UNREADABLE, reason: "unreadable" }, link);
    }

    // An https link's fragment is the browser's, as the page it opens leaves it out: never read into a field.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001#to=${B}`, { network: 2 })?.link, { amountDusk: "0.001", to: A });
    like(readPaymentLink(`dusk:${A}?amount=0.001&memo=Order%20%2312`, { network: 2 })?.link, { amountDusk: "0.001", memo: "Order #12" });
  });

  it("refuses a dusk: link that names a recipient in its query too, as an https link naming two", () => {
    // Marek's: it filled in the first and dropped the other without a word.
    for (const link of [`dusk:public-${A}?to=${B}&amount=0.001`, `dusk:${A}?to=${B}&amount=0.001`, `dusk:public-${A}?to=${A}`, `dusk:public-${A}@dusk:2?amount=0.001&to=`]) {
      assert.equal(parsePaymentLink(link), null, link);
      like(readPaymentLink(link, { network: 2 }), { link: null, problem: "This link says the recipient twice. Ask for a new one.", reason: "unreadable" }, link);
    }
  });

  it("refuses a dusk: link for another network than the wallet's by its query too, as an https link", () => {
    // Marek's: a link that says testnet filled in a mainnet send, and one that says mainnet a testnet send.
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=testnet`, { network: 1 }), {
      chainId: "dusk:2",
      link: null,
      network: "Testnet",
      problem: "This request is for Testnet. You are on Mainnet.",
      reason: "other-network",
    });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=mainnet`, { network: 2 }), { problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network" });
    like(readPaymentLink(`dusk:public-${A}?amount=0.001&network=testnet`, { network: 2 })?.link, { amountDusk: "0.001", chainId: "dusk:2", to: A });
    like(readPaymentLink(`dusk:public-${A}@dusk:1?amount=0.001&network=testnet`, { network: 2 }), {
      link: null,
      problem: "This link names two networks, Mainnet and Testnet. Ask for a new one.",
      reason: "unreadable",
    });
  });

  it("says why it refuses a link whose network can't be read, or that says nobody to pay", () => {
    const unknown = { link: null, problem: "This link's network can't be read. Ask for a new one.", reason: "unreadable" };

    like(readPaymentLink(`${testnetSend}?to=${A}&network=nowhere`, { network: 2 }), unknown);
    like(readPaymentLink(`dusk:public-${A}?network=nowhere`, { network: 2 }), unknown);
    like(readPaymentLink(`dusk:public-${A}@dusk:abc`, { network: 2 }), unknown);
    // Marek's: a chain's number with a zero before it is no network's, not "Testnet and Testnet".
    for (const link of [`${testnetSend}?to=${A}&amount=0.001&network=dusk:02`, `dusk:public-${A}?network=dusk:02`, `dusk:${A}?network=02`, `dusk:public-${A}@dusk:02`]) {
      like(readPaymentLink(link, { network: 2 }), unknown, link);
    }
    like(readPaymentLink(`${testnetSend}?amount=1`, { network: 2 }), { link: null, problem: "This link doesn't say who to pay. Ask for a new one.", reason: "unreadable" });
  });

  it("says amounts that differ, in DUSK and in lux or one of them twice, as two amounts", () => {
    for (const amounts of ["amount=0.001&amount=0.15", "amount=1&amountLux=1500000000", "amountLux=1&amountLux=2"]) {
      like(readPaymentLink(`${testnetSend}?to=${A}&${amounts}`, { network: 2 }), { link: null, problem: LINK_TWO_AMOUNTS, reason: "two-amounts" }, amounts);
      like(readPaymentLink(`dusk:public-${A}@dusk:2?${amounts}`, { network: 2 }), { reason: "two-amounts" }, amounts);
    }

    // The same amount, in DUSK and in lux, is one.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=1.5&amountLux=1500000000`, { network: 2 })?.link, { lux: 1_500_000_000n });
  });

  it("refuses a user part before the host, which makes a mainnet link read as testnet's", () => {
    // Marek's: it goes to mainnet's wallet.
    const disguised = `https://apps.testnet.dusk.network@apps.dusk.network/wallet/dashboard/send?to=${A}&amount=0.001`;

    assert.equal(parsePaymentLink(disguised), null);
    // Sofia's: it says what's wrong, for whoever sent it to fix.
    like(readPaymentLink(disguised, { network: 1 }), { chainId: "", link: null, problem: "This link has something before the site's address. Ask for a new one.", reason: "unreadable" });
    assert.equal(parsePaymentLink(`https://user:pass@apps.dusk.network/wallet/dashboard/send?to=${A}`), null);
    assert.equal(parsePaymentLink(`${mainnetSend}?to=${A}`)?.form, "https");
  });

  it("refuses a testnet link that says mainnet, rather than filling in nothing without a word", () => {
    // Marek's.
    like(readPaymentLink(`${testnetSend}?to=${A}&amount=0.001&network=mainnet`, { network: 2 }), {
      link: null,
      problem: "This link names two networks, Testnet and Mainnet. Ask for a new one.",
      reason: "unreadable",
    });
  });

  it("is nothing for what isn't a link, which Send reads as a recipient", () => {
    for (const text of ["", "  ", A, "name.dusk", `https://evil.example/wallet/dashboard/send?to=${A}`, `https://apps.dusk.network@evil.example/wallet/dashboard/send?to=${A}`]) {
      assert.equal(readPaymentLink(text, { network: 1 }), null, text);
    }

    like(readPaymentLink("dusk:invalid", { network: 1 }), { problem: LINK_UNREADABLE, reason: "unreadable" });
  });
});

describe("a request a payer can use", () => {
  it("is made for a recipient alone, and for a shielded one with its own kind", () => {
    like(makePaymentLink({ network: 2, to: A }), { lux: null, ok: true, problems: {} });
    like(makePaymentLink({ network: 2, to: SHIELDED }), { dusk: `dusk:shielded-${SHIELDED}@dusk:2`, ok: true });
    like(parsePaymentLink(makePaymentLink({ network: 2, to: SHIELDED }).https), { kind: "shielded", to: SHIELDED });
    assert.equal(recipientKind(A), "public");
    assert.equal(recipientKind(SHIELDED), "shielded");
    assert.equal(recipientKind("name.dusk"), "unknown");
  });

  it("refuses an amount of 0, as Send would when the payer gets there", () => {
    for (const amount of ["0", "0.0", "0,000"]) {
      like(makePaymentLink({ amount, language: "en-GB", network: 1, to: A }), { dusk: "", https: null, ok: false, problems: { amount: "Enter an amount greater than 0." } });
    }
    for (const amountLux of [0n, 0, "0", "abc", -1n]) {
      assert.equal(makePaymentLink({ amountLux, network: 1, to: A }).problems.amount, "Enter an amount greater than 0.", String(amountLux));
    }
  });

  it("says 1.234 is unclear, not that it has too many decimals", () => {
    assert.equal(makePaymentLink({ amount: "1.234", language: "es-ES", network: 1, to: A }).problems.amount, "Is that 1,2340 or 1234? Write the one you mean.");
    assert.equal(makePaymentLink({ amount: "abc", language: "es-ES", network: 1, to: A }).problems.amount, "Enter an amount such as 10 or 10,5.");
    // In English too: a point before three digits could be a thousands' group.
    assert.equal(makePaymentLink({ amount: "1.234", language: "en-GB", network: 1, to: A }).problems.amount, "Is that 1.2340 or 1234? Write the one you mean.");
    // And reads what each language writes.
    assert.equal(makePaymentLink({ amount: "1 000,5", language: "fr-FR", network: 1, to: A }).lux, 1_000_500_000_000n);
    assert.equal(makePaymentLink({ amount: "1.25", language: "en-GB", network: 1, to: A }).lux, 1_250_000_000n);
  });

  it("refuses more than 9 decimals, and more than a u64 of lux", () => {
    assert.equal(makePaymentLink({ amount: "0.1234567891", language: "en-GB", network: 1, to: A }).problems.amount, "DUSK has 9 decimals at most.");
    assert.equal(makePaymentLink({ amount: "18446744074", language: "en-GB", network: 1, to: A }).problems.amount, "That amount is too large.");
    assert.equal(makePaymentLink({ amountLux: 1n << 64n, network: 1, to: A }).problems.amount, "That amount is too large.");
    assert.equal(makePaymentLink({ amountLux: "123456789", network: 1, to: A }).https, `${networks.mainnet.apps.wallet}/dashboard/send?to=${A}&amount=0.123456789&network=mainnet`);
  });

  it("refuses a memo past 512 bytes, counted as bytes", () => {
    const tooLong = `That memo is too long: ${MAX_MEMO_BYTES} bytes at most.`;

    assert.equal(makePaymentLink({ memo: "x".repeat(512), network: 1, to: A }).ok, true);
    like(makePaymentLink({ memo: "x".repeat(600), network: 1, to: A }), { dusk: "", https: null, ok: false, problems: { memo: tooLong } });
    // Three bytes each.
    assert.equal(makePaymentLink({ memo: "€".repeat(170), network: 1, to: A }).ok, true);
    assert.equal(makePaymentLink({ memo: "€".repeat(171), network: 1, to: A }).problems.memo, tooLong);
    // As Send counts it: its ends' spaces aren't kept.
    assert.equal(makePaymentLink({ memo: `  ${"x".repeat(512)}  `, network: 1, to: A }).ok, true);
  });

  it("refuses what isn't a recipient, in the words of Send", () => {
    const notOne = "Not a valid address. Check it and try again.";

    for (const to of ["", "abc", "name.dusk", `${A}x`, A.slice(0, -1)]) {
      like(makePaymentLink({ network: 1, to }), { dusk: "", https: null, ok: false, problems: { to: notOne } }, to);
    }

    // The right length, but no key: DUSK sent there could never be spent.
    const noKey = "1".repeat(96);

    assert.equal(recipientKind(noKey), "public");
    assert.equal(makePaymentLink({ network: 1, to: noKey }).problems.to, notOne);
    assert.equal(makePaymentLink({ network: 1, to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F" }).problems.to, "That's an EVM address, not a Dusk account.");
  });

  it("refuses a recipient the apps won't send to", () => {
    const [compromised, scam] = networks.mainnet.display.blocklist;

    assert.equal(makePaymentLink({ network: 1, to: compromised.account }).problems.to, "Transfer restricted: this recipient address has been reported as compromised.");
    assert.equal(makePaymentLink({ network: 1, to: scam.account }).problems.to, "Transfer restricted: this recipient address is associated with reported fraud/scam activity.");
    // On any network, while it isn't known which, as on a chain there's no file for.
    assert.ok(makePaymentLink({ to: scam.account }).problems.to);
    assert.ok(makePaymentLink({ network: "dusk:77", to: scam.account }).problems.to);
  });

  it("says each thing that's wrong at once", () => {
    assert.deepEqual(makePaymentLink({ amount: "0", language: "en-GB", memo: "x".repeat(513), network: 1, to: "abc" }).problems, {
      amount: "Enter an amount greater than 0.",
      memo: "That memo is too long: 512 bytes at most.",
      to: "Not a valid address. Check it and try again.",
    });
  });

  it("makes links that read back, in every language", () => {
    for (const language of ["en-US", "en-GB", "nl-NL", "de-DE", "fr-FR", "es-ES", "de-CH", "hi-IN", "ar-EG"]) {
      const decimal = decimalSeparator(language);

      for (const [typed, lux] of /** @type {const} */ ([[`0${decimal}15`, 150_000_000n], [`1234${decimal}5`, 1_234_500_000_000n], ["7", 7_000_000_000n]])) {
        const made = makePaymentLink({ amount: typed, language, network: 1, to: A });

        assert.equal(made.lux, lux, `${language} ${typed}`);
        assert.equal(/** @type {any} */ (parsePaymentLink(made.https)).lux, lux, `${language} ${typed}`);
        assert.equal(/** @type {any} */ (parsePaymentLink(made.dusk)).lux, lux, `${language} ${typed}`);
      }
    }
  });
});

describe("the network a link is for", () => {
  it("is named as the apps name it", () => {
    assert.equal(chainLabel("dusk:1"), "Mainnet");
    assert.equal(chainLabel("dusk:2"), "Testnet");
    assert.equal(chainLabel("dusk:3"), "Devnet");
    assert.equal(chainLabel("dusk:0"), "Local");
    assert.equal(chainLabel("dusk:42"), "Chain 42");
    assert.equal(chainLabel(""), "");
    assert.equal(chainLabel(null), "");
    assert.equal(chainLabel("eip155:1"), "");
  });

  it("says when it isn't the wallet's", () => {
    assert.equal(networkMismatch("dusk:1", "dusk:2"), "This request is for Mainnet. You are on Testnet.");
    assert.equal(networkMismatch("dusk:2", 1), "This request is for Testnet. You are on Mainnet.");
    assert.equal(networkMismatch("dusk:7", "dusk:1"), "This request is for Chain 7. You are on Mainnet.");
    assert.equal(networkMismatch("dusk:1", "dusk:1"), "");
    assert.equal(networkMismatch("", "dusk:1"), "");
    assert.equal(networkMismatch("dusk:1", null), "");
  });
});

describe("a request shared as a message", () => {
  // Sofía's: Copy request link gave her client a 270-character blob; Chen's: Share gave his friends a bare link.
  const sofias = makePaymentLink({ amount: "0,03", language: "es-ES", memo: "Factura F-2026-071 – rediseño web", network: 2, to: A });

  it("says who asks for what, its memo, then the link as it is: in both wallets' words", () => {
    assert.equal(
      requestMessage({ language: "es-ES", link: /** @type {string} */ (sofias.https), lux: sofias.lux, memo: "Factura F-2026-071 – rediseño web", name: "sofiadesign.dusk" }),
      `sofiadesign.dusk asks you to pay 0,03 DUSK · Factura F-2026-071 – rediseño web\nPay here: ${sofias.https}`
    );
    // The memo only where there is one.
    assert.equal(requestMessage({ language: "en-SG", link: "https://example/send?x", lux: 20_000_000n, name: "Chen" }), "Chen asks you to pay 0.02 DUSK\nPay here: https://example/send?x");
  });

  it("writes the amount so any reader reads it as that amount, in the person's own decimal mark", () => {
    const of = (/** @type {bigint} */ lux, /** @type {string} */ language) => requestMessage({ language, link: "L", lux, name: "Lena" }).split("\n")[0];

    // No groups, which a reader of another language takes for decimals, and three decimals with a fourth, a zero.
    assert.equal(of(1000n * 1_000_000_000n, "de-DE"), "Lena asks you to pay 1000 DUSK");
    assert.equal(of(2_125_000_000n, "de-DE"), "Lena asks you to pay 2,1250 DUSK");
    assert.equal(of(2_125_000_000n, "en-GB"), "Lena asks you to pay 2.1250 DUSK");
    assert.equal(of(1_234_500_000_000n, "fr-FR"), "Lena asks you to pay 1234,5 DUSK");
    assert.equal(of(1n, "en-GB"), "Lena asks you to pay 0.000000001 DUSK");

    for (const language of ["en-GB", "de-DE", "fr-FR", "pl-PL", "es-ES"]) {
      for (const lux of [1_000_000_000_000n, 2_125_000_000n, 12_050_000_000n, 999_999_000_000n]) {
        const said = /** @type {string} */ (/asks you to pay (\S+) DUSK/.exec(of(lux, language))?.[1]);

        assert.deepEqual(readAmount(said, language), { lux, problem: null }, `${language}: ${said}`);
      }
    }
  });

  it("asks for any amount where the request names none, and says so without a name, and on a test network", () => {
    assert.equal(requestMessage({ link: "L", lux: null, memo: "chicken rice", name: "Chen" }), "Chen asks you for a payment in DUSK · chicken rice\nPay here: L");
    assert.equal(requestMessage({ link: "L", lux: 20_000_000n }), "You're asked to pay 0.02 DUSK\nPay here: L");
    assert.equal(requestMessage({ link: "L" }), "You're asked for a payment in DUSK\nPay here: L");
    assert.equal(requestMessage({ link: "L", lux: "20000000", name: "Chen", network: "Testnet" }), "Chen asks you to pay 0.02 DUSK on Testnet\nPay here: L");
  });

  it("shows what can't be seen in a name or a memo as its codes, as on a screen", () => {
    assert.equal(requestMessage({ link: "L", lux: 1_000_000_000n, memo: "pay ‮0001‬", name: "Ali​ce" }), "Ali\\u200bce asks you to pay 1 DUSK · pay \\u202e0001\\u202c\nPay here: L");
  });
});

describe("what's pasted in Send's To", () => {
  // Amélie's, Sofía's, Lena's, Chen's, Nandini's and Marek's: the wallet's own request, shared as a message and pasted
  // into the extension's or the app's Send, said "Not a valid address"; the web wallet's took the link out of it.
  const testnetSend = `${networks.testnet.apps.wallet}/dashboard/send`;
  const httpsLink = /** @type {string} */ (makePaymentLink({ amount: "0.03", language: "en", memo: "Factura 71", network: 2, to: A }).https);
  const duskLink = `dusk:public-${A}@dusk:2?amount=0.03&memo=Factura+71`;
  const filled = { amountDusk: "0.03", memo: "Factura 71", to: A };
  /** @param {string} link @param {string | null} [name] */
  const shared = (link, name = "sofiadesign.dusk") => requestMessage({ language: "en", link, lux: 30_000_000n, memo: "Factura 71", name, network: "Testnet" });
  /** @param {string} problem @param {string} reason */
  const refused = (problem, reason) => ({ chainId: "", link: null, network: "", problem, reason, text: "" });
  /**
   * That pasted text is refused as a message whose words say what its link doesn't, saying what: which part, as the
   * message and the link say it, in words of its own, or LINK_DISAGREES where it's no one part; and `expected` of it.
   *
   * @param {import("../src/payment-links.js").PastedLinkRead | null} read
   * @param {string} [message]
   * @param {Partial<import("../src/payment-links.js").Disagreement> & { problem?: string }} [expected]
   */
  const disagrees = (read, message, { problem, ...expected } = {}) => {
    like(read, { chainId: "", link: null, network: "", reason: "disagrees", text: "" }, message);

    const what = /** @type {import("../src/payment-links.js").Disagreement} */ (read?.disagrees);

    assert.deepEqual(Object.keys(what).sort(), ["link", "message", "part"], message);
    assert.ok(["amount", "network", "memo", "name", "address", "other"].includes(what.part), message);
    assert.equal(read?.problem === LINK_DISAGREES, what.part === "other", message);
    assert.match(String(read?.problem), /^The message[ ']/, message);
    like(what, expected, message);
    if (problem !== undefined) assert.equal(read?.problem, problem, message);
  };

  it("takes the one link out of a request as both wallets share it, its line break there or dropped, as a phone's field drops it", () => {
    for (const link of [httpsLink, duskLink]) {
      for (const message of [shared(link), shared(link, null)]) {
        for (const pasted of [message, message.replace("\n", ""), message.replace("\n", " "), `  ${message}\r\n`]) {
          const read = readPastedLink(pasted, { network: 2 });

          like(read, { problem: "", reason: "", text: link }, JSON.stringify(pasted));
          // As the link alone is read, and nothing else.
          assert.deepEqual({ ...read, text: undefined }, { ...readPaymentLink(link, { network: 2 }), text: undefined }, JSON.stringify(pasted));
          like(read?.link, filled, JSON.stringify(pasted));
        }
      }
    }
  });

  it("refuses a request as shared whose line says another amount, memo or network than its link: Marek's 0.002 above a link for 0.15", () => {
    // Marek's T2, as the web wallet's Copy gave it: from a profile without a name, on Testnet.
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.002", language: "en", memo: "r35 marek T2", network: 2, to: A }).https);
    const t2 = requestMessage({ language: "en", link, lux: 2_000_000n, memo: "r35 marek T2", network: "Testnet" });

    assert.equal(t2, `You're asked to pay 0.002 DUSK on Testnet · r35 marek T2\nPay here: ${link}`);
    like(readPastedLink(t2, { network: 2 })?.link, { amountDusk: "0.002", memo: "r35 marek T2", to: A });

    for (const pasted of [
      // Only the link's amount changed: both wallets filled in 0.15 under a line saying 0.002.
      t2.replace("amount=0.002", "amount=0.15"),
      t2.replace("amount=0.002", "amountLux=150000000"),
      t2.replace("&amount=0.002", ""),
      // The line's amount, its memo, its network, or all of it with a name.
      t2.replace("pay 0.002 DUSK", "pay 5 DUSK"),
      t2.replace("to pay 0.002 DUSK", "for a payment in DUSK"),
      t2.replace("· r35 marek T2", "· something else"),
      t2.replace(" · r35 marek T2", ""),
      t2.replace(" on Testnet", " on Mainnet"),
      t2.replace("You're asked to pay 0.002 DUSK on Testnet · r35 marek T2", "Sofía asks you to pay 0.001 DUSK · coffee"),
      // The link's memo, or none.
      t2.replace("memo=r35+marek+T2", "memo=r35+swap"),
      t2.replace("&memo=r35+marek+T2", ""),
      // A dusk: link in it, as the extension's QR code gives one.
      t2.replace(link, `dusk:public-${A}@dusk:2?amount=0.15&memo=r35+marek+T2`),
      // Typed with a typographic apostrophe, and in other case.
      t2.replace("You're", "You’re").replace("amount=0.002", "amount=0.15"),
      t2.replace("You're asked to pay", "YOU'RE ASKED TO PAY").replace("amount=0.002", "amount=0.15"),
    ]) {
      // Its line break there, dropped as a phone's one-line field drops it, a space, or Windows' line ends.
      for (const each of [pasted, pasted.replace("\n", ""), pasted.replace("\n", " "), pasted.replace(/\n/g, "\r\n"), `Hi Marek,\n${pasted}`, pasted.replace("Pay here: ", "")]) {
        disagrees(readPastedLink(each, { network: 2 }), JSON.stringify(each));
      }
    }

    // A link that names no network is paid on the wallet's: a line naming another is refused there, and only there.
    const anywhere = t2.replace(link, `dusk:public-${A}?amount=0.002&memo=r35+marek+T2`);

    disagrees(readPastedLink(anywhere, { network: 1 }));
    like(readPastedLink(anywhere, { network: 2 })?.link, { amountDusk: "0.002", memo: "r35 marek T2", to: A });

    // A line on a link for another network that doesn't agree is refused for that first: no other wallet is offered it.
    const mainnet = /** @type {string} */ (makePaymentLink({ amount: "0.15", memo: "Factura 71", network: 1, to: A }).https);

    disagrees(readPastedLink(requestMessage({ link: mainnet, lux: 2_000_000n, memo: "Factura 71" }), { network: 2 }));
    // What a link alone refuses, it refuses as the link alone says it, line or not.
    like(readPastedLink(t2.replace("amount=0.002", "amount=0.002%23"), { network: 2 }), { problem: LINK_BAD_AMOUNT, reason: "unreadable" });
  });

  it("fills in a request as either wallet shares it, in any language, amount, memo and name", () => {
    for (const language of ["en", "es-ES", "de-DE", "fr-FR", "pl-PL"]) {
      for (const lux of [30_000_000n, 2_125_000_000n, 1_000_000_000_000n, 1n, 1_500_000_000n, null]) {
        for (const memo of ["Factura F-2026-071 – rediseño web", "", "\u0627\u062f\u0641\u0639 10 \u0644\u0640 1000", "pay \u200b0001 · on time"]) {
          for (const name of ["sofiadesign.dusk", "Chen", "\u0639\u0644\u064a", null]) {
            const made = makePaymentLink({ amountLux: lux, language, memo, network: 2, to: A });

            for (const link of [/** @type {string} */ (made.https), made.dusk]) {
              const message = requestMessage({ language, link, lux, memo, name, network: "Testnet" });
              const read = readPastedLink(message, { network: 2 });

              like(read, { problem: "", reason: "", text: link }, JSON.stringify(message));
              like(read?.link, { memo, to: A }, JSON.stringify(message));
            }
          }
        }
      }
    }

    // On mainnet, which a message doesn't name.
    const mainnet = /** @type {string} */ (makePaymentLink({ amount: "0.03", memo: "Factura 71", network: 1, to: A }).https);

    like(readPastedLink(requestMessage({ link: mainnet, lux: 30_000_000n, memo: "Factura 71", name: "Chen" }), { network: 1 })?.link, filled);
    // Words that state no amount, network or .dusk name say nothing of the link: it fills in what the link says. Words
    // stating its amount, a request's line or not, agree with it; another amount is refused.
    for (const said of ["Pay me back for lunch", "Thanks!", "0.03 DUSK please", "Marek asks you to pay 0.03 DUSK for coffee", "Invoice 71, for 2 coffees", "Pay Sofia2 back", "DUSK Network"]) {
      like(readPastedLink(`${said}\n${httpsLink}`, { network: 2 })?.link, filled, said);
    }
    for (const said of ["0.001 DUSK please", "Marek asks you to pay 0.001 DUSK for coffee", "Pay 0.001 for coffee", "Send me 3 DUSK", "Pay 30k DUSK", "DUSK 1,000.5"]) {
      disagrees(readPastedLink(`${said}\n${httpsLink}`, { network: 2 }), said);
    }
  });

  it("reads a request's line by the whole of its name, whatever the name holds: Astra's profile named Alice asks you to pay", () => {
    // A name may say "asks you" itself, a memo "asks you to pay … DUSK", and either a " · ": the line is read as the
    // wallet writes it for its link, not by the first "asks you" in it.
    for (const name of ["Alice asks you to pay", "Alice asks you", "You're asked", "Sofía · Diseño", "asks you for a payment in DUSK on Testnet", "Bob asks you for a payment in DUSK on Testnet · x"]) {
      for (const memo of ["Factura 71", "", "Bob asks you to pay 1 DUSK on Mainnet · y", "on Testnet"]) {
        for (const lux of [30_000_000n, null]) {
          const made = makePaymentLink({ amountLux: lux, memo, network: 2, to: A });
          const link = /** @type {string} */ (made.https);
          const message = requestMessage({ language: "en", link, lux, memo, name, network: "Testnet" });
          const changed = lux ? message.replace("amount=0.03", "amount=0.15") : message.replace(`?to=${A}`, `?to=${A}&amount=0.15`);

          like(readPastedLink(message, { network: 2 }), { problem: "", reason: "", text: link }, JSON.stringify(message));
          disagrees(readPastedLink(changed, { network: 2 }), JSON.stringify(changed));
        }
      }
    }

    // A name that states another amount or network than its link, as any words do, is refused.
    for (const name of ["Bob asks you to pay 5 DUSK on Mainnet · x", "Bob, 5 DUSK", "Bob on Mainnet"]) {
      const message = requestMessage({ language: "en", link: httpsLink, lux: 30_000_000n, memo: "Factura 71", name, network: "Testnet" });

      disagrees(readPastedLink(message, { network: 2 }), name);
    }
  });

  it("reads Pay here: in any case and spacing: Astra's Pay, a no-break space, here: above a link for 0.15", () => {
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.002", language: "en", memo: "r35 marek T2", network: 2, to: A }).https);
    const t2 = requestMessage({ language: "en", link, lux: 2_000_000n, memo: "r35 marek T2", name: "sofiadesign.dusk", network: "Testnet" });

    for (const marker of ["Pay\u00a0here:", "Pay  here:", "PAY HERE:", "pay\there:", "Pay here :", "Pay\nhere:", "Pay \n here: "]) {
      const pasted = t2.replace("Pay here:", marker);

      like(readPastedLink(pasted, { network: 2 }), { problem: "", reason: "", text: link }, JSON.stringify(pasted));
      disagrees(readPastedLink(pasted.replace("amount=0.002", "amount=0.15"), { network: 2 }), JSON.stringify(pasted));
      assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), ["sofiadesign.dusk"], JSON.stringify(pasted));
    }
  });

  it("reads a network's name of any length: a custom chain's request, shared on its own network", () => {
    const link = `dusk:public-${A}@dusk:42?amount=0.03&memo=Factura+71`;

    for (const network of ["My private Dusk development network", "Dusk on the go", "Chain 42", "a b c d e f g h i j"]) {
      const message = requestMessage({ language: "en", link, lux: 30_000_000n, memo: "Factura 71", name: "Chen", network });

      like(readPastedLink(message, { network: 42 })?.link, filled, network);
      disagrees(readPastedLink(message.replace("amount=0.03", "amount=0.15"), { network: 42 }), network);
    }

    // A name may say the request again, network and all, and the line still reads as the wallet's own; one that can
    // be read in many more ways than the wallet's own line is refused, and at once.
    const echo = requestMessage({ language: "en", link: httpsLink, lux: 30_000_000n, memo: "Factura 71", name: "Bob asks you to pay 0.03 DUSK on Testnet", network: "Testnet" });

    like(readPastedLink(echo, { network: 2 })?.link, filled);
    disagrees(readPastedLink(`${"x asks you to pay 0.03 DUSK on ".repeat(2500)}Testnet \u00b7 Factura 71\nPay here: ${httpsLink}`, { network: 2 }));
    assert.deepEqual(pastedDuskNames(`sofiadesign.dusk ${"x asks you to pay 0.03 DUSK on ".repeat(2500)}Testnet \u00b7 Factura 71\nPay here: ${httpsLink}`, { network: 2 }), []);
  });

  it("reads a network by which it is, not by the name it's given: Astra's on Chain 2 above a testnet link", () => {
    const line = (/** @type {string} */ network) => `Chen asks you to pay 0.03 DUSK on ${network} · Factura 71\nPay here: `;

    for (const network of ["Chain 2", "chain 2", "TESTNET", "testnet"]) like(readPastedLink(`${line(network)}${httpsLink}`, { network: 2 })?.link, filled, network);
    like(readPastedLink(`${line("Local")}dusk:public-${A}@dusk:0?amount=0.03&memo=Factura+71`, { network: 0 })?.link, filled);
    like(readPastedLink(`${line("Chain 0")}dusk:public-${A}@dusk:0?amount=0.03&memo=Factura+71`, { network: 0 })?.link, filled);
    for (const network of ["Chain 1", "Mainnet", "Chain 3", "Devnet", "Local"]) disagrees(readPastedLink(`${line(network)}${httpsLink}`, { network: 2 }), network);
  });

  it("takes a name that is the link's label as written, though it has no letters to compare: Astra's \ud83d\udc99", () => {
    const labelled = (/** @type {string} */ label) => `${httpsLink.replace("&network=", `&label=${encodeURIComponent(label)}&network=`)}`;

    for (const name of ["\ud83d\udc99", "\u2764\ufe0f", "\u2605 \u2605", "\u0639\u0644\u064a"]) {
      like(readPastedLink(requestMessage({ language: "en", link: labelled(name), lux: 30_000_000n, memo: "Factura 71", name, network: "Testnet" }), { network: 2 })?.link, filled, name);
    }
    disagrees(readPastedLink(requestMessage({ language: "en", link: labelled("\ud83d\udc99"), lux: 30_000_000n, memo: "Factura 71", name: "\ud83d\udc9a", network: "Testnet" }), { network: 2 }));
  });

  it("refuses a request as shared whose line names someone else than its link does: by its label, its .dusk name, or as the name service says", () => {
    const line = (/** @type {string} */ name) => `${name} asks you to pay 0.03 DUSK on Testnet · Factura 71\nPay here: `;
    const labelled = `${httpsLink.replace("&network=", "&label=Sof%C3%ADa+Design&network=")}`;
    const named = `${testnetSend}?to=sofiadesign.dusk&amount=0.03&memo=Factura+71&network=testnet`;

    // The name a link gives, its label: in any case or spacing, and in no other.
    like(readPastedLink(`${line("Sofía Design")}${labelled}`, { network: 2 })?.link, filled);
    like(readPastedLink(`${line("sofia  design")}${labelled}`, { network: 2 })?.link, filled);
    disagrees(readPastedLink(`${line("Marek")}${labelled}`, { network: 2 }));
    // A .dusk name it pays: the line's .dusk name is it, or there's none to say otherwise.
    like(readPastedLink(`${line("sofiadesign.dusk")}${named}`, { network: 2 })?.link, { to: "sofiadesign.dusk" });
    like(readPastedLink(`${line("Sofía")}${named}`, { network: 2 })?.link, { to: "sofiadesign.dusk" });
    disagrees(readPastedLink(`${line("alice.dusk")}${named}`, { network: 2 }));
    disagrees(readPastedLink(`${line("alice·dusk")}${named}`, { network: 2 }));

    // An address it pays: the .dusk name the line gives, as the name service says whose it is (`owners`).
    const shared = `${line("sofiadesign.dusk")}${httpsLink}`;
    const OTHER = `${SHIELDED.slice(0, -1)}${SHIELDED.endsWith("1") ? "2" : "1"}`;

    assert.deepEqual(pastedDuskNames(shared), ["sofiadesign.dusk"]);
    for (const owner of [{ account: A }, { account: A, address: SHIELDED }, A, { address: SHIELDED }]) {
      like(readPastedLink(shared, { network: 2, owners: new Map([["sofiadesign.dusk", owner]]) })?.link, filled, JSON.stringify(owner));
    }
    for (const owner of [{ account: B }, B, { account: B, address: SHIELDED }, null]) {
      disagrees(readPastedLink(shared, { network: 2, owners: new Map([["sofiadesign.dusk", owner]]) }), JSON.stringify(owner));
      disagrees(readPastedLink(shared, { network: 2, owners: { "sofiadesign.dusk": owner } }), JSON.stringify(owner));
    }
    // Not looked up, or a lookup that failed: nothing to say otherwise.
    for (const owners of [undefined, new Map(), new Map([["alice.dusk", { account: B }]])]) like(readPastedLink(shared, { network: 2, owners })?.link, filled);
    // A name in look-alike letters or points is looked up as it reads.
    assert.deepEqual(pastedDuskNames(`${line("ѕofiadesign·dusk")}${httpsLink}`), ["sofiadesign.dusk"]);
    disagrees(readPastedLink(`${line("ѕofiadesign·dusk")}${httpsLink}`, { network: 2, owners: new Map([["sofiadesign.dusk", { account: B }]]) }));

    // A shielded address it pays, against the name's shielded address where the name service has one.
    const toShielded = /** @type {string} */ (makePaymentLink({ amount: "0.03", memo: "Factura 71", network: 2, to: SHIELDED }).https);
    const hers = (/** @type {unknown} */ owner) => readPastedLink(`${line("sofiadesign.dusk")}${toShielded}`, { network: 2, owners: new Map([["sofiadesign.dusk", /** @type {any} */ (owner)]]) });

    like(hers({ account: A, address: SHIELDED })?.link, { to: SHIELDED });
    like(hers({ account: A })?.link, { to: SHIELDED });
    disagrees(hers({ account: A, address: OTHER }));

    // Every .dusk name it states must be the link's recipient's: one of two that's another's refuses it.
    const both = `${line("sofiadesign.dusk alice.dusk")}${httpsLink}`;

    assert.deepEqual(pastedDuskNames(both), ["sofiadesign.dusk", "alice.dusk"]);
    disagrees(readPastedLink(both, { network: 2, owners: new Map([["sofiadesign.dusk", { account: A }], ["alice.dusk", { account: B }]]) }));
    like(readPastedLink(both, { network: 2, owners: new Map([["sofiadesign.dusk", { account: A }], ["alice.dusk", { account: A }]]) })?.link, filled);

    // One not looked up is held to the link's label, where it has one.
    const labelledLink = labelled.replace("Sof%C3%ADa+Design", "sofiadesign.dusk");

    like(readPastedLink(`${line("sofiadesign.dusk")}${labelledLink}`, { network: 2 })?.link, filled);
    disagrees(readPastedLink(`sofiadesign.dusk: ${labelled}`, { network: 2 }));
    disagrees(readPastedLink(`alice.dusk: ${labelledLink}`, { network: 2 }));

    // A .dusk name in words that aren't a request's line is looked up too; none in a link alone or a line naming none.
    assert.deepEqual(pastedDuskNames(`sofiadesign.dusk: ${httpsLink}`), ["sofiadesign.dusk"]);
    disagrees(readPastedLink(`sofiadesign.dusk: ${httpsLink}`, { network: 2, owners: new Map([["sofiadesign.dusk", { account: B }]]) }));
    for (const text of [httpsLink, `${line("Chen")}${httpsLink}`, "sofiadesign.dusk", "", null]) assert.deepEqual(pastedDuskNames(text), [], String(text));
  });

  it("reads every .dusk name a message gives, wherever it is: Nandini's to alice.dusk above a link to Amélie", () => {
    // Nandini's: both wallets filled in Amélie and said nothing of alice.dusk, which only "alice.dusk asks you…" did.
    const link = `${testnetSend}?to=${A}&amount=0.012&memo=Invoice+NOV-17c+r37&network=testnet`;
    const amelie = { amountDusk: "0.012", memo: "Invoice NOV-17c r37", to: A };
    const control = `You're asked to pay 0.012 DUSK on Testnet \u00b7 Invoice NOV-17c r37\nPay here: ${link}`;

    like(readPastedLink(control, { network: 2 })?.link, amelie);
    assert.deepEqual(pastedDuskNames(control, { network: 2 }), []);

    for (const pasted of [
      control.replace("DUSK on", "DUSK to alice.dusk on"),
      control.replace("DUSK on", "DUSK to alice\u00b7dusk on"),
      control.replace("DUSK on", "DUSK to \u0430lice.dusk on"),
      `Hi, it's alice.dusk!\n${control}`,
      control.replace("Pay here:", "From alice.dusk.\nPay here:"),
      `alice.dusk: ${link}`,
      `Pay alice.dusk here: ${link}`,
    ]) {
      assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), ["alice.dusk"], pasted);
      // Registered to another account, or to no one: refused.
      for (const owner of [{ account: B }, B, { account: B, address: SHIELDED }, null]) {
        disagrees(readPastedLink(pasted, { network: 2, owners: new Map([["alice.dusk", owner]]) }), pasted);
      }
      // Amélie's own: it agrees.
      like(readPastedLink(pasted, { network: 2, owners: new Map([["alice.dusk", { account: A }]]) })?.link, amelie, pasted);
    }

    // Its points set apart, the line reads as the wallet's own but for its link: refused before any lookup.
    const apart = control.replace("DUSK on", "DUSK to alice \u00b7 dusk on");

    assert.deepEqual(pastedDuskNames(apart, { network: 2 }), []);
    disagrees(readPastedLink(apart, { network: 2 }));
  });

  it("reads the wallet's own words through what can't be seen and letters that look alike: Marek's zero-width space, Cyrillic \u043e and \u041a, You are asked, above a link for 0.15", () => {
    // Marek's T2: one character in the line switched the check off, and the link's 0.15 filled in under 0.002.
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.002", language: "en", memo: "r37 marek T2", network: 2, to: A }).https);
    const l15 = link.replace("amount=0.002", "amount=0.15");
    const line = "You're asked to pay 0.002 DUSK on Testnet \u00b7 r37 marek T2";

    for (const said of [
      line.replace("You're", "You're\u200b"),
      line.replace("You're", "You\u200b're"),
      line.replace("You're", "You're\u200f"),
      line.replace("to pay", "t\u043e pay"),
      line.replace("DUSK", "DUS\u041a"),
      line.replace("DUSK", "\u1d05\u1d1c\ua731\u1d0b"),
      line.replace("DUSK", "\uff24\uff35\uff33\uff2b"),
      line.replace("Testnet", "T\u0435stnet"),
      line.replace("You're asked", "You are asked"),
      line.replace("You're asked", "Y\u043eu are \u0430sked"),
      line.replace("You're asked", "Sof\u00eda asks you"),
      line.replace("You're asked", "Sof\u00eda \u0430sks y\u043eu"),
      line.replace("You're asked to pay", "Please pay"),
      line.replace("You're asked to pay", "Pay"),
    ]) {
      disagrees(readPastedLink(`${said}\nPay here: ${l15}`, { network: 2 }), said);
      // The same words over the link they agree with fill it in.
      like(readPastedLink(`${said}\nPay here: ${link}`, { network: 2 })?.link, { amountDusk: "0.002", memo: "r37 marek T2", to: A }, said);
      // Read as the wallet's own line, they say its memo: another is refused.
      disagrees(readPastedLink(`${said.replace("r37 marek T2", "something else")}\nPay here: ${link}`, { network: 2 }), said);
    }

    // Marek's own words, its "DUSK:" no second link.
    disagrees(readPastedLink(`Please pay 0.002 DUSK: ${l15}`, { network: 2 }));
    like(readPastedLink(`Please pay 0.002 DUSK: ${link}`, { network: 2 })?.link, { amountDusk: "0.002", to: A });
    like(readPastedLink(`Please pay 0.002 DUSK. ${link}`, { network: 2 })?.link, { amountDusk: "0.002", to: A });
  });

  it("refuses a message whose amount shows as another than it is: Marek's 200.0 turned around to show as 0.002", () => {
    const link = /** @type {string} */ (makePaymentLink({ amount: "200", language: "en", memo: "r37 marek T2", network: 2, to: A }).https);

    for (const said of [
      // Turned around by an override, the amount or the whole line.
      "You're asked to pay \u202e200\u202c DUSK on Testnet \u00b7 r37 marek T2",
      "You're asked to pay \u202e002.0\u202c DUSK on Testnet \u00b7 r37 marek T2".replace("002.0", "0.002"),
      "\u202e2T keram 73r \u00b7 tentseT no KSUD 002 yap ot deksa er'uoY\u202c",
      "\u202dPlease pay 200 DUSK\u202c",
      // Its digits apart, as marks and isolates set them apart to show turned around, or what can't be seen in it.
      "You're asked to pay 2\u200f0\u200f0 DUSK on Testnet \u00b7 r37 marek T2",
      "Please pay 2\u2067\u20690\u2067\u20690 DUSK",
      "Please pay 20\u200b0 DUSK",
      // Letters that look like digits.
      "Please pay 2OO DUSK",
      "Please pay 20\u043e DUSK",
    ]) {
      disagrees(readPastedLink(`${said}\nPay here: ${link}`, { network: 2 }), said);
    }
  });

  it("reads an amount from the digits it's written in, never one a digit looks like: Astra's 1, an Arabic-Indic zero and 5, which shows as 1.5", () => {

    for (const [said, amount] of /** @type {const} */ ([
      // An Arabic-Indic zero looks like a point, and Unicode's table reads it as one: 105 shown as 1.5.
      ["You're asked to pay 1\u06605 DUSK on Testnet", "1.5"],
      ["Please pay 1\u06605 DUSK", "1.5"],
      ["Please pay 1\u06605 DUSK", "105"],
      ["You're asked to pay 1\u06605 DUSK on Testnet", "105"],
      // Digits of another script, as they are and as they look: Arabic-Indic 2 and 0,002, Bengali's 4 that looks like an 8.
      ["Please pay \u0662 DUSK", "2"],
      ["Please pay \u0660\u066b\u0660\u0660\u0662 DUSK", "0.002"],
      ["You're asked to pay \u0660\u066b\u0660\u0660\u0662 DUSK on Testnet", "0.002"],
      ["Please pay 0.00\u09ea DUSK", "0.008"],
      ["Please pay 0.00\u09ea DUSK", "0.004"],
    ])) {
      const link = /** @type {string} */ (makePaymentLink({ amount, language: "en", network: 2, to: SHIELDED }).https);

      disagrees(readPastedLink(`${said}\nPay here: ${link}`, { network: 2 }), `${said} ${amount}`);
    }

    // Digits styled as digits are the digits they are: fullwidth, mathematical; and plain ones, as before.
    for (const said of ["Please pay \uff11\uff0e\uff15 DUSK", "Please pay \u{1d7cf}.\u{1d7d3} DUSK", "Please pay 1.5 DUSK", "You're asked to pay 1.5 DUSK on Testnet"]) {
      like(readPastedLink(`${said}\nPay here: ${makePaymentLink({ amount: "1.5", language: "en", network: 2, to: SHIELDED }).https}`, { network: 2 })?.link, { amountDusk: "1.5" }, said);
    }
  });

  it("reads an amount in groups of thousands parted by spaces whole: Astra's Amount: 1 234.5 DUSK", () => {
    const linkFor = (/** @type {string} */ amount) => /** @type {string} */ (makePaymentLink({ amount, language: "en", network: 2, to: SHIELDED }).https);

    for (const space of ["\u202f", "\u00a0", " ", "\u2009"]) {
      for (const said of [`Amount: 1${space}234.5 DUSK`, `Please pay 1${space}234,5 DUSK`, `Pay 1${space}234.5 DUSK, thanks`, `You're asked to pay 1${space}234.5 DUSK on Testnet`, `DUSK 1${space}234.5`]) {
        const pasted = (/** @type {string} */ amount) => `${said}\nPay here: ${linkFor(amount)}`;

        like(readPastedLink(pasted("1234.5"), { network: 2 })?.link, { amountDusk: "1234.5" }, JSON.stringify(said));
        disagrees(readPastedLink(pasted("234.5"), { network: 2 }), JSON.stringify(said));
        disagrees(readPastedLink(pasted("1"), { network: 2 }), JSON.stringify(said));
      }
    }

    // A million in three groups; a group of another size, or a word before it, starts no amount.
    like(readPastedLink(`Please pay 1 000 000 DUSK\nPay here: ${linkFor("1000000")}`, { network: 2 })?.link, { amountDusk: "1000000" });
    like(readPastedLink(`For r37 500 DUSK\nPay here: ${linkFor("500")}`, { network: 2 })?.link, { amountDusk: "500" });
    like(readPastedLink(`In 2026 500 DUSK\nPay here: ${linkFor("500")}`, { network: 2 })?.link, { amountDusk: "500" });
  });

  it("takes a word that isn't a number for none, a .dusk name among them: Astra's Please pay oliver2.dusk here:", () => {
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.03", language: "en", memo: "x", network: 2, to: A }).https);

    for (const [said, name] of [
      ["Please pay oliver2.dusk here:", "oliver2.dusk"],
      ["Pay 2shop.dusk, thanks", "2shop.dusk"],
      ["Send l1sa.dusk the 0.03 DUSK", "l1sa.dusk"],
    ]) {
      const pasted = `${said} ${link}`;

      assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), [name], said);
      like(readPastedLink(pasted, { network: 2 })?.link, { amountDusk: "0.03", to: A }, said);
      like(readPastedLink(pasted, { network: 2, owners: new Map([[name, { account: A }]]) })?.link, { amountDusk: "0.03", to: A }, said);
      disagrees(readPastedLink(pasted, { network: 2, owners: new Map([[name, { account: B }]]) }), said);
    }

    // Names after "pay" that only hold letters a digit looks like, as Li or Io, are no amount; beside DUSK, they are one.
    for (const said of ["Pay Li back for lunch", "Pay Io, thanks", "Pay oliver2 back"]) like(readPastedLink(`${said}\n${link}`, { network: 2 })?.link, { amountDusk: "0.03" }, said);
    for (const said of ["Please pay lO DUSK", "Please pay 30k DUSK"]) disagrees(readPastedLink(`${said}\n${link}`, { network: 2 }), said);
  });

  it("reads no amount with a mark over a digit: Astra's 0 with a dot below, then 002, above a link for 2", () => {

    for (const [said, amount] of /** @type {const} */ ([
      ["You're asked to pay 0\u0323002 DUSK on Testnet", "2"],
      ["You're asked to pay 0\u0323002 DUSK on Testnet", "0.002"],
      ["Please pay 2\u0301 DUSK", "2"],
      ["Please pay 0.0\u033802 DUSK", "0.002"],
      ["Amount: 1\u20e3 DUSK", "1"],
    ])) {
      const link = /** @type {string} */ (makePaymentLink({ amount, language: "en", network: 2, to: SHIELDED }).https);

      disagrees(readPastedLink(`${said}\nPay here: ${link}`, { network: 2 }), `${said} ${amount}`);
    }

    // Marks over letters are read past, as before: "DÚSK" is DUSK, and an accented name says nothing.
    const link = /** @type {string} */ (makePaymentLink({ amount: "2", language: "en", network: 2, to: SHIELDED }).https);

    for (const said of ["Please pay 2 D\u00daSK", "Ren\u00e9e asks you to pay 2 DUSK on Testnet"]) like(readPastedLink(`${said}\nPay here: ${link}`, { network: 2 })?.link, { amountDusk: "2" }, said);
  });

  it("reads no network in a .dusk name, whatever its points: Astra's testnet\u00b7dusk asking on Mainnet", () => {
    const link = `${networks.mainnet.apps.wallet}/dashboard/send?to=testnet.dusk&amount=0.002&network=mainnet`;

    for (const name of ["testnet\u00b7dusk", "Testnet\uff0eDUSK", "pay.testnet\u00b7dusk", "testnet \u00b7 dusk", "testnet\u02d9dusk", "testnet\u2804dusk"]) {
      const pasted = `${name} asks you to pay 0.002 DUSK\nPay here: ${link}`;
      const dusk = name.startsWith("pay") ? "pay.testnet.dusk" : "testnet.dusk";

      assert.deepEqual(pastedDuskNames(pasted, { network: 1 }), [dusk], name);
      if (dusk === "testnet.dusk") like(readPastedLink(pasted, { network: 1 })?.link, { amountDusk: "0.002", to: "testnet.dusk" }, name);
      else disagrees(readPastedLink(pasted, { network: 1 }), name);
    }

    // Testnet named beside it, as a network, is still one.
    for (const said of ["On Testnet: testnet\u00b7dusk asks you to pay 0.002 DUSK", "Testnet. testnet\u00b7dusk"]) {
      disagrees(readPastedLink(`${said}\nPay here: ${link}`, { network: 1 }), said);
    }
  });

  it("refuses a message longer than any the wallets write, and reads a long one without failing: Astra's 150,000 x's before a link", () => {
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.03", language: "en", network: 2, to: SHIELDED }).https);

    for (const pasted of [`${"x".repeat(150_000)}\n${link}`, `${"x ".repeat(75_000)}\n${link}`, `${"0".repeat(150_000)} DUSK\n${link}`, `${"\u200b".repeat(150_000)}x\n${link}`]) {
      disagrees(readPastedLink(pasted, { network: 2 }), pasted.slice(0, 20));
      assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), [], pasted.slice(0, 20));
    }

    // A long word in a message the wallets could write is read as any.
    like(readPastedLink(`${"x".repeat(4_000)}\n${link}`, { network: 2 })?.link, { amountDusk: "0.03" });
  });

  it("reads the whole message, not only the line before its link: Marek's Thanks! between them, Pay me here:, and a line saying 0.15 below one saying 0.002", () => {
    // The extension compared only the line right before the link.
    const link = /** @type {string} */ (makePaymentLink({ amount: "0.002", language: "en", memo: "r37 marek T2", network: 2, to: A }).https);
    const l15 = link.replace("amount=0.002", "amount=0.15");
    const line = "You're asked to pay 0.002 DUSK on Testnet \u00b7 r37 marek T2";
    const his = { amountDusk: "0.002", memo: "r37 marek T2", to: A };

    for (const pasted of [
      `${line}\nThanks!\nPay here: ${l15}`,
      `${line}\nPay me here: ${l15}`,
      `${line}\nPay here \ud83d\udc49 ${l15}`,
      `${line}\n\nPay here: ${l15}`,
      `${line} (updated)\nPay here: ${l15}`,
      `${line}\nPay here:\n${l15}`,
      `${line}\u2028Pay here: ${l15}`,
      `${line}\n${line.replace("0.002", "0.15")}\nPay here: ${l15}`,
      `Hi Marek, it's 0.002 DUSK as we said.\nPay here: ${l15}`,
      `${line}\nIt's on Mainnet now.\nPay here: ${link}`,
      `${line}\nFor chain 1.\nPay here: ${link}`,
    ]) {
      disagrees(readPastedLink(pasted, { network: 2 }), pasted);
      // In a field of one line, as a phone's, its line breaks spaces, or dropped: then it fills in nothing, refused or
      // with "here:" before the link's address, no link.
      disagrees(readPastedLink(pasted.replace(/[\n\u2028]/g, " "), { network: 2 }), pasted);
      assert.equal(readPastedLink(pasted.replace(/[\n\u2028]/g, ""), { network: 2 })?.link ?? null, null, pasted);
    }

    // Lines stating no amount, network or .dusk name of their own may be around it.
    for (const pasted of [
      `Hi Marek,\n${line}\nThanks!\nPay here: ${link}`,
      `${line}\nPay me here: ${link}`,
      `${line}\nPay here \ud83d\udc49 ${link}`,
      `${line}\n\nPay here: ${link}`,
      `Lunch on Friday \ud83c\udf5c\n${line}\nPay here: ${link}`,
      `Still on Testnet, as before.\n${line}\nPay here: ${link}`,
    ]) {
      like(readPastedLink(pasted, { network: 2 })?.link, his, pasted);
    }
  });

  it("says what in the message isn't its link's, as each says it: Marek's 0.002 above a link for 0.15", () => {
    // Nandini's, Lena's and Marek's: "The message and its link don't agree." never said what doesn't.
    const link = `${testnetSend}?to=${A}&amount=0.002&memo=r39+marek+T2&network=testnet`;
    const t2 = `You're asked to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`;
    const short = (/** @type {string} */ id) => `${id.slice(0, 6)}\u2026${id.slice(-6)}`;

    like(readPastedLink(t2, { network: 2 })?.link, { amountDusk: "0.002", memo: "r39 marek T2", to: A });

    // The amount, as the message writes it and as the link asks it.
    disagrees(readPastedLink(t2.replace("amount=0.002", "amount=0.15"), { network: 2 }), "0.15", {
      link: "0.15 DUSK",
      message: "0.002 DUSK",
      part: "amount",
      problem: "The message says 0.002 DUSK; its link asks 0.15 DUSK.",
    });
    for (const [said, message] of [
      ["Please pay 0,002 DUSK", "0,002 DUSK"],
      ["0.002DUSK, thanks", "0.002 DUSK"],
      ["Pay me 2", "2"],
      ["You're asked to pay 0.0\u200b02 DUSK", "0.0\\u200b02 DUSK"],
      ["Please pay 2OO DUSK", "2OO DUSK"],
      // All that the amount read is part of, as written.
      ["Please pay 2 mDUSK", "2 mDUSK"],
      ["Please pay 0 . 002 DUSK", "0 . 002 DUSK"],
      ["Please pay 0.0\ufeff02 DUSK", "0.0\\ufeff02 DUSK"],
      ["Please pay 2e-3 DUSK", "2e-3 DUSK"],
      ["Please pay 0\u00b7002 DUSK", "0\u00b7002 DUSK"],
    ]) {
      disagrees(readPastedLink(`${said}\nPay here: ${link.replace("amount=0.002", "amount=0.15")}`, { network: 2 }), said, { link: "0.15 DUSK", message, part: "amount", problem: `The message says ${message}; its link asks 0.15 DUSK.` });
    }
    // One that reads two ways, in the message or the link or both: said so, and to ask for it written one way.
    disagrees(readPastedLink(`Please pay 1.000 DUSK\nPay here: ${link.replace("amount=0.002", "amount=1")}`, { network: 2 }), "1.000 over 1", {
      link: "1 DUSK",
      message: "1.000 DUSK",
      part: "amount",
      problem: "The message says 1.000 DUSK, which could be 1 or 1000 DUSK; its link asks 1 DUSK. Ask for the amount written one way.",
    });
    disagrees(readPastedLink(`Please pay 1.000 DUSK\nPay here: ${link.replace("amount=0.002", "amount=1.000")}`, { network: 2 }), "1.000 over 1.000", {
      link: "1.000 DUSK",
      message: "1.000 DUSK",
      part: "amount",
      problem: "The message and its link say 1.000 DUSK, which could be 1 or 1000 DUSK. Ask for the amount written one way.",
    });
    disagrees(readPastedLink(`Please pay 1 DUSK\nPay here: ${link.replace("amount=0.002", "amount=1.000")}`, { network: 2 }), "1 over 1.000", {
      problem: "The message says 1 DUSK; its link asks 1.000 DUSK, which could be 1 or 1000 DUSK. Ask for the amount written one way.",
    });

    // None in the message, or none in the link.
    disagrees(readPastedLink(t2.replace("to pay 0.002 DUSK", "for a payment in DUSK"), { network: 2 }), "any amount", {
      link: "0.002 DUSK",
      message: "",
      part: "amount",
      problem: "The message names no amount; its link asks 0.002 DUSK.",
    });
    disagrees(readPastedLink(t2.replace("&amount=0.002", ""), { network: 2 }), "no amount", { link: "", message: "0.002 DUSK", part: "amount", problem: "The message says 0.002 DUSK; its link names no amount." });

    // The network, by its name.
    for (const network of ["Mainnet", "MAINNET", "Chain 1", "M\u0430innet"]) {
      disagrees(readPastedLink(t2.replace("on Testnet", `on ${network}`), { network: 2 }), network, { link: "Testnet", message: "Mainnet", part: "network", problem: "The message says Mainnet; its link pays on Testnet." });
    }

    // The memo, as the line shows it and as the link has it.
    disagrees(readPastedLink(t2.replace("r39 marek T2\n", "r39 marek T3\n"), { network: 2 }), "memo", {
      link: "r39 marek T2",
      message: "r39 marek T3",
      part: "memo",
      problem: "The message's memo is \u201cr39 marek T3\u201d; its link's is \u201cr39 marek T2\u201d.",
    });
    disagrees(readPastedLink(`Pay 1 DUSK \u00b7 Previous payment 2 DUSK\nPay here: ${link.replace("amount=0.002", "amount=1")}`, { network: 2 }), "memo with an amount", {
      link: "r39 marek T2",
      message: "Previous payment 2 DUSK",
      part: "memo",
    });
    disagrees(readPastedLink(t2.replace(" \u00b7 r39 marek T2", ""), { network: 2 }), "no memo", { link: "r39 marek T2", message: "", part: "memo", problem: "The message has no memo; its link's is \u201cr39 marek T2\u201d." });
    disagrees(readPastedLink(t2.replace("&memo=r39+marek+T2", ""), { network: 2 }), "memo, none in its link", { link: "", message: "r39 marek T2", part: "memo", problem: "The message's memo is \u201cr39 marek T2\u201d; its link has none." });

    // Who asks, against its label; a .dusk name, against who it pays, or its label where it isn't looked up.
    const labelled = link.replace("&network=", "&label=Sof%C3%ADa+Design&network=");
    const named = (/** @type {string} */ name, /** @type {string} */ to = link) => `${name} asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${to}`;

    disagrees(readPastedLink(named("Marek", labelled), { network: 2 }), "label", { link: "Sof\u00eda Design", message: "Marek", part: "name", problem: "The message is from Marek; its link is from Sof\u00eda Design." });
    disagrees(readPastedLink(named("sofiadesign.dusk"), { network: 2, owners: new Map([["sofiadesign.dusk", { account: B }]]) }), "owner", {
      link: A,
      message: "sofiadesign.dusk",
      part: "name",
      problem: `The message says sofiadesign.dusk; its link pays ${short(A)}.`,
    });
    disagrees(readPastedLink(named("alice.dusk", link.replace(`to=${A}`, "to=sofiadesign.dusk")), { network: 2 }), "names", {
      link: "sofiadesign.dusk",
      message: "alice.dusk",
      part: "name",
      problem: "The message says alice.dusk; its link pays sofiadesign.dusk.",
    });
    disagrees(readPastedLink(`alice.dusk: ${labelled}`, { network: 2 }), "unlooked", { link: "Sof\u00eda Design", message: "alice.dusk", part: "name", problem: "The message says alice.dusk; its link is from Sof\u00eda Design." });

    // What turns what's shown around, or a line that isn't the wallet's own in no one part: no one part to name.
    disagrees(readPastedLink(t2.replace("0.002 DUSK", "\u202e200.0\u202c DUSK"), { network: 2 }), "turned", { link: "", message: "", part: "other", problem: LINK_DISAGREES });
    disagrees(readPastedLink(t2.replace("0.002 DUSK", "0.002 DUSK to alice \u00b7 dusk"), { network: 2 }), "apart", { part: "other", problem: LINK_DISAGREES });
  });

  it("reads who a request's line says asks as a name, its point spaced or another that looks like one: Marek's sofiadesign . dusk asks you\u2026 above a link to his own account", () => {
    // Marek's T2 with its line naming Sofía's .dusk name, over a link to his own Profile 1: both wallets filled it in.
    const link = `${testnetSend}?to=${A}&amount=0.002&memo=r39+marek+T2&network=testnet`;
    const owners = new Map([["sofiadesign.dusk", { account: B }]]);
    const his = { amountDusk: "0.002", memo: "r39 marek T2", to: A };

    for (const who of [
      "sofiadesign . dusk",
      "sofiadesign. dusk",
      "sofiadesign[.]dusk",
      "sofiadesign\u2e30dusk",
      "sofiadesign\u0323dusk",
      "sofiadesign dot dusk",
      "SofiaDesign . DUSK",
      "sofiadesign  .  dusk",
      "sofiadesign (dot) dusk",
      "sofiadesign\u2025dusk",
      "sofiadesign\u25cfdusk",
      "sofiadesign\u2218dusk",
      "Sof\u00eda (sofiadesign . dusk)",
    ]) {
      const pasted = `${who} asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`;

      assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), ["sofiadesign.dusk"], who);
      disagrees(readPastedLink(pasted, { network: 2, owners }), who, { link: A, message: "sofiadesign.dusk", part: "name" });
      // Over a link to her, whose name it is, it fills in.
      like(readPastedLink(pasted.replace(`to=${A}`, `to=${B}`), { network: 2, owners })?.link, { to: B }, who);
    }

    // A .dusk name as written in who asks is read too, though a full stop and a word follow it: Astra's "sofiadesign.dusk. Studio".
    const studio = `sofiadesign.dusk. Studio asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`;

    assert.ok(pastedDuskNames(studio, { network: 2 }).includes("sofiadesign.dusk"));
    disagrees(readPastedLink(studio, { network: 2, owners }), "studio", { message: "sofiadesign.dusk", part: "name" });

    // A request a wallet shares from a profile named as who asks reads, with that name as its link's label, fills in
    // with no lookup: the label is read as who asks is.
    for (const name of ["sofiadesign dot dusk", "sofiadesign . dusk", "sofiadesign (dot) dusk"]) {
      const labelled = /** @type {string} */ (makePaymentLink({ amount: "0.002", label: name, language: "en", memo: "r39 marek T2", network: 2, to: A }).https);

      like(readPastedLink(requestMessage({ language: "en", link: labelled, lux: 2_000_000n, memo: "r39 marek T2", name, network: "Testnet" }), { network: 2 })?.link, his, name);
    }

    // A name with a full stop that gives no .dusk name, and a sentence that isn't who asks, say nothing.
    for (const pasted of [
      `J. Smith asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`,
      `Mr. Dusk asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`,
      `Thanks. Dusk is great.\nPay here: ${link}`,
    ]) {
      like(readPastedLink(pasted, { network: 2, owners })?.link, his, pasted);
    }
    // "Mr. Dusk" read as a name is mr.dusk, looked up: someone else's is refused.
    assert.deepEqual(pastedDuskNames(`Mr. Dusk asks you to pay 0.002 DUSK on Testnet \u00b7 r39 marek T2\nPay here: ${link}`, { network: 2 }), ["mr.dusk"]);
    assert.deepEqual(pastedDuskNames(`Thanks. Dusk is great.\nPay here: ${link}`, { network: 2 }), []);
  });

  it("reads a number labelled as the total, the amount or the sum as an amount: Marek's Total 0.15 above his request for 0.02", () => {
    // Marek's W19 on his phone: a first line "Total 0.15", with no unit, over his own request for 0.02, filled in 0.02.
    const link = `${testnetSend}?to=${A}&amount=0.02&memo=marek-r10-req&network=testnet`;
    const own = `You're asked to pay 0.02 DUSK on Testnet \u00b7 marek-r10-req\nPay here: ${link}`;
    const his = { amountDusk: "0.02", memo: "marek-r10-req", to: A };

    like(readPastedLink(own, { network: 2 })?.link, his);
    disagrees(readPastedLink(`Total 0.15\n${own}`, { network: 2 }), "W19", { link: "0.02 DUSK", message: "0.15", part: "amount", problem: "The message says 0.15; its link asks 0.02 DUSK." });

    for (const [said, message] of [
      ["Total: 0.15", "0.15"],
      ["TOTAL 0.15", "0.15"],
      ["total = 0,15", "0,15"],
      ["Amount 0.15", "0.15"],
      ["Amount due: 0.15", "0.15"],
      ["Amount to pay: 0.15", "0.15"],
      ["Sum: .15", ".15"],
      ["Subtotal 0.15.", "0.15"],
      ["Grand total 0.15!", "0.15"],
      ["Total 0.1O", "0.1O"],
      ["Total \uff10.\uff11\uff15", "\uff10.\uff11\uff15"],
      ["Total 1 234.5", "1 234.5"],
      ["Total: 0.15 \u20ac", "0.15 \u20ac"],
      ["Total: \u0662", "\u0662"],
      ["Total \u0660.\u0661\u0665", "\u0660.\u0661\u0665"],
    ]) {
      disagrees(readPastedLink(`${said}\n${own}`, { network: 2 }), said, { link: "0.02 DUSK", message, part: "amount" });
    }

    // Its own amount, Marek's W29 among them, and a number that counts or prices something else, say nothing else.
    for (const said of ["Total 0.02", "Total 0.02 DUSK", "Total: 0,02", "Amount 0.020", "Total 2 coffees", "Sum of 3 coffees", "Total 15 EUR", "Totally 15 people", "Pay the full amount 2 days early", "Total for 2 people", "Total 1 234 EUR", "Total: 12 345,5 PLN", "Total \u0662 coffees"]) {
      like(readPastedLink(`${said}\n${own}`, { network: 2 })?.link, his, said);
    }
  });

  it("refuses a Dusk address in the message that isn't the one its link pays: Marek's Pay to Sof\u00eda's account above his request", () => {
    // Marek's W31 on his phone: a first line "Pay to <Sofía's account>" over his own request filled in his account.
    const link = `${testnetSend}?to=${A}&amount=0.02&memo=marek-r10-req&network=testnet`;
    const own = `You're asked to pay 0.02 DUSK on Testnet \u00b7 marek-r10-req\nPay here: ${link}`;
    const his = { amountDusk: "0.02", memo: "marek-r10-req", to: A };
    const short = (/** @type {string} */ id) => `${id.slice(0, 6)}\u2026${id.slice(-6)}`;

    disagrees(readPastedLink(`Pay to ${B}\n${own}`, { network: 2 }), "W31", { link: A, message: B, part: "address", problem: `The message says ${short(B)}; its link pays ${short(A)}.` });

    // However it's set in the words, and in letters that look like its own or with what can't be seen in it.
    for (const said of [`To: ${B}.`, `(${B})`, `Account ${B}, thanks`, `Pay to ${B.slice(0, 40)}\u200b${B.slice(40)}`, `Pay to ${B.replace(/a/g, "\u0430")}`, `Shielded: ${SHIELDED}`]) {
      disagrees(readPastedLink(`${said}\n${own}`, { network: 2 }), said, { part: "address" });
    }
    // An address that differs from the link's only in its middle is cut as far as they differ.
    const middle = Math.floor(A.length / 2);
    const near = `${A.slice(0, middle)}${A[middle] === "z" ? "y" : "z"}${A.slice(middle + 1)}`;
    const read = readPastedLink(`Pay to ${near}\n${own}`, { network: 2 });

    disagrees(read, "near", { link: A, message: near, part: "address" });
    assert.notEqual(/The message says (\S+); its link pays (\S+)\./.exec(String(read?.problem))?.[1], /The message says (\S+); its link pays (\S+)\./.exec(String(read?.problem))?.[2]);

    // An amount in the same word as an address is still read: only the address's own characters aren't an amount.
    disagrees(readPastedLink(`0.002DUSK(${A})\nPay here: ${link.replace("amount=0.02", "amount=0.15")}`, { network: 2 }), "glued", {
      link: "0.15 DUSK",
      message: "0.002 DUSK",
      part: "amount",
      problem: "The message says 0.002 DUSK; its link asks 0.15 DUSK.",
    });
    // An amount and an address with only a comma between: the amount up to the address is read.
    disagrees(readPastedLink(`Pay 0.15,${A}\n${own}`, { network: 2 }), "comma", { link: "0.02 DUSK", message: "0.15", part: "amount", problem: "The message says 0.15; its link asks 0.02 DUSK." });
    disagrees(readPastedLink(`${A}:0.15 DUSK\n${own}`, { network: 2 }), "colon", { link: "0.02 DUSK", message: "0.15 DUSK", part: "amount" });
    like(readPastedLink(`Pay 0.02,${A}\n${own}`, { network: 2 })?.link, his, "its own");

    // A mark over one of an address's letters is that letter: "\u1e41" is an m, not the "rn" Unicode's table makes it.
    const marked = A.replace("m", "m\u0307");

    disagrees(readPastedLink(`Pay to ${marked}\nPay here: ${link.replace(`to=${A}`, `to=${B}`)}`, { network: 2 }), "marked", { link: B, message: A, part: "address" });
    like(readPastedLink(`Pay to ${marked}\n${own}`, { network: 2 })?.link, his, "marked, the link's own");

    // The link's own, and what isn't an address, say nothing.
    for (const said of [`Pay to ${A}`, `Pay ${A}`, `From ${A}:`, `Tx ${"3fa9".repeat(16)}`, `Pay to ${B.slice(0, 60)}`]) {
      like(readPastedLink(`${said}\n${own}`, { network: 2 })?.link, his, said.slice(0, 30));
    }

    // A link paying a .dusk name: the address is held to whose the name is, looked up with the message's names.
    const named = `${testnetSend}?to=sofiadesign.dusk&amount=0.02&memo=marek-r10-req&network=testnet`;
    const pasted = `Pay to ${B}\nYou're asked to pay 0.02 DUSK on Testnet \u00b7 marek-r10-req\nPay here: ${named}`;

    assert.deepEqual(pastedDuskNames(pasted, { network: 2 }), ["sofiadesign.dusk"]);
    disagrees(readPastedLink(pasted, { network: 2, owners: new Map([["sofiadesign.dusk", { account: A }]]) }), "hers is A", {
      link: "sofiadesign.dusk",
      message: B,
      part: "address",
      problem: `The message says ${short(B)}; its link pays sofiadesign.dusk.`,
    });
    disagrees(readPastedLink(pasted, { network: 2, owners: new Map([["sofiadesign.dusk", null]]) }), "no one's", { part: "address" });
    like(readPastedLink(pasted, { network: 2, owners: new Map([["sofiadesign.dusk", { account: B }]]) })?.link, { to: "sofiadesign.dusk" });
    like(readPastedLink(pasted, { network: 2 })?.link, { to: "sofiadesign.dusk" });
    assert.deepEqual(pastedDuskNames(`Hi!\nYou're asked to pay 0.02 DUSK on Testnet \u00b7 marek-r10-req\nPay here: ${named}`, { network: 2 }), []);
  });

  it("fills in a request as the wallets share it in every language they write amounts in, and refuses it with the link's amount changed", () => {
    const languages = "af am ar ar-EG as az be bg bn bo br bs ca cs cy da de de-AT de-CH dz el en en-IN en-ZA es es-419 et eu fa fi fil fr fr-CA fr-CH ga gl gu ha he hi hr hu hy id ig is it it-CH ja ka kk km kn ko ky lo lt lv mk ml mn mr ms my nb ne nl or pa pl ps pt pt-PT ro ru si sk sl sq sr sv sw ta te th tr uk ur uz vi yo zh zh-TW zu";

    for (const language of languages.split(" ")) {
      for (const lux of [30_000_000n, 2_125_000_000n, 1_234_500_000_000n, 1n]) {
        // To a shielded address, whose reading is quick: the amount is what's read here.
        const made = makePaymentLink({ amountLux: lux, language, memo: "Factura 71", network: 2, to: SHIELDED });

        for (const name of ["sofiadesign.dusk", "Chen", null]) {
          const message = requestMessage({ language, link: /** @type {string} */ (made.https), lux, memo: "Factura 71", name, network: "Testnet" });

          like(readPastedLink(message, { network: 2 })?.link, { memo: "Factura 71", to: SHIELDED }, `${language}: ${message}`);
          disagrees(readPastedLink(message.replace(/amount=[^&]+/, "amount=0.15"), { network: 2 }), `${language}: ${message}`);
        }
      }
    }
  });

  it("ends a link pasted alone at its first space or line break, as a chat ends one: what's after it is words after it, a space in its memo too", () => {
    for (const link of [httpsLink, duskLink]) {
      // A space in its memo, or in its amount: refused, not "Factura" or 0 or 3 DUSK.
      assert.deepEqual(readPastedLink(link.replace("Factura+71", "Factura 71"), { network: 2 }), refused(LINK_UNCLEAR, "words-after"), link);
      assert.deepEqual(readPastedLink(link.replace("amount=0.03", "amount=0 .03"), { network: 2 }), refused(LINK_UNCLEAR, "words-after"), link);
      // Spaces and line breaks around it aren't after it.
      like(readPastedLink(` \t${link}\r\n \u0085`, { network: 2 })?.link, filled, link);
    }
  });

  it("refuses words after a link, whatever the link ends with, and never reads them into it: Lena's danke!", () => {
    // Lena's: the wallet's own link with " danke!" after it said "This link's network can't be read. Ask for a new
    // one."; a link ending with its memo took the word into it, "Lena r35 odd danke!".
    const own = /** @type {string} */ (makePaymentLink({ amount: "0.01", memo: "Lena r35", network: 2, to: A }).https);

    for (const link of [
      own,
      `${testnetSend}?to=${A}&amount=0.01&memo=Lena+r35+odd`,
      `${testnetSend}?memo=x&amount=0.01&to=${A}`,
      `${testnetSend}?to=${A}&memo=x&amount=0.01`,
      `${testnetSend}?to=${A}&memo=x&amountLux=10000000`,
      `${testnetSend}?to=${A}&amount=0.01&label=Lena`,
      `dusk:public-${A}@dusk:2?amount=0.01&memo=Lena+r35`,
      `dusk:public-${A}@dusk:2`,
      `dusk:${A}`,
    ]) {
      like(readPastedLink(link, { network: 2 }), { problem: "", reason: "" }, link);

      for (const space of [" ", "\n", "\r\n", "\t", "\u00a0", "\u3000", "\u2028", "\u0085", " \n "]) {
        // A word, a figure, what reads as more of the link, as Marek's link broken before "&amount=0.15".
        for (const words of ["danke!", "5", "&amount=0.15", "thanks, Marek"]) {
          for (const pasted of [`${link}${space}${words}`, `Pay here: ${link}${space}${words}`, `${shared(link)}${space}${words}`]) {
            assert.deepEqual(readPastedLink(pasted, { network: 2 }), refused(LINK_UNCLEAR, "words-after"), JSON.stringify(pasted));
          }
        }
      }
    }
  });

  it("asks nothing where words after the link may be part of it, and says so: a chat page's time, a thanks, a memo cut at its space", () => {
    for (const pasted of [
      `Pay here: ${httpsLink.replace("Factura+71", "Factura 71")}`,
      `Pay here: ${duskLink} thanks!`,
      // Sofía's: the bubble of her chat page copied whole, its time after the link.
      `${shared(httpsLink)} 06:50`,
      `${shared(httpsLink)}\nthanks, Marek`,
    ]) {
      assert.deepEqual(readPastedLink(pasted, { network: 2 }), refused(LINK_UNCLEAR, "words-after"), pasted);
    }
  });

  it("asks nothing with two links in it, wherever they are, and says so: a link's memo carries no other link", () => {
    assert.deepEqual(readPastedLink(`Pay here: ${duskLink} or here: ${httpsLink}`, { network: 2 }), refused(LINK_SEVERAL, "several-links"));
    assert.deepEqual(readPastedLink(`${shared(httpsLink)}\nOr this one: ${httpsLink.replace("0.03", "0.3")}`, { network: 2 }), refused(LINK_SEVERAL, "several-links"));
    // Text that starts with a link: read whole, it took the second link into the first one's memo, and paid Alice.
    for (const pasted of [
      `${duskLink} ${httpsLink}`,
      "dusk:public-alice.dusk?amount=1&memo=x dusk:public-bob.dusk",
      `${testnetSend}?to=${A}&amount=0.03&memo=pay dusk:public-bob.dusk`,
      `${testnetSend}?to=${A}&amount=0.03&memo=or\n${httpsLink}`,
    ]) {
      assert.deepEqual(readPastedLink(pasted, { network: 2 }), refused(LINK_SEVERAL, "several-links"), pasted);
    }
    // One link, and words after it that are no payment link: a space ends it, and never joins them into its memo.
    assert.deepEqual(readPastedLink(`${testnetSend}?to=${A}&amount=0.03&memo=see https://example.com/invoice 71`, { network: 2 }), refused(LINK_UNCLEAR, "words-after"));
  });

  it("refuses what the link alone refuses, as the link alone says it, and gives a link for another network to the page that takes it", () => {
    const cut = `${testnetSend}?to=${A.slice(0, 40)}&amount=0.03&network=testnet`;

    like(readPastedLink(shared(cut), { network: 2 }), { link: null, problem: LINK_BAD_ADDRESS, reason: "unreadable", text: cut });

    const mainnet = /** @type {string} */ (makePaymentLink({ amount: "0.03", memo: "Factura 71", network: 1, to: A }).https);

    assert.deepEqual(readPastedLink(requestMessage({ link: mainnet, lux: 30_000_000n, memo: "Factura 71" }), { network: 2 }), {
      chainId: "dusk:1",
      link: null,
      network: "Mainnet",
      problem: "This request is for Mainnet. You are on Testnet.",
      reason: "other-network",
      text: mainnet,
    });
  });

  it("reads a link to the app's own address where it's told it, as readPaymentLink does", () => {
    const own = `http://localhost:5900/wallet/dashboard/send?to=${A}&amount=0.03&memo=Factura+71`;

    like(readPastedLink(shared(own), { walletUrl: "http://localhost:5900/wallet" })?.link, filled);
    assert.equal(readPastedLink(shared(own)), null);
  });

  it("is no link without one, as an address, a name or words: Send reads it as a recipient", () => {
    for (const pasted of [A, "sofiadesign.dusk", "Pay me back tomorrow", "", "   ", "https://example.com/pay?to=x", `Pay here: https://example.com/send?to=${A}`, null, undefined]) {
      assert.equal(readPastedLink(pasted, { network: 2 }), null, String(pasted));
    }
  });

  it("says why it fills in nothing in both wallets' words", () => {
    assert.equal(LINK_SEVERAL, "That has more than one payment link. Paste just the one to pay.");
    assert.equal(LINK_UNCLEAR, "The words after that link may be part of it. Paste the link alone.");
    assert.equal(LINK_DISAGREES, "The message and its link don't agree.");
  });
});
