# Changelog

## 1.0.0

- Added `run_async`, `operation_status`, `operation_output`, and `operation_cancel` Pi tools backed by session-scoped persistent shell operations.
- Reused Pi's built-in Bash validation and permission pipeline and rejected non-built-in Bash implementations.
- Added bounded output retrieval, cancellation, per-session ownership, lifecycle cleanup, and asynchronous-operation prompt guidance.
