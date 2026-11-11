import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nativeRateEstimate, sozuRateEstimate } from "@dusk-network/networks/rates";
import { sozuFee, sozuStake } from "@dusk-network/networks/sozu";

import { activityRows } from "../src/activity.js";
import { GROWTH_MAX_AGE_MS, nativeRewards, stDuskWorth, sozuFacts, sozuGrowth, sozuPointAt, sozuPosition, sozuRate, sozuRateLine, sozuYear } from "../src/sozu.js";
import { DUSK, POOL, entryFrom, entryOf, hash } from "./fixtures/activity.js";
import { readFixture } from "./fixtures/helpers.js";
import { chainArchive, newYear } from "./fixtures/sozu.js";

// Recorded on Testnet: an account's two stakes, and its status read after them;
// another account's unstake and the stake after it; and a third account's two
// unstakes that reached a provisioner, the second of all it had.
const recording = readFixture("sozu-testnet.json");
const { account: ACCOUNT, other: OTHER, third: THIRD } = recording;
const { provisioners, tipHeight } = readFixture("provisioners-mainnet.json");
const entriesOf = (/** @type {string} */ account, /** @type {any[]} */ list) => list.map((raw) => entryFrom(account, raw, recording.details[raw.origin]));
const STAKES = activityRows({ public: entriesOf(ACCOUNT, recording.stakes), account: ACCOUNT, network: 2 });
const ROUND = activityRows({ public: entriesOf(OTHER, recording.round), account: OTHER, network: 2 });
const [UNSTAKE] = ROUND.filter((row) => row.sozu === "unstake");
const UNSTAKES = activityRows({ public: entriesOf(THIRD, recording.unstakes), account: THIRD, network: 2 });
const STATUS = /** @type {any} */ (recording.status);
const BALANCE = BigInt(STATUS.position.balance);
const ST_DUSK = BigInt(STATUS.position.stDusk);
// The same status as the extension's engine keeps it.
const EXTENSION_STATUS = {
  features: STATUS.flags,
  fees: STATUS.fees,
  pool: { exchangeRate: 3.1445, tokenTotalSupply: STATUS.pool.supply, totalStakeLux: STATUS.pool.stake },
  position: { poolBalanceLux: STATUS.position.balance, stDuskBalanceLux: STATUS.position.stDusk },
};
const NATIVE = nativeRateEstimate({ provisioners, tipHeight });

/**
 * The stDUSK token's own transfer of a transaction: what it minted or burned,
 * its data's first u64.
 *
 * @param {any} raw
 */
function tokenTransfer(raw) {
  const [event] = raw.events.filter((/** @type {any} */ e) => e.topic === "transfer" && e.target === STATUS.contracts.stDusk);

  return Buffer.from(event.data, "hex").readBigUInt64LE(0);
}

/**
 * An archive answering each height's `moonlightHistory(sender:)` from the
 * entries it has, as the node does.
 *
 * @param {any[]} entries
 */
function archiveOf(entries) {
  const archive = {
    /** @type {string[]} */
    asked: [],
    /** @param {string} text */
    query: async (text) => {
      archive.asked.push(text);

      return Object.fromEntries(
        [...text.matchAll(/(h\d+): moonlightHistory\(sender: "([^"]+)", fromBlock: (\d+), toBlock: (\d+)\)/g)].map(([, alias, sender, from, to]) => [
          alias,
          { json: entries.filter((raw) => raw.block_height >= Number(from) && raw.block_height <= Number(to) && raw.events.some((/** @type {any} */ e) => e.data?.sender === sender)) },
        ])
      );
    },
  };

  return archive;
}

