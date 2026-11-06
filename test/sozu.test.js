import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { nativeRateEstimate, sozuRateEstimate } from "@dusk-network/networks/rates";
import { sozuFee, sozuStake } from "@dusk-network/networks/sozu";

import { activityRows } from "../src/activity.js";
import { GROWTH_MAX_AGE_MS, sozuFacts, sozuGrowth, sozuPosition, sozuRate, sozuRateLine, sozuYear } from "../src/sozu.js";
import { DUSK, POOL, entryFrom, entryOf, hash } from "./fixtures/activity.js";
import { readFixture } from "./fixtures/helpers.js";

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
