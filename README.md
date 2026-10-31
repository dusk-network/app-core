# @dusk-network/app-core

Shared logic for the Dusk apps: public and shielded history, activity rows, bridge arrivals and DuskEVM withdrawals.

It has no framework and runs in a browser extension's service worker. Each part is its own entry point, so an app loads only what it uses. Apps pass in their own fetch, batching and storage; the package never chooses storage keys.

Network data (endpoints, contracts, routes) comes from [`@dusk-network/networks`](https://github.com/dusk-network/networks).

## Install

From npm:

```sh
npm i @dusk-network/app-core
```

From JSR, where it's `@dusk/app-core`:

```sh
npx jsr add @dusk/app-core
deno add jsr:@dusk/app-core
```

The entry points are the same on both, under each registry's name: `@dusk-network/app-core/history` on npm is `@dusk/app-core/history` on JSR.

## Entry points

| Import | What it gives |
|---|---|
| `@dusk-network/app-core/history` | A public account's history from the Dusk archive, synced by block height into the app's store (`createHistory`), through the archive's GraphQL (`createArchive`, `historyArchiveUrl`); its entries as facts (`parseHistoryEntry`, `historyEntry`); a range of heights (`historyRange`); a transaction's details (`fetchTxDetails`, `fetchTxNonce`); and the heights a history covers (`addCoverage`, `topGap`, `shownDownTo`) |
| `@dusk-network/app-core/shielded` | A profile's shielded history from the notes its shielded sync keeps, each block asked for among kept decoys (`shieldedHistory`); its entries as facts (`shieldedEntries`); the blocks at the notes' heights (`fetchShieldedBlocks`); the note tree's heights and the decoys drawn from them (`noteTreeHeights`, `readNoteHeights`, `createLeafHeightTap`, `pickHeights`, `leafInfo`) |
| `@dusk-network/app-core/activity` | An account's activity as rows of facts, one per transaction, newest first, from its public and shielded history and the wallet's own sends (`activityRows`), and the sends the chain's rows now say all of (`settleSends`) |
| `@dusk-network/app-core/bridge` | The other side of the bridge's routes: where a deposit to DuskEVM arrived (`depositArrivals`), a migration's payout on Dusk (`migrationPayouts`), and where a transfer out to BNB Smart Chain arrived (`serviceArrivals`); the history's entries as those transfers (`depositOf`, `migrationPayoutOf`, `serviceTransferOf`); and the arrivals as `/activity` takes them (`arrivalsOf`) |
| `@dusk-network/app-core/duskevm-withdrawals` | A DuskEVM withdrawal's life, signing aside: its start on DuskEVM (`withdrawalCall`), finding an address's withdrawals (`syncWithdrawals`, `explorerWithdrawals`, `withdrawalsByNonce`), and on Dusk where each is, its proof and its claim, ready for the app's wallet to sign (`createWithdrawals`) |

Every entry point has its `.d.ts`. The one runtime dependency is `@dusk-network/networks`. `/duskevm-withdrawals` also takes [viem](https://viem.sh) (`^2.55.2`), an optional peer: an app installs it to use that entry, and no other entry imports it.

## History

```js
import { createArchive, createHistory, historyArchiveUrl } from "@dusk-network/app-core/history";

const archive = createArchive({
  url: historyArchiveUrl({ nodeUrl, archiveUrl }), // the node, when the archive is another chain's
  fetch,
  refusals: { get: getRefusal, put: putRefusal }, // when nodes answered without the archive, by URL
});
const history = createHistory({ archive, account, network: chainId, store });

await history.sync({ onStep: () => redraw() }); // one run
const { entries, complete } = await history.read({ limit: 50 });
// entries[0]: { hash, blockHeight, direction: "out", kind: "transfer", value: 1_000_000_000n, fee: 1_849_580n, route, sozu, … }
```

- A run reads the newest heights first, in windows under the last finalized block: a day, then wider while they hold few entries, narrower where a page of 50 fills. It makes at most 8 history requests and 2 details requests (`maxRequests`, 2 at least, and `maxDetailRequests`), and keeps each step as it lands, each page of a block with more than a page too, so the next run carries on where it stopped. A later run asks only for what is above the heights kept.
- A details request that fails ends the run's details, not the run: it reads on, and resolves with `detailsError`. The next run asks for the details again. A history request that fails rejects the run, as does the store.
- `read({ limit, before })` gives the entries above the first gap, newest first: below it, newer ones may be missing. `complete` says every height from the head down is covered. When `limit` cuts through a block, the rest of that block comes too, so `before` the last entry's height reads on without skipping any.
- A node whose GraphQL has no archive is asked nothing for an hour. Without `refusals`, the archive object alone remembers it.
- A node on another chain than the history kept (a reset devnet) makes the run ask the store to `clear()` and start over, within its budget; where another run started it over on that chain already, it carries on from what that run kept. A run another one overtook that way, or whose history was cleared under it, keeps nothing more and rejects with a `StaleHistoryError`.
- `network` is the node's network or its chain ID, for the DuskEVM bridge's calls, the bridge's routes and Sozu. A node of a network there's no file for passes none.
- `fillDetails(entries)` reads the details of entries shown before a run gave them any.

An entry is facts, not text: `direction` ("in", "out", "self"), `kind` (`transfer`, `shield`, `unshield`, `contract_call`, `stake`, `unstake`, `withdraw_reward`), `counterparty`, `value` and `fee` in lux (a gas refund paid to another account counts in the sender's `value` and in that account's, told apart as `refund`), `memo` (as text, or as 0x hex with `memoBinary: true` for bytes that aren't text), and with its details its time, outcome, gas and call. A call to DuskEVM's bridge or Portal has `bridge`, what it did (`decodeBridgeCall`): a deposit's amount and DuskEVM address, or a withdrawal's proof or claim, its hash, whom it pays and its nonce. A transfer with one of the bridge's accounts has its `route` (`routeForAccount`), and a stake or an unstake with Sozu `sozu: true` (`isSozuCall`, with the pools the hub named in `read({ pools })`).

### The store

The app keeps each account's history where it wants, under its own keys, and passes a store for one account on one network. Each method may return a value or a promise.

| Method | Does |
|---|---|
| `getState()` | The sync state, or null before the first run. |
| `commit(entries, update)` | Keeps one step in one transaction: `entries` by hash, an entry kept already keeping the fields these don't carry (its details), and the state `update(kept)` makes from the state kept now. When `update` throws, nothing of the step is kept. Gives the state kept. |
| `patch(details, check)` | Adds details to kept entries, by hash (a `Map`); entries that aren't kept are left alone. |
| `list({ limit, before })` | Kept entries, newest first: at most `limit`, below the height `before` when given. |
| `clear(check)` | Forgets what is kept of the old chain. |

A store that can calls `check(kept)` first, with the state kept now, in the same transaction, and writes nothing when it throws. Then no details go on a history another run started over since, and a run that finds a reset doesn't forget what another one already read of the new chain. A store that doesn't call it works as before.

The state is `{ account, covered, crowded, finalized, genesis, headAt, target, updatedAt, window }`; fields the store keeps beside these stay. An entry is kept with its amounts as decimal strings, so it stores as JSON. A store that rejects a write, as one bound to a wallet that has been reset since, makes the run reject, and nothing more is kept.

### Calls the app reads

Facts the app reads from other contracts' calls come through `callFacts`, as the wallets read a .dusk name's calls with `@duskdomains/sdk/call-facts`. The history asks a call's arguments only when the call is one the app reads, and keeps what it reads with the entry's details:

```js
const history = createHistory({
  archive,
  account,
  network: chainId,
  store,
  callFacts: {
    // Whether a kept entry's call is one the app reads, and what it reads isn't kept yet.
    wants: (entry) => isNameContract(entry.contractId ?? entry.counterparty) && entry.registeredName === undefined,
    // The fields to keep, here the name a registration registered; nothing for another contract's call.
    read: (call, account) => (isNameContract(call.contractId) ? { registeredName: nameOf(call, account) } : {}),
  },
});
```

`wants` is given the entry as the store keeps it, amounts as text, also when the app passes the entries it read. `read` is given every call whose arguments were asked, a bridge call's too. What it keeps must make `wants` false, or the call is asked again next run. Before its details, an entry names its contract only as `counterparty`, when it paid that contract a deposit; a call without one is asked again once its contract is known.

### Other reads

- `historyRange(archive, { account, from, to, direction, pages, page })`: an account's entries between two heights, a page at a time, from `page` on.
- `fetchTxDetails(archive, hashes, options)` and `fetchTxNonce(archive, hash)`: a transaction's time, outcome, fee and call, and its nonce.
- `archive.query(text)`: one GraphQL request, its integers past 2^53 kept as text. A request answered 429, 502, 503 or 504 is sent again, twice at most.

An app with its own GraphQL client passes `query` instead of `fetch`: it takes the query's text and gives the answer's `data`, throwing with the node's message on errors.

## Shielded history

```js
import { createArchive } from "@dusk-network/app-core/history";
import { shieldedHistory } from "@dusk-network/app-core/shielded";

const { entries, pending } = await shieldedHistory({
  archive: createArchive({ url: nodeUrl, fetch, refusals }),
  notes: () => syncedNotes(profile), // [{ leaf, nullifier, spent }], as the shielded sync keeps them
  valueOf: (note) => noteValue(profile, note), // in lux, from the profile's keys
  tree, // the node's note tree: { size(), leaves(from) }
  store, // this profile's kept history
  treeHeights, // the note tree's heights, kept for the network
  synced: true, // the shielded sync has found every note
  isCurrent: () => profile === currentProfile(),
});
// entries[0]: { hash, blockHeight, kind: "unshield", direction: "out", value: "9475570898", fee: "12429102", success: true, timestamp: 1782131528000 }
```

- Shielded transfers are off on Mainnet and Testnet, so a profile's shielded history is final: it is worked out once from its notes, and kept. The same notes again read the kept history and ask nothing. Until `synced`, a read gives what is kept, `pending`, and asks nothing.
- A note's leaf holds the height it entered the note tree at, and the block there says which transaction made it and which of the profile's notes that transaction spent. Each of the profile's heights is asked for among four others that hold notes, drawn from the tree's heights. The decoys are kept, and read back, before any block is asked for, so a read that fails partway asks for the same heights next time. Without another height to ask among, nothing is asked.
- The tree's heights are read once, in one stream of its leaves, and kept for the network; a later read takes only the leaves added since. A shielded sync that streams the tree from its first note can keep them on the way: it pipes its stream through `tap.stream()` of a `createLeafHeightTap()`, and once the stream is read, keeps `tap.heights(total)`, when there are any, as `{ heights, notes: Number(total) }`.
- A history is kept only whole: once each note's block has the event that made it (a note of the genesis block aside) and lists each transaction that spent the profile's notes. Until then, as while the archive is still indexing a block, a read gives what is kept, `pending`, and the next one asks again, among the same decoys.
- `isCurrent` is asked between every two steps, before each request and write, and once more after the history is kept: once the wallet, the profile or the node changed, the read asks and keeps nothing more and rejects. A node that answered without the archive is asked nothing for an hour, its tree included.
- The blocks come 15 heights a request, through the archive of `/history`.

An entry is facts, not text: `kind` (the kinds of `/history`), `direction` for the profile's notes ("in", "out", or "self" when what they spent came back but the fee), `value` and `fee` in lux as decimal strings (a fee only where the profile's notes paid it), `success` and `error`, and its block's `timestamp`. It stores as JSON as it is.

### The stores and the tree

The app keeps the history where it wants, under its own keys, and reads its notes, their values and the note tree through its own wallet library. Each method may return a value or a promise.

| Option | Does |
|---|---|
| `store.get()` | The profile's kept history, `{ fingerprint, entries, decoys }`, or null. Reject when it can't be read: the read then asks nothing rather than draw new decoys. |
| `store.put(record)` | Keeps it in place of the one kept. A put that rejects, as one bound to a wallet that has been reset since, rejects the read. A store that can't keep a history for want of room may pass over it: the read gives it anyway, and the next one works it out again among the same decoys. |
| `treeHeights.get()`, `treeHeights.put({ heights, notes })` | The note tree's distinct heights from its first `notes` leaves, shared by the network's profiles. A put that fails is passed over. |
| `tree.size()` | How many leaves the node's note tree has (the transfer contract's `num_notes`). |
| `tree.leaves(from)` | Its leaves from position `from` on (`leaves_from_pos`): a stream of their bytes, or an answer whose body is one. |

The app runs one read at a time per profile.
## Activity

```js
import { activityRows, settleSends } from "@dusk-network/app-core/activity";

const { entries, state } = await history.read({ limit: 50 });
const rows = activityRows({
  public: entries, // `/history`'s read
  shielded, // `/shielded`'s entries
  pending: sends, // the wallet's own records of what it sent, settled ones too
  account, // a send to it is to itself
  profileIndex, // another profile's sends are left out
  network: chainId, // DuskEVM's bridge, the routes to other chains, and Sozu
  state, // a row without a time yet sorts by the time its height gives
});
// rows[0]: { hash, source: "public", kind: "transfer", category: "sent", direction: "out", value: 1_000_000_000n, fee: 1_849_580n, status: "executed", time, … }
```

- A transaction both the chain and the wallet know is the chain's once its outcome is: its outcome, amount, time and fee come from the chain's history, and the wallet's record adds what the chain doesn't say, as the name typed for the recipient or a shielded send's memo. Until then its amount is what the wallet sent. One the chain has is final, its outcome the one the wallet saw it end with, or `unknown` until its details come.
- A send the chain's histories don't have yet is `pending`: for 15 minutes at most (`PENDING_MS`), unless the node has it in its queue, then `unknown`. One the node dropped is `unknown` and `dropped`. A send marked settled shows with the chain's row alone.
- The shielded side of a shield or an unshield is the public row's, with the fee the shielded side paid.
- `category` is the filter a row is under: "staking" (native and Sozu's), "bridge" (DuskEVM's bridge and the routes to other chains), "sent", "received", or "other" (a shield, an unshield, a transfer to the account itself).
- A call to DuskEVM's bridge or Portal has `bridge`: what it did (`step`: "deposit", "withdrawal", "proof", "claim" or "call"), the amount its call names, a deposit's DuskEVM address and where it arrived there (`arrivals`), a withdrawal's hash, recipient and nonce, and whether a proof's withdrawal is claimed: by a claim of the same activity that went through, is on its way or is on chain, or as the app read it (`claims`).
- A transfer with one of the bridge's accounts has its `route`, and a call of Sozu's pool `sozu`, "stake" or "unstake" (with the pools the hub named in `pools`).
- `nameCall` is the app's hook for the name service, as the wallets read .dusk names with `@duskdomains/sdk/call-facts`: given a call's contract and function, and the entry or the send it is from, it says what the call does, and the name and the reservation it is for. A reservation has the name of a registration after it with the same reservation.

A row is facts, not text: amounts in lux as bigints, `time`, `status`, `counterparty` and its verified name (`counterpartyName`, from `names`), the name typed for it (`toName`), and `sent` and `entry`, the wallet's record and the public entry, as given. The words are the app's.

### Settling sends

```js
const { drop, keep } = settleSends({ public: entries, shielded, pending: sends });
// drop: the hashes of the sends the chain's rows now say all of, to forget;
// keep: the others the chain has the outcome of, marked settled, to keep for what they add.
```

By default a send adds the name typed for its recipient, or a shielded send's recipient or memo, which the shielded history doesn't have; `keeps(send)` says what else does. A failed send that tried to move an amount is always kept: the chain's row says it moved nothing.

## Bridge

```js
import { arrivalsOf, depositArrivals, depositOf } from "@dusk-network/app-core/bridge";

const { arrivals } = await depositArrivals({
  network: chainId,
  deposits: entries.map((entry) => depositOf(entry, account)).filter(Boolean), // `/history`'s entries
  taken: keptArrivals, // the DuskEVM transactions the app's other deposits arrived with
  fetch,
});
// arrivals.get(hash): { state: "arrived", hash: "0x029e…", at: 1793080333000, amount: 500000000n, block: 3951755 }
arrivalsOf(arrivals); // Map { hash => { hash: "0x029e…", at: 1793080333000 } }: `/activity`'s `arrivals`
```

- Each credit pays one transfer. Equal transfers (the same route, recipient and payout) are paid in the order they were sent: the oldest takes the first credit after it, from 2 minutes before its block, as the chains' clocks differ. The app passes the transfers it still waits for, and the credits its others arrived with (`taken`): none of those pays a waiting one, though an earlier transfer read from the chain takes its own back, as one given but not looked for does.
- A transfer's time is its Dusk block's, never the device's clock. One without it yet isn't looked for. One sent more than a week ago (`waitMs`) is unknown, and isn't asked about.
- A deposit is followed on DuskEVM's explorer (`via: "explorer"`, the default): the recipient's incoming calls, newest first, read once for all its deposits, back past the oldest, 5 pages at most. Those calls don't say who deposited, so a payment is a deposit's only when it can't be another's: within 2 minutes either side of its block, once those minutes are over, with no other payment of its amount there (a failed one counts) that isn't another given deposit's. Nothing is asked before then.
- On DuskEVM's RPC (`via: "rpc"`), a deposit is found by DuskEVM's bridge event from its sender's DuskEVM address. With `/history`'s archive, each sender's equal deposits in the hours before its own are read from its history and paid first; a deposit there whose call can't be read leaves the order unclear. Without it, the RPC's credits are taken as the explorer's are. A deposit given without its sender takes no credit from the sender of another equal one given.
- A migration is paid by a transfer to the account from its route's payout account, with the migration's transaction hash as the memo, of exactly its amount: from the account's entries, less any `refund` paid to the account with it, or from the archive's memo index, which gives each payout's own amount. One from that account of another amount leaves it unsure, not waiting: the value of an entry an earlier version kept holds any gas refund paid to the account. With `entries`, the payouts there of migrations the app didn't list come too (`unlisted`), each with its `payer`; where one account pays out more than one route, a payout of a migration not listed doesn't say which: its `route` is null.
- A transfer out is read from the chain: what the route's account received, the address its memo gives as the route's bridge reads it (0x and 40 hex digits, any case, nothing around them), and its block. It arrives with the DUSK token's `Transfer` from its route's payout address to that address, of what the account received less the fee. The account's history lists every transfer that named the same address, in any case: equal ones in the hours before (a given one's by its own fee) are paid first, and one that can't be read leaves the order unclear. One that pays nothing out is `no-payout`, with its `problem`. `serviceTransferOf` gives what left the account (`sent`), and what the account received (`amount`) only where no gas was left to refund: an entry's value holds any refund paid to another account.
- With the archive, each transfer reads only its own hours of its account's history (its sender's for a deposit, the route's account's for a transfer out), further back while equal ones before it run on, and only once the archive lists the transfer there. A call reads 4 pages of it (`HISTORY_PAGES`) for each: a transfer whose history is longer waits, and the next call reads on from its `scan`.
- A route without its payout account or address in the network's file pays out nothing that can be told apart: `no-route`.
- An RPC search starts at a block from before the transfer, estimated from the chain's pace and checked by its time, and reads 8 windows of 5,000 blocks at most, narrower where the RPC asks for it. It reads each block more than once: its window at the head reaches back 1,000 blocks, so the newest blocks are read again on each call, and once it has reached the head with a transfer not arrived, it reads its blocks again from the first, a pass at a time with the windows a call has left (one at least while a pass is under way, so 9 where the search ahead takes all 8), in windows no wider than the RPC took: the first a minute later, each one after as long again as it has been since it reached the head. Where a later equal transfer, still without its credit, could have had the credit an earlier one takes, the earlier one waits until the blocks are read again 8 times since the credit was found, one pass after the other. A result that isn't arrived says where the next search starts, with what it searched for and the credits found so far (`scan`): the app keeps it with the arrivals it was made with, and passes both back. A search for another sender or amount starts afresh.