describe("what a stake with Sozu did", () => {
  it("reads the stDUSK each stake got, to the lux, from the pool's own event", async () => {
    const facts = await sozuFacts({ account: ACCOUNT, archive: archiveOf(recording.stakes), rows: STAKES });

    assert.equal(facts.size, 2);

    for (const raw of recording.stakes) {
      const fact = /** @type {any} */ (facts.get(raw.origin));

      assert.equal(fact.kind, "stake");
      // As the stDUSK token's own transfer says, which this doesn't read.
      assert.equal(fact.stDusk, tokenTransfer(raw));
      // As Sozu's rules say it, at the pool's rate in its event.
      assert.deepEqual(sozuStake(fact.amount, fact.pool, { denominator: 400n, numerator: 1n }), { fee: fact.fee, ok: true, stDusk: fact.stDusk, worth: fact.amount - fact.fee });
    }

    // Both stakes are all the account ever staked: the stDUSK it holds now.
    assert.equal([...facts.values()].reduce((sum, fact) => sum + fact.stDusk, 0n), ST_DUSK);
    assert.equal(/** @type {any} */ (facts.get(recording.stakes[0].origin)).amount, 1000n * DUSK);
    assert.equal(/** @type {any} */ (facts.get(recording.stakes[0].origin)).fee, 2_500_000_000n);
  });

  it("reads the stDUSK an unstake burned", async () => {
    const facts = await sozuFacts({ account: OTHER, archive: archiveOf(recording.round), rows: ROUND });
    const raw = recording.round.find((/** @type {any} */ each) => each.origin === UNSTAKE.hash);
    const fact = /** @type {any} */ (facts.get(UNSTAKE.hash));

    assert.equal(fact.kind, "unstake");
    assert.equal(fact.amount, UNSTAKE.value);
    assert.equal(fact.fee, 0n);
    assert.equal(fact.stDusk, tokenTransfer(raw));
  });

  it("reads the stDUSK an unstake burned where it reached a provisioner, and where it took all there was", async () => {
    const facts = await sozuFacts({ account: THIRD, archive: archiveOf(recording.unstakes), rows: UNSTAKES });
    const read = recording.unstakes.map((/** @type {any} */ raw) => {
      const fact = facts.get(raw.origin);

      return fact && [fact.kind, fact.amount, fact.stDusk];
    });

    // As the vault has the account's stDUSK: from 98,418,603 lux to 66,591,098, then from 95,163,097 to none.
    assert.deepEqual(read, [
      ["unstake", 100_000_000n, 31_827_505n],
      ["unstake", 299_017_938n, 95_163_097n],
    ]);
  });

  it("asks once for all of them, and not again with a cache", async () => {
    const archive = archiveOf(recording.stakes);
    const cache = new Map();

    await sozuFacts({ account: ACCOUNT, archive, cache, rows: STAKES });
    assert.equal(archive.asked.length, 1);

    const again = await sozuFacts({ account: ACCOUNT, archive, cache, rows: STAKES });

    assert.equal(archive.asked.length, 1);
    assert.equal(/** @type {any} */ (again.get(recording.stakes[1].origin)).stDusk, tokenTransfer(recording.stakes[1]));
  });

  it("reads again what a cache from 0.7.1 kept, which could be a lux short", async () => {
    const archive = archiveOf(recording.stakes);
    const cache = new Map();

    await sozuFacts({ account: ACCOUNT, archive, cache, rows: STAKES });

    // As 0.7.1 kept them: under its own key, an unstake's stDUSK a lux short.
    const old = new Map([...cache].map(([key, text]) => [key.replace(/^sozu2:/, "sozu:"), text.replace(/"stDusk":"(\d+)"/, (_, n) => `"stDusk":"${BigInt(n) - 1n}"`)]));
    const read = await sozuFacts({ account: ACCOUNT, archive, cache: old, rows: STAKES });

    assert.equal(archive.asked.length, 2);
    assert.equal(/** @type {any} */ (read.get(recording.stakes[1].origin)).stDusk, tokenTransfer(recording.stakes[1]));
  });

  it("leaves out what the archive doesn't list yet, and what doesn't read as the row's", async () => {
    const archive = archiveOf([]);

    assert.equal((await sozuFacts({ account: ACCOUNT, archive, rows: STAKES })).size, 0);

    const changed = structuredClone(recording.stakes);

    for (const raw of changed) {
      for (const event of raw.events) {
        if (event.topic === "deposit" && typeof event.data === "string") event.data = `${"00".repeat(8)}${event.data.slice(16)}`;
      }
    }

    assert.equal((await sozuFacts({ account: ACCOUNT, archive: archiveOf(changed), rows: STAKES })).size, 0);

    const reverted = structuredClone(recording.stakes);

    for (const raw of reverted) for (const event of raw.events) event.reverted = true;

    assert.equal((await sozuFacts({ account: ACCOUNT, archive: archiveOf(reverted), rows: STAKES })).size, 0);
  });

  it("asks nothing for what isn't a stake or an unstake that went through", async () => {
    const archive = archiveOf([]);
    const failed = activityRows({ public: [entryOf({ contractId: POOL, fnName: "sozu_stake", kind: "contract_call", success: false, value: "0" })], network: 2 });
    const plain = activityRows({ public: [entryOf({ kind: "transfer", value: "5" })], network: 2 });

    await sozuFacts({ account: ACCOUNT, archive, rows: [...failed, ...plain] });
    assert.deepEqual(archive.asked, []);
  });
});

