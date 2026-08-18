## 1. Core (`moa-core/mcp/server.mjs`)

- [ ] 1.1 `zStep`: add `unless: z.string().min(1).optional()`; `moa_run_start` registration (l.2466): add `provided: z.array(z.string().min(1)).optional()` and pass it through (nodes `zStep`, `moa_run_start`)
- [ ] 1.2 `opRunStart`: filter `chosen` by `provided`; record `provided` + `skipped` in the manifest; gate loop-target validation with an error naming gate, skipped target and fix; frame `skipped:` line + unused-provided note; pipeline string shows survivors (node `opRunStart`)
- [ ] 1.3 Tests in `moa-core/mcp/test.mjs` (`node test.mjs`): the six scenarios of `specs/provided-inputs/spec.md` (skip, none, unused, frame, gate fails fast, non-gate tolerated); existing helpers `freshRun`/`startExternalRun` untouched

## 2. Schema, templates, docs

- [ ] 2.1 `moa-core/schema/config.schema.json`: `unless` on step items (description mirrors `zStep`)
- [ ] 2.2 `moa-core/templates/full-engineering.yml` + `lite-build.yml`: `unless: plan` on plan / review-plan steps
- [ ] 2.3 `moa-core/SKILL.md` step 3 (`moa_run_start`): one source-agnostic line on `provided`; `DESIGN.md` §4: document `unless`
