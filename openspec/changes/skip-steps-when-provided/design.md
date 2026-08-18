## Context

`zStep` (`moa-core/mcp/server.mjs` l.93) is the single step shape for config pipelines, ad-hoc steps and the tool boundary. `opRunStart` (l.1624) selects `chosen` steps (ad-hoc | named | default), writes the manifest (`steps`, `current: 0`, `loops`, …) and returns `frame` + `describeStep(0)`. `opStepReport`'s REVISE branch (l.1859) resolves the loop target from `step.loopBackTo`, or the nearest previous non-gate non-master step, and errors if none. Everything downstream indexes `manifest.steps`, so filtering *before* the manifest is written leaves the rest of the state machine untouched. See proposal.md - Why.

## Goals / Non-Goals

**Goals:** one pipeline for fresh and pre-planned work; skips explicit and audited; zero behavior change when `provided` is absent; core stays source-agnostic (no tool or vendor names).

**Non-Goals:** a predicate DSL (`when: exists(path)`), auto-detecting inputs from the filesystem, skipping by task size (named pipelines already cover that), re-pointing loop targets automatically.

## Decisions

- `unless: <input>` on the step + `provided: [...]` on the run, rather than `produces`/`requires` inference: the skip reason lives on the step that is skipped, and gates that only make sense for a skipped producer are opted out explicitly (`unless: plan` on review-plan) instead of being inferred away.
- Filter in `opRunStart` right after `chosen` is selected; manifest gets `provided` and `skipped: [{phase, unless}]`. `manifest.steps` = survivors, so `current`, `loops`, `producerFor`, `describeStep` and REVISE work unchanged.
- Fail fast on gates with the same target rule the REVISE branch uses; run start errors instead of the run dying mid-flight. A non-gate `loopBackTo` only feeds the effort-rung lookup (`manifest.loops[s.loopBackTo ?? s.phase]`), harmless when the target is absent → tolerated.
- Frame gets a `skipped:` line plus an "unused provided" note; the master must state skips out loud (anti-self-certification: a skipped gate is never silent).
- Ad-hoc `steps` accept `unless` too (same `zStep`), so an adaptive master can compose once and reuse with different `provided`.
- Skill wording is source-agnostic: "if the brief already carries an input a step would produce, pass `provided`". OpenSpec briefs simply satisfy it.

## Risks / Trade-offs

- A master could over-declare `provided` to dodge a gate → mitigated by the frame listing every skip and by validate/critical gates not carrying `unless` in the shipped templates.
- Templates gain `unless: plan` on planning phases; custom pipelines opt in by adding the field — no silent behavior change for existing configs.