describe("what one stDUSK was worth", () => {
  it("is the pool's DUSK over its stDUSK as a stake's event gave them, in lux, rounded down", async () => {
    assert.equal(stDuskWorth({ stake: 3n * DUSK, supply: DUSK }), 3n * DUSK);
    assert.equal(stDuskWorth({ stake: DUSK, supply: 3n * DUSK }), 333_333_333n);

    // Lena's first stake, as its line in the export says it: 1 stDUSK = 1.840349526 DUSK.
    const facts = await sozuFacts({ account: ACCOUNT, archive: archiveOf(recording.stakes), rows: STAKES });

    assert.equal(stDuskWorth(/** @type {any} */ (facts.get(recording.stakes[0].origin)).pool), 1_840_349_526n);
  });

  it("is nothing for a pool of no stDUSK, or none", () => {
    assert.equal(stDuskWorth({ stake: 5n, supply: 0n }), null);
    assert.equal(stDuskWorth(null), null);
    assert.equal(stDuskWorth(undefined), null);
  });
});

describe("a position with Sozu", () => {
  it("says what went in, what it's worth and what it earned, to the lux", async () => {
    const facts = await sozuFacts({ account: ACCOUNT, archive: archiveOf(recording.stakes), rows: STAKES });

    assert.deepEqual(sozuPosition({ facts, rows: STAKES, status: STATUS }), {
      depositFees: 2_625_000_000n,
      earned: BALANCE - 1050n * DUSK + 2_625_000_000n,
      feesExact: true,
      putIn: 1050n * DUSK,
      stDusk: ST_DUSK,
      takenOut: 0n,
      waiting: 0,
      worthNow: BALANCE,
    });
  });

  it("reads the status as either wallet keeps it", () => {
    assert.deepEqual(sozuPosition({ rows: STAKES, status: EXTENSION_STATUS }), sozuPosition({ rows: STAKES, status: STATUS }));
    // As readSozuStatus gives it, in bigints.
    const bigints = {
      fees: { deposit: { denominator: 10000n, numerator: 25n }, reward: { denominator: 100n, numerator: 10n } },
      pool: { stake: BigInt(STATUS.pool.stake), supply: BigInt(STATUS.pool.supply) },
      position: { balance: BALANCE, stDusk: ST_DUSK },
    };

    assert.deepEqual(sozuPosition({ rows: STAKES, status: bigints }), sozuPosition({ rows: STAKES, status: STATUS }));
  });

  it("works deposit fees out at today's rate where they weren't read, and says so", () => {
    const position = sozuPosition({ rows: STAKES, status: STATUS });

    assert.equal(position.depositFees, 2_625_000_000n);
    assert.equal(position.feesExact, false);
    // Without the rate either, what they came to isn't known, nor what it earned.
    const unread = sozuPosition({ rows: STAKES, status: { position: STATUS.position } });

    assert.equal(unread.depositFees, null);
    assert.equal(unread.earned, null);
    assert.equal(unread.worthNow, BALANCE);
  });

  it("counts what was taken out, and what's put in, taken out, worth and earned add up", async () => {
    const facts = await sozuFacts({ account: OTHER, archive: archiveOf(recording.round), rows: ROUND });
    const worthNow = 6_000n * DUSK;
    const position = sozuPosition({ facts, rows: ROUND, status: { position: { balance: worthNow, stDusk: 1n } } });

    assert.equal(position.putIn, 13_685n * DUSK);
    assert.equal(position.takenOut, 8_664n * DUSK);
    assert.equal(position.depositFees, 34_212_500_000n);
    assert.equal(position.feesExact, true);
    assert.equal(position.worthNow, worthNow);
    assert.equal(/** @type {bigint} */ (position.earned) + position.putIn - /** @type {bigint} */ (position.depositFees), worthNow + position.takenOut);
  });

  it("says nothing of what it earned until the history is whole", () => {
    const position = sozuPosition({ complete: false, rows: STAKES, status: STATUS });

    assert.equal(position.earned, null);
    assert.equal(position.putIn, 1050n * DUSK);
    assert.equal(position.worthNow, BALANCE);
  });

  it("counts neither a stake that failed nor one on its way", () => {
    const failed = entryOf({ contractId: POOL, error: "Panic", fee: "5000000", fnName: "sozu_stake", hash: hash(0xa1), kind: "contract_call", success: false, value: "0" });
    const rows = activityRows({
      account: ACCOUNT,
      network: 2,
      now: Date.UTC(2026, 10, 5),
      pending: [{ amount: "0", contractId: POOL, deposit: "7000000000", fnName: "sozu_stake", hash: hash(0xa2), kind: "contract_call", status: "submitted", submittedAt: Date.UTC(2026, 10, 5) - 1000 }],
      public: [failed, ...entriesOf(ACCOUNT, recording.stakes)],
    });
    const position = sozuPosition({ rows, status: STATUS });

    assert.equal(position.putIn, 1050n * DUSK);
    assert.equal(position.waiting, 1);
  });

  it("is nothing for an account that never staked", () => {
    assert.deepEqual(sozuPosition(), { depositFees: 0n, earned: null, feesExact: true, putIn: 0n, stDusk: null, takenOut: 0n, waiting: 0, worthNow: null });
    assert.equal(sozuPosition({ rows: [], status: { position: { balance: 0n, stDusk: 0n } } }).earned, 0n);
  });
});

