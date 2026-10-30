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
| `@dusk-network/app-core/shielded` | A profile's shielded history from the notes its shielded sync keeps, each block asked for among kept decoys (`shieldedHistory`); its entries as facts (`shieldedEntries`); the blocks at the notes' heights (`fetchShieldedBlocks`); the note tree's heights and the decoys drawn from them (`noteTreeHeights`, `readNoteHeights`, `createLeafHeightTap`, `pickHeights`, `leafInfo`) |

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

## License

MPL-2.0
