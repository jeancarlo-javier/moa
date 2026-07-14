# Registered Tool Discovery and MCP Execution

**Date:** 2026-07-14  
**Status:** Approved for implementation  
**Target:** `feat/mcp`

## Problem

MOA can learn an external agent launcher and persist its proven invocation profile, but the current MCP path cannot reliably use it.

The dogfood configuration demonstrates three concrete failures:

1. A project registry model such as `claude-opus-4-8` is merged with the matching registered-tool model `anthropic/claude-opus-4-8`. The registry row wins and carries no route, after which resolution defaults it to `host-native`. MOA therefore asks Claude Code for a native Opus subagent even though the host reported only `openai-codex/gpt-5.6-sol` as natively spawnable.
2. `moa_spawn_prep` returns argv and asks the master to execute it with a shell. This leaves external execution outside the MCP contract and fails in hosts where the MOA skill can call only `mcp__moa__*` tools.
3. The registered OMP profile uses `{bin}` and `{maxTime}`, while `moa_spawn_prep` expands only `{model}`, `{promptFile}`, and `{cwd}`.

A saved profile must become an immediately discoverable, routable, and executable MCP capability.

## Goals

- Expose registered external launchers and their models through a compact `moa_tools` MCP call.
- Replace shell handoff with a run-bound `moa_spawn` MCP call that executes the selected registered launcher.
- Treat project model entries as requested model metadata, not proof that the host can launch those models natively.
- Preserve the actual invocation model ID required by each route, including provider-qualified aliases.
- Honor `runtime.subagents: auto | native | external | blocked` during route selection.
- Keep prompt transport safe by construction: temp file, argv array, and `shell: false`.
- Preserve the run state machine: spawning executes work, while `moa_step_report` alone advances phases.
- Prove the behavior with deterministic fake-launcher tests and one real, cheap OMP dogfood launch.

## Non-goals

- Moving the complete unregistered-tool discovery and T1–T4 probe protocol into the MCP server.
- Dynamically adding one MCP tool per registered launcher.
- Reintroducing the parked graded tool-policy enforcement system.
- Automatically trusting a worker's changed-files or verification claims.
- Automatically calling `moa_step_report` after a spawn.
- Supporting arbitrary direct execution by binary, tool name, or model outside an active run.

## Public MCP Surface

### `moa_tools`

`moa_tools` reloads registered profiles on every call, so a successful `moa_binding_save` is visible without restarting the MCP server.

It returns only usable MCP-facing information, not raw argv instructions:

```json
{
  "tools": [
    {
      "tool": "omp",
      "version": "16.1.7",
      "available": true,
      "capabilities": {
        "canProduce": true,
        "canSelectModel": true,
        "promptSafe": true,
        "toolRestriction": "observed-honors-no-tools"
      },
      "models": [
        {
          "id": "anthropic/claude-opus-4-8",
          "family": "claude",
          "tags": ["strong", "vision"]
        }
      ],
      "usage": {
        "tool": "moa_spawn",
        "arguments": ["runId", "phase", "prompt"]
      }
    }
  ],
  "skipped": []
}
```

A profile whose executable cannot be resolved and executed is returned as unavailable or skipped with a machine-readable reason and is excluded from routing. Resolution never treats an unreachable profile as a valid route.

Executable resolution is shell-free:

- Absolute paths and paths containing a separator are checked directly with executable access.
- Bare executable names are resolved by searching `PATH` entries.

### `moa_spawn`

Input:

```json
{
  "runId": "run-...",
  "phase": "plan",
  "prompt": "..."
}
```

Successful output:

```json
{
  "tool": "omp",
  "model": "anthropic/claude-opus-4-8",
  "family": "claude",
  "phase": "plan",
  "exitCode": 0,
  "durationMs": 12450,
  "result": "Worker result"
}
```

`moa_spawn` is deliberately run-bound. It rejects:

- Unknown runs.
- Finished runs.
- A phase other than the run's current phase.
- Master-owned phases.
- Host-native phases; those must use the host's native subagent capability.
- Missing, invalid, unproven, or unavailable registered profiles.
- A resolved model that the selected profile does not serve.
- Unknown or unexpanded argv placeholders.

