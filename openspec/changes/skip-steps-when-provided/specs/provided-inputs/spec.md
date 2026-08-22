## Purpose

Lets a run declare phases whose output already exists (a reviewed plan, prior research, a design) so those steps — and the steps that depend on them — are skipped. One pipeline serves fresh work and pre-planned work, every skip is visible in the frame, and a well-formed run is never blocked.

Throughout this spec, **the reference pipeline** is:

| # | phase | role | gate | loopBackTo | other |
|---|-------|------|------|------------|-------|
| 0 | frame | master | — | — | — |
| 1 | plan | planner | — | — | `skippable: true` |
| 2 | review-plan | plan-reviewer | standard | plan | — |
| 3 | execute | coder | — | plan | — |
| 4 | review-work | code-reviewer | standard | execute | — |
| 5 | validate | verifier | critical | execute | — |
| 6 | finalize | master | — | — | — |

## ADDED Requirements

### Requirement: A step declares whether a run may skip it
A pipeline step MAY declare `skippable: true`, in config pipelines and in ad-hoc steps alike. A step without it SHALL never be skipped by `provided`. `skippable` SHALL be rejected on any step with a `gate` other than `none` — `provided` is written by the run, and a run SHALL NOT remove a gate directly.

#### Scenario: Config validation accepts skippable
- **WHEN** a `.moa.yml` pipeline step has `skippable: true` and no gate
- **THEN** `moa_load` accepts the config and its pipeline listing reports the field on that step

#### Scenario: skippable on a gate is rejected at load
- **WHEN** a `.moa.yml` pipeline step has both `skippable: true` and `gate: standard`
- **THEN** `moa_load` reports an error naming the phase and stating that a gate cannot be marked skippable

#### Scenario: skippable on an ad-hoc gate is rejected at run start
- **WHEN** `moa_run_start` is called with ad-hoc `steps` containing a step with `skippable: true` and `gate: critical`
- **THEN** it returns an error naming the phase and no run manifest is written

#### Scenario: Unknown fields still rejected
- **WHEN** a step has an unrecognized field
- **THEN** `moa_load` rejects it as before (strict step shape unchanged)

### Requirement: A step's parent determines whether it follows a skip
Every step SHALL resolve a parent phase: its `requires: <phase>` when declared, otherwise its `loopBackTo` **when the step is a gate**, otherwise none. A non-gate step's `loopBackTo` SHALL NOT make it a dependent — that field's only other meaning is the effort-ladder key. `requires` MAY be declared on any step, gates included, and MAY name any phase in the same pipeline.

#### Scenario: Gate inherits its parent from loopBackTo
- **WHEN** the reference pipeline runs with `provided: ["plan"]`
- **THEN** `review-plan` is skipped because its `loopBackTo` names the skipped `plan`, without declaring `requires`

#### Scenario: Non-gate loopBackTo does not create a dependent
- **WHEN** the reference pipeline runs with `provided: ["plan"]`
- **THEN** `execute` runs, even though its `loopBackTo` names the skipped `plan`

#### Scenario: requires declares a parent where no loopBackTo exists
- **WHEN** a pipeline has `execute` (`skippable: true`, no gate) followed by `q&a` (`requires: execute`, no gate, no `loopBackTo`) and the run starts with `provided: ["execute"]`
- **THEN** both `execute` and `q&a` are skipped

#### Scenario: requires overrides loopBackTo on a gate
- **WHEN** a gate declares both `requires: frame` and `loopBackTo: plan`, and the run starts with `provided: ["plan"]`
- **THEN** the gate runs, because its parent is `frame`, which was not skipped

### Requirement: Run start skips provided phases and their dependents
`moa_run_start` SHALL accept an optional `provided: string[]` naming phases of the chosen pipeline. A step SHALL be skipped when it is `skippable` and its phase is in `provided`, or when its parent was skipped — applied transitively until no further step is removed. Remaining steps SHALL keep their order and semantics. The manifest SHALL record `provided` and `skipped` as `{phase, reason}`, where `reason` is `provided` or `child of <parent-phase>`. Skipping SHALL happen before the manifest is written, so every later consumer sees only surviving steps.

