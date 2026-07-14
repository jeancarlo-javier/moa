# Live Tool Model Discovery — Execution Status

**Last updated:** 2026-07-14
**Worktree:** `/Users/jeancarlojavier/pr26/moa--feat-mcp`
**Branch:** `feat/mcp`
**Baseline commit:** `cbb0e7085881e584eb00328679061bd8bf9a27be`
**Status:** In progress — Tasks 1–3 implemented and accepted; external Opus 4.8 whole-branch review remains.

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
- Current MOA phase: `implement` has not yet been reported because the complete plan is not finished.
- The host exposed only one native model identity, so native critical-gate independence was unavailable. The final external Opus 4.8 review is intended to provide independent cross-model review.

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

Prepared artifacts:

- Branch patch: `.omp-work/review/live-discovery.patch`
- Patch size: 122,450 bytes
- Requested model: `anthropic/claude-opus-4-8:xhigh`
- OMP live inventory confirmed the exact selector and support for `xhigh` reasoning.
- Intended result: `.omp-work/results/opus-4-8-final-review.md`
- Intended log: `.omp-work/logs/opus-4-8-final-review.log`

The first helper invocation exceeded the context-mode MCP transport's 30-second request timeout and produced no result. The same review was relaunched as long-lived background job `bg_1`; check the result path before taking further action.

Required review output:

1. First line exactly `APPROVE` or `REVISE`.
2. Numbered findings with severity and `file:line`.
3. Coverage of every plan/design acceptance criterion, process safety, exact routing, persistence, docs/templates/version, debug artifacts, and overengineering.
4. On APPROVE, residual risks and verification gaps.

## Current review and remaining work

### Finish Opus 4.8 review

1. Check `.omp-work/results/opus-4-8-final-review.md`.
2. If missing/invalid, inspect only the tail of `.omp-work/logs/opus-4-8-final-review.log` and rerun with `anthropic/claude-opus-4-8:xhigh`.
3. If verdict is REVISE, fix only concrete findings, rerun `cd moa-core/mcp && npm test`, commit, and request one Opus re-review.
4. Record verdict and evidence here.

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

1. Run the focused deterministic suite after all changes.
2. Run required static contract searches.
3. Confirm worktree contains no accidental `.omp-subagents.json`, `.omp-work`, debug logs, inventory files, temporary MOA homes, or scratch projects in tracked output.
4. Report the MOA `implement`, `review`, `validate`, and `finalize` phases honestly; identify the actual external review model.
5. Update this document with final commits, Opus verdict, Task 3 evidence, and terminal state.
6. Use the development-branch finishing workflow; do not merge without the user's choice.

## Current deterministic evidence

```text
node test.mjs
54 checks passed
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