`moa_spawn_prep` is removed. There is one external-spawn path.

### `moa_binding_save`

`moa_binding_save` remains the registration boundary. It continues to require `promptSafe: true` and passing T1/T4 evidence. On success it returns the compact registered tool record used by `moa_tools`, in addition to persistence metadata. A subsequent `moa_tools` call sees the saved profile immediately.

## Model and Route Resolution

### Separate logical model identity from execution route

A candidate model has:

- Logical identity: normalized independence group, family, tags, context, cost, and project short name.
- One or more execution routes: `{ binding, modelId, source }`.

`modelId` belongs to the route. This matters because a project may request `claude-opus-4-8`, while a registered launcher requires `anthropic/claude-opus-4-8`.

### Route sources

- Project registry entries contribute desired metadata and optional route pins. They do not create a native route.
- Every `hostModels` entry contributes a `host-native` route using the host's exact model ID.
- Every usable registered profile model contributes an external route using that profile's exact model ID.

Models are merged by the existing normalized independence group. Metadata keeps project precedence, while routes are accumulated instead of discarded.

If multiple provider aliases in one profile collapse to the same logical model and the project did not pin a provider-qualified ID, profile declaration order is the deterministic tie-breaker.

### Route selection

For a chosen logical model:

1. Apply an explicit `roles.<role>.binding` pin, else `models.<model>.binding` pin.
2. Filter routes by `runtime.subagents`:
   - `auto`: native and external routes are eligible.
   - `native`: only `host-native` routes are eligible.
   - `external`: only registered external routes are eligible.
   - `blocked`: no subagent route is eligible.
3. Validate that an explicit pin names a route that actually serves the model.
4. Without a pin, prefer a real host-native route; otherwise select the first registered route in deterministic profile order.
5. If no route survives, emit `blocked_no_binding`/`blocked_no_model` diagnostics rather than inventing a native route.

The resolved role stores the route's exact `modelId`, family, normalized group, selected binding, and selection reason. Gate independence continues to compare logical model groups, not provider routes.

### Dogfood expectation

Given:

- Host-native pool: only `openai-codex/gpt-5.6-sol`.
- Registered OMP profile: Opus, Sonnet, MiniMax, and other external models.
- Existing `moa/.moa.yml`.

Resolution must produce:

```text
planner / editor / compactor  -> OMP external routes
GPT review and validation     -> host-native gpt-5.6-sol
```

It must not label Opus, Sonnet, or MiniMax as host-native merely because they appear in the project registry.

## External Process Execution

### Working directory

`opLoad` records the requested project directory. The spawn cwd is:

- The directory containing `.moa.yml` when a config exists.
- The normalized cwd passed to `moa_load` in config-absent mode.

It must not fall back to the MCP server process's unrelated startup directory.

### Prompt and placeholders

The prompt is written literally to a file inside the run directory for the run record. The server expands these profile placeholders:

- `{bin}`: resolved executable path.
- `{model}`: route-specific exact model ID.
- `{promptFile}`: generated prompt file.
- `{cwd}`: project working directory.
- `{maxTime}`: profile timeout in seconds.

Expansion operates on individual argv elements. After expansion, any remaining `{...}` token is an error. The prompt content is never substituted into argv.

The profile's `bin` field is authoritative. After expansion, `run.argv[0]` must resolve to that same executable; a profile cannot redirect spawning to a different program.

### Process boundary

The server executes without a shell:

```js
const child = spawn(resolvedBin, argv.slice(1), {
  cwd,
  shell: false,
  stdio: [promptVia === "stdin" ? "pipe" : "ignore", "pipe", "pipe"]
})
```

For `promptVia: file`, the generated prompt file is referenced through `{promptFile}` and stdin is ignored. For `promptVia: stdin`, the server writes the prompt bytes to the child's stdin and closes it; the prompt file remains only as the run record. `promptVia: arg` remains rejected at registration.

The profile timeout is enforced. On timeout, the server terminates the child and returns a structured timeout error. Captured output is bounded to prevent an external process from consuming unbounded server memory; exceeding the fixed bound terminates the child and returns an output-limit error.

