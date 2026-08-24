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

Two run-level fields record what the run chose NOT to do. `provided` is the phase list the caller
passed to `moa_run_start` (`null` when it passed none), and `skipped` is `[{phase, reason}]` in
pipeline order, where `reason` is `provided` (the caller declared that phase's output already
exists) or `child of <phase>` (its parent was skipped). `steps` holds only the survivors, so every
index into it — `current`, `stepIndex` on a spawn record, the loop counters — counts survivors and
nothing else; the skipped phases live only in `skipped`.

The manifest also carries two run-level observation fields. `attempt` is a run-global monotonic
counter incremented on every REVISE loop-back and every gate ERROR retry: a re-entered step keeps
its `stepIndex`, so without it a completed spawn from attempt 1 would read as evidence about
attempt 2. `snapshotAtStepEntry` is the working-tree photograph taken when the current step was
entered, and is exactly one of three shapes — `null` (not a repository, or git unusable),
`{root, head, entries: null, frame, reason}` (a repository moa **refuses** to claim it observed),
or `{root, head, entries, sinceHead, frame}` (observed). `entries` maps a projectDir-relative
POSIX path to a **content identity**, not a path set: a file that was already dirty at entry and
edited again has a different identity, which a comparison of path sets cannot see. `frame` is the
filesystem identity — `dev:ino` for the resolved project directory and for the absolute git
directory — pinned before the observation and re-validated after all of it, and compared again
across the pair in `computeDelta`: a directory replaced at the *same* pathname leaves every path
string equal and is invisible to anything but its inode. The check compares two *endpoints*, so it
catches a replacement that outlives either of them and not one undone in between — see the ABA
boundary below.

Each phase record additionally carries `observed`
(`{source, reason, files, undeclared, phantom}`). `source` is `"git"` when the phase was observed
and `"unobserved"` otherwise, and only a `"git"` observation feeds the mutation floor; anything
else falls back to the phase's declared `changedFiles`.

**Scope of the observation**, stated rather than implied: it covers **git-visible net repository
state under `projectDir` only**. Out of scope, each named — writes outside the repository; writes
outside `projectDir` in a monorepo (porcelain paths are repo-root-relative and anything escaping
`projectDir` is dropped); git-ignored paths, and paths marked `assume-unchanged` or
`skip-worktree`, which git reports as clean by design; **a write hidden by an ABA swap of the
project or git directory — replaced at the same path *after* the frame is pinned and put back
*before* it is re-validated, so both endpoints stat the same inode, the frame holds, and the
snapshot reports `source: "git"` over content it never read**. That one is not a refusal and does
not degrade to the declared list: it is a case the observation cannot see, and it is deliberately
**not guarded**. Closing it needs every read bound to a directory *handle* rather than re-resolved
from a pathname (`openat` semantics), which Node does not expose — and a guard built on pathnames
strong enough to catch it also refuses on ordinary operation. That is the same reason the
`assume-unchanged` / `skip-worktree` case above is documented rather than defended: the underlying
move is an in-place `$GIT_DIR/index` replacement, and pinning the index inode would refuse on
ordinary `git status`, which rewrites the index through an `index.lock` rename. Both cases need an
actor manipulating the filesystem *during* the observation, so the snapshot is evidence about a
filesystem no one is racing; it is **not proof against concurrent filesystem manipulation**.
Pinned as an executable limitation by the `KNOWN LIMITATION` row in `mcp/test.mjs`. Also out of
scope: **every repository moa refuses to
photograph — a `projectDir` that will not resolve, a repository identity that cannot be read, a
`projectDir` retargeted mid-observation, a project or git directory replaced at the same path
mid-observation, more than 2000 dirty paths, a dirty path that cannot be identified (unreadable,
or a dirty submodule), a HEAD that cannot be read and cannot be confirmed unborn, and a failed
diff after HEAD moved; those eight are the complete set of refusals in `workspaceSnapshot`, one
per distinct reason string, joined by one more in `computeDelta` (a project that resolves to a
*different repository* — a different path, or a different directory at the same path — between
step entry and report), and each falls back to the declared list**; and
attribution of a write to one worker among several, which is deferred with the worktree question
above.

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
Worktree-per-role isolation was **considered and deferred**, not overlooked: it is the only
mechanism that would make `fanout: byDisjointWriteSet` meaningful in a shared directory, and it
needs its own design. Until then, phase attribution rests on the phase-local delta, and concurrent
writers in one directory are explicitly out of scope.

## Budgets & determinism

- Budgets are **not** enforced, and moa does not meter spawns itself: `moa_spawn` returns no
  usage or cost. Only what the conductor passes to `moa_step_report` as `usage` accumulates into
  the manifest — an honest record of what was reported, nothing more. A run is bounded per spawn
  by the profile's own `run.timeoutSeconds` and the server's output limit, never by a per-run
  cost or token ceiling.
- For CI / release-critical templates, the `models` registry must use **pinned** refs (no `auto`),
  so the same config produces the same routing on every machine.
