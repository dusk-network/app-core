# Changelog

All notable changes to this package are listed here. It follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `/shielded`: `shieldedHistory`, a profile's shielded history from the notes its sync keeps, each block asked for among decoys kept before asking

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
- Published to npm as `@dusk-network/app-core` and to JSR as `@dusk/app-core`
