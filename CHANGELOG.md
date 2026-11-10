# Changelog

All notable changes to this package are listed here. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/text`: `numbersNote`, what a text's numbers ask a person to check, in the words both wallets show: "A number here uses digits that look like other digits. Check it digit by digit."
- `/names`: `profileNameClash`, the name a profile's new name takes of the other profiles and the contacts, look-alikes too, to refuse
- `/export`: `rewardsByYear`, staking's rewards by calendar year as they reached the account, native ones claimed and what Sozu's unstakes took out, in DUSK and at each one's price
- `/sozu`: `nativeRewards`, what native staking paid over the last 30 days, measured from the stake contract's rewards on chain, and the yearly rate that comes to; `sozuRateLine` says it with its period (`native`)
- `/requests`: a match of a request of no amount says so (`anyAmount`), for its badge to say what came in rather than "Paid"
- `/payment-links`: `parsePaymentLink` reads a plain `dusk:<address>` link, an account or a shielded address as written, with its query and network

### Changed

- `/amounts`: `defaultCurrency` is the currency the browser's region pays in where CoinGecko gives DUSK's price in it, as SGD in Singapore, else USD; `PRICE_CURRENCIES` lists those it gives
- `/export`: `accountingCsv` writes every value in fiat to 8 decimals, a cent's worth or a fraction of one
- `/export`: `accountingCsv` writes the person's contact name for a counterparty, where they asked for theirs, before its verified .dusk name
- `/amounts`: `readAmount` says a space the language doesn't group with is what's wrong: "Leave out the space: 1234,5."

### Fixed

- `/text`: `displayText` shows a variation selector that isn't on an emoji or a keycap as its code, so `/names`' `nameHides` refuses "Alice" with U+FE0F after it
- `/payment-links`: a `dusk:` link that also names a recipient in its query (`to=`) is refused as saying the recipient twice
- `/payment-links`: a network whose number has a zero before it (`dusk:02`) is one that can't be read, not the one it looks like

## [0.9.1]

### Fixed

- `/amounts`: `amountsMeant` reads an amount typed with its leading zeros, so `0.0` finds 0.05

## [0.9.0]

### Added

- `/names`: `nameHides` and `NAME_HIDES`, a name holding what can't be seen, as a right-to-left override, to refuse
- `/text`: `displayText` flags a number whose digits look like other Latin digits than they are (`lookalike_digits`), as Bengali's ৪ that looks like an 8
- `/text`: `searchKey`, text as a search compares it, without accents, case or what can't be seen, so "ilustracion" finds "Ilustración"
- `/amounts`: `amountsMeant`, the amounts of DUSK a search can mean, with either decimal mark
- `/requests`: a request's kept payment holds what it paid (`paid.lux`), which `matchRequests` gives for a request kept paid, as the chain's where its payment is read
- `/sozu`: `stDuskWorth`, what one stDUSK was worth when a stake or an unstake went through, as the export says it
- `/requests`: `refundOf`, a payment that paid a request again, sent back to its sender with the request's memo
- `/export`: `accountingCsv` takes `evmAddresses`, the EVM addresses the app knows as the person's own, and then writes a migration's gas only where one of them sent it

### Changed

- `/names`: `sameName`, `nameClash` and `lookAlikes` compare names without what can't be seen in them
- `/payment-links`: `readPaymentLink` says why it refuses a link: a field said twice, a user part before the host, two networks, a network that can't be read, or no recipient

### Fixed

- `/payment-links`: a `dusk:` link's `network=` names its network, as an https link's does, so one for another network is refused

## [0.8.2]

### Fixed

- `/export`: `accountingCsv` puts a migration's fees on its own chain in the period of their own time, not their payout's

## [0.8.1]

### Fixed

- `/bridge`: `migrationFacts` reads an RPC's refusal of old logs, as Ethereum's gives a day on, as `"unread"` with the migration's gas, not an error

## [0.8.0]

### Added

- `/amounts`: `defaultCurrency`, euros where the browser's region pays in them, US dollars elsewhere
- `/bridge`: `migrationFacts` and `migrationsOf`, a migration's gas on its own chain with the approval it spent, which `transferLedger` takes (`evm`)
- `/export`: a migration's gas and its approval's, on lines of their own (`evm`)
- `/names`: `looksAlike`, `sameName`, `nameSkeleton`, `nameClash` and `lookAlikes`, by Unicode's confusables
- `/payment-links`: `readPaymentLink`, a link as Send reads it on the wallet's network, and the network it's for
- `/requests`: `matchRequests` and `sentAlready`; a request of no amount paid with its memo is paid
- `/sozu`: `sozuGrowth`, how stDUSK grew over the last 30 days, which `sozuRate`, `sozuYear` and `sozuRateLine` take
- `/text`: `displayText` flags digits that read right to left (`rtl_digits`) or mix systems (`mixed_digits`)

### Changed

- `/payment-links`: `parsePaymentLink` refuses a link that says a field twice or has a user part before its host

## [0.7.2]

### Added

- `/text`: `displayText`'s `isolate`, right-to-left words and numerals set apart and their lines kept left to right, so a text reads in the order of its bytes

### Fixed

- `/sozu`: `sozuFacts` reads the stDUSK an unstake burned where it reached a provisioner, to the lux where it took all, so `/export` writes it as the trade back; facts cached by 0.7.1 are read again

## [0.7.1]

### Fixed

- `/export`: a token's transfer has its amount, currency and recipient in the file's own columns, from the wallet's record of it, and an allowance says what it allows and to whom
- `/activity`: `settleSends` keeps a token's record by default, for what the chain's row doesn't say

## [0.7.0]

### Added

- `/text`: `displayText`, text a person must trust with what hides in it made visible
- `/payment-links`: `parsePaymentLink` and `makePaymentLink`, `dusk:` and https payment links, made only for what Send takes
- `/export`: `accountingCsv`, an account's activity as Koinly's universal CSV, for a quarter or any dates
- `/sozu`: `sozuPosition`, `sozuYear`, `sozuRateLine` and `sozuFacts`, a stake with Sozu in figures
- `/bridge`: `transferLedger`, a transfer's exact amounts, the same in every app
- `/bridge`: `bridgeStatus`, whether a route is paying out, its last payout and what it can pay
- `/amounts`: `formatAmount`, an amount of any decimals by DUSK's rule
- `/amounts`: `readAmount`, what was typed or what's wrong with it in plain words, and `amountExample`, a hint's example in the language's separators

### Changed

- `/amounts`: `normalizeAmount` reads a language's own digit groups: `1 000,5` in French, `1'000` in Swiss German, `12,34,567` in Hindi