describe("what Sozu pays", () => {
  const FEES = { deposit: { denominator: 400n, numerator: 1n }, reward: { denominator: 100n, numerator: 15n } };

  it("works its rate out as both wallets do: from native staking's as it's shown", () => {
    // 86.15% shows as 86%: Sozu's 10% off that is 77.4%, never 77.5% from the figure before rounding.
    assert.equal(sozuRate(0.8615, STATUS), 0.774);
    assert.equal(sozuRate(0.8615, EXTENSION_STATUS), 0.774);
    assert.equal(sozuRate(NATIVE, { fees: FEES }), sozuRateEstimate(Math.round(NATIVE * 100) / 100, FEES.reward));
    assert.equal(sozuRate(null, STATUS), null);
    assert.equal(sozuRate(0.2, {}), null);
  });

  it("says what an amount earns in a year, after Sozu's share and the deposit fee", () => {
    const amount = 1000n * DUSK;
    const year = sozuYear({ amount, nativeRate: 0.24, status: { fees: FEES } });

    // 0.25% of 1,000 off first, then 24% less Sozu's 15% on what's left.
    assert.deepEqual(year, { depositFee: 2_500_000_000n, earned: 200_990_000_000n, rate: 0.204, rewards: 203_490_000_000n, worth: 997_500_000_000n });
    assert.equal(year.depositFee, sozuFee(amount, FEES.deposit));
    // A stake's worth as the pool takes it.
    assert.equal(year.worth, sozuStake(amount, { stake: 1n, supply: 1n }, FEES.deposit).worth);
    assert.deepEqual(sozuYear({ amount: String(amount), nativeRate: 0.24, status: { fees: { deposit: { denominator: "400", numerator: "1" }, reward: { denominator: "100", numerator: "15" } } } }), year);
  });

  it("says less where its figures weren't read, and invents none", () => {
    assert.deepEqual(sozuYear({ amount: DUSK, status: { fees: FEES } }), { depositFee: 2_500_000n, earned: null, rate: null, rewards: null, worth: 997_500_000n });
    assert.deepEqual(sozuYear({ amount: DUSK, nativeRate: 0.24 }), { depositFee: null, earned: null, rate: null, rewards: null, worth: null });
    assert.deepEqual(sozuYear({ amount: 0n, nativeRate: 0.24, status: { fees: FEES } }), { depositFee: 0n, earned: 0n, rate: 0.204, rewards: 0n, worth: 0n });
  });

  it("gives one line of what the rate is made of, from the node's own figures", () => {
    const status = { fees: FEES };
    // What a block pays stakers in Rusk's first period, as nativeRateEstimate counts it: 19.8574 × 0.78.
    const line = sozuRateLine({ provisioners, status, tipHeight });

    assert.equal(NATIVE > 0.2 && NATIVE < 0.3, true);
    assert.equal(line, `15.5 DUSK a block to stakers, 203.6M DUSK staked now: about 24% a year. Less Sozu's 15%: about 20%, and a little over as it restakes rewards every hour.`);
    assert.equal(sozuRateLine({ nativeRate: 0.24, status }), "About 24% a year across the network. Less Sozu's 15%: about 20%, and a little over as it restakes rewards every hour.");
    assert.equal(sozuRateLine({ nativeRate: 0.24 }), "About 24% a year across the network, before Sozu's share.");
    assert.equal(sozuRateLine({ status }), null);
  });

  it("counts what's staked as the estimate does, or its figures wouldn't make its rate", () => {
    // The line's two figures, as it rounds them, give the rate it states.
    const match = /^([\d.]+) DUSK a block to stakers, ([\d.]+)M DUSK staked now/.exec(/** @type {string} */ (sozuRateLine({ provisioners, status: {}, tipHeight })));
    const blocksInAYear = (365.25 * 24 * 60 * 60) / 10;
    const rate = (Number(match?.[1]) * blocksInAYear) / (Number(match?.[2]) * 1e6);

    assert.ok(Math.abs(rate - NATIVE) < 0.002, `${rate} ${NATIVE}`);
    // A provisioner under the least stake, or not eligible yet, isn't counted.
    const notCounted = [...provisioners, { amount: 1000, eligibility: 1 }, { amount: 5e15, eligibility: tipHeight + 1 }];

    assert.equal(sozuRateLine({ provisioners: notCounted, status: {}, tipHeight }), sozuRateLine({ provisioners, status: {}, tipHeight }));
  });

  it("writes the line's numbers in the language's separators", () => {
    const line = /** @type {string} */ (sozuRateLine({ locale: "de-DE", provisioners, status: { fees: FEES }, tipHeight }));

    assert.match(line, /^15,5 DUSK a block to stakers, 203,6\sMio\. DUSK staked now/);
  });
});

