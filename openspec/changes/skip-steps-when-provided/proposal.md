## Why

A moa run always executes every step of the chosen pipeline. Work that arrives with a plan already made and reviewed (e.g. an OpenSpec change: proposal / specs / design / tasks) therefore either re-plans — spending tokens to second-guess a human-approved plan — or needs a duplicate pipeline without planning phases. One pipeline should serve both cases, and every skipped step must stay visible.

## What Changes

- Steps gain an optional `unless: <input>` field: the step is skipped when the run declares that input as already provided.
- `moa_run_start` gains an optional `provided: string[]`; skipped steps are removed from the run's step list before the manifest is written (manifest records `provided` and `skipped`).
- Fail fast at run start: a surviving **gate** step whose loop-back target (explicit `loopBackTo`, or the implicit "nearest previous producer") was skipped → error naming the fix. A non-gate step's `loopBackTo` to a skipped phase is ignored (it only feeds the effort ladder).
- The frame reports what was skipped and why (`skipped: plan, review-plan (provided: plan)`) and notes provided inputs that no step declares.
- Templates `full-engineering.yml` and `lite-build.yml`: `unless: plan` on planning phases. Skill: one source-agnostic line — declare `provided` when the brief already carries an input a step would produce.

## Capabilities

### New Capabilities
- `provided-inputs`: a run declares inputs that already exist; the steps whose only job is to produce them are skipped, visibly and safely.

### Modified Capabilities
- (none — `openspec/specs/` is empty; this is moa's first spec)

## Impact

Computed with `graphify affected` / `graphify explain` (graph rebuilt AST-only, 684 nodes):
- `moa-core/mcp/server.mjs`: `zStep` (l.93 — the ONE step shape shared by config pipelines, ad-hoc steps and the tool boundary), `opRunStart` (l.1624 — filter, validate, manifest, frame), `moa_run_start` registration (l.2466 — new param). `opStepReport`'s REVISE path (l.1859) stays untouched: it already errors on a missing target; run-start validation makes that unreachable for skipped targets.
- `moa-core/schema/config.schema.json`: `unless` on step items.
- `moa-core/mcp/test.mjs`: callers of `opRunStart` — `freshRun`, `deltaRun`, `startExternalRun`, `twoStepExternalRun` — untouched (param optional); new tests added.
- `moa-core/templates/full-engineering.yml`, `lite-build.yml`: `unless: plan`.
- `moa-core/SKILL.md` (symlinked into `~/.claude/skills/moa`) and `DESIGN.md` §4: document the field.
