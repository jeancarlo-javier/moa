# Run store — durability, resume, determinism, budgets

Every run writes to `runtime.workDir/runs/<run-id>/` (default `.moa/runs/<id>/`).
The store makes long multi-agent runs auditable and reproducible. Phase transitions are
recorded in the manifest; external executions are recorded separately as spawn records.

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

## Spawn records

External executions live at `runs/<run-id>/spawns/<spawn-id>.json`. The record is written before
model discovery or launch and atomically advances through `queued`, `discovering`, `running`, and
one terminal state: `completed`, `failed`, `timed_out`, `cancelled`, or `interrupted`. It stores the
prompt hash, exact resolved route, timestamps, normalized result or structured failure, and child
PID while running. A stable request key deterministically identifies the job, so retrying a lost
start response cannot duplicate paid work.

Terminal records survive client disconnects and MCP server restarts. A nonterminal record found
without a live owning server process becomes `interrupted`; moa does not claim to reattach to a
child across an MCP server crash. Spawn records are execution evidence, not phase transitions:
only `moa_step_report` changes pipeline progress or verification state.

Concurrent control of one run by multiple MCP server processes is unsupported: only the owning
server process drives a nonterminal job. A foreign status reader uses the recorded `ownerPid` as
the liveness signal: a live owner keeps the record out of `interrupted`, while a dead owner
promotes it to `interrupted` even if an orphan child PID is still observable — moa does not
wait on a child whose owning server is gone. Cancellation is cooperative through the MCP
boundary and forceful at the child boundary (SIGTERM → one-second grace → SIGKILL). A launcher
timeout surfaces as `timed_out` with failure code `timeout`; a discovery timeout surfaces as
`failed` with failure code `model_discovery_timeout`.

moa does not implement a patches-first / worktree sandbox layer: workers execute in the manifest's
project directory and apply changes directly. A phase restart replays the producer from scratch;
moa does not claim to apply isolated patches on resume, and any earlier prose claiming automatic
mid-phase patch application or arbitrary resume-after-crash is broader than the code.

## Budgets & determinism

- Budgets are **not** enforced, and moa does not meter spawns itself: `moa_spawn` returns no
  usage or cost. Only what the conductor passes to `moa_step_report` as `usage` accumulates into
  the manifest — an honest record of what was reported, nothing more. A run is bounded per spawn
  by the profile's own `run.timeoutSeconds` and the server's output limit, never by a per-run
  cost or token ceiling.
- For CI / release-critical templates, the `models` registry must use **pinned** refs (no `auto`),
  so the same config produces the same routing on every machine.
