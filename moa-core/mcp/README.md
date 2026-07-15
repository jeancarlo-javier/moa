# moa MCP server

Moves moa's deterministic contract from prose into code. The skill's SKILL.md used to *describe*
rules the master had to remember across a long context — config location + validation, role→model
resolution, gate sequencing, independence grading, the run store. This server *enforces* them:
the master calls tools, the server holds state and refuses illegal transitions (a gate can't be
skipped, a REVISE can't be ignored, a config can't be found-but-unread). The master keeps what
needs judgment: framing, worker prompts, result inspection, and synthesis. The MCP server executes
registered external tools; host-native phases still use the host's own subagent capability.

## Tools
| Tool | When | Enforces in code |
|---|---|---|
| `moa_load` | First call, always | `.moa.yml` cwd→root search, safe-subset YAML, schema + cross-checks, dispatch mode, `~/.moa/bindings` profiles (metadata only — no inventory subprocess) |
| `moa_tools` | On-demand external-tool discovery | runs every registered `modelDiscovery` recipe live; returns the models each learned tool currently serves plus the stable spawn call; **never persists** a stored list; reports external routes only, never host-native as external |
| `moa_resolve` | Second; pass `hostModels` | independently re-runs live discovery across every learned tool, then intersects the live external routes with `.moa.yml`'s model aliases and the `hostModels` you passed; pins every role's model/effort/binding (model-level only — `roles.<name>.binding` is rejected) with a recorded reason, writes `effective-config.json` |
| `moa_run_start` | Per task | pipeline selection, run store + manifest, the Frame assembled from real data |
| `moa_step_report` | After every phase | gate verdicts required, REVISE→loopBackTo, `maxGateLoops`, independence grade vs the *actual* producer, mutation floor (`done_unverified` label), terminal states |
| `moa_spawn` | Current registered-tool phase | re-runs `modelDiscovery` against the bound tool's current inventory; refuses to launch when the frozen model is no longer served (`model_not_served`); exact route, file or stdin prompt transport, `shell: false`, timeout, 4 MiB output bound, normalized result; never advances state |
| `moa_init` | `/moa init` | overwrite guard, comment-preserving template splice, registry = union of picks (only the aliases roles chose — never the full live inventory), validation before write |
| `moa_binding_save` | `/moa learn-tool` | refuses profiles without `modelDiscovery` + T1 + T2 + T4 = pass, `promptSafe: true` and `canSelectModel: true`; refuses any `run.argv` placeholder spawn cannot expand; runs the discovery recipe once before persistence to confirm the live model inventory |

## Native vs external

A route the server can spawn on is one of two kinds, and the terminology is strict:

- **Native (host-native)** — the model runs inside the *host agent runtime* itself (the
  conductor's own subagent capability). The MCP server never executes native phases; the
  master launches them through its own host tool. The server cannot enumerate native
  models — it has no view into the agent runtime — so the master passes its own `hostModels`
  to `moa_resolve` as input. `moa_tools` does **not** report native routes: native is
  whatever the host says it is, and the server keeps the two views separate.
- **External (learned tool)** — a CLI bound through `learn-tool` and persisted to
  `~/.moa/bindings/<tool>/profile.yml`. The server owns the spawn: it runs the
  `modelDiscovery` recipe to learn the tool's current inventory, intersects that inventory
  with the resolved model, and executes the run through `moa_spawn`. The profile stores the
  recipe, not the resolved model list — every `moa_tools` call is live.

A route is either native or external; it is never both, and the server never claims a
native route belongs to a learned tool (or vice versa).

## Model-level binding — example

`binding` is a property of a *model* the role picks through, never of a role. Roles select
aliases with `use`; only `models.<alias>.binding` exists, and the server schema rejects
`roles.<name>.binding` for any role:

```yaml
models:
  opus-via-omp:
    id: anthropic/claude-opus-4-8
    family: claude
    tags: [strong, vision]
    effort: [high]
    binding: omp                    # optional exact route pin: host-native or one learned tool name
roles:
  planner:
    use: [opus-via-omp]             # role picks an alias; binding lives on the model entry
```

## Discovery errors (the seven)

`moa_tools`, `moa_resolve`, `moa_spawn`, and `moa_binding_save` share the same
`modelDiscovery` machinery. **Every `modelDiscovery` failure** — and only those failures —
surfaces as one of these seven codes; treat the code, not the prose, as the contract:

| Code | Meaning |
|---|---|
| `model_discovery_unavailable` | the profile has no `modelDiscovery` block, the argv expanded a non-`{bin}` placeholder, or the resolved binary does not match `profile.bin` |
| `model_discovery_failed` | the tool exited non-zero, the spawn itself failed, or the binary could not be resolved on `PATH` |
| `model_discovery_timeout` | the recipe ran longer than `modelDiscovery.timeoutSeconds` |
| `model_discovery_overflow` | the recipe's stdout exceeded the 4 MiB output bound |
| `model_discovery_parse_failed` | the output shape did not match `modelDiscovery.output` (missing list path, wrong id path, non-array, or any id that fails `^[^\s/]+/[^\s]+$`) |
| `model_inventory_empty` | the recipe parsed cleanly but the resulting list was empty |
| `model_not_served` | a frozen model on `moa_spawn` is no longer in the tool's current live inventory (drift between resolve-time and spawn-time) |

## Execution flow

The conductor calls `moa_load`, optionally inspects `moa_tools`, then calls `moa_resolve` and
`moa_run_start`. For each returned step:

- Host-native routes are spawned through the host capability.
- Registered external routes are executed with `moa_spawn(runId, phase, prompt)`.
- The conductor inspects the normalized result and actual workspace effects, then calls
  `moa_step_report`.

`moa_spawn` executes only the current external non-master phase. It never records changed files,
reports a verdict, or advances the manifest; `moa_step_report` remains the only transition
operation.

## Register

```sh
cd moa-core/mcp && npm install
claude mcp add moa -- node /absolute/path/to/moa-core/mcp/server.mjs
```

Or in a project's `.mcp.json`:

```json
{ "mcpServers": { "moa": { "command": "node", "args": ["/absolute/path/to/moa-core/mcp/server.mjs"] } } }
```

## Test

```sh
node test.mjs
```

## Notes

- The server cannot enumerate the host's own models (a stdio server has no view into the agent
  runtime) — that's why `moa_resolve` takes `hostModels` as input.
- Deliberately out: budget *enforcement* (only what `moa_step_report` is given as `usage` is
  recorded; no ceiling halts a run), patches-first merge machinery, and any attempt to restrict
  a spawned tool's own tools/network/filesystem. `DESIGN.md` is the **historical** design pass
  and still specifies several of these — the code wins. `bindings/` documents a separate,
  still-archived adapter-process design (`bindings/README.md`).
- `MOA_HOME` env var overrides `~` for bindings storage (used by tests).
