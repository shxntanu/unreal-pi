# Async harness experiment: Pi core delta

## Step 1 — architecture and Milestone 0

No agent-loop, provider API, session persistence, tool implementation, TUI, runtime dependency, or package manifest changes.

The opt-in observer lives at `packages/coding-agent/examples/extensions/baseline-metrics.ts`. It uses existing lifecycle/execution hooks and registers only the `--baseline-results` CLI flag. It writes external JSONL rather than adding model-context or session entries.

Documentation changes: `docs/async-harness-design.md`, `experiments/async-harness/README.md`, the extension examples index, and the coding-agent Unreleased changelog.

Source verification required local dependencies (`npm ci --ignore-scripts`) and ignored model data (`npm run hydrate:model-data`). No build, full test suite, paid model call, commit, branch switch, or unit-test addition is part of this step.

Future core changes remain gated on repeated measurements showing that extension-level completion delivery is materially constrained by the current tool-batch barrier.
