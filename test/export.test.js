import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { activityRows } from "../src/activity.js";
import { CSV_COLUMNS, accountingCsv, datesPeriod, quarterPeriod } from "../src/export.js";
import { sozuFacts } from "../src/sozu.js";
import { A, B, C, POOL, entryFrom, entryOf, hash, recorded } from "./fixtures/activity.js";
import { readFixture } from "./fixtures/helpers.js";

/** @typedef {import("../src/export.js").ExportOptions} ExportOptions */

// Recorded chains: B sent A 1,000 DUSK at this height, each account's history has it.
const BETWEEN = 4657992;
const SOFIA = "Estudio Sofía, S.L.";
const PERSONAL = "Personal";
const profiles = [{ account: B, address: "shieldedB", name: SOFIA }, { account: A, name: PERSONAL }];
const sozu = readFixture("sozu-testnet.json");
const bridge = readFixture("bridge-status.json");
const deposit = readFixture("duskevm-deposit-history.json");

/**
 * A file's text as a spreadsheet reads it: its fields, with their commas,
 * quotes and line breaks as they were.
 *
 * @param {string} text
 * @returns {string[][]}
 */
function fieldsOf(text) {
  /** @type {string[][]} */
  const lines = [];
  /** @type {string[]} */
  let line = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      line.push(cell);
      cell = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      line.push(cell);
      lines.push(line);
      line = [];
      cell = "";
      i += 1;
    } else {
      cell += char;
    }
  }

  assert.equal(line.length + cell.length, 0, "the file ends with a line's end");

  return lines;
}

/**
 * The lines of a file, each by its columns' names.
 *
 * @param {string} csv
 * @returns {Record<string, string>[]}
 */
function recordsOf(csv) {
  const [head, ...lines] = fieldsOf(csv);

  assert.deepEqual(head, CSV_COLUMNS);

  return lines.map((line) => {
    assert.equal(line.length, head.length, line.join("|"));

    return Object.fromEntries(line.map((value, i) => [head[i], value]));
  });
}

/**
 * The file of some of an account's rows, by what they were read from.
 *
 * @param {string} account
 * @param {Parameters<typeof activityRows>[0]} input
 * @param {Partial<ExportOptions>} [options]
 */
async function fileOf(account, input, options = {}) {
  const rows = activityRows({ account, network: 2, ...input });
  const profile = profiles.find((each) => each.account === account) ?? { account, name: "Other" };
  const result = await accountingCsv({ profile, profiles, rows, ...options });

  return { ...result, records: recordsOf(result.csv) };
}

/**
 * @param {string} account
 * @param {number} height
 * @param {Partial<ExportOptions>} [options]
 */
const recordedFile = (account, height, options) => fileOf(account, { public: [recorded(account, height)] }, options);

describe("the days of a period", () => {
  it("starts on the day itself where the clocks skip midnight", () => {
    const { from } = datesPeriod("2026-09-06", "2026-09-06", { timeZone: "America/Santiago" });
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Santiago" }).format(from);

    assert.equal(day, "2026-09-06");
  });

  it("refuses a day that doesn't exist", () => {
    assert.throws(() => datesPeriod("2026-02-29", "2026-03-01"), RangeError);
    assert.throws(() => datesPeriod("2026-13-01", "2026-13-02"), RangeError);
  });
});

describe("the format", () => {
  it("has Koinly's universal columns, its twelve first and by their exact names", () => {
    assert.deepEqual(CSV_COLUMNS.slice(0, 12), [
      "Date",
      "Sent Amount",
      "Sent Currency",
      "Received Amount",
      "Received Currency",
      "Fee Amount",
      "Fee Currency",
      "Net Worth Amount",
      "Net Worth Currency",
      "Tag",
      "Description",
      "TxHash",
    ]);
  });

  it("writes a date in UTC, an exact amount with a point and no grouping, and its hash", async () => {
    // A transfer of 767,000 DUSK.
    const { records } = await recordedFile(B, 4643730);

    assert.deepEqual(records, [
      {
        Account: B,
        "Account Name": SOFIA,
        Counterparty: records[0].Counterparty,
        "Counterparty Name": "",
        Date: "2026-10-21 01:04:44",
        Description: "",
        "Fee Amount": "0.001853668",
        "Fee Currency": "DUSK",
        "Internal Transfer": "",
        Memo: "",
        "Net Worth Amount": "",
        "Net Worth Currency": "",
        "Received Amount": "",
        "Received Currency": "",
        "Sent Amount": "767000",
        "Sent Currency": "DUSK",
        Tag: "",
        TxHash: "4ebebdb32b6af876f1d03921f41c279f5d75a8f81745521a3c511c97e644b96e",
      },
    ]);
  });

  it("is comma-separated, CRLF-ended and without a BOM, unless one is asked for", async () => {
    const { csv } = await recordedFile(B, 4643730);

    assert.equal(csv.charCodeAt(0), "D".charCodeAt(0));
    assert.match(csv, /^Date,Sent Amount,Sent Currency,/);
    assert.ok(csv.endsWith("\r\n"));

    const withBom = await accountingCsv({ bom: true, profile: profiles[0], rows: [] });

    assert.equal(withBom.csv.charCodeAt(0), 0xfeff);
    assert.equal(withBom.csv.slice(1), `${CSV_COLUMNS.join(",")}\r\n`);
  });

  it("lists a period's rows oldest first", async () => {
    const entries = [4643730, 4643728, 4643726, 4657973].map((height) => recorded(B, height));
    const { records } = await fileOf(B, { public: entries });

    assert.deepEqual(records.map((record) => record.Date), [...records.map((record) => record.Date)].sort());
    assert.equal(records.length, 4);
  });
});

