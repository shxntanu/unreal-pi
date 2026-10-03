# Changelog

## [Unreleased]

### Added

- Added a Pi-independent local operation manager with registered runners, bounded concurrency, cancellation, shutdown, and restart recovery.
- Added versioned operation/result/event contracts and a built-in SQLite store with atomic lifecycle/event persistence, exclusive manager ownership, strict JSON bounds, and paginated history.
- Added a streamed shell runner with bounded output tails/logs, versioned metadata, exit and duration capture, timeouts, process-tree cancellation, and shutdown cleanup.
- Added bounded UTF-8-safe stdout/stderr tail reads with literal filtering, explicit missing-file results, and path/symlink checks.
