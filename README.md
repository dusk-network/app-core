# @dusk-network/app-core

Shared logic for the Dusk apps: public and shielded history, activity rows, bridge arrivals and DuskEVM withdrawals.

It has no framework and runs in a browser extension's service worker. Each part is its own entry point, so an app loads only what it uses. Apps pass in their own fetch, batching and storage; the package never chooses storage keys.

Network data (endpoints, contracts, routes) comes from [`@dusk-network/networks`](https://github.com/dusk-network/networks).

Nothing is published yet.

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

Every entry point has its `.d.ts`. The one runtime dependency is `@dusk-network/networks`.

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
- `read({ limit, before })` gives the entries above the first gap, newest first: below it, newer ones may be missing. `complete` says every height from the head down is covered. When `limit` cuts through a block, the rest of that block comes too, so `before` the last entry's height reads on without skipping any.
- A node whose GraphQL has no archive is asked nothing for an hour. Without `refusals`, the archive object alone remembers it.
- A node on another chain than the history kept (a reset devnet) makes the run ask the store to `clear()` and start over, within its budget. A run another one overtook that way, or whose history was cleared under it, keeps nothing more and rejects with a `StaleHistoryError`.
- `network` is the node's network or its chain ID, for the DuskEVM bridge's calls, the bridge's routes and Sozu. A node of a network there's no file for passes none.
- `fillDetails(entries)` reads the details of entries shown before a run gave them any.

An entry is facts, not text: `direction` ("in", "out", "self"), `kind` (`transfer`, `shield`, `unshield`, `contract_call`, `stake`, `unstake`, `withdraw_reward`), `counterparty`, `value` and `fee` in lux (a gas refund paid to another account counts in the sender's `value`), `memo`, and with its details its time, outcome, gas and call. A call to DuskEVM's bridge or Portal has `bridge`, what it did (`decodeBridgeCall`): a deposit's amount and DuskEVM address, or a withdrawal's proof or claim, its hash, whom it pays and its nonce. A transfer with one of the bridge's accounts has its `route` (`routeForAccount`), and a stake or an unstake with Sozu `sozu: true` (`isSozuCall`, with the pools the hub named in `read({ pools })`).

### The store

The app keeps each account's history where it wants, under its own keys, and passes a store for one account on one network. Each method may return a value or a promise.

| Method | Does |
|---|---|
| `getState()` | The sync state, or null before the first run. |
| `commit(entries, update)` | Keeps one step in one transaction: `entries` by hash, an entry kept already keeping the fields these don't carry (its details), and the state `update(kept)` makes from the state kept now. When `update` throws, nothing of the step is kept. Gives the state kept. |
| `patch(details)` | Adds details to kept entries, by hash (a `Map`); entries that aren't kept are left alone. |
| `list({ limit, before })` | Kept entries, newest first: at most `limit`, below the height `before` when given. |
| `clear()` | Forgets what is kept of the old chain. |

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

- `historyRange(archive, { account, from, to, direction, pages })`: an account's entries between two heights, a page at a time.
- `fetchTxDetails(archive, hashes, options)` and `fetchTxNonce(archive, hash)`: a transaction's time, outcome, fee and call, and its nonce.
- `archive.query(text)`: one GraphQL request, its integers past 2^53 kept as text. A request answered 429, 502, 503 or 504 is sent again, twice at most.

An app with its own GraphQL client passes `query` instead of `fetch`: it takes the query's text and gives the answer's `data`, throwing with the node's message on errors.

## License

MPL-2.0
