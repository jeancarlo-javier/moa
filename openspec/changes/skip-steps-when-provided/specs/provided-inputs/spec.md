## Purpose

Lets a run declare inputs that already exist (a reviewed plan, prior research, a design) so the pipeline skips the steps whose only job is to produce them — one pipeline serves fresh work and pre-planned work, and every skip is visible in the frame.

## ADDED Requirements

### Requirement: Step declares the input that makes it unnecessary
A pipeline step MAY declare `unless: <input-name>` (non-empty string), in config pipelines and in ad-hoc steps alike. Steps without `unless` SHALL never be skipped.

#### Scenario: Config validation accepts unless
- **WHEN** a `.moa.yml` pipeline step has `unless: plan`
- **THEN** `moa_load` accepts the config and reports the field on the step

#### Scenario: Unknown fields still rejected
- **WHEN** a step has an unrecognized field
- **THEN** `moa_load` rejects it as before (strict step shape unchanged)

### Requirement: Run start skips steps whose input is provided
`moa_run_start` SHALL accept an optional `provided: string[]`. Every step whose `unless` value is in `provided` SHALL be removed from the run's steps before the manifest is written; the remaining steps SHALL keep their order and semantics; the manifest SHALL record `provided` and `skipped` (phase + unless).

#### Scenario: Provided plan skips planning phases
- **WHEN** pipeline steps are frame, plan (unless: plan), review-plan (unless: plan, gate: standard, loopBackTo: plan), execute, validate (gate: critical, loopBackTo: execute), finalize and the run starts with `provided: ["plan"]`
- **THEN** the run's steps are frame, execute, validate, finalize; the manifest lists skipped plan and review-plan; the first step returned is frame

#### Scenario: Nothing provided, nothing skipped
- **WHEN** the same pipeline starts without `provided`
- **THEN** all six steps run in order (behavior identical to today)

#### Scenario: Provided input no step declares
- **WHEN** the run starts with `provided: ["research"]` and no step has `unless: research`
- **THEN** no step is skipped and the frame notes that `research` was provided but unused

### Requirement: Skips are visible in the frame
The frame returned by `moa_run_start` SHALL list skipped phases with the input that caused each skip, and the pipeline string SHALL show only surviving phases.

#### Scenario: Frame reports skips
- **WHEN** plan and review-plan were skipped because `plan` was provided
- **THEN** the frame contains `skipped: plan, review-plan (provided: plan)` and `pipeline: frame→execute→validate→finalize`

### Requirement: A gate must keep a reachable loop-back target
At run start, every surviving gate step SHALL resolve a loop-back target among surviving steps — its explicit `loopBackTo`, or, when absent, the nearest previous non-gate non-master step. If it cannot, `moa_run_start` SHALL fail with an error naming the gate, the skipped target, and the fix (add `unless` to the gate too, or change `loopBackTo`), and SHALL NOT create a run. A non-gate step's `loopBackTo` to a skipped phase SHALL NOT be an error.

#### Scenario: Gate pointing at a skipped phase fails fast
- **WHEN** review-plan (gate: standard, loopBackTo: plan) has no `unless` and the run starts with `provided: ["plan"]`
- **THEN** `moa_run_start` returns an error mentioning `review-plan`, `plan` and `unless`; no run manifest is written

#### Scenario: Non-gate loop-back to a skipped phase is tolerated
- **WHEN** execute (no gate, loopBackTo: plan) survives and plan is skipped
- **THEN** the run starts normally