#### Scenario: Provided plan skips the planner and its review gate
- **WHEN** the reference pipeline starts with `provided: ["plan"]`
- **THEN** the run's steps are `frame`, `execute`, `review-work`, `validate`, `finalize`; the manifest records `skipped` as `plan (provided)` and `review-plan (child of plan)`; the first step returned is `frame`

#### Scenario: Nothing provided, nothing skipped
- **WHEN** the reference pipeline starts without `provided`
- **THEN** all seven steps run in order and the manifest carries no `skipped` entries (behavior identical to today)

#### Scenario: Cascade is transitive
- **WHEN** a pipeline has `plan` (`skippable: true`), `review-plan` (gate, `loopBackTo: plan`) and `sign-off` (`requires: review-plan`), and the run starts with `provided: ["plan"]`
- **THEN** all three are skipped, `sign-off` with reason `child of review-plan`

#### Scenario: Repeated provided entries are idempotent
- **WHEN** the reference pipeline starts with `provided: ["plan", "plan"]`
- **THEN** the result is identical to `provided: ["plan"]`

### Requirement: Run start rejects only authoring mistakes
`moa_run_start` SHALL fail, writing no manifest, when: no step survives; `provided` names a phase absent from the chosen pipeline; `provided` names a phase that is not `skippable`; or `provided` is non-empty while `master.mode` is `strict`, which is defined as running the pipeline verbatim. Each error SHALL name the offending phase and the fix. No other condition SHALL block a run.

#### Scenario: Provided names an unknown phase
- **WHEN** the reference pipeline starts with `provided: ["research"]`
- **THEN** `moa_run_start` returns an error naming `research` and listing the pipeline's skippable phases; no run manifest is written

#### Scenario: Provided names a phase that is not skippable
- **WHEN** the reference pipeline starts with `provided: ["execute"]`
- **THEN** `moa_run_start` returns an error stating that `execute` is not marked `skippable`; no run manifest is written

#### Scenario: Every step skipped
- **WHEN** a pipeline's every step is `skippable` or a dependent, and `provided` names them all
- **THEN** `moa_run_start` returns an error stating that no steps remain; no run manifest is written

#### Scenario: Strict mode rejects provided
- **WHEN** the config sets `master.mode: strict` and the run starts with a non-empty `provided`
- **THEN** `moa_run_start` returns an error stating that strict mode runs the pipeline verbatim; no run manifest is written

#### Scenario: A gate with no loopBackTo and no requires survives
- **WHEN** the reference pipeline is amended so `review-plan` has neither `loopBackTo` nor `requires`, and the run starts with `provided: ["plan"]`
- **THEN** `plan` is skipped, `review-plan` runs, and a later REVISE at `review-plan` resolves its loop-back target among surviving steps exactly as it does today

### Requirement: Skips are visible in the frame
The frame returned by `moa_run_start` SHALL list every skipped phase with its reason, and the pipeline string SHALL show only surviving phases. The order of listed skips SHALL follow the pipeline's original step order.

#### Scenario: Frame reports skips
- **WHEN** `plan` and `review-plan` were skipped because `plan` was provided
- **THEN** the frame contains `skipped: plan (provided), review-plan (child of plan)` and `pipeline: frame→execute→review-work→validate→finalize`

#### Scenario: Frame omits the line when nothing was skipped
- **WHEN** a run starts without `provided`
- **THEN** the frame carries no `skipped` line

### Requirement: The effort ladder survives a skipped loop-back target
A step's effort rung SHALL be read from the loop counter of its `loopBackTo` phase only while that phase is among the run's steps; otherwise it SHALL be read from the step's own phase. A REVISE that sends work back to a step SHALL therefore raise that step's effort whether or not its `loopBackTo` target survived.

#### Scenario: Execute escalates after a REVISE when plan was skipped
- **WHEN** the reference pipeline runs with `provided: ["plan"]` and `validate` returns REVISE, sending the run back to `execute`
- **THEN** the next `execute` step is described at effort rung 1, not rung 0

#### Scenario: Escalation via a surviving target is unchanged
- **WHEN** the reference pipeline runs without `provided` and `review-plan` returns REVISE, sending the run back to `plan`
- **THEN** `execute` is subsequently described at the rung recorded for `plan`, exactly as today
