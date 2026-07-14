# Live Tool Model Discovery Design

**Date:** 2026-07-14  
**Status:** Approved design

## Summary

MOA must not persist a learned tool's model inventory. Model inventories change independently of MOA and inevitably make a stored `models` list stale.

A learned profile will instead persist only a validated, declarative recipe for listing the models the tool currently serves. The MCP server executes that recipe whenever it needs an external inventory. Project `.moa.yml` files remain the source of user preferences and model metadata. Host-native availability continues to come exclusively from `hostModels` supplied by the host.

The resulting relationship is:

```text
role -> configured model alias -> optional binding -> current live route
```

A role does not select a tool directly.

## Problem

The current learned profile stores both:

- a `models` snapshot captured during `/moa learn-tool`;
- an optional `listModels` command.

At runtime, `moa_tools` and `moa_resolve` consume only the stored snapshot. They never execute `listModels`. New models therefore remain invisible until the user relearns the tool, while removed models continue to look available.

The current public behavior can also blur route terminology. Models listed by OMP, Agy, or OpenCode are external models served through learned bindings. They are not host-native models. Only models supplied through `hostModels` may receive the `host-native` route.

## Goals

1. Never persist a learned tool's model inventory.
2. Obtain external model availability from the tool at the time it is needed.
3. Preserve `.moa.yml` as the source of user model preferences and metadata.
4. Preserve configless adaptive orchestration using current live inventories.
5. Represent native and external routes accurately.
6. Pin a tool only on a configured model entry, never on a role.
7. Reject tools that cannot prove a usable model-discovery operation.
8. Keep command execution inside the MCP server with no shell handoff.
9. Freeze each selected route in the run manifest and detect later capability drift without silently rerouting.

## Non-goals

- MOA will not call provider APIs directly.
- MOA will not maintain its own provider model catalog.
- MOA will not infer that a model is available merely because it appears in `.moa.yml`.
- MOA will not cache live model inventories in this increment.
- MOA will not update a launcher's remote catalog. It queries the inventory returned by the registered list command. If a launcher maintains its own catalog cache, refreshing that cache remains the launcher's responsibility.
- MOA will not support a learned launcher without a programmatic model-list operation in this increment.
- MOA will not support a learned launcher that cannot select and prove an exact discovered model ID.
- MOA will not add compatibility aliases for obsolete learned profiles or role-level binding pins.

## Sources of model data

MOA uses three sources with different authority:

| Source | Authority | Creates a route |
|---|---|---:|
| `.moa.yml` `models` | User preference and metadata | No |
| Live learned-tool inventory | Current external availability | Yes, external |
| `hostModels` | Current host-native availability | Yes, `host-native` |

A configured model becomes runnable only when its exact ID has an allowed current route.

## Learned profile contract

Version `0.8.0` replaces the persisted `models` array and `listModels` argv shorthand with a required `modelDiscovery` object.

### JSON discovery

```yaml
tool: omp
bin: /absolute/path/to/omp
version: 16.4.2

run:
  argv: ["{bin}", "-p", "@{promptFile}", "--model", "{model}", "--cwd", "{cwd}"]
  promptVia: file
  modelPlaceholder: "{model}"
  timeoutSeconds: 1800

output:
  format: text
  resultPath: stdout

modelDiscovery:
  argv: ["{bin}", "models", "--json"]
  output:
    format: json
    listPath: models
    idPath: selector
  timeoutSeconds: 10

capabilities:
  canProduce: true
  canSelectModel: true
  promptSafe: true

evidence:
  probedOn: 2026-07-14
  tests:
    modelDiscovery: pass
    T1: pass
    T2: pass
    T3: pass
    T4: pass
```

`listPath` and `idPath` are dot-separated property paths. The value at `listPath` must be an array. The value at `idPath` within every retained item must be a canonical model ID matching `^[^\s/]+/[^\s]+$`: a non-empty provider/tool namespace, `/`, and a non-empty whitespace-free model selector.

### Line discovery

A launcher whose model-list operation emits exactly one canonical model ID per line may use:

```yaml
modelDiscovery:
  argv: ["{bin}", "models"]
  output:
    format: lines
  timeoutSeconds: 10
```

The server trims each line, removes blank lines, validates every line against `^[^\s/]+/[^\s]+$`, deduplicates exact strings while preserving order, and passes the exact string to `{model}`. A launcher whose output uses display names, headings, warnings, or other prose is not compatible with the `lines` format.

### Schema invariants

