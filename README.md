# @dusk-network/app-core

Shared logic for the Dusk apps: amounts, text a person must trust, payment links and requests, names that look alike, public and shielded history, activity rows, an accountant's export, Sozu positions and growth, bridge arrivals, ledgers and status, and DuskEVM withdrawals.

It has no framework and runs in a browser extension's service worker. Each part is its own entry point, so an app loads only what it uses. Apps pass in their own fetch, batching and storage; the package never chooses storage keys.

Network data (endpoints, contracts, routes) comes from [`@dusk-network/networks`](https://github.com/dusk-network/networks). On a chain there's no network file for, `/bridge` takes a network the app builds from its own settings.

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
| `@dusk-network/app-core/amounts` | Amounts as the apps write and read them, in the browser's language: `formatDusk`, `formatAmount`, `formatDuskPlain`, `readAmount`, `normalizeAmount`, `unclearAmount`, `parseDusk`, `amountExample`, `decimalSeparator`, `amountLocale`, `amountForField`, `groupDigits`; the amounts a search can mean (`amountsMeant`); and the currency a wallet starts on, by the browser's region (`defaultCurrency`), of those the price source gives (`PRICE_CURRENCIES`) |
| `@dusk-network/app-core/text` | Text a person must trust, as a memo or a message to sign, with what hides in it made visible (`displayText`) and what its numbers ask a person to check (`numbersNote`); and text as a search compares it, without accents or case (`searchKey`) |
| `@dusk-network/app-core/payment-links` | Payment links, `dusk:` and https to the web wallet's Send: reading both (`parsePaymentLink`), as Send reads them on the wallet's network (`readPaymentLink`), making them only for what Send takes (`makePaymentLink`), and the network they're for (`chainLabel`, `networkMismatch`) |
| `@dusk-network/app-core/names` | Names a person gives, as a contact's: whether two read as the same name (`sameName`) or look alike in other letters (`looksAlike`, `nameSkeleton`), by Unicode's confusables; whether one holds what can't be seen, to refuse it (`nameHides`, `NAME_HIDES`); the name a contact's takes (`nameClash`), or a profile's (`profileNameClash`), a profile's .dusk name among them; the name one starts as, to ask about (`nameStarts`); what a profile's name says at Save, in the wallets' words (`profileNameCheck`); and which in a list to show with their address (`lookAlikes`) |
| `@dusk-network/app-core/requests` | Payment requests: what came in for each request a wallet made (`matchRequests`), a payment that paid one again, sent back (`refundOf`), and the payment a send would make again (`sentAlready`) |
| `@dusk-network/app-core/history` | A public account's history from the Dusk archive, synced by block height into the app's store (`createHistory`), through the archive's GraphQL (`createArchive`, `historyArchiveUrl`); its entries as facts (`parseHistoryEntry`, `historyEntry`); a range of heights (`historyRange`); a transaction's details (`fetchTxDetails`, `fetchTxNonce`); and the heights a history covers (`addCoverage`, `topGap`, `shownDownTo`) |
| `@dusk-network/app-core/shielded` | A profile's shielded history from the notes its shielded sync keeps, each block asked for among kept decoys (`shieldedHistory`); its entries as facts (`shieldedEntries`); the blocks at the notes' heights (`fetchShieldedBlocks`); the note tree's heights and the decoys drawn from them (`noteTreeHeights`, `readNoteHeights`, `createLeafHeightTap`, `pickHeights`, `leafInfo`) |
| `@dusk-network/app-core/activity` | An account's activity as rows of facts, one per transaction, newest first, from its public and shielded history and the wallet's own sends (`activityRows`), and the sends the chain's rows now say all of (`settleSends`) |
| `@dusk-network/app-core/export` | An account's activity as the file an accountant or a tax tool reads, for a quarter or any dates: Koinly's universal CSV (`accountingCsv`, `quarterPeriod`, `datesPeriod`); and staking's rewards by calendar year, as they reached the account and as Sozu's stDUSK grew while held (`rewardsByYear`) |
| `@dusk-network/app-core/sozu` | A stake with Sozu: put in, taken out, worth now and earned (`sozuPosition`), what an amount earns in a year (`sozuYear`, `sozuRate`), how stDUSK grew, from the chain (`sozuGrowth`), what native staking paid, from the chain (`nativeRewards`), what the rate is made of (`sozuRateLine`), what each stake and unstake did (`sozuFacts`), and what one stDUSK was worth then (`stDuskWorth`), or at any moment, from the chain (`sozuPointAt`) |
| `@dusk-network/app-core/bridge` | The other side of the bridge's routes: where a deposit to DuskEVM arrived (`depositArrivals`), a migration's payout on Dusk (`migrationPayouts`), and where a transfer out to BNB Smart Chain arrived (`serviceArrivals`); the history's entries as those transfers (`depositOf`, `migrationPayoutOf`, `serviceTransferOf`); the arrivals as `/activity` takes them (`arrivalsOf`); a migration's side on its own chain, its gas and the approval it spent (`migrationFacts`, `migrationsOf`), and the gas of every approval and revoke of a migration's contract (`migrationApprovals`); a transfer's exact amounts (`transferLedger`); and how a route is doing (`bridgeStatus`) |
| `@dusk-network/app-core/bridge-explorer` | Where a deposit to DuskEVM arrived, on DuskEVM's explorer alone (`depositArrivalsFromExplorer`): `/bridge`'s explorer path, for an app that reads nothing else, without the RPC path and `/history` |
| `@dusk-network/app-core/duskevm-withdrawals` | A DuskEVM withdrawal's life, signing aside: its start on DuskEVM (`withdrawalCall`), finding an address's withdrawals (`syncWithdrawals`, `explorerWithdrawals`, `withdrawalsByNonce`), and on Dusk where each is, its proof and its claim, ready for the app's wallet to sign (`createWithdrawals`) |

Every entry point has its `.d.ts`. The one runtime dependency is `@dusk-network/networks`. `/duskevm-withdrawals` also takes [viem](https://viem.sh) (`^2.55.2`), an optional peer: an app installs it to use that entry, and no other entry imports it.

## Amounts

```js
import { amountExample, formatAmount, formatDusk, readAmount } from "@dusk-network/app-core/amounts";

formatDusk(1_853_542n, { round: "nearest" }); // { text: "0.0019", exact: "0.001853542" }
formatAmount(90_082_082_000_000_000n, { decimals: 18, round: "down" }); // { text: "0.09", exact: "0.090082082" }
readAmount("1 000,5", "fr-FR"); // { lux: 1_000_500_000_000n, problem: null }
readAmount("1.000", "es-ES"); // { lux: null, problem: "Is that 1 or 1000? Write the one you mean." }
`Enter an amount such as 10 or ${amountExample("10.5", "fr-FR")}.`; // "…10 or 10,5."
```

- The one rule for an amount, of DUSK or an EVM token: a row and a balance line show `text`, its detail shows `exact`. `text` has at most 4 decimals, 2 significant digits under 0.01, and is never 0 for an amount that isn't. It rounds down for an amount or a balance, to the nearest for a fee paid, and up for the most a fee can be.
- `defaultCurrency` is the fiat currency a wallet starts on: the one the browser's region pays in, where the apps' price source (CoinGecko) gives DUSK's price in it, as "SGD" in Singapore, "INR" in India, "CHF" in Switzerland and "EUR" in the euro's regions (the euro area, Bulgaria in it since 2026; Andorra, Monaco, San Marino, the Vatican, Montenegro, Kosovo; France's overseas regions and the collectivities that use it; Åland, the Canary Islands, Ceuta and Melilla); "USD" anywhere else, as in Romania or Kenya. A language without a region takes the one it's most spoken in: "de" and "fr" are EUR, "pt" (Brazil) BRL, "en" USD. `PRICE_CURRENCIES` are the 45 currencies the price source gives, as its list said in November 2026, for a wallet to offer.
- An amount reads back as itself or is refused, never as another. A language's own groups are read: `1 000` with any of its spaces in French, `1'000` in Swiss German, `12,34,567` in Hindi. A lone point or comma before three digits, after a whole part that isn't 0, could mean two things in any language, and stays unclear (`unclearAmount`): `1.000` and `1,000` are one or a thousand in English and in German alike, as a point is often typed for decimals where a comma is the language's, and the other way round. `readAmount` asks which is meant in numbers no reader takes for the other, exactly, and as each can be written to mean it: "Is that 1 or 1000?", and "Is that 1.2340 or 1234?" for `1,234`, never `1.000` for one, nor about 1.23, so the amount the question shows reads back as itself. Plain decimals, as `0.5`, `1.25`, `0.500` or `1.2345`, are read as they are. `amountForField` writes what an app puts in a field (Max, a link's amount, Send back's) so it reads back without a question: `1.234` DUSK is `1.2340`. A space where the language doesn't group with one, as `1 234,5` in Spanish, is refused saying so: "Leave out the space: 1234,5."
- `amountsMeant` is what a search typed can mean as amounts of DUSK, as ranges of lux: what a row shows starts with what's typed, so `"120"` is from 120 up to 121 DUSK. It reads either decimal mark, so `"0.2"` finds 0,2 in German as `"0,2"` does, and looks for both amounts where a mark could mean either, as `"1.000"` in German.

## Text

```js
import { displayText, numbersNote, searchKey } from "@dusk-network/app-core/text";

displayText(memo); // { text: "pay \\u202e0001\\u202c DUSK", neutralized: true, flags: ["bidi_control"] }
displayText(message, { lineBreaks: true, maxChars: 500 }); // for text written in lines, and cut
displayText(memo, { isolate: true }); // for a screen: right-to-left words set apart, the rest in the order of the bytes
numbersNote(displayText(memo).flags); // "A number here uses digits that look like other digits. Check it digit by digit."
searchKey(memo).includes(searchKey(query)); // a search: "ilustracion" finds "Ilustración"
```

Text-direction controls, characters that render as nothing, controls and line breaks show as their codes, never left out, so what's shown is what the bytes say; half a character shows as the replacement mark. A variation selector is an emoji's own only on an emoji, or on a keycap's digit with the keycap's mark after it: on anything else it renders as nothing and shows as its code. `neutralized` says whether anything was, for the app to say so, and `flags` what. Some things are only flagged, the text as it was: a number whose digits read right to left (`rtl_digits`), as N'Ko's 0001 that shows as 1000, mix digit systems (`mixed_digits`), as 1٠5 with an Arabic-Indic zero that looks like a point, or look like other Latin digits than they are by Unicode's confusables (`lookalike_digits`), as Bengali's ৪, a 4 that looks like an 8. `numbersNote` says what those ask a person to check, in the words both wallets show under the text. On a screen, right-to-left letters turn the numbers and words beside them around: `isolate` sets each run of them, and of their digits, apart, so "Pay א 10 א 1000" doesn't read as "Pay א 1000 א 10". It's for display: sign and send the original.

`searchKey` is text as a search compares it, in both wallets: without accents and other marks, case or what can't be seen, compatibility forms as their plain letters and ß as ss, and spaces and line breaks of any kind as one space. A field holds a query where its key holds the query's.

## Payment links

```js
import { makePaymentLink, networkMismatch, parsePaymentLink } from "@dusk-network/app-core/payment-links";

const made = makePaymentLink({ to: account, amount: typed, memo, network: chainId, language });
// { ok: true, lux: 150000000n, problems: {}, dusk: "dusk:public-…@dusk:1?amount=0.15&memo=…",
//   https: "https://apps.dusk.network/wallet/dashboard/send?to=…&amount=0.15&memo=…&network=mainnet" }
// Or { ok: false, problems: { amount: "Is that 1,2340 or 1234? Write the one you mean." }, dusk: "", https: null, lux: null }

const link = parsePaymentLink(pastedOrScanned); // { form: "https", kind: "public", to, amountDusk: "0.15", lux, memo, label, chainId: "dusk:1", raw }
networkMismatch(link.chainId, walletChain); // "This request is for Mainnet. You are on Testnet."

// In Send, pasted, scanned or opened alike: what it fills in, or why it fills in nothing.
readPaymentLink(pastedOrScanned, { network: walletChain });
// { link: null, problem: "This request is for Mainnet. You are on Testnet.", reason: "other-network", chainId: "dusk:1", network: "Mainnet" }
```

- `parsePaymentLink` reads a `dusk:` link, `dusk:public-…` or `dusk:<address>` with an account or a shielded address as it's written, its network after the `@` or as `network=` in its query, as an https link says it; an https link to the web wallet's Send on a network there's a file for (or at `walletUrl`, the app's own address); or a recipient as it is. A field is read by its name in any case: `To=` is `to=`. An https link anywhere else is no payment link: it reads as a recipient, which Send refuses. One that names two networks is null (a `dusk:` link's `@` and query, or a network other than its wallet's), and so is one whose network can't be read (`dusk:02` is no chain's), one without a recipient, one that says a field twice, in any case (`To=` beside `to=`, a `dusk:` link's recipient in its query too), one whose field names hide something or read as a field they aren't: one that isn't printable ASCII, as every field's is (`am\u200bount=`, `to =`, fullwidth `ｔｏ=`, a small capital in `ɴetwork=`, a Cyrillic т in `тo=`), or one in ASCII that looks like a field's (`amountIux=` with a capital I, `Iabel=`), which a person reading it would take for a field no reader reads, one with a user part before its host (`https://apps.testnet.dusk.network@apps.dusk.network/…` goes to the host after the `@`), a `dusk:shielded-` link to a public account or a `dusk:public-` one to a shielded address, and a `dusk:` link with a `#` in it, which readers read in different ways. An https link's fragment is the browser's, left out as the page it opens leaves it out.
- `readPaymentLink` is Send's reading, the same pasted, scanned, opened or handed over by a site, for a wallet to say what's wrong at once and never fill a link in as a recipient: `link` to fill in, or `problem` in the wallets' words, by `reason`: "two-amounts" (amounts that differ, in DUSK and in lux or one of them twice), "unreadable", or "other-network"; and either way the network it's for, `chainId` and its name `network`. An unreadable link's `problem` says why, for whoever sent it to fix: "This link says the memo twice. Ask for a new one." It refuses a recipient Send can't pay as `LINK_BAD_ADDRESS`, "This link's address isn't valid. Ask for a new one.": anything but an account, a shielded address, a `.dusk` name or an EVM address, as two addresses in one, or one with a line break or a hidden character in it, which a field that drops them would leave as an address to pay. It refuses an amount that isn't a plain number once decoded, digits with one point or comma, as `LINK_BAD_AMOUNT`, "This link's amount can't be read. Ask for a new one.": a `#` it encodes (`%23`), a hidden character or a space would leave an amount a field shows that the link doesn't say. And it refuses a memo with a line break in it as `LINK_MEMO_LINE_BREAK`, "This link's memo has a line break. Ask for a new one.", as both wallets write a request's memo on one line. A link refused gives nothing to fill in or show, `link` null: a preview of it says why and shows no recipient or amount. What isn't a link is null, for Send to read as a recipient.
- `makePaymentLink` checks what Send checks, and says what's wrong by the field: a recipient that is one, an amount above 0 with 9 decimals at most, and a memo of 512 bytes at most, on one line.
- The https link ends with its network, so a mail or chat client that cuts a link's last punctuation cuts none of it.

## Names

```js
import { lookAlikes, looksAlike, nameClash, nameHides, nameStarts, profileNameCheck, profileNameClash } from "@dusk-network/app-core/names";

nameHides("\u202eecilA"); // true: it reads as "Alice", so it's refused, saying NAME_HIDES
looksAlike("Bob", "Bօb"); // true: an Armenian օ
nameClash("Profile 2", { profiles, contacts, except: editedId });
// { kind: "profile", same: true, entry: profiles[1], name: "Profile 2" }: a contact named like a profile, to refuse
nameClash("Estudio Mаrta", { profiles, contacts }); // { kind: "contact", same: false, entry, name: "Estudio Marta" }: another's, in other letters
profileNameClash("Alice", { profiles, contacts, self: account }); // { kind: "contact", same: true, entry, name: "Alice" }: a profile named like a contact, to refuse
// Each profile with its verified .dusk name, where it has one:
profileNameClash("sоfiadesign.dusk", { profiles: [{ account, address, name: "Profile 1", duskName: "sofiadesign.dusk" }, …], contacts, self: other });
// { kind: "profile", same: false, entry, name: "sofiadesign.dusk" }: the other profile's .dusk name in other letters, to refuse
nameStarts("Lucas (petit-fils)", { profiles }); // { kind: "profile", entry, name: "Lucas" }: to ask whether it's someone else
lookAlikes([...profiles, ...contacts]); // the entries to show with their address
// At Save of a profile's name, in both wallets: refused, or asked, in the words the form shows.
profileNameCheck("alice.dusk", { profiles, contacts, self: account });
// { refused: false, kind: "contact", dusk: true, entry: wendy, name: "alice.dusk", words: "You have a contact called Wendy, at alice.dusk. Is this someone else?" }
```

- `nameHides` says a name holds what can't be seen as it's shown, which can make it read as another: a control that turns text around (U+202E makes "\u202eecilA" read as "Alice"), a character that renders as nothing, as a zero-width space, a joiner between emoji or a variation selector on what isn't an emoji (U+FE0F after "Alice"), a line break or another control. A wallet refuses such a name for a contact or a profile, saying `NAME_HIDES`, and shows one kept from before with `displayText` of `/text`, its hidden characters as codes.
- Names look alike when they read as the same name, whatever their case, accents, spaces and punctuation, and without what can't be seen (`sameName`), or have the same skeleton by Unicode's confusables (UTS #39), as written or in lower case: Cyrillic, Greek, Armenian and Cherokee letters that look like Latin ones, a capital I that looks like a small l, rn that looks like m. As written, the letter pairs that look like one letter in most fonts are that letter too, beside the name as written (so "daIe" still looks like "Dale"): "VVendy" looks like "Wendy" and "Davicl" like "David", but "Clara" not like "Dara", as their capitals tell them apart. `nameSkeleton` is Unicode's alone, without the pairs, for a search that shouldn't find every d in "cl". The table is Unicode's, version 18.0.0, kept in the package as data: `npm run generate:confusables` makes `src/confusables.js` again from the pinned file, once its hash is checked.
- `nameClash` says whose name a new or changed contact's takes: one of the person's profiles first, by the name it was given or its verified .dusk name (`duskName`), as a contact named like a profile would read as that profile on Review; then another contact's. `name` is the name taken, and `same` says it reads as that name, rather than looking like it.
- `profileNameClash` says the same of a profile's new name, the other way round: another of the person's profiles first, by its name or its .dusk name, then a contact's, both to refuse, as History and Review would read the profile as that one: a client's payments as from "sofiadesign.dusk". `self` is the account or address of the profile named: it, its own .dusk name, and a contact saved with its address, take nothing from it.
- `nameStarts` says which profile, then contact, has a name that starts with this one's, word for word, or is the start of it, as the look-alike rules read names: "Lucas" and "Lucas (petit-fils)", not "Ann" and "Anna". It's for a question, not a refusal: the two read differently, but Send's "From Lucas … To Lucas (petit-fils)" can be taken one for the other at a glance. Give it what to check against: a contact's name against `profiles`, a profile's against `contacts`, with `self`.
- `profileNameCheck` is what both wallets say of a profile's name at Save, on the form: refused (`refused`, not saved) for what can't be seen in it and for what `profileNameClash` finds; asked (saved, the question under it) for a contact's .dusk name it is or looks like, naming that contact ("You have a contact called Wendy, at alice.dusk. Is this someone else?"), for a .dusk name of the wallet's it starts as or is the start of, another profile's first ("Your other profile is called sofiadesign.dusk. Is this someone else?") and a contact's after, and for a contact's name it starts as, as before. The .dusk names are the wallet's own: each profile's verified one and the one each contact was saved from (`duskName`). With `entry`, `kind`, the name of theirs (`name`) and whether it's a .dusk name (`dusk`), for an app that says more.
- `lookAlikes` gives the entries whose name looks like another's of another address, for a list or a picker to show each with its address.
- For what a person reads only: a payment goes to an address, and a name never stands for one.

## Requests

```js
import { matchRequests, sentAlready } from "@dusk-network/app-core/requests";

const matches = matchRequests(kept, rows); // the wallet's requests, as it keeps them, and `/activity`'s rows
// matches.get(id): { state: "paid", matched: "amount-memo", hash, at, lux, memo, more: [{ hash, at, lux, matched, memo }] }
refundOf(request, matches.get(id).more[0], rows); // Send back: { to, lux, memo: "Refund: Factura 33" }, or null
sentAlready(rows, { to, lux, memo }); // before a send: the row of the payment it would make again, or null
```

- A request is kept as `{ id, to, lux, memo, network, at, paid? }`: `lux` as text, null for any amount, and `paid` the payment that paid it, `{ at, hash, lux }`, for it to stay paid once that payment is too far back to read, and to say what it paid then too.
- A match says what came in (`lux`), for the app to show on every request paid: one of any amount is paid by any payment with its memo, one lux too. Its match says so (`anyAmount`): its badge says what came in, in no colour that says all is well, rather than "Paid".
- "paid" takes the amount and the memo asked, both, in one payment, or the memo of a request of no amount; anything less is "check", with what `matched`, never paid. "waiting" is none yet. Only a payment that went through (`executed`) counts, by what its transfer paid, without a gas refund its transaction paid with it. A payment answers one request, to the address it asked on, from 5 minutes before it was asked: the oldest it pays in full, before any it matches less. `more` holds what else came in for it, oldest first: one with all of it again (`matched` "amount-memo") paid it twice.
- `refundOf` is what Send is filled in with to pay back a payment that paid a request again: to whoever sent it, as the rows say, what it brought, and the request's memo after "Refund: " where that fits in a memo's 512 bytes, else "Refund". Null where the sender isn't known, as for a shielded payment.
- `sentAlready` is a payment out to the same recipient, of the same amount and memo, that didn't fail and wasn't dropped, on its way too: in the last 10 minutes, or at any time with a memo. Its amount is what its transfer paid, without a gas refund to another account.

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

An entry is facts, not text: `kind` (the kinds of `/history`; a conversion's by where its value went, as its event says), `direction` for the profile's notes ("in", "out", or "self" when what they spent came back but the fee), `value` and `fee` in lux as decimal strings (a fee only where the profile's notes paid it), `success` and `error`, and its block's `timestamp`. It stores as JSON as it is.

### The stores and the tree

The app keeps the history where it wants, under its own keys, and reads its notes, their values and the note tree through its own wallet library. Each method may return a value or a promise.

| Option | Does |
|---|---|
| `store.get()` | The profile's kept history, `{ fingerprint, entries, decoys }`, or null. Reject when it can't be read: the read then asks nothing rather than draw new decoys. |
| `store.put(record)` | Keeps it in place of the one kept. A put that rejects, as one bound to a wallet that has been reset since, rejects the read. A store that can't keep a history for want of room may pass over it: the read gives it anyway, and the next one works it out again among the same decoys. |
| `store.update(change)` | Optional: keeps `change(kept)` in place of the record kept now, in one transaction, and gives what it kept. The decoys are then drawn from those kept and kept at once, so two reads of a profile at once ask among the same ones. Without it, two such reads can each draw their own. It rejects and passes over a history as `put` does. |
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
- A call to DuskEVM's bridge or Portal has `bridge`: what it did (`step`: "deposit", "withdrawal", "proof", "claim" or "call"), the amount its call names, a deposit's DuskEVM address and where it arrived there (`arrivals`), a withdrawal's hash, recipient and nonce, and whether a proof's withdrawal is claimed: by a claim of the same activity that went through, is on its way or is on chain, or as the app read it (`claims`). What came in from an account has none, whatever its transaction called: a gas refund from another account's call to the bridge is a transfer from that account.
- A transfer with one of the bridge's accounts has its `route`, and a call of Sozu's pool `sozu`, "stake" or "unstake" (with the pools the hub named in `pools`).
- `nameCall` is the app's hook for the name service, as the wallets read .dusk names with `@duskdomains/sdk/call-facts`: given a call's contract and function, and the entry or the send it is from, it says what the call does, and the name and the reservation it is for. A reservation has the name of a registration after it with the same reservation.

A row is facts, not text: amounts in lux as bigints, `time`, `status`, `counterparty` and its verified name (`counterpartyName`, from `names`), the name typed for it (`toName`), and `sent` and `entry`, the wallet's record and the public entry, as given. The words are the app's.

### Settling sends

```js
const { drop, keep } = settleSends({ public: entries, shielded, pending: sends });
// drop: the hashes of the sends the chain's rows now say all of, to forget;
// keep: the others the chain has the outcome of, marked settled, to keep for what they add.
```

By default a send adds the name typed for its recipient, a shielded send's recipient or memo, which the shielded history doesn't have, or a token's amount and recipient (`asset`), which the public one doesn't; `keeps(send)` says what else does. A failed send that tried to move an amount is always kept: the chain's row says it moved nothing.

## Export

```js
import { accountingCsv, datesPeriod, quarterPeriod } from "@dusk-network/app-core/export";

const { csv, fileName, count, left, unpriced } = await accountingCsv({
  rows, // `/activity`'s, all of them for the period
  profile: { name, account, address },
  profiles, // the person's others, the same way
  period: quarterPeriod(2026, 4), // or datesPeriod("2026-10-01", "2026-10-31"), on the device's clock unless `timeZone` says
  price: ({ at, coin }) => euros(coin, at), // optional: what one DUSK was worth, as text or a number, or null
  currency: "EUR",
  facts, // optional: `sozuFacts` of `/sozu`, what each stake and unstake did
  evm, // optional: `migrationFacts` of `/bridge`, what each migration paid on its own chain
  evmAddresses, // optional, with `evm`: the EVM addresses the app knows as the person's, the only ones whose gas is written then
  approvals, // optional: `migrationApprovals` of `/bridge`, the gas of approvals and revokes no migration's lines have
  contactName, // optional: the person's own names, only when they asked for them in the file: before a .dusk name
  network, // the file's name says it, unless it's "mainnet"
});
// fileName: "dusk-estudio-sofia-2026-q4.csv"; left: { pending: 0, notRead: 1, outOfPeriod: 42 }
```

The file is [Koinly's universal CSV](https://support.koinly.io/en/articles/9489976-how-to-create-a-custom-csv-file-with-your-data), the template other tools' follow and explorers write: `Date`, `Sent Amount`, `Sent Currency`, `Received Amount`, `Received Currency`, `Fee Amount`, `Fee Currency`, `Net Worth Amount`, `Net Worth Currency`, `Tag`, `Description`, `TxHash`, then `Account Name`, `Account`, `Counterparty Name`, `Counterparty`, `Internal Transfer` and `Memo`, which Koinly ignores. Dates are UTC, amounts are exact, with a point and no grouping, and it has no BOM unless asked for (`bom`): Koinly has refused a file's headers over one.

- A transfer between the person's own profiles has no tag, so it can't read as income: its description and `Internal Transfer` say what it is, and each profile's file has it with the same time, amount and hash, which is what Koinly merges.
- Rewards claimed are tagged `reward`. A native stake and an unstake are tagged `stake` and `unstake`, which Koinly leaves out of its reports, and their fees are on lines of their own, as `cost`, which stay in; so are the fees of what moved nothing, or failed.
- A stake with Sozu is a trade of DUSK for stDUSK, and an unstake the trade back, once `facts` says its stDUSK, with its deposit fee and what a stDUSK was worth in the description. Until then, it's what moved under the staking tags.
- A token's transfer is what it moved, with its amount, currency and recipient in the same columns, from the wallet's record of it (`sent.asset`, which `settleSends` keeps), with no value in fiat. An allowance is its fee, saying what it allows and to whom. What the wallet has no record of stays what the chain says: a call, and its fee.
- A memo with commas, quotes and line breaks comes through, with nothing in it that hides or reorders what it says, and is never read as a formula.
- A value in fiat has 8 decimals, rounded half up, on every line: a cent's worth or a fraction of one.
- `Account Name` is the profile's `name`, as the app gives it: the name the person gave it. `Counterparty Name` is the person's own: another profile's name, then, where they asked for their contact names (`contactName`), the contact's; then the verified `.dusk` name or the name typed for it.
- An approval or a revoke of a migration's contract that no migration's lines have, given as `approvals` (`migrationApprovals` of `/bridge`), is a cost line of its own, its gas there at its own time: one never used, a revoke, or one a migration spent where that migration's lines don't say it. Each is in the file once, so the gas the file books is all that left the address.
- A migration's side on its own chain, given as `evm` (`migrationFacts` of `/bridge`), has lines of its own before its payout's: what its approval and it paid in gas there, in that chain's coin, as costs, each at its own time, with its own hash and its EVM address as the account. Each is in the file of its own time's period, which may be one before its payout's. Where the app gives `evmAddresses`, the EVM addresses it knows as the person's own, as those it connected, only a migration sent from one of them has these lines: anyone can migrate to an account, as a customer to a shop's, and their gas is no cost of its owner's. Without it, every migration has them.
- `rows` must be all of the period's, and with `evm`, every migration's payout from the period's start on: one after the period can have fees in it. Read the history down to the period first. What was left out is counted: on its way, not looked up yet, or outside the period.

```js
import { rewardsByYear } from "@dusk-network/app-core/export";

await rewardsByYear({ rows, facts, price, timeZone, complete, status, archive, cache });
// [{ year: 2026, claimed: { lux: 301288041449337n, worth: "18077.28248696", unpriced: 0 },
//    sozu: { lux: 8155553283n, worth: "0.48933320", unpriced: 0 }, sozuGrown: { lux: 118858069243n, worth: "7.13148415", unpriced: 0 }, reading: 0 }]
```

`rewardsByYear` is staking's rewards by calendar year on the person's clock, from what the file has: native staking's rewards claimed (the file's `reward` lines) and what Sozu's unstakes took out (`sozu`), as they reached the account; and what Sozu's stDUSK grew while held (`sozuGrown`). What an unstake took out is what its stDUSK was worth at its own rate, beyond what that stDUSK cost at the rates it was staked at, on average: deposit fees aside, and the pool's rounding too, as the pool rounds what each stake mints and each unstake pays by a lux or so, so a stake and its unstake at one rate took out nothing. The growth is the stDUSK held times how much one stDUSK's worth rose: from each stake and unstake at its own rate, and across each new year at the pool's rate after its last restake by then, read from the chain (`sozuPointAt`, a few requests a year, kept in `cache` for good), to now at what `status` says it's worth. A year's are summed exactly and come to whole lux, toward nothing: what's under a lux is no reward. Every year's growth together is what `sozuPosition` says the stake earned so far, but for a lux or so of the pool's rounding in each stake and unstake, and a stake all unstaked within a year grew what it took out. Each is worth what `price` says at its own time, a part of the growth at its end, to 8 decimals, in the currency `price` answers in, and `unpriced` counts those without one. Without every stake and unstake's facts, or the whole history (`complete`), Sozu's are null; so is a year's growth where a new year's rate can't be read (no `archive`), or this year's without `status`. But the newest stakes and unstakes of the last 10 minutes (`FACTS_WAIT_MS`) whose facts the archive doesn't list yet, as right after an unstake, are left out until it does, and a year says how many (`reading`): its figures are what they were before them, for the app to keep showing while it reads their facts again, a little later, rather than say they couldn't be read.

```js
import { REWARDS_COUNTED, REWARD_WORDS } from "@dusk-network/app-core/export";

REWARD_WORDS.sozuGrown; // "Sozu, grown while held": and `claimed`, `sozu`, for each year's lines
REWARDS_COUNTED; // "Taken out by unstaking is part of grown while held: what came back, less what that stDUSK cost at its average price, deposit fees not counted."
```

Both wallets show a year's rewards by `REWARD_WORDS`, and `REWARDS_COUNTED` once under them: taken out by unstaking is part of what grew while held, not more on top of it.

## Sozu

```js
import { nativeRewards, sozuFacts, sozuGrowth, sozuPointAt, sozuPosition, sozuRate, sozuRateLine, sozuYear, stDuskWorth } from "@dusk-network/app-core/sozu";

const facts = await sozuFacts({ archive, account, rows, cache }); // optional: each one's own deposit fee and stDUSK
sozuPosition({ rows, status, facts, complete });
// { putIn: 1050000000000n, takenOut: 0n, worthNow: 1784753386279n, stDusk: 567580253155n, depositFees: 2625000000n, feesExact: true, earned: 737378386279n, waiting: 0 }
sozuYear({ amount, nativeRate, status }); // { rate: 0.204, depositFee, worth, rewards, earned }: `earned` after Sozu's share and the deposit fee
sozuRateLine({ provisioners, tipHeight, status });
// "15.5 DUSK a block to stakers, 203.6M DUSK staked now: about 24% a year. Less Sozu's 15%: about 20%, and a little over as it restakes rewards every hour."

const growth = await sozuGrowth({ archive, pool: status.contracts.pool, status, cache }); // what stDUSK did, from the chain
sozuRate(nativeRate, status, growth); // 0.204: the rate, once it's read
sozuRateLine({ growth }); // "stDUSK went from 1.2740 to 1.2953 DUSK over the last 30 days, after Sozu's share."

const point = await sozuPointAt({ archive, pool: status.contracts.pool, at: Date.UTC(2025, 11, 31, 23), anchors, cache }); // the 2026 new year in Berlin
stDuskWorth(point); // 1056231313n: one stDUSK was worth 1.056231313 DUSK

const native = await nativeRewards({ archive, provisioners, tipHeight, network: "mainnet", cache }); // what native staking paid, from the chain
// { days: 30, perBlock: 15276211075n, staked: 207258170780379280n, rate: 0.232, from, to, blocks: 6 }
sozuRateLine({ native, status }); // "15.3 DUSK a block to stakers over the last 30 days, 207.3M DUSK staked now: about 23% a year. Less Sozu's 15%: …"
```

- `status` is what `readSozuStatus` of `@dusk-network/networks/sozu` gives, or the same figures as the extension's engine names them, and `rows` are `/activity`'s, all of them; `complete` is `read()`'s, without which `earned` is null. Earned is what's left of worth now and what was taken out, once what was put in, its deposit fees aside, is off: the five add up to the lux. Deposit fees are worked out at today's rate where `facts` doesn't have them (`feesExact`).
- `sozuFacts` reads the pool's own event in each transaction, and the stDUSK an unstake burned from the token's transfer in it, a request for each 25, without a data driver. With `cache`, a `Map` of text does, each is read once. `stDuskWorth(fact.pool)` is what one stDUSK was worth then, in lux, for a stake's or an unstake's details to say as the export does: "1 stDUSK = 1.840349526 DUSK".
- `sozuRate` is Sozu's rate as both wallets work it out: from native staking's as it's shown, to the percent. `sozuRateLine` takes the node's provisioners for what a block pays and what's staked, or `nativeRate` alone for the rate.
- `nativeRewards` measures what native staking paid over the last 30 days (`days`), from the chain: what a block paid stakers, every reward in the stake contract's event but Dusk's own tenth, over six blocks across the period, the most and the least of them aside, at the period's own pace, shared with what's staked now, eligible yet or not: a stake suspended for a fault, or waiting for its first epoch, shares the pay again within days, and counted only while eligible it made the rate jump by points at an epoch's start. The period is fixed to whole days of blocks: it ends on the last day's line (a multiple of 8,640 blocks) an hour or more below the tip, and its six blocks are at fixed heights, so two apps that read it in the same day read the same blocks and say the same rate, and a day on, one of the six is another at most. Its `rate` goes where `nativeRateEstimate`'s did, and `days` says the period it's of; `sozuRateLine` takes it (`native`) to say the same. One or two requests, about 110 kB on mainnet, kept in `cache` (`network` keeps networks apart in one cache): with the app's `tipHeight`, while the tip is in the same day of blocks, else for an hour; null where it can't be read: then the rate is estimated as before. The provisioners' own `reward` grows by Dusk's tenth too: what a block pays stakers is the rest.
- `sozuPointAt` reads what one stDUSK was worth at a moment as `sozuGrowth` does: the pool's figures after its last restake by then, among the transactions calling it around that moment's block. The block is found by its time, from blocks whose height and time the app knows (`anchors`, as `{ height, at }` of an account's rows) and the tip: three requests where rows are on both sides of the moment, about six where none are. It's null until the archive's tip has passed the moment, as a restake may still come before it, where no restake is found in the two hours or so before the moment, as while a pool was idle, or where the archive can't be read. What it finds is kept in `cache` for good once the tip is ten minutes past the moment.
- `sozuGrowth` reads how stDUSK grew over the last 30 days (`days`), from the chain: the pool's hourly restake near the tip and near the period's start, among the transactions calling it, and what one stDUSK was worth after each, as the pool's reward event says. That growth is what a holder earned, Sozu's share off. Given it, `sozuRate`, `sozuYear` and `sozuRateLine` go by it, so the rate shown, what an amount earns and the line agree. Two or three requests, about 120 kB on mainnet, kept in `cache` for an hour; null where it can't be read, or where the latest restake isn't the pool's rate `status` read: then the rate is worked out as before.

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

An app that follows deposits on DuskEVM's explorer alone imports `depositArrivalsFromExplorer` from `@dusk-network/app-core/bridge-explorer`: the same reads and results as `depositArrivals` with `via: "explorer"`, without the RPC path and `/history`. `/bridge` exports it too.

- Each credit pays one transfer. Equal transfers (the same route, recipient and payout) are paid in the order they were sent: the oldest takes the first credit after it, from 2 minutes before its block, as the chains' clocks differ. The app passes the transfers it still waits for, and the credits its others arrived with (`taken`): none of those pays a waiting one, though an earlier transfer read from the chain takes its own back, as one given but not looked for does.
- A transfer's time is its Dusk block's, never the device's clock. One without it yet isn't looked for. One sent more than a week ago (`waitMs`) is unknown, and isn't asked about.
- A deposit is followed on DuskEVM's explorer (`via: "explorer"`, the default): the recipient's incoming calls, newest first, read once for all its deposits, back past the oldest, 5 pages at most. Those calls don't say who deposited, so a payment is a deposit's only when it can't be another's: within 2 minutes either side of its block, once those minutes are over, with no other payment of its amount there (a failed one counts) that isn't another given deposit's. Nothing is asked before then.
- On DuskEVM's RPC (`via: "rpc"`), a deposit is found by DuskEVM's bridge event from its sender's DuskEVM address. With `/history`'s archive, each sender's equal deposits in the hours before its own are read from its history and paid first; a deposit there whose call can't be read leaves the order unclear. Without it, the RPC's credits are taken as the explorer's are, as they are while it can't be read and on a network that doesn't name DuskEVM's bridge and Portal on Dusk: a deposit is an `error` only when DuskEVM's RPC can't be read either. A deposit given without its sender takes no credit from the sender of another equal one given. With `cache`, the app's cache of what can't change any more (a `Map` of text does), the call of each deposit its sender's history lists is kept once its block is final and its answer says all a match reads of it (that it failed, that it's another call than a deposit, or a deposit's amount and DuskEVM address), and isn't asked for again; one whose arguments come cut short is asked for again.
- `network` is a network file or its chain ID, or, on a chain there's no file for, an object the app builds from its settings: `{ chainId, duskEvm: { rpcUrl, blockscoutApiUrl, predeploys: { l2StandardBridge }, contracts } }`, each as a network file has it, DuskEVM's `contracts` on Dusk only for its senders' histories. Its fields are checked as a file's are: an address that isn't 0x and 40 hex digits, a URL that isn't http(s) or ends with a slash, or a contract ID that isn't 64 lower-case hex digits is a TypeError. It has no routes to other chains unless it gives them as a file does: transfers out and migrations there are `no-route`.
- A migration is paid by a transfer to the account from its route's payout account, with the migration's transaction hash as the memo, as text, of exactly its amount: from the account's entries, less any `refund` paid to the account with it, or from the archive's memo index, which gives each payout's own amount. One from that account of another amount leaves it unsure, not waiting: the value of an entry an earlier version kept holds any gas refund paid to the account. With `entries`, the payouts there of migrations the app didn't list come too (`unlisted`), each with its `payer`; where one account pays out more than one route, a payout of a migration not listed doesn't say which: its `route` is null.
- A transfer out is read from the chain: what the route's account received, the address its memo gives as the route's bridge reads it (0x and 40 hex digits, any case, nothing around them, as text: a memo of bytes that aren't text gives none), and its block. It arrives with the DUSK token's `Transfer` from its route's payout address to that address, of what the account received less the fee. The account's history lists every transfer that named the same address, in any case: equal ones in the hours before (a given one's by its own fee) are paid first, and one that can't be read leaves the order unclear. One that pays nothing out is `no-payout`, with its `problem`. `serviceTransferOf` gives what left the account (`sent`), and what the account received (`amount`) only where no gas was left to refund: an entry's value holds any refund paid to another account.
- With the archive, each transfer reads only its own hours of its account's history (its sender's for a deposit, the route's account's for a transfer out), further back while equal ones before it run on, and only once the archive lists the transfer there. A call reads 4 pages of it (`HISTORY_PAGES`) for each: a transfer whose history is longer waits, and the next call reads on from its `scan`.
- A route without its payout account or address in the network's file pays out nothing that can be told apart: `no-route`.
- An RPC search starts at a block from before the transfer, 10 minutes before it as the chain's pace says, checked by its time and stepped back until it is, and reads 8 windows at most: of 5,000 blocks, twice as many after each one the RPC answers whole, up to 100,000, and fewer where it asks for it, the width kept in the search's `scan` from call to call. A call reads a chain's head and pace once for all its searches. Once a deposit's windows are over and read, a search without its sender's history reads no further. It reads each block more than once: its window at the head reaches back 1,000 blocks, so the newest blocks are read again on each call, and once it has reached the head with a transfer not arrived, it reads its blocks again from the first, a pass at a time with the windows a call has left (one at least while a pass is under way, so 9 where the search ahead takes all 8): the first a minute later, each one after as long again as it has been since it reached the head. Where a later equal transfer, still without its credit, could have had the credit an earlier one takes, the earlier one waits until the blocks are read again 8 times since the credit was found, one pass after the other. A result that isn't arrived says where the next search starts, with what it searched for and the credits found so far (`scan`): the app keeps it with the arrivals it was made with, and passes both back. A search for another sender or amount starts afresh. The block times the app keeps (`blockTimes`) are a chain's: for transfers out, a cache a chain by its chain ID, or one cache where the network's service routes are all on one chain.

A result is facts: `arrived`, with the other side's transaction, its block's time, the lux it paid and its block; `waiting`; or `unknown`, with why: `unsure` (a credit could be another's), `late` (none came in its window), `beyond` (the explorer's pages don't reach it), `searching` (carry on from `scan`), `expired`, `no-route`, `no-payout` or `error`. The words are the app's.

`activityRows` of `/activity` takes the deposits that arrived as its `arrivals`: `arrivalsOf` gives them by the deposit's hash, the DuskEVM transaction that paid it and when, and the deposit's row says where it arrived. Its `claims` are DuskEVM withdrawals', which this entry point doesn't read.

### One transfer's ledger

```js
import { transferLedger } from "@dusk-network/app-core/bridge";

const ledger = transferLedger({ row, arrival, locale }); // from a row of `/activity`
// Or from what an app keeps of a transfer:
transferLedger({ network, route: "dusk-to-bsc", sent: amountLux, networkFee: [feeLux, proveFeeLux, claimFeeLux], gasWei: feeWei, received, locale });
// ledger.lines: [{ key: "sent", amount, decimals, coin: "DUSK", text: "0.19", exact: "0.190082082", expected: false }, { key: "bridgeFee", … }, { key: "networkFee", … }, { key: "received", … }, { key: "gas", … }]
```

Each app shows the same numbers: a row a line's `text`, its detail `exact`. A line is there only where it's known, and a route without such a fee has none. `received` is what arrived, or until then what will (`expected`), and `gas` what was paid in the other chain's coin. Of a transfer that failed, only its fee is left. What left an account holds a gas refund it paid another, which isn't the transfer's; a value from the wallet's own record holds none, as `/requests` reads it too.

```js
import { migrationApprovals, migrationFacts, migrationsOf, transferLedger } from "@dusk-network/app-core/bridge";

const evm = await migrationFacts({ network: chainId, migrations: migrationsOf(rows), fetch, cache }); // or [{ hash, route, approval }] the app keeps
transferLedger({ row, evm: evm.get(row.memo) }).gas; // { key: "gas", coin: "BNB", exact: "0.00000474855", parts: ["approval", "migration"], … }

const { approvals } = await migrationApprovals({ network: chainId, owners: evmAddresses, fetch, cache });
// [{ hash, state: "revoke", gasWei: 24222000387552n, coin: "ETH", at, owner, … }]: what each approval and revoke cost, for the receipts and `accountingCsv`'s `approvals`
```

- A migration's gas is what it paid on its own chain and what the approval it spent paid, to the wei, whichever app signed either and whenever: the approval is the owner's latest of the route's contract on its token before the migration, found among their logs read back from the migration's block, 5,000 blocks first and twice as many each window after, 75,000 at most. The token writes an approval of what's left as a migration spends one: that's no approval. Where an earlier migration spent from the same approval, its fee is that one's (`approvalState: "earlier"`): a transfer to the contract between them spent from it where the token wrote an approval in it too, and the owner's own transfer to the contract didn't; where the token writes none as it's spent, that can't be told, and the approval's fee isn't counted (`"uncertain"`). An RPC that no longer gives logs that far back says nothing, or refuses them (Ethereum's publicnode a day on), and that's said too (`"unread"`): the migration's gas alone, its `parts` saying so. With the approval's hash (`approval`), the logs are read all the same, for an earlier migration that spent it first; where they can't say, it counts only when the owner sent it right before the migration, by their nonce. A migration that failed spent no approval.
- `migrationsOf` gives the migrations `/activity`'s rows were paid for: a migration's payout on Dusk has its hash as the memo.
- `migrationApprovals` gives the approvals and revokes the person's EVM addresses sent for each migration route's contract, oldest first, each with what it paid in gas there and what came of it: `spent` by a migration (whose gas line has it), `unused` (the owner's next approval or revoke came first), `open`, `uncertain` (a transfer to the contract came between whose transaction can't be read), or a `revoke`. A migration's draw is a transfer to the contract with the token's Approval beside it, or, for a token that writes none, in a transaction sent to the contract or with an event of its own: the owner's own transfer to it draws on nothing. They're the token's Approval logs between the two, read back from the head in the same windows, 8 at most, an Approval in a migration's own transaction aside; `reads` says how far back each was read. One another address sent, as a permit, paid nothing of the owner's and isn't there. `accountingCsv` books each that no migration's lines have (`approvals`), so an approval never used and a revoke cost what they did.
- A transfer to BNB Smart Chain brings no gas money on mainnet: its payout address only mints and pays out the token. The 0.01 ETH testnet's test chain sends a recipient that holds little comes from a wallet of the test chain's own, which the network's file doesn't name: nothing here books it.

### A route's status

```js
import { bridgeStatus } from "@dusk-network/app-core/bridge";

const status = await bridgeStatus({ network: chainId, route: "dusk-to-bsc", cache, fetch });
// { paying: "yes", lastPayout: { hash, at, amount, block }, readSince: null, waitingSince, canPay: null, limit: "mints", gas: { wei, coin: "BNB" }, running: true, readAt, requests: 10, error: "" }
```

- One read on opening the page: what it read stays in `cache` (a `Map` of text does) for 10 minutes (`maxAgeMs`), two at once make one, and the next asks only for the blocks since, or further back while no payout is known, up to 30 days. Without a cache, each call reads. A read is a few small requests: the node's head and an account's newest, and on the other chain its head and at most 8 log searches.
- `paying`: "yes", a payout in the last week or four times the route's usual time; "late", a transfer in went past twice the usual time with no payout since, where that's known, as on a route out; "quiet", none, and nothing says one is due; "stopped", the route isn't running; "on-claim", a DuskEVM withdrawal, whose owner claims it; "unknown", the reads failed.
- `canPay`: a migration's, its payout account's balance; a DuskEVM withdrawal's, the L1 bridge's. A route out to BSC has none (`limit: "mints"`): its payout address holds no DUSK between payouts, as it mints what it pays, so `gas` says what it has to pay with. A deposit to DuskEVM is minted there. A Transfer of nothing from the payout address, which anyone's transaction can write, is no payout.
- How many transfers wait isn't said: that takes matching each transfer in to its payout, as `serviceArrivals` does for a person's own. Nor is a DuskEVM withdrawal's last claim, which no read finds without paging all the bridge's events.

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

- `syncWithdrawals({ address, duskEvm, network, state })` reads an address's withdrawals from the bridge's own `ETHBridgeInitiated` events, the newest final blocks first, a window of 100,000 blocks at a time (narrower where the RPC asks for it), 8 requests a run, the head's among them. It gives the app the state to keep, and the next run carries on below. Each run reads the newest 50,000 final blocks, the new ones first, in as many windows as they take, though in half its requests at most (while older blocks are still to be read, only once the final head has moved). Under a final head lower than the last run's, what it covered and found above it is dropped, and read again. Where the RPC has no finalized block, the latest less 1,800 blocks (`UNFINALIZED_MARGIN`, about an hour) is the final head, and the blocks a run reads within 1,800 under it are read again once they're under a later run's (`open`, in the state): among the newest blocks a run reads again, or, once all the blocks are covered, before its passes over them, with the requests it has left. A deeper reorg there is found, and older blocks are read as they would be without it. It reads each final block more than once: once it has covered them all, it reads them again from the newest down, a pass at a time with the requests a run has left, the first an hour later and each one after as long again as it has been since. A withdrawal is found once.
- `explorerWithdrawals({ address, network, fetch })` lists the address's own calls of the bridge on DuskEVM's explorer, each with the explorer's word for it (`explorerStage`), and `withdrawalsByNonce({ nonces, network, fetch })` finds the DuskEVM transactions of withdrawals known by the nonces their proofs and claims on Dusk carry.

### Reads and caches

- The Portal and the dispute game factory are read with the app's drivers; each game's hub and the anchor state registry raw. Reads go to the node's contracts through the app's `fetch` (its Multicall for Dusk batcher), sent again twice at most when the node answers 429, 502, 503 or 504; a refusal carries the contract's own words. `maxBatch` is how many reads one query holds (32 by default), each game checked taking 4: its status, the Portal's blacklist, and the registry's two answers. A game's status is read on its own hub, which the factory names: a game type's hub can change, and the games made before stay where they were.
- What a deployment doesn't change is read once: each game's hub and each game type's hub, once the factory names one, each hub's clock limit, and a withdrawal's receipt once its DuskEVM block is final. A receipt is read after DuskEVM's finalized block, one read for the receipts read at the same time, and kept when its block is at or under that one; one that isn't final yet, or isn't a withdrawal's, is read again each time. `cache`, a `Map` of text by default, is where they're kept: an app can keep them across sessions.
- Dusk's latest block comes from `latestBlock`, or the node's GraphQL. Without it, a proved withdrawal's status fails: its date can't be worked out, and no claim is built.

## License

MPL-2.0. `src/confusables.js` is Unicode's data, © Unicode, Inc., under the [Unicode License v3](https://www.unicode.org/license.txt).
