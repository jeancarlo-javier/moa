# Live Tool Model Discovery — Execution Status

**Last updated:** 2026-07-14
**Worktree:** `/Users/jeancarlojavier/pr26/moa--feat-mcp`
**Branch:** `feat/mcp`
**Baseline commit:** `cbb0e7085881e584eb00328679061bd8bf9a27be`
**Status:** Complete and verified — MOA terminal `done`; branch and worktree preserved pending the user's integration choice.

## Source of truth

- Approved design: `docs/superpowers/specs/2026-07-14-live-tool-model-discovery-design.md`
- Execution plan: `docs/superpowers/plans/2026-07-14-live-tool-model-discovery.md`
- This document records execution state only. The design and plan remain authoritative for behavior and acceptance criteria.

## User direction

- Execute the approved plan in this worktree.
- Use external OMP subagents where useful; avoid additional process layers.
- Run a final review with **`anthropic/claude-opus-4-8:xhigh`**.
- Keep this status document current so work can continue in a later session.

## Orchestration state

- MOA run: `run-20260714-194000-54df`
- Pipeline: `frame → implement → review → validate → finalize`
- MOA terminal: `done`; all five phases reported and both critical gates passed.
- Independent verifier: `anthropic/claude-opus-4-8:xhigh` (different model family from the implementation producer).

## Completed work

### Task 1 — Live discovery, resolution, and spawn cutover

Commits:

1. `5dc4404 feat(mcp): resolve live tool model inventories`
2. `469bc9f fix(mcp): enforce live model routing contract`

Implemented:

- Required strict `modelDiscovery` recipes; rejected persisted profile `models` and `listModels`.
- Canonical IDs matching `^[^\s/]+/[^\s]+$` for learned, configured, init, and host inputs.
- Required exact `{model}` selection placeholder and T1/T2/T4/model-discovery evidence.
- Shell-free JSON/line discovery with 10-second default, 30-second cap, and combined 4 MiB stdout/stderr bound.
- Async live `opTools`, `opResolve`, and `opBindingSave`.
- Exact route-first candidate construction; configured aliases stay distinct while sharing independence identity.
- Configless adaptive mode can see current learned-tool routes.
- Only `hostModels` create `host-native` routes.
- Spawn revalidates the frozen model against the current learned-tool inventory and never silently reroutes.
- Public resolve pool retains candidate `sources` and route `source` provenance.
- External JSON schema removes role binding and documents model-only binding.

Verification:

- Focused deterministic suite: **54 checks passed**, exit 0.
- `config.schema.json` parsed successfully.
- `git diff --check` passed.
- Independent native task re-review: **Spec APPROVE / Quality APPROVE** after two review fixes.

### Task 2 — Skill, init, templates, README, and version contract

Commits:

1. `3df8bdf docs(moa): publish live model discovery`
2. `2c3a1d5 docs(moa): close four documentation contract review findings`

Implemented:

- Synchronized `SKILL.md`, learn-tool/init/adaptive references, MCP README, five templates, server descriptions, package metadata, and lockfile.
- Version synchronized at **0.8.0** in skill, server, package, and both lockfile records.
- Documentation teaches live external discovery, exact canonical IDs, model-only binding, native/external separation, and spawn-time frozen-route revalidation.
- Templates retain empty `models: {}` and contain no launcher inventory dumps.
- Learn-tool guidance rejects launchers without a programmatic canonical model list.
- Fixed Markdown fence, external-only `moa_tools` wording, unsupported no-list fallback, discovery-error scope, and malformed README table row.

Verification:

- Focused deterministic suite: **54 checks passed**, exit 0.
- First task review returned REVISE with four documentation findings; all four were fixed in `2c3a1d5`.
- The superseded native re-review was cancelled when the user requested one Opus 4.8 final review instead.

## Current external Opus 4.8 review

Review artifacts:

- Model: `anthropic/claude-opus-4-8:xhigh`
- Result: `.omp-work/results/opus-4-8-final-review.md`
- Log: `.omp-work/logs/opus-4-8-final-review.log`
- Initial verdict: **REVISE**

Blocking finding:

- `independenceGroup` stripped every trailing `-<alnum>` segment, collapsing distinct sibling selectors such as `vendor/fake-9` and `vendor/fake-10`. This could incorrectly block `differentModelFrom` and downgrade valid verification.