describe("a transfer between a person's own profiles", () => {
  it("is a withdrawal in one file and a deposit in the other, as the format merges them, and neither reads as income", async () => {
    const sent = (await recordedFile(B, BETWEEN)).records[0];
    const received = (await recordedFile(A, BETWEEN)).records[0];

    // What the tool matches them by.
    assert.equal(sent.Date, received.Date);
    assert.equal(sent.TxHash, received.TxHash);
    assert.equal(sent["Sent Amount"], "1000");
    assert.equal(received["Received Amount"], "1000");
    assert.equal(sent["Sent Currency"], received["Received Currency"]);

    for (const record of [sent, received]) {
      assert.equal(record.Tag, "", "no tag, as the format has for income");
      assert.equal(record["Internal Transfer"], "yes");
    }

    // Who it was with, by the name the person gave it, and whose file it is.
    assert.equal(sent["Counterparty Name"], PERSONAL);
    assert.equal(sent["Account Name"], SOFIA);
    assert.equal(sent.Description, `Transfer to own profile ${PERSONAL}`);
    assert.equal(received["Counterparty Name"], SOFIA);
    assert.equal(received["Account Name"], PERSONAL);
    assert.equal(received.Description, `Transfer from own profile ${SOFIA}`);
    // The sender paid the fee; it's not in the other's file.
    assert.equal(sent["Fee Amount"], "0.001854889");
    assert.equal(received["Fee Amount"], "");
  });

  it("is found by a profile's shielded address too", async () => {
    const send = { amount: "2000000000", feePaid: "1000", hash: hash(0x51), kind: "transfer", privacy: /** @type {const} */ ("shielded"), status: "executed", timestamp: Date.UTC(2026, 9, 26), to: "shieldedA" };
    const { records } = await fileOf(B, { pending: [send] }, { profiles: [{ address: "shieldedA", name: PERSONAL }] });

    assert.equal(records[0]["Internal Transfer"], "yes");
    assert.equal(records[0].Description, `Transfer to own profile ${PERSONAL}`);
  });

  it("isn't what a transfer with anyone else is", async () => {
    const { records } = await recordedFile(A, 4655845);

    assert.equal(records[0]["Internal Transfer"], "");
    assert.equal(records[0].Description, "");
    assert.equal(records[0].Tag, "");
    assert.equal(records[0]["Received Amount"], "1100");
  });
});