- `modelDiscovery` is required.
- `modelDiscovery.argv` contains at least one element.
- Its first argument must resolve to the profile's validated executable through `{bin}`.
- Only `{bin}` is a valid discovery placeholder.
- `modelDiscovery.output.format` is initially `json` or `lines`.
- JSON discovery requires `listPath` and `idPath`.
- Line discovery rejects JSON-only path properties.
- Every normalized ID must match `^[^\s/]+/[^\s]+$`.
- `timeoutSeconds` defaults to 10 seconds and cannot exceed 30 seconds.
- A top-level learned-profile `models` property is invalid.
- The old `listModels` property is invalid.
- `run.modelPlaceholder` and `capabilities.canSelectModel: true` are required.
- `run.argv` must contain the declared model placeholder.
- The profile remains strict: unknown properties fail validation.

## Learning protocol changes

`/moa learn-tool` continues to begin with the tool's root `--help`, followed by help for relevant subcommands. It must discover rather than assume:

- the non-interactive run command;
- the model-selection argument;
- the model-list command;
- the model-list output shape;
- prompt transport;
- result extraction;
- isolation flags.

The model-list command is mandatory. Learning rejects a tool when the command is missing, exits unsuccessfully, times out, overflows the output bound, produces malformed output, returns a noncanonical ID, or returns an empty inventory.

The learning flow performs these model checks:

1. Execute the draft `modelDiscovery` recipe through the same server-owned runner used after registration.
2. Normalize its current exact IDs.
3. Select one returned canonical ID deterministically.
4. Run T2 with that exact ID.
5. Require T2 to prove that the tool accepts an ID emitted by its own discovery command; T2 is mandatory.
6. Save only the discovery recipe and evidence, never the returned inventory.

`moa_binding_save` independently executes and validates the submitted discovery recipe before writing the profile. A reasoning agent's claim that discovery worked is insufficient.

## Safe discovery execution

A single internal `discoverToolModels(profile)` helper owns all model-list execution.

It must:

1. revalidate the executable and authoritative real path;
2. expand the registered argv array one element at a time;
3. reject unknown placeholders;
4. require `argv[0]` to resolve to the profile executable;
5. invoke `spawn` with an argv array and `shell: false`;
6. send no prompt and no workspace content;
7. enforce a short timeout;
8. enforce a combined stdout/stderr limit of 4 MiB;
9. accept stdout only as inventory data;
10. validate canonical IDs, then deduplicate exact IDs while preserving order;
11. return structured success or failure;
12. write no inventory to disk or process-global state.

The helper returns conceptually:

```json
{
  "tool": "omp",
  "checkedAt": "2026-07-14T12:00:00.000Z",
  "models": [
    { "id": "anthropic/claude-opus-4-8" }
  ]
}
```

Discovery exposes canonical IDs only. Additional launcher fields are ignored. `.moa.yml` remains authoritative for configured family, tags, cost, priority, context, and effort.

## `.moa.yml` model and binding contract

The `binding` field remains on model entries:

```yaml
models:
  opus-omp:
    id: anthropic/claude-opus-4-8
    family: claude
    tags: [strong, vision]
    effort: [high]
    binding: omp

roles:
  planner:
    use: [opus-omp]
```

`roles.<name>.binding` is removed from the schema. A role chooses a configured model alias; the alias may choose a binding.

If different roles must use the same logical model through different tools, the project declares distinct aliases:

```yaml
models:
  opus-omp:
    id: anthropic/claude-opus-4-8
    family: claude
    binding: omp

  opus-opencode:
    id: anthropic/claude-opus-4-8
    family: claude
    binding: opencode

roles:
  planner:
    use: [opus-omp]

  reviewer:
    use: [opus-opencode]
```

These aliases remain distinct routing candidates. They share the same independence group because they identify the same underlying model. Running one through OMP and the other through OpenCode does not create independent verification.

For a model without a binding pin:

```yaml
models:
  opus:
    id: anthropic/claude-opus-4-8
```

route selection applies `runtime.subagents` first, then prefers `host-native` in `auto` mode, then the first eligible external route in deterministic tool order.

Binding and route invariants:

- `model.binding` is the only configuration pin.
- Every resolved configured ID (`models.<alias>.id`, or the alias when `id` is omitted) and every `hostModels[].id` must match `^[^\s/]+/[^\s]+$`.
- A pin is satisfied only by a current route from that exact binding for the configured exact model ID.
- A missing pinned route yields `blocked_no_binding`.
- MOA never silently removes a pin or substitutes another binding.
- Model matching uses exact canonical IDs; fuzzy CLI matching is not used for resolution.

## Candidate construction

The resolver must stop collapsing configured aliases before route selection.