Resolution:

- Added a failing regression proving sibling selectors remain independently verifiable.
- Removed the suffix-stripping heuristic; provider aliases and `:effort` still collapse, but distinct selectors do not.
- Updated the former cosmetic group assertion from `fake` to `fake-9`.
- Commit: `f9d98be fix(mcp): preserve sibling model independence`.
- Post-fix focused suite: **55 checks passed**, exit 0.
- Re-review result: `.omp-work/results/opus-4-8-rereview.md`.
- Final Opus verdict: **APPROVE**.
- Opus confirmed the regression fails under the removed heuristic, passes with exact selector grouping, duplicate aliases still share one group, distinct sibling selectors remain independent, and provider/effort normalization remains intact.

Opus also reported low-priority duplicate test coverage, sync `opInit` awaited by callers, and redundant `discovery.error || discovery.code` disjuncts. They are nonblocking and intentionally left unchanged to avoid unrelated cleanup.

## Final acceptance

### Opus 4.8 review — complete

1. Initial verdict: **REVISE** with one blocking correctness finding.
2. Blocking finding fixed in `f9d98be` with a red/green regression.
3. Re-review model: `anthropic/claude-opus-4-8:xhigh`.
4. Final verdict: **APPROVE** with no new blocking correctness, safety, or contract regression.

### Task 3 — Installed-CLI dogfood and final acceptance — complete

All probes used isolated temporary directories and an isolated `MOA_HOME`; the user's real `~/.moa/bindings` was never modified. Temporary state was removed after evidence capture.

- Clean deterministic suite: **54 checks passed**, exit 0.
- OMP inventory: **74/74 canonical IDs**; sample `anthropic/claude-opus-4-8`.
- OMP T2/T4: exact returned selector `minimax-code/MiniMax-M2.7-highspeed` produced the prompt-file nonce, exit 0.
- Isolated `moa_binding_save` accepted the OMP profile and persisted only its invocation/parser recipe and evidence.
- OpenCode inventory: **7/7 canonical IDs**; sample and T2-proven selector `opencode/big-pickle`.
- OpenCode T2/T4: exact returned selector produced the stdin nonce, exit 0.
- Isolated `moa_binding_save` accepted the OpenCode line-discovery profile.
- Agy returned eight display-name lines and zero canonical IDs; registration failed with `model_discovery_parse_failed`, and no profile was written.
- Codex root help exposes no `models` subcommand; no profile was written.
- A configured `anthropic/claude-opus-4-8` with `binding: omp` resolved through OMP even when the same ID was host-native.
- A missing exact ID pinned to OMP produced `blocked_no_binding`.
- `runtime.subagents: native` resolved the same live host model only through `host-native`.
- `moa_tools` did not label learned-tool inventory entries as host-native.
- `roles.<name>.binding` failed schema validation.
- Saved binding YAML contained neither a model inventory nor `listModels`.
- `effective-config.json` contained resolved roles only, not the candidate pool or discovery inventory.
- Compact machine-readable evidence: `.omp-work/results/installed-dogfood.json`.

### Final gates

- [x] Focused deterministic suite after the code fix: **55 checks passed**, exit 0.
- [x] Required static contract searches passed: obsolete runtime reads absent, version synchronized, discovery/binding documentation present, templates empty.
- [x] Worktree hygiene passed: clean status; `.omp-work` and `.omp-subagents.json` untracked/ignored; isolated dogfood state removed.
- [x] External independent review: `anthropic/claude-opus-4-8:xhigh` **APPROVE**.
- [x] MOA terminal `done`: `frame`, `implement`, `review`, `validate`, and `finalize` reported.
- [ ] Use the development-branch finishing workflow; do not merge without the user's choice.

## Current deterministic evidence

```text
node test.mjs
55 checks passed
exit 0
```

## Scratch execution records

Ignored local records:

- `.superpowers/sdd/progress.md`
- `.superpowers/sdd/task-1-report.md`
- `.superpowers/sdd/task-2-report.md`
- `.superpowers/sdd/review-*.diff`
- `.omp-work/`

These are useful during this session but are not a substitute for this tracked status document.