describe("staking", () => {
  it("tags rewards claimed as income, with the fee on the same line", async () => {
    const { records } = await recordedFile(B, 4643701);

    assert.equal(records.length, 1);
    assert.equal(records[0].Tag, "reward");
    assert.equal(records[0]["Received Amount"], "62166.587991666");
    assert.equal(records[0]["Received Currency"], "DUSK");
    assert.equal(records[0]["Fee Amount"], "0.033029329");
    assert.equal(records[0].Description, "Staking rewards claimed");
  });

  it("tags an unstake, which the format leaves out, and keeps its fee in on a line of its own", async () => {
    const { records } = await recordedFile(B, 4643699);

    assert.deepEqual(
      records.map((record) => [record.Tag, record["Sent Amount"], record["Received Amount"], record["Fee Amount"], record.Description]),
      [
        ["unstake", "", "500000", "", "Native unstake"],
        ["cost", "0.03307096", "", "", "Network fee: Native unstake"],
      ]
    );
    assert.equal(records[0].TxHash, records[1].TxHash);
    assert.equal(records[0].Date, records[1].Date);
  });

  it("tags a native stake", async () => {
    const stake = entryOf({ contractId: "02".padEnd(64, "0"), counterparty: "02".padEnd(64, "0"), fee: "2000000", kind: "stake", value: "1000000000000" });
    const { records } = await fileOf(B, { public: [stake] });

    assert.deepEqual(
      records.map((record) => [record.Tag, record["Sent Amount"], record["Fee Amount"]]),
      [
        ["stake", "1000", ""],
        ["cost", "0.002", ""],
      ]
    );
  });

  const rowsOf = (/** @type {string} */ account, /** @type {any[]} */ list) => activityRows({ account, network: 2, public: list.map((raw) => entryFrom(account, raw, sozu.details[raw.origin])) });
  const archiveOf = (/** @type {any[]} */ entries) => ({
    query: async (/** @type {string} */ text) =>
      Object.fromEntries([...text.matchAll(/(h\d+): moonlightHistory\(sender: "[^"]+", fromBlock: (\d+)/g)].map(([, alias, from]) => [alias, { json: entries.filter((raw) => raw.block_height === Number(from)) }])),
  });

  it("makes a stake with Sozu a trade of DUSK for stDUSK, with its fees, once its stDUSK is known", async () => {
    const rows = rowsOf(sozu.account, sozu.stakes);
    const facts = await sozuFacts({ account: sozu.account, archive: archiveOf(sozu.stakes), rows });
    const { csv } = await accountingCsv({ facts, profile: { account: sozu.account, name: "Lena" }, rows });
    const [first, second] = recordsOf(csv);

    assert.equal(first.Date, "2026-05-31 14:00:40");
    assert.equal(first["Sent Amount"], "1000");
    assert.equal(first["Sent Currency"], "DUSK");
    assert.equal(first["Received Amount"], "542.016603574");
    assert.equal(first["Received Currency"], "stDUSK");
    assert.equal(first["Fee Amount"], "0.00214169");
    assert.equal(first.Tag, "");
    assert.equal(first.Description, "Staked with Sozu, deposit fee 2.5 DUSK, 1 stDUSK = 1.840349526 DUSK");
    assert.equal(second["Received Amount"], "25.563649581");
  });

  it("makes an unstake the trade back, of the stDUSK it burned", async () => {
    const rows = rowsOf(sozu.other, sozu.round);
    const facts = await sozuFacts({ account: sozu.other, archive: archiveOf(sozu.round), rows });
    const { csv } = await accountingCsv({ facts, profile: { account: sozu.other, name: "Lena" }, rows });
    const unstake = recordsOf(csv).find((record) => record["Received Currency"] === "DUSK");

    assert.equal(unstake?.["Sent Amount"], "5723.2825315");
    assert.equal(unstake?.["Sent Currency"], "stDUSK");
    assert.equal(unstake?.["Received Amount"], "8664");
    assert.equal(unstake?.Description, "Unstaked from Sozu, 1 stDUSK = 1.513816582 DUSK");
  });

  it("says what moved where its stDUSK isn't known, under the staking tags, and invents none", async () => {
    const { records } = await fileOf(sozu.account, { public: [entryFrom(sozu.account, sozu.stakes[0], sozu.details[sozu.stakes[0].origin])] });

    assert.deepEqual(
      records.map((record) => [record.Tag, record["Sent Amount"], record["Sent Currency"], record["Received Amount"], record.Description]),
      [
        ["stake", "1000", "DUSK", "", "Staked with Sozu, its stDUSK not read"],
        ["cost", "0.00214169", "DUSK", "", "Network fee: Staked with Sozu, its stDUSK not read"],
      ]
    );
  });
});

describe("what's only a fee", () => {
  it("is a failed transaction's fee, as nothing moved", async () => {
    const { records } = await recordedFile(B, 3544084);

    assert.equal(records.length, 1);
    assert.equal(records[0]["Sent Amount"], "2000");
    assert.equal(records[0].Tag, "cost");
    assert.equal(records[0]["Fee Amount"], "");
    assert.match(records[0].Description, /^Failed: /);
  });

  it("is a failed stake with Sozu's fee, whatever it tried to move", async () => {
    const failed = entryOf({ contractId: POOL, fee: "5000000", fnName: "sozu_stake", kind: "contract_call", success: false, value: "0" });
    const sent = { amount: "0", contractId: POOL, deposit: "9000000000", fnName: "sozu_stake", hash: hash(0xaa), kind: "contract_call", status: "failed" };
    const { records } = await fileOf(B, { pending: [sent], public: [failed] });

    assert.equal(records.length, 1);
    assert.equal(records[0]["Sent Amount"], "0.005");
    assert.equal(records[0].Description, "Failed: Staked with Sozu");
  });

  it("is a call that moved nothing, as what it was", async () => {
    const { records } = await recordedFile(A, 4658000);

    assert.equal(records[0].Tag, "cost");
    assert.equal(records[0]["Sent Amount"], "0.001959593");
    assert.equal(records[0].Description, "Call commit");
  });

  it("is a transfer to the account itself", async () => {
    const { records } = await recordedFile(B, 2517146);

    assert.equal(records[0].Tag, "cost");
    assert.equal(records[0]["Sent Amount"], "0.000069945");
    assert.equal(records[0].Description, "Transfer to the account itself · extension test");
    assert.equal(records[0].Memo, "extension test");
  });

  it("counts a shield received from someone else as money coming in", async () => {
    const received = { amount: "5000000000", direction: "in", fee: null, hash: hash(0x77), kind: "shield", success: true, timestamp: 1_790_000_000, value: "5000000000" };
    const { records } = await fileOf(B, { shielded: [received] }, { profile: { account: B, address: "shieldedB", name: SOFIA } });

    assert.equal(records.length, 1);
    assert.equal(records[0]["Received Amount"], "5");
  });

  it("is a shield to the profile's own address, which moves nothing out of it", async () => {
    const shield = recorded(B, 2517213);
    const address = /** @type {string} */ (shield.counterparty);
    const own = await fileOf(B, { public: [shield] }, { profile: { account: B, address, name: SOFIA } });

    assert.equal(own.records[0].Tag, "cost");
    assert.equal(own.records[0]["Sent Amount"], "0.025612969");
    assert.equal(own.records[0].Description, "Shield of 13.3517 DUSK, within the profile");

    // Where the app doesn't say the profile's address, it's taken for its own, as a wallet's shield is.
    const unsaid = await fileOf(B, { public: [shield] }, { profile: { account: B, name: SOFIA } });

    assert.equal(unsaid.records[0].Tag, "cost");

    // To another address of the person's, it moved.
    const across = await fileOf(B, { public: [shield] }, { profile: { account: B, address: "another", name: SOFIA }, profiles: [{ address, name: PERSONAL }] });

    assert.equal(across.records[0]["Sent Amount"], "13.3517");
    assert.equal(across.records[0]["Fee Amount"], "0.025612969");
    assert.equal(across.records[0]["Internal Transfer"], "yes");
    assert.equal(across.records[0].Description, `Shield to own profile ${PERSONAL}`);
  });

  it("isn't an unshield the profile's shielded history doesn't have: that's DUSK received", async () => {
    const { records } = await recordedFile(C, 3602438);

    assert.equal(records[0]["Received Amount"], "8.987551049");
    assert.equal(records[0]["Fee Amount"], "");
    assert.equal(records[0].Description, "Unshield");
  });

  it("is an unshield its shielded history has, within the profile, whose shielded side paid", async () => {
    const unshield = recorded(C, 3602438);
    const shielded = { blockHeight: 3602438, direction: /** @type {const} */ ("in"), fee: "12429102", hash: unshield.hash, kind: /** @type {const} */ ("unshield"), success: true, timestamp: Date.UTC(2026, 5, 22), value: "8987551049" };
    const rows = activityRows({ account: C, network: 2, public: [unshield], shielded: [shielded] });
    const { csv } = await accountingCsv({ profile: { account: C, name: "C" }, rows });
    const [record] = recordsOf(csv);

    assert.equal(record.Description, "Unshield of 8.987551049 DUSK, within the profile");
    assert.equal(record.Tag, "cost");
  });
});

describe("a token", () => {
  // Recorded: A called a contract at this height. Here, that call is a token's
  // transfer, sent by the wallet: the chain's row says only that the contract
  // was called, with nothing moved, and the wallet's own record says the rest.
  const CALLED = 4658000;
  const TOKEN = "ab".repeat(32);
  /**
   * The chain's row of a call and the wallet's record of it, as the wallet keeps a
   * token's once it's settled: for what the chain's row lacks.
   *
   * @param {Record<string, unknown>} asset
   * @param {Partial<ExportOptions>} [options]
   * @param {string} [fnName]
   */
  const tokenFile = (asset, options, fnName = "transfer") => {
    const entry = recorded(A, CALLED, { contractId: TOKEN, fnName });

    return fileOf(A, {
      pending: [{ amount: "0", asset, contractId: TOKEN, deposit: "0", fnName, hash: entry.hash, kind: "contract_call", privacy: "public", profileIndex: 0, settled: true, status: "executed", submittedAt: entry.timestamp }],
      public: [entry],
    }, options);
  };
  const SENT = { decimals: 9, driver: "drc20", name: "Token", op: "transfer", symbol: "TKN", to: C, type: "DRC20", valueUnits: "123456789100" };
  const FEE = "0.001959593";

  it("writes a transfer's amount, currency and recipient in the format's own columns, beside its fee", async () => {
    const { records } = await tokenFile(SENT);

    assert.equal(records.length, 1);
    assert.equal(records[0]["Sent Amount"], "123.4567891");
    assert.equal(records[0]["Sent Currency"], "TKN");
    assert.equal(records[0]["Received Amount"], "");
    assert.equal(records[0]["Fee Amount"], FEE);
    assert.equal(records[0]["Fee Currency"], "DUSK");
    assert.equal(records[0].Tag, "");
    assert.equal(records[0].Counterparty, C);
    assert.equal(records[0].Description, `Transfer of TKN, contract ${TOKEN}`);
  });

  it("writes one the wallet alone knows of yet, from its record", async () => {
    const { records } = await fileOf(A, {
      pending: [{ amount: "0", asset: SENT, contractId: TOKEN, deposit: "0", feePaid: "1000000", fnName: "transfer", hash: hash(0x7a), kind: "contract_call", privacy: "public", profileIndex: 0, status: "executed", submittedAt: 1_000, timestamp: 2_000 }],
    });

    assert.equal(records[0]["Sent Amount"], "123.4567891");
    assert.equal(records[0]["Sent Currency"], "TKN");
    assert.equal(records[0]["Fee Amount"], "0.001");
    assert.equal(records[0].Counterparty, C);
  });

  it("is exact to the token's own decimals", async () => {
    for (const [decimals, valueUnits, amount] of [[18, "1000000000000000001", "1.000000000000000001"], [0, "5", "5"], [2, "150", "1.5"], [6, "7", "0.000007"]]) {
      const { records } = await tokenFile({ ...SENT, decimals, valueUnits });

      assert.equal(records[0]["Sent Amount"], amount);
    }
  });

  it("names the recipient as the person asked, and leaves out what isn't them", async () => {
    const contactName = (/** @type {string} */ id) => (id === C ? "Carla" : id === TOKEN ? "the contract" : "");
    const { records } = await tokenFile(SENT, { contactName });

    assert.equal(records[0]["Counterparty Name"], "Carla");
    assert.equal(records[0]["Internal Transfer"], "");
  });

  it("is a transfer between the person's own profiles, which isn't income", async () => {
    const { records } = await tokenFile({ ...SENT, to: B });

    assert.equal(records[0]["Sent Amount"], "123.4567891");
    assert.equal(records[0].Counterparty, B);
    assert.equal(records[0]["Counterparty Name"], SOFIA);
    assert.equal(records[0]["Internal Transfer"], "yes");
    assert.equal(records[0].Description, `Transfer of TKN to own profile ${SOFIA}, contract ${TOKEN}`);
  });

  it("is only a fee when it goes to the account itself", async () => {
    const { records } = await tokenFile({ ...SENT, to: A });

    assert.equal(records.length, 1);
    assert.equal(records[0].Tag, "cost");
    assert.equal(records[0]["Sent Currency"], "DUSK");
    assert.equal(records[0]["Sent Amount"], FEE);
    assert.equal(records[0].Description, "Transfer of TKN to the account itself");
  });

  it("is only a fee when it moved nothing", async () => {
    const { records } = await tokenFile({ ...SENT, valueUnits: "0" });

    assert.equal(records.length, 1);
    assert.equal(records[0].Tag, "cost");
    assert.equal(records[0]["Sent Currency"], "DUSK");
    assert.equal(records[0].Description, `Transfer of no TKN, contract ${TOKEN}`);
  });

  it("moved nothing when it failed: its fee alone", async () => {
    const entry = recorded(A, CALLED, { contractId: TOKEN, error: "Panic", fnName: "transfer", success: false });
    const { records } = await fileOf(A, { pending: [{ asset: SENT, contractId: TOKEN, fnName: "transfer", hash: entry.hash, kind: "contract_call", profileIndex: 0, settled: true, status: "failed" }], public: [entry] });

    assert.equal(records.length, 1);
    assert.equal(records[0]["Sent Currency"], "DUSK");
    assert.equal(records[0].Tag, "cost");
    assert.match(records[0].Description, /^Failed: /);
  });

  it("makes an allowance a fee, saying what it allows and to whom, as nothing moved", async () => {
    const approve = { decimals: 2, op: "approve", spender: C, symbol: "TKN", type: "DRC20", valueUnits: "150" };

    for (const [asset, words] of /** @type {[Record<string, unknown>, string][]} */ ([
      [approve, "Allowance of 1.5 TKN"],
      [{ ...approve, isMax: true, valueUnits: "18446744073709551615" }, "Unlimited allowance of TKN"],
      [{ ...approve, valueUnits: "0" }, "Allowance of TKN removed"],
    ])) {
      const { records } = await tokenFile(asset, {}, "approve");

      assert.equal(records.length, 1);
      assert.equal(records[0].Tag, "cost");
      assert.equal(records[0]["Sent Currency"], "DUSK");
      assert.equal(records[0]["Sent Amount"], FEE);
      assert.equal(records[0].Counterparty, C);
      assert.equal(records[0].Description, `${words}, contract ${TOKEN}`);
    }
  });

  it("keeps DUSK a call paid beside it, on a line of its own", async () => {
    const entry = recorded(A, CALLED, { contractId: TOKEN, fnName: "transfer", value: "2000000000" });
    const { records } = await fileOf(A, { pending: [{ asset: SENT, contractId: TOKEN, deposit: "2000000000", fnName: "transfer", hash: entry.hash, kind: "contract_call", profileIndex: 0, settled: true, status: "executed" }], public: [entry] });

    assert.deepEqual(records.map((record) => [record["Sent Amount"], record["Sent Currency"], record["Fee Amount"]]), [["123.4567891", "TKN", FEE], ["2", "DUSK", ""]]);
  });

  it("asks no price of DUSK for what isn't DUSK, leaves its value empty and counts it", async () => {
    /** @type {unknown[]} */
    const asked = [];
    const { records, unpriced } = await tokenFile(SENT, {
      price: (at) => {
        asked.push(at);

        return "0.5";
      },
    });

    assert.deepEqual(asked, []);
    assert.equal(records[0]["Net Worth Amount"], "");
    assert.equal(records[0]["Net Worth Currency"], "");
    assert.equal(unpriced, 1);
  });

  it("never reads a token's own words as a formula, or lets them hide anything", async () => {
    const { records } = await tokenFile({ ...SENT, symbol: "=HYPERLINK(1)", to: "@evil\u202e" });

    assert.equal(records[0]["Sent Currency"], "'=HYPERLINK(1)");
    assert.match(records[0].Counterparty, /^'@evil\\u202e$/);
    assert.ok(!records[0].Description.includes("\u202e"));
  });

  it("leaves a token's recipient empty when its record has none, never naming the contract called", async () => {
    const { records } = await tokenFile({ ...SENT, to: undefined });

    assert.equal(records[0]["Sent Currency"], "TKN");
    assert.equal(records[0].Counterparty, "");
    assert.ok(!JSON.stringify(records[0]).includes(`"Counterparty":"${TOKEN}"`));
  });

  it("keeps DUSK a call moved when its token moved nothing", async () => {
    const entry = recorded(A, CALLED, { contractId: TOKEN, fnName: "approve", value: "2000000000" });
    const asset = { ...SENT, op: "approve", spender: C, to: undefined };
    const { records } = await fileOf(A, { pending: [{ asset, contractId: TOKEN, deposit: "2000000000", fnName: "approve", hash: entry.hash, kind: "contract_call", profileIndex: 0, settled: true, status: "executed" }], public: [entry] });

    assert.ok(records.some((record) => record["Sent Currency"] === "DUSK" && record["Sent Amount"] === "2"), JSON.stringify(records));
  });

  it("invents no amount from a record it can't read: the fee, as what it was", async () => {
    for (const asset of [{ ...SENT, decimals: undefined }, { ...SENT, decimals: 1_000_000 }, { ...SENT, valueUnits: "12x" }, { ...SENT, valueUnits: "-5" }, { kind: "sozu", action: "stake" }]) {
      const { records } = await tokenFile(asset);

      assert.equal(records.length, 1);
      assert.equal(records[0]["Sent Currency"], "DUSK");
      assert.equal(records[0]["Sent Amount"], FEE);
      assert.equal(records[0].Description, "Call transfer, which may have moved a token: its amount isn't in this wallet's record");
    }
  });
});

describe("the bridge", () => {
  it("says a deposit's DuskEVM address, as what left the wallet", async () => {
    const tx = { blockTimestamp: 1793080300, err: null, gasSpent: 1985878, tx: { callData: { contractId: deposit.entry.events[0].data.receiver, fnName: "depositETHToWithValue" }, gasLimit: 5000000, gasPrice: 1 } };
    const entry = entryFrom(deposit.account, deposit.entry, tx, { bridge: { amount: "500000000", kind: "deposit", to: "0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F" } });
    const { records } = await fileOf(deposit.account, { public: [entry] });

    assert.equal(records[0]["Sent Amount"], "0.5");
    assert.equal(records[0]["Fee Amount"], "0.001985878");
    assert.equal(records[0].Tag, "");
    assert.equal(records[0].Description, "To DuskEVM 0xAB84EDFFd745AF9420ac74FeC73121FBEE9fC86F");
  });

  it("says a transfer to BNB Smart Chain and its fee, as mainnet's chain has it", async () => {
    const [raw] = bridge.mainnet.paid;
    const entry = entryFrom(bridge.mainnet.sender, raw, bridge.mainnet.details[raw.origin], {}, { network: 1 });
    const rows = activityRows({ account: bridge.mainnet.sender, network: 1, public: [entry] });
    const { csv } = await accountingCsv({ profile: { account: bridge.mainnet.sender, name: "Nandini" }, rows });
    const [record] = recordsOf(csv);

    assert.equal(record["Sent Amount"], "20301");
    assert.equal(record["Fee Amount"], "0.001858749");
    assert.equal(record.Description, "To BNB Smart Chain, bridge fee 1 DUSK · 0xe5006cb536a927d13a2cace8e7666d1083b329e0");
    assert.equal(record.Memo, "0xe5006cb536a927d13a2cace8e7666d1083b329e0");
  });

  it("says a migration's payout, as mainnet's chain has it", async () => {
    const raw = bridge.mainnet.sent[1];
    const receiver = raw.events[0].data.receiver;
    const entry = entryFrom(receiver, raw, bridge.mainnet.details[raw.origin], {}, { network: 1 });
    const rows = activityRows({ account: receiver, network: 1, public: [entry] });
    const { csv } = await accountingCsv({ profile: { account: receiver, name: "Nandini" }, rows });
    const [record] = recordsOf(csv);

    assert.equal(record["Received Amount"], "54.325305359");
    assert.equal(record["Fee Amount"], "");
    assert.match(record.Description, /^From BNB Smart Chain · 0xea3e4e/);
  });
});

describe("a period", () => {
  it("is a quarter on the person's clock, from its first moment to the next quarter's", () => {
    assert.deepEqual(quarterPeriod(2026, 4, { timeZone: "UTC" }), { from: Date.UTC(2026, 9, 1), label: "2026-q4", to: Date.UTC(2027, 0, 1) });
    assert.deepEqual(quarterPeriod(2026, 1, { timeZone: "UTC" }), { from: Date.UTC(2026, 0, 1), label: "2026-q1", to: Date.UTC(2026, 3, 1) });

    // Madrid is 2 hours ahead on 1 October, and 1 on 1 January, either side of the clocks changing.
    const madrid = quarterPeriod(2026, 4, { timeZone: "Europe/Madrid" });

    assert.equal(new Date(madrid.from).toISOString(), "2026-09-30T22:00:00.000Z");
    assert.equal(new Date(madrid.to).toISOString(), "2026-12-31T23:00:00.000Z");

    for (const bad of [0, 5, 1.5]) assert.throws(() => quarterPeriod(2026, bad), RangeError);
  });

  it("is any two days, both whole", () => {
    const period = datesPeriod("2026-10-21", "2026-10-22", { timeZone: "UTC" });

    assert.deepEqual(period, { from: Date.UTC(2026, 9, 21), label: "2026-10-21-to-2026-10-22", to: Date.UTC(2026, 9, 23) });
    assert.equal(datesPeriod("2026-12-31", "2026-12-31", { timeZone: "UTC" }).to, Date.UTC(2027, 0, 1));
    assert.throws(() => datesPeriod("yesterday", "2026-10-22"), RangeError);
    assert.throws(() => datesPeriod("2026-10-22", "2026-10-21"), RangeError);
  });

  it("holds the rows in it, and says what it left out", async () => {
    const rows = activityRows({
      account: B,
      network: 2,
      now: Date.UTC(2026, 10, 5),
      pending: [
        { amount: "1000000000", hash: hash(0x71), kind: "transfer", status: "submitted", submittedAt: Date.UTC(2026, 10, 5) - 1000, to: A },
        // The node dropped it: it never happened.
        { amount: "1000000000", hash: hash(0x72), kind: "transfer", status: "removed", submittedAt: Date.UTC(2026, 9, 20), to: A },
      ],
      public: [
        recorded(B, 4643730), // 21 October
        recorded(B, 3449834), // 4 June, a quarter before
        // Not looked up yet: no time, no outcome.
        recorded(B, 4657973, { detailsAt: undefined, success: undefined, timestamp: undefined }),
      ],
    });
    const { count, left, records } = await (async () => {
      const result = await accountingCsv({ period: quarterPeriod(2026, 4, { timeZone: "UTC" }), profile: profiles[0], profiles, rows });

      return { ...result, records: recordsOf(result.csv) };
    })();

    assert.equal(count, 1);
    assert.equal(records[0].Date, "2026-10-21 01:04:44");
    assert.deepEqual(left, { notRead: 1, outOfPeriod: 1, pending: 1 });
  });

  it("counts a time at its edges as a quarter does", async () => {
    const at = (/** @type {number} */ time, /** @type {number} */ n) => entryOf({ counterparty: A, fee: "1", hash: hash(n), timestamp: time, value: "1000000000" });
    const period = quarterPeriod(2026, 4, { timeZone: "UTC" });
    const rows = activityRows({ account: B, network: 2, public: [at(period.from - 1, 1), at(period.from, 2), at(period.to - 1, 3), at(period.to, 4)] });
    const { csv } = await accountingCsv({ period, profile: profiles[0], rows });

    assert.deepEqual(recordsOf(csv).map((record) => record.TxHash), [hash(2), hash(3)]);
  });
});

describe("a memo", () => {
  const withMemo = (/** @type {string} */ memo) => entryOf({ counterparty: C, fee: "1000", memo, value: "1000000000" });

  it("survives with its commas, quotes and line breaks", async () => {
    for (const memo of ['Factura 33, "abril", 2026', "Línea 1\nLínea 2\r\nLínea 3", "semi;colon", "a,b\n\"c\",d", "“curly” — ñ €"]) {
      const { records } = await fileOf(B, { public: [withMemo(memo)] });

      assert.equal(records[0].Memo, memo, memo);
      assert.equal(records[0].Description, memo, memo);
      assert.equal(records.length, 1, memo);
    }
  });

  it("stays beside what the row was", async () => {
    const entry = entryOf({ counterparty: A, fee: "1000", memo: "Factura 33", value: "1000000000" });
    const rows = activityRows({ account: B, network: 2, public: [entry] });
    const { csv } = await accountingCsv({ profile: profiles[0], profiles, rows });

    assert.equal(recordsOf(csv)[0].Description, `Transfer to own profile ${PERSONAL} · Factura 33`);
  });

  it("is never read as a formula", async () => {
    for (const memo of ["=HYPERLINK(1)", "+1", "-1", "@SUM(A1)"]) {
      const { records } = await fileOf(B, { public: [withMemo(memo)] });

      assert.equal(records[0].Memo, `'${memo}`, memo);
      assert.equal(records[0].Description, `'${memo}`, memo);
    }
  });

  it("hides nothing from whoever reads the file", async () => {
    const { records } = await fileOf(B, { public: [withMemo("pay \u202E0001\u202C DUSK")] });

    assert.equal(records[0].Memo, "pay \\u202e0001\\u202c DUSK");
  });
});

describe("the value at the time of payment", () => {
  const at = Date.UTC(2026, 9, 26, 13, 32);
  const sent = entryOf({ counterparty: A, fee: "1853668", timestamp: at, value: "1500000000" });

  it("leaves its columns empty without a price lookup", async () => {
    const { records, unpriced } = await fileOf(B, { public: [sent] });

    assert.equal(records[0]["Net Worth Amount"], "");
    assert.equal(records[0]["Net Worth Currency"], "");
    assert.equal(unpriced, 0);
  });

  it("is the app's price at the row's own time, to the cent", async () => {
    /** @type {any[]} */
    const asked = [];
    const { records, unpriced } = await fileOf(B, { public: [sent] }, { currency: "EUR", price: (query) => (asked.push(query), "0.25") });

    assert.deepEqual(asked, [{ at, coin: "DUSK" }]);
    // The value of what moved, 1.5 DUSK, not the unit's.
    assert.equal(records[0]["Net Worth Amount"], "0.38");
    assert.equal(records[0]["Net Worth Currency"], "EUR");
    assert.equal(unpriced, 0);
  });

  it("takes a price as a number, or as a promise of one, and exactly", async () => {
    const whole = entryOf({ counterparty: A, fee: "1", timestamp: at, value: "123456789012345" });

    assert.equal((await fileOf(B, { public: [whole] }, { price: async () => 0.1 })).records[0]["Net Worth Amount"], "12345.68");
    assert.equal((await fileOf(B, { public: [whole] }, { price: () => "1.123456789" })).records[0]["Net Worth Amount"], "138698.37");
    assert.equal((await fileOf(B, { currency: "USD", public: [whole] }, { currency: "USD", price: () => 2 })).records[0]["Net Worth Currency"], "USD");
  });

  it("keeps a fee's small value from reading as nothing", async () => {
    const { records } = await fileOf(B, { public: [entryOf({ contractId: "cd".repeat(32), fee: "1853668", fnName: "pay", kind: "contract_call", timestamp: at, value: "0" })] }, { price: () => "0.12" });

    assert.equal(records[0]["Net Worth Amount"], "0.00022244");
  });

  it("leaves a row out of the price where the app has none, or its lookup fails, and counts it", async () => {
    for (const price of [() => null, () => undefined, () => "soon", () => -1, () => Number.NaN, async () => { throw new Error("no price"); }]) {
      const { records, unpriced } = await fileOf(B, { public: [sent] }, { price: /** @type {any} */ (price) });

      assert.equal(records[0]["Net Worth Amount"], "");
      assert.equal(records[0]["Net Worth Currency"], "");
      assert.equal(unpriced, 1);
    }
  });

  it("asks once for each time, a transaction's two lines together", async () => {
    let asked = 0;
    const { records } = await recordedFile(B, 4643699, { price: () => ((asked += 1), "1") });

    assert.equal(asked, 1);
    assert.deepEqual(records.map((record) => record["Net Worth Amount"]), ["500000.00", "0.03"]);
  });
});

describe("the file's name", () => {
  it("carries the profile's name, and the period's", async () => {
    const { fileName } = await accountingCsv({ period: quarterPeriod(2026, 4, { timeZone: "UTC" }), profile: profiles[0], rows: [] });

    assert.equal(fileName, "dusk-estudio-sofia-s-l-2026-q4.csv");
    assert.equal((await accountingCsv({ period: datesPeriod("2026-10-01", "2026-10-31"), profile: profiles[1], rows: [] })).fileName, "dusk-personal-2026-10-01-to-2026-10-31.csv");
  });

  it("says a test network, and is one a file system takes, whatever the name", async () => {
    assert.equal((await accountingCsv({ network: "Testnet", profile: { name: "Ana" }, rows: [] })).fileName, "dusk-ana-testnet-all.csv");
    assert.equal((await accountingCsv({ network: "mainnet", profile: { name: "Ana" }, rows: [] })).fileName, "dusk-ana-all.csv");

    for (const [name, slug] of [["../../etc/passwd", "etc-passwd"], ["a/b\\c:d*e?f", "a-b-c-d-e-f"], ["Анна", "анна"], ["日本語", "日本語"], ["Ana \u202Eevil", "ana-evil"], ["***", "profile"], [null, "profile"], ["x".repeat(100), "x".repeat(60)]]) {
      assert.equal((await accountingCsv({ profile: { name: /** @type {any} */ (name) }, rows: [] })).fileName, `dusk-${slug}-all.csv`, String(name));
    }
  });
});

describe("who the other side is", () => {
  it("is the verified name or the one typed for it, and the person's contact only where they asked", async () => {
    const entry = recorded(A, 4655845);
    const counterparty = /** @type {string} */ (entry.counterparty);
    const named = await fileOf(A, { names: new Map([[counterparty, "faucet.dusk"]]), public: [entry] });

    assert.equal(named.records[0]["Counterparty Name"], "faucet.dusk");
    assert.equal(named.records[0].Counterparty, counterparty);

    const contact = await fileOf(A, { public: [entry] }, { contactName: () => "The faucet" });

    assert.equal(contact.records[0]["Counterparty Name"], "The faucet");
    assert.equal((await fileOf(A, { public: [entry] })).records[0]["Counterparty Name"], "");
    // Never as a formula.
    assert.equal((await fileOf(A, { public: [entry] }, { contactName: () => "=1+1" })).records[0]["Counterparty Name"], "'=1+1");
  });

  it("is the person's own name for their profile, before any other", async () => {
    const { records } = await fileOf(B, { names: new Map([[A, "faucet.dusk"]]), public: [recorded(B, BETWEEN)] }, { contactName: () => "A contact" });

    assert.equal(records[0]["Counterparty Name"], PERSONAL);
  });
});
