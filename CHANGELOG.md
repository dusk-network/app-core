# Changelog

All notable changes to this package are listed here. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