A non-zero exit returns a structured execution error containing the exit code and bounded stderr. It is never reported as a successful worker result.

### Output extraction

- `format: text`: `resultPath` is absent or `stdout`; return stdout.
- `format: json`: parse stdout as one JSON value. `resultPath: stdout` returns raw stdout; otherwise resolve a dot-separated property path.
- `format: jsonl`: parse non-empty lines. `resultPath: stdout` returns raw stdout; otherwise return the last parsed record containing the dot-separated path.

Malformed declared output or a missing result path is an explicit parse error.

## State-Machine Boundary

`moa_spawn` executes only the current non-master phase. It does not modify `manifest.current`, record a verdict, or claim changed files.

After a successful spawn, the master must:

1. Inspect the result.
2. Inspect actual workspace effects for producing phases.
3. Parse and assess a verifier verdict for gate phases.
4. Call `moa_step_report` with the actual producer model/family and observed changed files.

This keeps execution and transition authority separate. A worker cannot advance or certify its own phase.

## Failure Semantics

Every failure is structured and leaves the run on the same phase:

- `tool_unavailable`
- `model_not_served`
- `wrong_phase`
- `native_spawn_required`
- `unknown_placeholder`
- `spawn_failed`
- `timeout`
- `output_limit_exceeded`
- `nonzero_exit`
- `output_parse_failed`

The master may fix the condition or retry the same phase. `moa_step_report` remains the only operation that advances or terminates the run.

## Documentation Changes

Update the active documentation consistently:

- `moa-core/SKILL.md`: profile phases call `moa_spawn`, not shell or `moa_spawn_prep`.
- `moa-core/references/learn-tool.md`: a saved profile is registered with the MCP server and used through `moa_tools`/`moa_spawn`.
- `moa-core/mcp/README.md`: document both tools and remove shell-handoff language.
- MCP package/server version: feature-version bump applied consistently.

No concrete launcher command or flag is added to the skill core.

## Tests

Deterministic tests use a temporary fake executable and isolated `MOA_HOME`.

### Discovery and registration

- Reject an unproven profile.
- Save a proven profile.
- `moa_tools` immediately lists the saved profile, models, capabilities, and usage contract.
- Missing/non-executable binaries are unavailable and excluded from routes.

### Resolution

- A short registry model ID merges with a provider-qualified registered model and resolves externally when the host does not offer it.
- The resolved external model ID is the profile's exact provider-qualified ID.
- A genuinely host-provided model resolves natively.
- `auto`, `native`, `external`, and `blocked` filter routes correctly.
- Explicit model/role binding pins are honored only when the route serves the model.
- An unavailable route yields a diagnostic instead of silently becoming native.

### Spawn safety and behavior

- Only the current phase can spawn.
- Native and master phases are rejected.
- `{bin}`, `{model}`, `{promptFile}`, `{cwd}`, and `{maxTime}` are expanded.
- No placeholders remain.
- Shell metacharacters in the prompt remain literal file content and produce no host side effect.
- Text output is returned.
- JSON and JSONL result paths are extracted.
- Unknown placeholders, non-zero exit, malformed output, missing result path, timeout, and output overflow return structured errors without advancing the run.

### Dogfood

Using the real registered OMP profile:

1. Load and resolve the existing `moa/.moa.yml` while reporting only `openai-codex/gpt-5.6-sol` as host-native.
2. Assert planner/editor routes are external through OMP and GPT verification roles remain native.
3. Start a minimal external liveness phase on a cheap registered model.
4. Execute it through `moa_spawn` and confirm the nonce appears in the normalized result.

## Acceptance Criteria

- The master can discover every usable learned launcher with one MCP call.
- Saving a proven profile makes it immediately discoverable without restart.
- The master can execute the current externally routed phase with one MCP call and no shell handoff.
- Registry-only models are never mislabeled host-native.
- The existing dogfood configuration routes Opus/Sonnet through OMP when Claude Code exposes only GPT natively.
- Prompt metacharacters cannot execute through shell interpolation.
- External execution failures are explicit and do not advance the pipeline.
- All focused MCP tests pass.
- A real cheap OMP liveness spawn passes through the new MCP execution path.
