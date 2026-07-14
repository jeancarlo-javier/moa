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
| `moa_load` | First call, always | `.moa.yml` cwd→root search, safe-subset YAML, schema + cross-checks, dispatch mode, `~/.moa/bindings` profiles |
| `moa_tools` | On-demand external-tool discovery | reloads registered profiles; reports executable tools, models, capabilities, and the stable spawn call |
| `moa_resolve` | Second; pass host-native models | role `use` resolution (pins, `auto`, effort ladders), `differentModelFrom`, `effective-config.json` |
| `moa_run_start` | Per task | pipeline selection, run store + manifest, the Frame assembled from real data |
| `moa_step_report` | After every phase | gate verdicts required, REVISE→loopBackTo, `maxGateLoops`, independence grade vs the *actual* producer, mutation floor (`done_unverified` label), terminal states |
| `moa_spawn` | Current registered-tool phase | exact run/phase/model route, file or stdin prompt transport, `shell: false`, timeout, 4 MiB output bound, normalized result; never advances state |
| `moa_init` | `/moa init` | overwrite guard, comment-preserving template splice, registry = union of picks, validation before write |
| `moa_binding_save` | `/moa learn-tool` | refuses profiles without proven T1+T4 evidence and `promptSafe: true` |

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
- Deliberately out (see `temp-docs` design note / DESIGN.md): budget *enforcement* (usage is
  recorded per phase), patches-first merge machinery, tool-policy enforcement (parked in
  `bindings/`).
- `MOA_HOME` env var overrides `~` for bindings storage (used by tests).
