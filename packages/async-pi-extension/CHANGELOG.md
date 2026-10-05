# Changelog

## [Unreleased]

### Added

- Added automatic compact terminal notifications, idle wakeup and active steering, persisted session-message receipts, and restart recovery without duplicate notifications or command replay.

### Changed

- Separated compact model-facing completion content from persisted, expandable human-facing output. Successful operations use 512-byte stream excerpts; failures and cancellations use 8 KiB stream excerpts with diagnostic context. Reload and compaction retain the separation.

### Fixed

- Made `run_async` the explicit default for slow shell commands, including when no independent work remains, and clarified system-prompt guidance to continue independent work or end the turn until automatic completion delivery instead of polling status, output, or logs.

## 1.0.0

- Added `run_async`, `operation_status`, `operation_output`, and `operation_cancel` Pi tools backed by session-scoped persistent shell operations.
- Reused Pi's built-in Bash validation and permission pipeline and rejected non-built-in Bash implementations.
- Added bounded output retrieval, cancellation, per-session ownership, lifecycle cleanup, and asynchronous-operation prompt guidance.
