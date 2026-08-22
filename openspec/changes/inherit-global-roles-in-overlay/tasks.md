## 1. Lock the current behavior in a failing test

- [x] 1.1 Add `load: overlay without roles inherits the global palette` to `moa-core/mcp/test.mjs` — global declares 3 roles, overlay declares only `runtime`/`template`; assert `opLoad` returns all 3 and no errors. Confirm it fails on current `main`.
- [x] 1.2 Add `load: overlay subset keeps its inherited differentModelFrom target` — global declares `coder` and `verifier: { differentModelFrom: coder }`, overlay declares `verifier: {}`; assert no `errors` and both roles present. Confirm it fails on current `main` with `differentModelFrom names unknown role 'coder'`.
- [x] 1.3 Add `load: overlay pipeline may name a global-only role` — overlay declares a pipeline step whose role exists only globally; assert the config loads. Confirm it fails on current `main` with `names unknown role`.

## 2. Change the merge rule

- [x] 2.1 Rewrite the `roles` branch of `mergeConfigLayers` (`moa-core/mcp/server.mjs:325-330`) to union global keys with a per-key merge of the overlay's roles; delete the `else { delete merged.roles }` branch. Guard the assignment the same way the `models` branch does, so neither layer having roles leaves the key absent.
- [x] 2.2 Verify tasks 1.1–1.3 now pass and no other test regressed (`node --test` in `moa-core/mcp`).

## 3. Reconcile the tests that encoded the old rule

- [x] 3.1 Rewrite `load: project roles inherit global staffing without role union` (`moa-core/mcp/test.mjs:295`) for the union rule: rename it, and invert the `assert.equal(loaded.roles.globalOnly, undefined)` assertion at `:327` to assert the global-only role is present with its global `use`.
- [x] 3.2 Keep and re-verify the per-key merge assertions in that same test (`:332` project effort overrides global, `:333` global effort survives) — union must not change per-key precedence.
- [x] 3.3 Grep the suite for any other assertion that a global role is absent after merge; reconcile or remove.
- [x] 3.4 Add `resolve: an inherited differentModelFrom constraint is still enforced` — drive `opResolve` with the 1.2 fixture and assert `verifier` picks a model from a different group than `coder`, and reports `blocked_dependency` when no such model exists.

## 4. Cover the second call site

- [x] 4.1 Confirm `opInit` scope=project (`moa-core/mcp/server.mjs:2321`) still validates and writes correctly under the union rule — its `minimalRegistry` filter (`:2305`) narrows models to those referenced by *overlay* roles, so check that inherited global roles' `use` aliases still resolve against the merged registry.
- [x] 4.2 Add or extend a test asserting `/moa project` output loads cleanly when the global layer declares roles the template does not.

## 5. Document the rule where authors read it

- [x] 5.1 Update the `roles` description in `moa-core/schema/config.schema.json` (`:95`) to state: project keys merge over global keys, global-only keys are retained, omitting the section inherits the global layer.
- [x] 5.2 Add the equivalent sentence to the `models` description (`:42`) so both named collections document the same rule.
- [x] 5.3 Add a short "how the two layers combine" note to `moa-core/references/init.md`, using its existing plain-language vocabulary rather than "layer / overlay / merge" (see its glossary at `:26`).

## 6. Verify

- [x] 6.1 Run the full suite in `moa-core/mcp` and report the pass count.
- [x] 6.2 Re-run the proposal's repro fixture by hand and confirm it now loads with both roles present.
- [x] 6.3 `openspec validate --strict` on this change.