describe("how Sozu's stDUSK grew", () => {
  // What the archives answered on 2026-11-06: the tip, the pool's transactions
  // and the events of the blocks with a restake read.
  const { networks: chains } = readFixture("sozu-growth.json");
  const HOUR = 3_600_000;

  /**
   * An archive that answers the tip, a contract's transactions in a range of
   * blocks and a block's events, from a network's recording; `queries` keeps
   * each query.
   *
   * @param {any} chain
   */
  const archiveOf = (chain) => {
    /** @type {string[]} */
    const queries = [];

    return {
      queries,
      query: async (/** @type {string} */ query) => {
        queries.push(query);

        /** @type {Record<string, any>} */
        const data = {};

        if (query.includes("tip: block(height: -1) { header { height } }")) data.tip = { header: { height: chain.tip } };
        for (const [, alias, from, to, contract] of query.matchAll(/(\w+): blockTxs\(range: \[(\d+), (\d+)\], contract: "([0-9a-f]+)"\)/g)) {
          assert.ok(Number(to) - Number(from) < 200, "the archive lists 200 blocks at most");
          data[alias] = contract === chain.pool ? chain.txs.filter((/** @type {any} */ tx) => tx.blockHeight >= Number(from) && tx.blockHeight <= Number(to)) : [];
        }
        for (const [, alias, height] of query.matchAll(/(\w+): contractEvents\(height: (\d+)\)/g)) data[alias] = { json: chain.events[height] ?? [] };

        return data;
      },
    };
  };
  it("measures it from the pool's own restakes, 30 days apart, as Lena did", async () => {
    // Mainnet: 1.2740 DUSK a stDUSK on 7 October, 1.2953 on 6 November.
    const growth = /** @type {any} */ (await sozuGrowth({ archive: archiveOf(chains.mainnet), pool: chains.mainnet.pool }));

    assert.equal(growth.days, 30);
    assert.deepEqual(growth.from, { at: Date.UTC(2026, 9, 7, 11, 5, 17), height: 5_431_889, stake: 42_109_694_827_953_470n, supply: 33_053_801_993_391_055n });
    assert.equal(growth.to.height, 5_690_984);
    assert.equal(Math.round(growth.rate * 1000) / 1000, 0.204);
    assert.equal(sozuRateLine({ growth, locale: "en-GB" }), "stDUSK went from 1.2740 to 1.2953 DUSK over the last 30 days, after Sozu's share.");
    assert.equal(sozuRateLine({ growth, locale: "de-DE", nativeRate: NATIVE, provisioners, tipHeight }), "stDUSK went from 1,2740 to 1,2953 DUSK over the last 30 days, after Sozu's share.");
  });

  it("is the rate shown and what an amount earns, so the line and the figure agree", async () => {
    // Testnet's grew faster than the network's estimate says now.
    const growth = /** @type {any} */ (await sozuGrowth({ archive: archiveOf(chains.testnet), pool: chains.testnet.pool }));
    const percent = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0, style: "percent" });

    assert.equal(sozuRateLine({ growth, locale: "en-GB" }), "stDUSK went from 2.8973 to 3.1513 DUSK over the last 30 days, after Sozu's share.");
    assert.equal(percent.format(/** @type {number} */ (sozuRate(NATIVE, STATUS, growth))), "107%");
    assert.notEqual(sozuRate(NATIVE, STATUS, growth), sozuRate(NATIVE, STATUS));

    const year = sozuYear({ amount: 100n * DUSK, growth, nativeRate: NATIVE, status: STATUS });

    assert.equal(year.rate, growth.rate);
    assert.equal(year.rewards, (/** @type {bigint} */ (year.worth) * BigInt(Math.round(growth.rate * 1e9))) / 1_000_000_000n);
  });

  it("takes three requests, keeps what it read for an hour, and makes one of two reads at once", async () => {
    const archive = archiveOf(chains.mainnet);
    const cache = new Map();
    const now = Date.UTC(2026, 10, 6, 12);
    const [first, second] = await Promise.all([0, 1].map(() => sozuGrowth({ archive, cache, now, pool: chains.mainnet.pool })));

    assert.equal(archive.queries.length, 3);
    assert.deepEqual(first, second);
    assert.deepEqual(await sozuGrowth({ archive, cache, now: now + HOUR - 1, pool: chains.mainnet.pool }), first);
    assert.equal(archive.queries.length, 3);

    await sozuGrowth({ archive, cache, now: now + GROWTH_MAX_AGE_MS, pool: chains.mainnet.pool });
    assert.equal(archive.queries.length, 6);

    // With the tip the app has read, two.
    const told = archiveOf(chains.mainnet);

    assert.deepEqual(await sozuGrowth({ archive: told, pool: chains.mainnet.pool, tipHeight: chains.mainnet.tip }), first);
    assert.equal(told.queries.length, 2);
  });

  it("takes the pool the status names, and checks its figures against the rate now", async () => {
    const growth = /** @type {any} */ (await sozuGrowth({ archive: archiveOf(chains.mainnet), pool: chains.mainnet.pool }));
    // The pool's rate as its latest restake left it.
    const now = { stake: growth.to.stake, supply: growth.to.supply };

    assert.deepEqual(await sozuGrowth({ archive: archiveOf(chains.mainnet), status: /** @type {any} */ ({ contracts: { pool: chains.mainnet.pool }, pool: now }) }), growth);
    // Figures that aren't the pool's rate now aren't the pool's.
    assert.equal(await sozuGrowth({ archive: archiveOf(chains.mainnet), pool: chains.mainnet.pool, status: /** @type {any} */ ({ pool: { stake: now.stake * 2n, supply: now.supply } }) }), null);
  });

  it("checks each caller's own status, also against what's kept or read at once for another", async () => {
    const cache = new Map();
    const archive = archiveOf(chains.mainnet);
    const growth = /** @type {any} */ (await sozuGrowth({ archive, cache, pool: chains.mainnet.pool }));
    const off = /** @type {any} */ ({ pool: { stake: growth.to.stake * 2n, supply: growth.to.supply } });

    // Kept without a status, it's still not the pool's for a status it doesn't match.
    assert.equal(await sozuGrowth({ archive, cache, pool: chains.mainnet.pool, status: off }), null);

    // Read once for two callers at once: each gets its own answer.
    const both = new Map();
    const [plain, checked] = await Promise.all([
      sozuGrowth({ archive: archiveOf(chains.mainnet), cache: both, pool: chains.mainnet.pool }),
      sozuGrowth({ archive: archiveOf(chains.mainnet), cache: both, pool: chains.mainnet.pool, status: off }),
    ]);

    assert.deepEqual(plain, growth);
    assert.equal(checked, null);
  });

  it("is nothing, and throws nothing, for a status whose pool has no stake or no stDUSK", async () => {
    const cache = new Map();
    const archive = archiveOf(chains.mainnet);

    await sozuGrowth({ archive, cache, pool: chains.mainnet.pool });
    for (const pool of [{ stake: 0n, supply: 1n }, { stake: 1n, supply: 0n }]) {
      assert.equal(await sozuGrowth({ archive, cache, pool: chains.mainnet.pool, status: /** @type {any} */ ({ pool }) }), null);
      assert.equal(await sozuGrowth({ archive: archiveOf(chains.mainnet), pool: chains.mainnet.pool, status: /** @type {any} */ ({ pool }) }), null);
    }
  });

  it("is nothing where no restake is found at either end, or the archive can't be read: the rate is worked out as before", async () => {
    const none = { ...chains.mainnet, txs: chains.mainnet.txs.filter((/** @type {any} */ tx) => tx.blockHeight > chains.mainnet.tip - 1000) };

    assert.equal(await sozuGrowth({ archive: archiveOf(none), pool: chains.mainnet.pool }), null);
    assert.equal(
      await sozuGrowth({
        archive: {
          query: async () => {
            throw new Error("The archive answers with HTTP 502");
          },
        },
        pool: chains.mainnet.pool,
      }),
      null
    );
    assert.equal(await sozuGrowth({ archive: archiveOf(chains.mainnet), pool: "not a pool" }), null);
    assert.equal(sozuRateLine({ growth: null, nativeRate: 0.2, status: STATUS, locale: "en-GB" }), sozuRateLine({ nativeRate: 0.2, status: STATUS, locale: "en-GB" }));
  });
});