It builds two structures:

1. **Live route inventory:** exact model ID to one or more `{ binding, modelId, source }` routes.
2. **Selection candidates:** one entry per configured alias plus adaptive entries for current unconfigured models.

A configured candidate contains its alias, exact ID, metadata, optional binding pin, and the current routes for that ID. Two aliases with the same ID remain separate candidates but carry the same independence group.

A live model not present in `.moa.yml`:

- is visible through `moa_tools`;
- may participate in `use: [auto]` selection;
- may participate in configless adaptive orchestration;
- has no configured binding pin;
- receives its canonical ID from discovery;
- receives no invented family or strength tags.

Distinct canonical IDs with unknown family metadata may support model-distinct verification but must never be reported as cross-family verification.

## MCP operation behavior

### `moa_load`

- Loads and validates `.moa.yml` and learned profiles.
- Confirms that registered executables are present.
- Does not execute model discovery.
- Returns tool metadata and whether a discovery recipe is registered, but no saved model inventory.

### `moa_tools`

- Reloads learned profiles on every call.
- Executes each usable profile's discovery recipe.
- Returns current external inventories, check timestamps, and per-tool structured diagnostics.
- Never labels learned-tool models as native.
- Never writes inventory data.

No new MCP operation is required; `moa_tools` remains the public discovery operation.

### `moa_resolve`

- Executes live discovery itself for every usable learned tool.
- Does not require a preceding `moa_tools` call.
- Combines live external routes with the current `hostModels` argument.
- Intersects configured exact IDs and model binding pins with current routes.
- Supports current live models in adaptive-bare mode.
- Writes only resolved role assignments to `effective-config.json`, not complete tool inventories.

### `moa_run_start`

- Freezes the selected model ID, binding, executable route, and phase assignments in the run manifest.
- Does not retain unrelated discovery results.

### `moa_spawn`

- Reloads the frozen binding profile.
- Reruns that binding's discovery recipe.
- Confirms that the frozen exact model ID is still served.
- Executes the frozen route if valid.
- Returns a structured failure without advancing the run when the route drifted.
- Never silently resolves or selects a replacement model.

### `moa_binding_save`

- Rejects obsolete profile shapes.
- Executes discovery and validates its output before persistence.
- Confirms that the evidence includes passing model-discovery, T1, T2, and T4 checks.
- Confirms `canSelectModel: true` and a registered model placeholder.
- Persists the validated recipe and evidence only.

### `/moa init`

- Calls live `moa_tools` when offering external model choices.
- Shows model ID and route source separately.
- Writes selected preferences and optional `binding` pins into `.moa.yml`.
- Does not copy the complete live inventory into project configuration.

## Native terminology

The following terms are strict:

- **Native model:** supplied by the current host through `hostModels`; route binding is `host-native`.
- **External model:** returned by a learned tool's live discovery; route binding is the learned tool name.
- **Configured model:** declared in `.moa.yml`; it may currently have zero, one, or multiple routes.

A request such as “Which models are available natively?” must filter to `binding === "host-native"`. It must not include OMP, Agy, or OpenCode inventories.

## Failure semantics

All known discovery failures are structured and non-throwing:

| Code | Meaning |
|---|---|
| `model_discovery_unavailable` | Profile has no valid discovery recipe |
| `model_discovery_failed` | Discovery process could not start or exited nonzero |
| `model_discovery_timeout` | Discovery exceeded its timeout |
| `model_discovery_overflow` | Combined output exceeded 4 MiB |
| `model_discovery_parse_failed` | Declared JSON/path/line output could not be normalized |
| `model_inventory_empty` | No usable model IDs were returned |
| `model_not_served` | A frozen model disappeared before spawn |

Failure policy:

- A profile that cannot discover models is rejected during learning or registration.
- A previously registered tool whose discovery currently fails is excluded from that resolution.
- Other learned tools and host-native routes remain usable.
- No stale inventory exists to fall back to.
- Resolution reports the excluded tool and exact diagnostic.
- Spawn failure preserves the current run phase.

## Installed-CLI observations

Read-only probes on the development machine established:

| CLI | Observed model discovery | Design result |
|---|---|---|
| OMP | `omp models --json`; JSON array at `models`, selector at `selector` | Compatible |
| OpenCode | `opencode models`; one exact ID per line | Compatible |
| Agy | `agy models`; display names rather than canonical IDs | Rejected for now |
| Codex | No actual `models` subcommand in the current CLI | Rejected for now |

These observations are test inputs and dogfood targets, not hardcoded product adapters. `/moa learn-tool` must discover the commands from help output for every tool.