## [0.6.0]

### Added

- `/amounts`: `formatDusk` and `formatDuskPlain`, moved from `@dusk-network/networks/format`, and reading amounts in the browser's language

## [0.5.2]

### Changed

- `@dusk-network/networks` 0.3.2, with devnet's explorer on its own domain

## [0.5.1]

### Changed

- `@dusk-network/networks` 0.3.1, with mainnet's and testnet's explorers on their own domains

## [0.5.0]

### Added

- `/bridge-explorer`: `depositArrivalsFromExplorer`, deposits followed on DuskEVM's explorer without the RPC path and `/history`, which `/bridge` exports too
- `/bridge`: a network an app builds from its own settings, for a chain there's no network file for, its fields checked as a file's are
- `/bridge`: `depositArrivals` takes a `cache`, where the call of each deposit a sender's history lists is kept once its block is final and its arguments are read, and isn't asked for again

### Fixed

- `/bridge`: on the RPC, a deposit with its sender is followed as without the archive while the archive can't be read, and is an `error` only when the RPC can't be read either
- `/duskevm-withdrawals`: a game type's hub is kept in `cache` only once the factory names one, so a proof goes against a resolved game once it does
- `/duskevm-withdrawals`: where the RPC has no finalized block, `syncWithdrawals` reads the blocks it read within 1,800 under the head it takes as final again on a later run, rather than once

## [0.4.1]

### Changed

- `/duskevm-withdrawals`: a withdrawal's receipt is kept in `cache` once its DuskEVM block is final, and read once

### Fixed

- `/bridge`: a memo of bytes that aren't text (`memoBinary`) gives no payout address, and names no migration

## [0.4.0]

### Added

- `/history`: `memoBinary` on an entry whose memo is bytes given as 0x hex, rather than typed 0x text
- `/history`: a `check` for the store's `patch` and `clear` to make in the same transaction, so a run after a reset leaves another run's history of the new chain alone
- `/shielded`: an optional `update` on the store, which keeps the decoys in one transaction, so two reads at once ask among the same ones
- `/bridge`: `serviceArrivals` takes `blockTimes` as a cache for each chain, by its chain ID