describe("what native staking paid", () => {
  // What Testnet's archive answered on 2026-11-10, and its provisioners then.
  const recorded = readFixture("native-rewards.json");
  const HOUR = 3_600_000;

  /**
   * An archive that answers the tip, the two ends' times and each block's
   * events from the recording; `queries` keeps each query.
   *
   * @param {(answer: any) => any} [change]
   */
  const archiveOf = (change = (answer) => answer) => {
    /** @type {string[]} */
    const queries = [];

    return {
      queries,
      query: async (/** @type {string} */ query) => {
        queries.push(query);

        return query.includes("tip: block(height: -1)") ? { tip: { header: { height: recorded.tip } } } : change(structuredClone(recorded.answer));
      },
    };
  };

  it("measures what a block paid stakers over the last 30 days, from the stake contract's own rewards, Dusk's tenth left out", async () => {
    // Lena's: the provisioners' rewards grew 17.75 DUSK a block, Dusk's own 1.98574 among them.
    const native = /** @type {any} */ (await nativeRewards({ archive: archiveOf(), provisioners: recorded.provisioners }));

    assert.equal(native.days, 30);
    assert.equal(native.blocks, 6);
    assert.equal(native.perBlock, 15_516_918_020n);
    assert.deepEqual([native.from.height, native.to.height], [recorded.tip - 30 * 8640, recorded.tip]);
    // At the period's own pace, over what's staked now: the 87% the wallets showed, not 100%.
    assert.equal(Math.round(native.rate * 1000) / 1000, 0.872);
    assert.equal(native.staked > 56_000_000n * DUSK && native.staked < 56_200_000n * DUSK, true);
    // How a million is shortened ("56.1M" or "56.1m") is the runtime's own, so it's asked of the same formatter.
    const staked = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1, notation: "compact" }).format(56_100_000);
    assert.equal(sozuRateLine({ locale: "en-GB", native, status: { fees: { reward: { denominator: 10n, numerator: 1n } } } }), `15.5 DUSK a block to stakers over the last 30 days, ${staked} DUSK staked now: about 87% a year. Less Sozu's 10%: about 78%, and a little over as it restakes rewards every hour.`);
  });

  it("takes two requests, one with the app's tip, keeps what it read for an hour, and makes one of two reads at once", async () => {
    const archive = archiveOf();
    const cache = new Map();
    const now = Date.UTC(2026, 10, 10, 12);
    const [first, second] = await Promise.all([0, 1].map(() => nativeRewards({ archive, cache, now, provisioners: recorded.provisioners })));

    assert.equal(archive.queries.length, 2);
    assert.deepEqual(first, second);
    assert.deepEqual(await nativeRewards({ archive, cache, now: now + HOUR - 1, provisioners: recorded.provisioners }), first);
    assert.equal(archive.queries.length, 2);
    await nativeRewards({ archive, cache, now: now + HOUR, provisioners: recorded.provisioners });
    assert.equal(archive.queries.length, 4);
    // Another network's, kept apart.
    await nativeRewards({ archive, cache, network: "mainnet", now: now + HOUR, provisioners: recorded.provisioners });
    assert.equal(archive.queries.length, 6);

    const told = archiveOf();

    assert.deepEqual(await nativeRewards({ archive: told, provisioners: recorded.provisioners, tipHeight: recorded.tip }), first);
    assert.equal(told.queries.length, 1);
  });

  it("counts what's staked at the app's tip, also where what was paid is kept from an earlier one", async () => {
    const archive = archiveOf();
    const cache = new Map();
    const now = Date.UTC(2026, 10, 10, 12);
    const first = /** @type {any} */ (await nativeRewards({ archive, cache, now, provisioners: recorded.provisioners }));
    // A stake that's eligible 100 blocks after the tip read, asked about 200 blocks after it.
    const newcomer = { amount: 1_000_000 * Number(DUSK), eligibility: recorded.tip + 100 };
    const later = /** @type {any} */ (await nativeRewards({ archive, cache, now: now + 1, provisioners: [...recorded.provisioners, newcomer], tipHeight: recorded.tip + 200 }));

    assert.equal(archive.queries.length, 2);
    assert.equal(later.staked, first.staked + 1_000_000n * DUSK);
    assert.ok(later.rate < first.rate);
  });

  it("is nothing where the blocks' rewards can't be read, or nothing is staked: the rate is estimated as before", async () => {
    const thinned = archiveOf((answer) => ({ ...answer, e0: { json: [] }, e1: { json: [{ ...answer.e1.json[0], data: "00" }] }, e2: { json: null }, e3: { json: [{ ...answer.e3.json[0], source: POOL }] } }));

    assert.equal(await nativeRewards({ archive: thinned, provisioners: recorded.provisioners }), null);
    assert.equal(await nativeRewards({ archive: archiveOf(), provisioners: [] }), null);
    assert.equal(await nativeRewards({ archive: { query: async () => Promise.reject(new Error("The archive answers with HTTP 502")) }, provisioners: recorded.provisioners }), null);
    // Half of them read is enough.
    const half = archiveOf((answer) => ({ ...answer, e0: { json: [] }, e1: { json: [] }, e2: { json: [] } }));

    assert.equal((await nativeRewards({ archive: half, provisioners: recorded.provisioners }))?.blocks, 3);
  });
});