## Verification strategy

### Deterministic fake-launcher tests

1. Profile schema accepts JSON discovery.
2. Profile schema accepts line discovery.
3. Profile schema rejects persisted `models`.
4. Profile schema rejects old `listModels`.
5. Profile schema rejects missing discovery.
6. Profile schema rejects role-level `binding`.
7. Profile schema requires model selection and a model placeholder.
8. Discovery parses JSON paths and exact canonical IDs.
9. Discovery parses one-canonical-ID-per-line output.
10. Discovery rejects display names, whitespace, malformed JSON, missing paths, non-string IDs, and empty inventories.
11. Discovery preserves valid shell metacharacters as literal model-selector data.
12. Discovery deduplicates exact IDs while preserving order.
13. Discovery reports executable failure, nonzero exit, timeout, and output overflow.
14. Two consecutive calls observe model additions and removals without restarting the server.
15. No model inventory is written under `~/.moa/bindings`, project `.moa`, or run directories.
16. `moa_resolve` works correctly without a preceding `moa_tools` call.
17. Exact configured IDs intersect current external and native routes.
18. A model-level binding pin chooses the requested live tool.
19. An unavailable model-level binding pin yields `blocked_no_binding`.
20. Duplicate aliases with one model ID remain distinct routing candidates.
21. Duplicate aliases with one model ID share one independence group.
22. `use: [auto]` can select current unconfigured models.
23. Adaptive-bare mode can select current external models.
24. Unknown family metadata never produces a cross-family grade.
25. Native-only reporting excludes all learned-tool routes.
26. One failed learned tool does not remove healthy external or native routes.
27. `moa_binding_save` executes discovery and refuses an unproven profile.
28. `moa_spawn` detects model removal after run start.
29. `moa_spawn` does not reroute after discovery drift.
30. Discovery execution uses `shell: false`, literal argv elements, timeout, and the combined output limit.
31. Existing run-state invariants remain intact: discovery and spawn never advance the workflow.

### Manual dogfood

1. Learn OMP from a clean bindings directory.
2. Confirm its profile contains `modelDiscovery` and no model inventory.
3. Call `moa_tools`; compare returned exact IDs with `omp models --json`.
4. Resolve a configured OMP-bound model.
5. Confirm a host-native query excludes OMP models.
6. Learn OpenCode through line discovery and resolve one exact returned ID.
7. Attempt to learn Agy and confirm rejection because its current output contains display names rather than canonical IDs.
8. Attempt to learn Codex and confirm a clear incompatibility result.
9. Change a fake launcher's live inventory after registration and confirm the next resolve observes the change immediately.

## Documentation changes

Update together:

- `moa-core/SKILL.md`;
- `moa-core/references/learn-tool.md`;
- `moa-core/references/init.md`;
- `moa-core/mcp/README.md`;
- `.moa.yml` templates and examples;
- `moa-core/schema/config.schema.json`;
- MCP package and lockfile versions.

The documentation must teach:

```text
learn invocation + live-discovery recipes
-> query current models
-> configure aliases and optional model-level bindings
-> resolve current routes
-> freeze a route
-> revalidate before spawn
```

It must no longer teach stored tool model catalogs or role-level binding pins.

## Migration and versioning

This is a clean `0.8.0` cutover:

- Existing learned profiles containing `models` or `listModels` are invalid and must be relearned.
- Existing `.moa.yml` files with `roles.<name>.binding` are invalid; move the pin to a selected model alias.
- No compatibility parser, alias, automatic profile migration, or stale fallback is added.
- `SKILL.md`, MCP server version, `package.json`, root lockfile package version, and package entry version must remain synchronized at `0.8.0`.

## Acceptance criteria

1. No learned profile or runtime path persists an external model inventory.
2. Every accepted learned tool has a server-validated live model-discovery recipe.
3. `moa_tools` and `moa_resolve` observe current tool inventories without a server restart.
4. `moa_resolve` does not depend on an earlier `moa_tools` call.
5. `.moa.yml` model metadata never creates availability without a current route.
6. Model-level `binding` pins work; role-level binding is removed.
7. Duplicate model aliases can pin different tools without creating false independence.
8. Configless adaptive mode can use live learned-tool models.
9. Native reporting includes only `host-native` routes.
10. Spawn-time inventory drift produces a structured failure and no silent reroute.
11. Missing model discovery, model selection, or canonical IDs makes a tool unlearnable in this increment.
12. The deterministic suite and OMP/OpenCode acceptance plus Agy/Codex rejection dogfood scenarios pass as specified.