A result is facts: `arrived`, with the other side's transaction, its block's time, the lux it paid and its block; `waiting`; or `unknown`, with why: `unsure` (a credit could be another's), `late` (none came in its window), `beyond` (the explorer's pages don't reach it), `searching` (carry on from `scan`), `expired`, `no-route`, `no-payout` or `error`. The words are the app's.

`activityRows` of `/activity` takes the deposits that arrived as its `arrivals`: `arrivalsOf` gives them by the deposit's hash, the DuskEVM transaction that paid it and when, and the deposit's row says where it arrived. Its `claims` are DuskEVM withdrawals', which this entry point doesn't read.

## DuskEVM withdrawals

```js
import { createWithdrawals, withdrawalCall } from "@dusk-network/app-core/duskevm-withdrawals";

// The start, for the app's EVM wallet to send on DuskEVM.
const start = withdrawalCall(chainId, { amountWei, sender: evmAddress, to: duskAccount }); // { to, data, value }

const withdrawals = createWithdrawals({
  network: chainId,
  nodeUrl,
  fetch: createMulticallFetch({ nodeUrl, multicallId }), // the reads one task starts go as one query
  drivers: { optimismPortal: () => loadDriver(portalDriver), disputeGameFactory: () => loadDriver(factoryDriver) },
  duskEvm: publicClient, // a viem client, or { url, fetch }
});

const status = await withdrawals.status(txHash, { submitter: account, proofGame });
// { stage: "proven_waiting", reason: "game-in-progress", readyAt: 1793589639n, readyAtExact: false, facts: { amountWei, recipient, … }, … }

const { call, claim } = await withdrawals.prepareProof(txHash, { submitter: account });
// claim: when it can be claimed if proved now; call: { contractId, fnName, fnArgs, deposit: 0n, gasLimit, decoded }
const claimCall = await withdrawals.claimCall(txHash, { submitter: account }); // once `status` says "ready_to_finalize"
```

- Only DUSK withdrawals on the bridge's route count, as Dusk's L1 bridge pays them out (`decodeWithdrawal` of `@dusk-network/networks/duskevm`): to Dusk's messenger, relaying DuskEVM's bridge to Dusk's, paying a Dusk account, or a contract only whole lux at the address DuskEVM gives it, and no one past a u64 of lux. Anything else is refused, for its status, its proof and its claim (`WithdrawalError`, `code: "not-a-withdrawal"`).
- `stage` is where the withdrawal is for the account whose proof counts (`submitter`, a Dusk account or its Portal address; its recipient's account when none is given): "waiting_for_output", "ready_to_prove", "proven_waiting", "ready_to_finalize" or "finalized". `reason` says why it waits. A claim date is worked out as the Portal checks a claim (`claimFrom`), counted from Dusk's latest block, and is exact once the proof's game has resolved; `readyAt` is absent when the game can't be read now, so the date known so far stands. A claim is ready once the Portal takes it, its game has resolved for the defender, and its date has come: never while the game, the Portal's blacklist or the anchor state registry's word on it can't be read, nor on the Portal's own check alone, which may take just the proof and its game. A proof whose game the Portal refuses (blacklisted, retired, no longer respected, or won by the challenger) can't be claimed, whatever that check says (`proofRejected`, "proof-rejected"). `provenByOther` says another account holds a proof that stands, which this one can't claim with.
- `proofGame`, the game the last status found the proof against, puts that game's reads in the same query as the Portal's: a check is one query.
- A proof goes against a game that covers the withdrawal and has already resolved for its proposal, where the anchor state registry calls it proper and respected and it came after the respected game type last changed, so its claim date is exact when it's made; otherwise against the newest game that covers it, among the newest 64 (`gameSearchDepth`), that the Portal takes a proof against: a game the Portal blacklisted, the registry calls improper or not respected, or the challenger won is passed over for an older one, as is one whose standing can't be read. Where none of those is one the Portal takes, a status offers a proof against one that has resolved, as `prepareProof` finds it, to an account that never proved and to one whose proof the Portal refuses. A proof isn't prepared for a claimed withdrawal, nor over a proof of the account's that stands: it would cost its fee for nothing. One the Portal refuses is made again against another game it takes.
- `prepareProof` and `claimCall` refuse what would do nothing or can't be made: "claimed", "proven", "no-proof", "not-ready" (with the status), and "gas" for a withdrawal whose own gas takes the limit over the app's bound (`gasLimitUpper`, 1,000,000,000 by default). The gas limit is 50M and the withdrawal's own gas, at least 1M; the price is the app's.
- A call is encoded by the Portal's data driver the app loaded, as the network's file names and pins it, and read back before it's handed over: its arguments must say exactly the withdrawal, the game, the output root proof and the proof's nodes they were built from, as Dusk Wallet reads them (`decoded`), or it's refused ("bad-call"). It sends no DUSK along; the app signs `fnArgs` as given, with no amount and no one paid but the account itself.
- `prepareProof` gives `at`, when it was prepared: an app that shows a proof's claim date sends that proof, for as long as it chooses.
- `claims(hashes, { submitter })` reads when the withdrawals an account proved can be claimed, by their hashes: claimed, ready, a date, none, or to prove again. Its map is `/activity`'s `claims`.
- `timing()` is how long a withdrawal takes: the Portal's two delays, and how often outputs come.

### Finding withdrawals

- `syncWithdrawals({ address, duskEvm, network, state })` reads an address's withdrawals from the bridge's own `ETHBridgeInitiated` events, the newest final blocks first, a window of 100,000 blocks at a time (narrower where the RPC asks for it), 8 requests a run. It gives the app the state to keep, and the next run carries on below and reads only what is new above. Under a final head lower than the last run's, what it covered and found above it is dropped, and read again.
- `explorerWithdrawals({ address, network, fetch })` lists the address's own calls of the bridge on DuskEVM's explorer, each with the explorer's word for it (`explorerStage`), and `withdrawalsByNonce({ nonces, network, fetch })` finds the DuskEVM transactions of withdrawals known by the nonces their proofs and claims on Dusk carry.

### Reads and caches

- The Portal and the dispute game factory are read with the app's drivers; each game's hub and the anchor state registry raw. Reads go to the node's contracts through the app's `fetch` (its Multicall for Dusk batcher), sent again twice at most when the node answers 429, 502, 503 or 504; a refusal carries the contract's own words. `maxBatch` is how many reads one query holds (32 by default), each game checked taking 4: its status, the Portal's blacklist, and the registry's two answers. A game's status is read on its own hub, which the factory names: a game type's hub can change, and the games made before stay where they were.
- What a deployment doesn't change is read once: each game's hub, each game type's hub, each hub's clock limit. `cache`, a `Map` of text by default, is where they're kept: an app can keep them across sessions.
- Dusk's latest block comes from `latestBlock`, or the node's GraphQL. Without it, a proved withdrawal's status fails: its date can't be worked out, and no claim is built.

## License

MPL-2.0