describe("what one stDUSK was worth at a moment", () => {
  // Mainnet around the 2026 new year: Sozu restaked at 22:52:09 and 23:52:16 UTC on 31 December.
  const BERLIN = Date.UTC(2025, 11, 31, 23);
  const UTC = Date.UTC(2026, 0, 1);
  // The blocks of a stake before it and an unstake after it, as an account's rows know them.
  const anchors = [newYear.stake, newYear.unstake].map(({ height, timestamp }) => ({ at: timestamp * 1000, height }));

  it("is the pool's rate after its last restake by then, read from the chain: the new year in Berlin, and in UTC an hour on", async () => {
    const archive = chainArchive(newYear);
    const berlin = await sozuPointAt({ archive, at: BERLIN, pool: newYear.pool });
    const utc = await sozuPointAt({ anchors, archive, at: UTC, pool: newYear.pool });

    assert.deepEqual(berlin, { at: Date.UTC(2025, 11, 31, 22, 52, 9), height: 3_059_632, stake: 13_780_497_247_081_399n, supply: 13_046_855_426_301_906n });
    assert.equal(stDuskWorth(berlin), 1_056_231_313n);
    assert.equal(utc?.height, 3_059_992);
    assert.equal(stDuskWorth(utc), 1_056_254_364n);
  });

  it("finds the moment's block in a few requests, fewer from blocks the account's rows know, and keeps what it found for good", async () => {
    const bare = chainArchive(newYear);

    await sozuPointAt({ archive: bare, at: BERLIN, pool: newYear.pool });
    assert.ok(bare.queries.length <= 6, `${bare.queries.length} requests`);

    const told = chainArchive(newYear);
    const cache = new Map();
    const point = await sozuPointAt({ anchors, archive: told, at: BERLIN, cache, pool: newYear.pool });

    assert.equal(told.queries.length, 3);
    assert.deepEqual(await sozuPointAt({ anchors, archive: told, at: BERLIN, cache, pool: newYear.pool }), point);
    assert.equal(told.queries.length, 3);
  });

  it("is nothing where no restake is found before the moment, the archive can't be read, or the moment is past the tip", async () => {
    const idle = { ...newYear, txs: newYear.txs.filter((/** @type {any} */ tx) => tx.blockHeight > 3_060_000) };

    assert.equal(await sozuPointAt({ anchors, archive: chainArchive(idle), at: BERLIN, pool: newYear.pool }), null);
    assert.equal(await sozuPointAt({ anchors, archive: { query: async () => Promise.reject(new Error("The archive answers with HTTP 502")) }, at: BERLIN, pool: newYear.pool }), null);
    assert.equal(await sozuPointAt({ archive: chainArchive(newYear), at: newYear.tip.timestamp * 1000 + 86_400_000, pool: newYear.pool }), null);
    assert.equal(await sozuPointAt({ archive: chainArchive(newYear), at: BERLIN, pool: "not a pool" }), null);
  });
});
