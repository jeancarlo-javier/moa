# Run store — durability, resume, determinism, budgets

Every run writes to `runtime.workDir/runs/<run-id>/` (default `.moa/runs/<id>/`).
The store makes long multi-agent runs resumable, revertible, auditable, and reproducible.

## Effective config (materialized before any subagent runs)

`validate` resolves the source `.moa.yml` (+ template defaults + per-run
overrides) and writes **`effective-config.json`**: for each role the exact
`{ model, provider, modelFamily, family, binding, selectionReason }`, where `binding` is the
chosen realization (host-native or a learned tool profile). A reviewer reads what *actually* ran,
not just the optional source YAML.

Precedence (highest wins): **per-run override > project config > template default > skill built-in.**

## Run manifest (append-only)

`manifest.json` records, per phase:
`{ phase, status, attempt, inputHash, producedArtifacts, changedFiles, lockOwner, retryPolicy }`.
`status` is one of the explicit terminal/intermediate states (`pending`, `running`, `done`,
`blocked_no_binding`, `blocked_no_model`, `verification_unavailable`,
`blocked_verifier_disagreement`, `max_loops_exceeded`).

## Patches-first execution

Coder/verifier subagents work in an **isolated worktree/patch sandbox** and produce a
**patch** first. Applying that patch to the real workspace is a separate, committed
transition recorded in the manifest. Consequences:
- A mid-phase crash or timeout is resumable — replay from the last committed phase using
  `inputHash` to detect staleness.
- A bad phase is revertible — the unapplied patch is just discarded.
- Parallel workers can't corrupt each other: each has its own worktree; undeclared writes
  are rejected; patches merge serially; conflicts are treated as review failures.

## Budgets & determinism

- Budgets are **not** enforced, and moa does not meter spawns itself: `moa_spawn` returns no
  usage or cost. Only what the conductor passes to `moa_step_report` as `usage` accumulates into
  the manifest — an honest record of what was reported, nothing more. A run is bounded per spawn
  by the profile's own `run.timeoutSeconds` and the server's output limit, never by a per-run
  cost or token ceiling.
- For CI / release-critical templates, the `models` registry must use **pinned** refs (no `auto`),
  so the same config produces the same routing on every machine.
