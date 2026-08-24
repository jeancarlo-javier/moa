## Why

A moa run always executes every step of the chosen pipeline. Work that arrives with a plan already made and reviewed (e.g. an OpenSpec change: proposal / specs / design / tasks) therefore either re-plans — spending tokens to second-guess a human-approved plan — or needs a duplicate pipeline without planning phases. One pipeline should serve both cases, and every skipped step must stay visible.

## What Changes

- Steps gain `skippable: true` — the run may skip this phase. Forbidden on any gate: `provided` is written by the run, and a run must never delete a gate directly.
- `moa_run_start` gains an optional `provided: string[]`, naming **phases** whose output the caller already has. Skipped steps are removed before the manifest is written (manifest records `provided` and `skipped`).
- A step whose parent was skipped is skipped too, transitively. The parent is `requires: <phase>` when declared, otherwise — **for a gate only** — its `loopBackTo`. A gate exists to guard the phase it sends work back to; when that phase is gone the gate has nothing to verify. `requires` covers children with no `loopBackTo` (e.g. `execute` → `q&a`); non-gate `loopBackTo` keeps its only current meaning, the effort-ladder key.
- Fail fast at run start on authoring mistakes only: no surviving steps; `provided` naming a phase that is unknown or not `skippable`; `skippable` on a gate; non-empty `provided` under `master.mode: strict`, which is defined as running the pipeline verbatim. A well-formed run never hits a blocker.
- Fix an existing defect the skip path exposes: `describeStep` reads the effort rung from `loops[s.loopBackTo ?? s.phase]` (`:1587`) while the REVISE branch writes `loops[steps[ti].phase]` (`:1866`). With `plan` skipped, `execute` (`loopBackTo: plan` in all three shipped pipelines) is frozen at rung 0 through every REVISE. Fall back to `s.phase` when `loopBackTo` names a phase absent from `manifest.steps`.
- The frame reports what was skipped and why (`skipped: plan (provided), review-plan (child of plan)`) and shows only surviving phases in the pipeline string.
- Templates `full-engineering.yml` and `lite-build.yml`: `skippable: true` on `plan`. Nothing else — `review-plan` follows by cascade. Skill: one source-agnostic line — declare `provided` when the brief already carries a phase's output.

## Capabilities

### New Capabilities
- `provided-inputs`: a run declares phases whose output already exists; those steps and their dependents are skipped, visibly and without blocking.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this is moa's first spec)

## Impact

Computed with `graphify affected` / `graphify explain` (graph rebuilt AST-only, 684 nodes):
- `moa-core/mcp/server.mjs`: `zStep` (`:93` — the ONE step shape shared by config pipelines, ad-hoc steps and the tool boundary), `opRunStart` (`:1624` — filter, validate, manifest, frame), `moa_run_start` registration (`:2466` — new param), `describeStep` (`:1587` — effort-rung fallback), `opLoad`'s pipeline formatter (`:1091` — currently emits only phase/role/gate, so it cannot report the new fields).
- Unchanged by design: `opStepReport`'s REVISE branch (`:1859`). An explicit `loopBackTo` can no longer dangle — a gate naming a skipped phase is itself skipped — and implicit targets keep resolving among survivors at report time exactly as today.
- `moa-core/schema/config.schema.json`: `skippable` + `requires` on step items; `master.mode` strict description (`:77`) must state that `provided` is rejected.
- `moa-core/mcp/test.mjs`: callers of `opRunStart` — `freshRun`, `deltaRun`, `startExternalRun`, `twoStepExternalRun` — untouched (param optional); new tests added.
- `moa-core/templates/full-engineering.yml`, `lite-build.yml`: `skippable: true` on `plan`.
- `moa-core/SKILL.md` (symlinked into `~/.claude/skills/moa`) step 3, `DESIGN.md` §4 (`:46` states gates "can never be skipped" — must be narrowed to master discretion), `moa-core/references/run-store.md` (`:18`–`:27` lists manifest fields without `provided`/`skipped`).
