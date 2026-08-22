## 1. Step shape and load-time validation (`moa-core/mcp/server.mjs`)

- [ ] 1.1 `zStep` (`:93`): add `skippable: z.literal(true).optional()` and `requires: z.string().min(1).optional()`, each with a description mirroring the schema (node `zStep`)
- [ ] 1.2 Config validation (alongside the existing `loopBackTo` check at `:301`): reject `skippable` on any step whose `gate` is not `none`, and reject `requires` naming a phase absent from the same pipeline — both with the phase named in the message
- [ ] 1.3 `opLoad`'s pipeline formatter (`:1091`) currently emits only `phase(role,gate:…)`; extend it to report `skippable` and `requires` so the spec's "reports the field on that step" scenario is satisfiable

## 2. Run start (`moa-core/mcp/server.mjs`)

- [ ] 2.1 `moa_run_start` registration (`:2466`): add `provided: z.array(z.string().min(1)).optional()` and pass it through (node `moa_run_start`)
- [ ] 2.2 `opRunStart` (`:1624`): after `chosen` is selected and the existing ad-hoc checks pass, reject `skippable` on an ad-hoc gate; then resolve the skip set — seed with `skippable` steps named in `provided`, then iterate to a fixed point adding any step whose parent is skipped, where `parentOf(s) = s.requires ?? (isGate(s) ? s.loopBackTo : null)` (node `opRunStart`)
- [ ] 2.3 `opRunStart`: the four run-start errors, each naming the phase and the fix — `provided` entry unknown to the pipeline (list the skippable phases), `provided` entry not `skippable`, zero survivors, non-empty `provided` under `master.mode: strict`. All must return before `saveRun`
- [ ] 2.4 `opRunStart`: manifest records `provided` and `skipped: [{phase, reason}]` in original step order (`reason`: `provided` | `child of <parent>`); frame gains the `skipped:` line and its `pipeline` string shows survivors only

## 3. Effort-ladder fix (`moa-core/mcp/server.mjs`)

- [ ] 3.1 `describeStep` (`:1587`): read the rung from `loops[s.loopBackTo]` only when that phase is present in `manifest.steps`, else from `loops[s.phase]`. Pre-existing defect that skipping makes permanent — see design.md (node `describeStep`)

## 4. Tests (`moa-core/mcp/test.mjs`, `node test.mjs`)

- [ ] 4.1 Load-time: `skippable` accepted and reported; `skippable` on a gate rejected; `requires` naming an unknown phase rejected; unknown field still rejected
- [ ] 4.2 Skip resolution: provided plan skips `plan` + `review-plan`; nothing provided changes nothing; non-gate `loopBackTo` does not cascade (`execute` survives); `requires` without `loopBackTo` cascades; `requires` overriding a gate's `loopBackTo`; transitive cascade; duplicate `provided` entries idempotent
- [ ] 4.3 Run-start errors: unknown phase, non-skippable phase, zero survivors, strict mode, ad-hoc gate marked skippable — each writes no manifest
- [ ] 4.4 Frame: exact `skipped:` line and survivor-only pipeline string; no `skipped` line when nothing was skipped
- [ ] 4.5 Effort ladder: with `plan` skipped, a REVISE at `validate` describes `execute` at rung 1; without `provided`, escalation through a surviving target is unchanged
- [ ] 4.6 Existing helpers `freshRun` / `deltaRun` / `startExternalRun` / `twoStepExternalRun` stay untouched (param optional) — confirm the suite passes unmodified

## 5. Schema, templates, docs

- [ ] 5.1 `moa-core/schema/config.schema.json`: `skippable` + `requires` on step items (descriptions mirror `zStep`); amend the `master.mode` strict description (`:77`) to state that `provided` is rejected
- [ ] 5.2 `moa-core/templates/full-engineering.yml` + `lite-build.yml`: `skippable: true` on the `plan` step only — `review-plan` follows by cascade
- [ ] 5.3 `moa-core/SKILL.md` step 3 (`:51`): one source-agnostic line on `provided` — name the phases whose output the brief already carries
- [ ] 5.4 `DESIGN.md` §4 (`:46`): narrow "gates … can never be skipped" to master discretion, and document `skippable` / `requires` / `provided` with the parent rule
- [ ] 5.5 `moa-core/references/run-store.md` (`:18`–`:27`): add `provided` and `skipped` to the documented manifest fields

## 6. Verify

- [ ] 6.1 Run the full suite in `moa-core/mcp` and report the pass count
- [ ] 6.2 Start a real run against `full-engineering.yml` with `provided: ["plan"]` and confirm the frame's `skipped:` line and survivor pipeline match the spec verbatim
- [ ] 6.3 `openspec validate --strict` on this change