### Changed

- `/history`: a details request that fails in `sync()` ends the run's details and resolves it with `detailsError`, rather than rejecting the run
- `/bridge`: an RPC search's windows grow up to 100,000 blocks while the RPC answers them whole, and a call reads a chain's head and pace once for all its searches

### Fixed

- `/shielded`: a conversion is a shield or an unshield as its event says, also for a profile that only got its change
- `/shielded`: two notes a block made for one shielded address go to a transaction each, rather than both to the first
- `/activity`: a gas refund from another account's call to DuskEVM's bridge is a received transfer, rather than a bridge withdrawal
- `/bridge`: an RPC search starts 10 minutes before the transfer as the chain's pace says, at a block whose time is checked to be before it, rather than a fifth further back than the pace says
- `/bridge`: an RPC search keeps the width of its windows in its `scan`, so one window a call moves on past an RPC that takes fewer blocks than it asked
- `/bridge`: `serviceArrivals` uses one `blockTimes` cache only for a network whose service routes are all on one chain
- `/bridge`: a deposit without its sender's history reads no further once its windows are over and read
- `/duskevm-withdrawals`: `syncWithdrawals` reads the final blocks again, the newest 50,000 on each run and all of them a pass at a time once covered, rather than once
- `/duskevm-withdrawals`: `syncWithdrawals` counts both its head's requests against `maxRequests` where the RPC has no finalized block

## [0.3.2]

### Fixed

- `/bridge`: an RPC search reads each block more than once while its transfers wait, from the first transfer's block on, rather than once
- `/bridge`: on an RPC, an earlier one of equal transfers takes a credit a later one could have had once the blocks before it are read again, rather than at once

## [0.3.1]

### Added

- `/history`: `historyRange` reads on from a `page`

### Fixed

- `/bridge`: each transfer reads only its own hours of its account's history, read on from its `scan` while a call can't read it all: it waits then, rather than staying unsure
- `/bridge`: a transfer the archive doesn't list in its account's history yet waits, rather than taking an earlier one's credit
- `/bridge`: a deposit whose call's arguments the archive doesn't give counts as one that could be equal, rather than none

## [0.3.0]

### Added

- `/duskevm-withdrawals`: a DuskEVM withdrawal's start, finding it again, its status and claim date, and its proof's and claim's calls, checked before they're handed over to sign

### Fixed

- `/bridge`: a migration is paid by its own route's payout account also where one account pays out both routes (a payout of one not listed then has a null `route`), and a payout read from an entry leaves out a gas refund paid with it, which `/history` entries now tell apart as `refund`

## [0.2.0]

### Added

- `/bridge`: `depositArrivals`, `migrationPayouts` and `serviceArrivals`, where a deposit to DuskEVM, a migration and a transfer out to BNB Smart Chain arrived, each credit paying one transfer, in order

## [0.1.0]

### Added

- `/history`: `createHistory`, a public account's history synced from the archive by block height into the app's own store, newest first, carried on run by run, and `StaleHistoryError` for a run another one overtook
- `/history`: `createArchive`, the archive's GraphQL by the app's fetch or caller, with exact amounts, retries, and an hour's rest for a node without the archive
- `/history`: `historyArchiveUrl`, the node in place of an archive on another chain
- `/history`: `parseHistoryEntry` and `historyEntry`, what an entry did for the account, with its bridge route and Sozu call
- `/history`: `fetchTxDetails` and `fetchTxNonce`, a transaction's time, outcome, fee and call, a DuskEVM bridge call read from its arguments
- `/history`: `callFacts`, the app's own hook for the calls it reads
- `/history`: `historyRange`, an account's entries between two heights, a page at a time
- `/history`: `addCoverage`, `topGap` and `shownDownTo`, the heights a history covers
- `/shielded`: `shieldedHistory`, a profile's shielded history from the notes its sync keeps, each block asked for among decoys kept before asking
- `/activity`: `activityRows`, an account's rows from its public and shielded history and the wallet's own sends, as facts, and `settleSends`, for the sends the chain's rows now say all of
- Published to npm as `@dusk-network/app-core` and to JSR as `@dusk/app-core`
