# Registered Tool MCP Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every proven learned launcher immediately discoverable, correctly routable, and executable through stable `moa_tools` and `moa_spawn` MCP calls.

**Architecture:** Keep learned launchers as validated YAML data under `~/.moa/bindings`, but separate logical model metadata from concrete execution routes. The MCP server discovers usable profiles, resolves each role to a route the host or a learned launcher actually serves, and executes external phases itself with temp-file/stdin prompt transport, argv arrays, `shell: false`, bounded output, and explicit failure results.

**Tech Stack:** Node.js ESM, Node standard library (`fs`, `path`, `child_process`), Zod, YAML, MCP SDK, `node:assert/strict` self-checks.

## Global Constraints

- Work only in `/Users/jeancarlojavier/pr26/moa--feat-mcp` on branch `feat/mcp`.
- No new runtime dependency; use Node standard library for executable lookup and process execution.
- No concrete launcher command or flag may enter `moa-core/SKILL.md`, `.moa.yml`, or generic MCP logic.
- `moa_binding_save` remains the T1/T4 registration gate; `promptSafe: true`, `T1: pass`, and `T4: pass` stay mandatory.
- `promptVia: arg` remains rejected; `file` and `stdin` are supported without shell interpolation.
- A project model declaration is metadata, not proof of a native route.
- A native route exists only for an exact model supplied through `hostModels`; external routes come only from usable registered profiles.
- `moa_spawn` executes only the current external non-master phase and never advances the manifest.
- `moa_step_report` remains the only state transition operation.
- External execution uses `shell: false`, a 4 MiB combined output limit, and the profile timeout.
- Remove `moa_spawn_prep`; do not leave a compatibility alias or second spawn path.
- Version the feature consistently as `0.7.0` in the skill, MCP server, package manifest, and lockfile.

---

## File Structure

- Modify `moa-core/mcp/server.mjs`: validate/discover profiles, resolve executable routes, execute external phases, and register the new MCP tools.
- Modify `moa-core/mcp/test.mjs`: deterministic discovery, routing, prompt-safety, process, output, timeout, and state-boundary coverage.
- Modify `moa-core/mcp/README.md`: public MCP tool table and execution semantics.
- Modify `moa-core/SKILL.md`: replace the shell handoff with `moa_tools`/`moa_spawn` conductor instructions.
- Modify `moa-core/references/learn-tool.md`: define successful save as immediate MCP registration and describe MCP execution.
- Modify `moa-core/mcp/package.json`: bump to `0.7.0`.
- Modify `moa-core/mcp/package-lock.json`: keep root package versions synchronized at `0.7.0`.
- No new production file: the repository currently keeps the MCP contract in one server module, and the new code shares its schemas, state, and run-store helpers directly.

---

### Task 1: Registered Tool Discovery

**Files:**
- Modify: `moa-core/mcp/server.mjs:24-205,218-260,614-658`
- Modify: `moa-core/mcp/test.mjs:1-30,233-280`

**Interfaces:**
- Consumes: `MOA_HOME`, `~/.moa/bindings/<tool>/profile.yml`, existing proven-profile schema.
- Produces: `opTools() -> { tools: ToolRecord[], skipped: SkippedTool[] }`.
- Produces: `loadBindings() -> { bindings: UsableProfile[], tools: ToolRecord[], skipped: SkippedTool[] }`.
- Produces: `ToolRecord = { tool, version, available, capabilities, models, usage }`.
- Changes: `opBindingSave({ profile })` returns persistence metadata plus `tool: ToolRecord`.

- [ ] **Step 1: Add a reusable proven profile fixture and import the future operation**

Replace the import and add the helper after `HOST` in `moa-core/mcp/test.mjs`:

```js
const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opInit, opBindingSave } =
  await import("./server.mjs");

const provenProfile = (overrides = {}) => ({
  tool: "fakecli",
  bin: process.execPath,
  version: process.version,
  run: {
    argv: ["{bin}", "--version", "{promptFile}"],
    promptVia: "file",
    timeoutSeconds: 60,
  },
  output: { format: "text", resultPath: "stdout" },
  models: [{ id: "vendor/fake-9", family: "fake", tags: ["strong", "cheap"] }],
  capabilities: { promptSafe: true, canProduce: true, canSelectModel: true },
  evidence: {
    probedOn: "2026-07-14",
    tests: { T1: "pass", T2: "pass", T3: "pass", T4: "pass" },
  },
  ...overrides,
});
```

- [ ] **Step 2: Write failing discovery and immediate-registration tests**

Replace the old combined `binding_save/spawn_prep` test with these synchronous checks:

```js
t("binding_save: rejects unproven profiles", () => {
  const bad = provenProfile({
    capabilities: { promptSafe: false },
    evidence: { probedOn: "2026-07-14", tests: { T1: "pass", T4: "fail" } },
  });
  assert.match(opBindingSave({ profile: bad }).error, /unproven/);
});

t("tools: a proven save is immediately discoverable", () => {
  const saved = opBindingSave({ profile: provenProfile() });
  assert.ok(saved.bound.endsWith("profile.yml"));
  assert.equal(saved.tool.tool, "fakecli");
  assert.equal(saved.tool.available, true);

  const listed = opTools();
  assert.equal(listed.tools.length, 1);
  assert.deepEqual(listed.tools[0].usage, {
    tool: "moa_spawn",
    arguments: ["runId", "phase", "prompt"],
  });
  assert.equal(listed.tools[0].models[0].id, "vendor/fake-9");
});

t("tools: unavailable executables are reported and excluded from load", () => {
  opBindingSave({ profile: provenProfile({ tool: "missingcli", bin: path.join(TMP, "missing-bin") }) });
  const listed = opTools();
  const missing = listed.tools.find((tool) => tool.tool === "missingcli");
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "executable_not_found");

  const loaded = opLoad({ cwd: REPO });
  assert.ok(!loaded.bindings.some((tool) => tool.tool === "missingcli"));
});
```

- [ ] **Step 3: Run the self-check and confirm the new API fails first**

Run from `moa-core/mcp` with context-mode:

```text
npm test
```

Expected: FAIL during module import because `opTools` and `opSpawn` are not exported yet, or at the first `opTools` call.

- [ ] **Step 4: Move the profile schema before discovery and validate every loaded profile**

Move the existing `zProfile` declaration from lines 616-640 to immediately after `zConfig`. Keep its current fields and add no new profile keys. Replace structural profile acceptance in `loadBindings` with `zProfile.safeParse` so discovery and save use the same schema.

Use this result shape:

```js
function loadBindings() {
  const bindings = [];
  const tools = [];
  const skipped = [];
  let dirs = [];
  try { dirs = fs.readdirSync(BINDINGS_DIR()); }
  catch { return { bindings, tools, skipped }; }

  for (const dir of dirs.sort()) {
    const file = path.join(BINDINGS_DIR(), dir, "profile.yml");
    try {
      const parsed = parseYamlStrict(fs.readFileSync(file, "utf8"), dir);
      if (parsed.errors) {
        skipped.push({ tool: dir, reason: "invalid_yaml" });
        continue;
      }
      const validated = zProfile.safeParse(parsed.value);
      if (!validated.success) {
        skipped.push({ tool: dir, reason: "invalid_profile" });
        continue;
      }
      const profile = validated.data;
      const resolvedBin = resolveExecutable(profile.bin);
      const record = toolRecord(profile, resolvedBin);
      tools.push(record);
      if (resolvedBin) bindings.push({ ...profile, resolvedBin });
    } catch {
      skipped.push({ tool: dir, reason: "unreadable_profile" });
    }
  }
  return { bindings, tools, skipped };
}
```

- [ ] **Step 5: Implement shell-free executable resolution and public records**

Add before `loadBindings`:

```js
function resolveExecutable(bin, envPath = process.env.PATH ?? "") {
  const hasSeparator = bin.includes(path.sep) || (path.sep === "\\" && bin.includes("/"));
  const candidates = hasSeparator
    ? [path.resolve(bin)]
    : envPath.split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, bin));
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch {}
  }
  return null;
}

function toolRecord(profile, resolvedBin) {
  return {
    tool: profile.tool,
    version: profile.version ?? null,
    available: Boolean(resolvedBin),
    ...(resolvedBin ? {} : { reason: "executable_not_found" }),
    capabilities: profile.capabilities ?? {},
    models: (profile.models ?? []).map((model) => ({
      id: model.id,
      family: model.family,
      tags: model.tags ?? [],
    })),
    usage: { tool: "moa_spawn", arguments: ["runId", "phase", "prompt"] },
  };
}

export function opTools() {
  const { tools, skipped } = loadBindings();
  return { tools, skipped };
}
```

- [ ] **Step 6: Return usable records from load and save**

In `opLoad`, retain usable profiles in `state.loaded.bindings`, record `projectDir`, and return compact records in both branches:

```js
if (!configPath) {
  const projectDir = path.resolve(cwd);
  state.loaded = {
    config: null,
    configPath: null,
    projectDir,
    dispatch: "adaptive-bare",
    bindings,
  };
  return {
    config: null,
    configPath: null,
    dispatch: "adaptive-bare",
    mode: "auto",
    bindings: tools.filter((tool) => tool.available),
    skippedBindings: skipped,
    note: "no .moa.yml from cwd to root — adaptive mode, write nothing; offer /moa init after substantial work",
  };
}
```

After config validation:

```js
const projectDir = path.dirname(configPath);
state.loaded = { config: cfg, configPath, projectDir, dispatch, bindings };
```

Return `tools.filter((tool) => tool.available)` as the existing `bindings` response and structured `skippedBindings`.

After `opBindingSave` writes YAML, reload and return the saved record:

```js
const discovered = opTools();
return {
  bound: file,
  models: p.models.length,
  families,
  tool: discovered.tools.find((tool) => tool.tool === p.tool),
  note: `models from ${families.length} famil${families.length === 1 ? "y" : "ies"} now available to every project`,
};
```

- [ ] **Step 7: Run the focused self-check**

Run:

```text
npm test
```

Expected: discovery tests PASS; the suite may still fail only where old routing or `opSpawn` expectations have not yet been migrated.

- [ ] **Step 8: Commit discovery**

```bash
git add moa-core/mcp/server.mjs moa-core/mcp/test.mjs
git commit -m "feat(mcp): discover registered agent tools"
```

---

### Task 2: Route Models Only Through Real Capabilities

**Files:**
- Modify: `moa-core/mcp/server.mjs:171-205,262-334`
- Modify: `moa-core/mcp/test.mjs:87-132`

**Interfaces:**
- Consumes: usable profiles from Task 1 and `hostModels` passed to `opResolve`.
- Produces: candidate rows with `routes: { binding, modelId, source }[]`.
- Produces: resolved roles whose `model` is the selected route's exact model ID and whose `binding` is a route that actually serves it.
- Preserves: `group` as the logical model identity used for independence.

- [ ] **Step 1: Add failing external-alias and policy tests**

Add a helper and tests under the resolve section:

```js
function writeRouteRepo(name, subagents = "auto", roleBinding = null) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: ${subagents}
models:
  fake: { id: fake-9, family: fake, tags: [strong] }
roles:
  worker:
    use: [fake]
${roleBinding ? `    binding: ${roleBinding}\n` : ""}pipelines: {}
`);
  return repo;
}

t("resolve: registry aliases use a registered external route", () => {
  const repo = writeRouteRepo("route-external");
  opLoad({ cwd: repo });
  const result = opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker.model, "vendor/fake-9");
  assert.equal(result.roles.worker.binding, "fakecli");
  assert.equal(result.roles.worker.group, "fake-9");
});

t("resolve: host-native exists only when the host reports the model", () => {
  const repo = writeRouteRepo("route-native");
  opLoad({ cwd: repo });
  const result = opResolve({ hostModels: [...HOST, { id: "host/fake-9", family: "fake", tags: ["strong"] }] });
  assert.equal(result.roles.worker.model, "host/fake-9");
  assert.equal(result.roles.worker.binding, "host-native");
});

t("resolve: runtime.subagents filters routes", () => {
  const nativeRepo = writeRouteRepo("route-native-only", "native");
  opLoad({ cwd: nativeRepo });
  assert.equal(opResolve({ hostModels: HOST }).diagnostics[0].state, "blocked_no_binding");

  const externalRepo = writeRouteRepo("route-external-only", "external");
  opLoad({ cwd: externalRepo });
  assert.equal(opResolve({ hostModels: [...HOST, { id: "host/fake-9", family: "fake" }] }).roles.worker.binding, "fakecli");

  const blockedRepo = writeRouteRepo("route-blocked", "blocked");
  opLoad({ cwd: blockedRepo });
  assert.equal(opResolve({ hostModels: [...HOST, { id: "host/fake-9", family: "fake" }] }).diagnostics[0].state, "blocked_no_binding");
});

t("resolve: an unavailable binding pin is diagnosed", () => {
  const repo = writeRouteRepo("route-bad-pin", "auto", "missingcli");
  opLoad({ cwd: repo });
  const result = opResolve({ hostModels: HOST });
  assert.equal(result.diagnostics[0].state, "blocked_no_binding");
  assert.match(result.diagnostics[0].hint, /missingcli/);
});
```

- [ ] **Step 2: Make every existing test model genuinely host-routable**

The base `CONFIG` uses Opus, GPT, and MiniMax. Update `HOST` so those existing happy-path tests describe real native capability instead of relying on the bug:

```js
const HOST = [
  { id: "claude-opus-4-8", family: "claude", tags: ["strong"] },
  { id: "claude-sonnet-4-6", family: "claude", tags: ["strong", "cheap"] },
  { id: "openai/gpt-5.5", family: "gpt", tags: ["strong"] },
  { id: "minimax/MiniMax-M3", family: "minimax", tags: ["strong", "cheap"] },
];
```

The existing `nowhere/ghost-1` test must also make the first role genuinely host-routable so it continues to isolate `differentModelFrom`:

```js
opLoad({ cwd: solo });
const r = opResolve({
  hostModels: [{ id: "nowhere/ghost-1", family: "ghost", tags: ["strong"] }],
});
assert.equal(r.roles.a.model, "nowhere/ghost-1");
assert.equal(r.diagnostics[0].state, "blocked_no_model");
assert.equal(r.diagnostics[0].role, "b");
```

- [ ] **Step 3: Run the tests and confirm routing failures**

Run:

```text
npm test
```

Expected: FAIL because registry rows still default to `host-native`, route policies are not applied, and resolved external model IDs are not preserved.

- [ ] **Step 4: Accumulate routes while preserving registry metadata**

Replace `candidatePool` with a map keyed by `independenceGroup`:

```js
function candidatePool(cfg, bindings, hostModels) {
  const pool = [];
  const byGroup = new Map();
  let priority = 0;

  const ensure = (model) => {
    const group = independenceGroup(model.id);
    let candidate = byGroup.get(group);
    if (!candidate) {
      candidate = {
        shortName: model.shortName ?? shortName(model.id),
        id: model.id,
        family: model.family,
        tags: model.tags ?? [],
        context: model.context,
        cost: model.cost,
        priority: model.priority ?? priority++,
        effort: model.effort,
        group,
        registryBinding: model.registryBinding,
        sources: [],
        routes: [],
      };
      byGroup.set(group, candidate);
      pool.push(candidate);
    }
    candidate.sources.push(model.source);
    return candidate;
  };

  const addRoute = (candidate, route) => {
    if (!candidate.routes.some((item) => item.binding === route.binding && item.modelId === route.modelId))
      candidate.routes.push(route);
  };

  for (const [name, entry] of Object.entries(cfg?.models ?? {})) {
    if (entry.enabled === false) continue;
    ensure({
      shortName: name,
      id: entry.id ?? name,
      family: entry.family,
      tags: entry.tags,
      context: entry.context,
      cost: entry.cost,
      priority: entry.priority,
      effort: entry.effort,
      registryBinding: entry.binding,
      source: "registry",
    });
  }

  for (const profile of bindings) {
    for (const model of profile.models) {
      const candidate = ensure({ ...model, source: `binding:${profile.tool}` });
      addRoute(candidate, {
        binding: profile.tool,
        modelId: model.id,
        source: `binding:${profile.tool}`,
      });
    }
  }

  for (const model of hostModels ?? []) {
    const candidate = ensure({ ...model, source: "host" });
    addRoute(candidate, { binding: "host-native", modelId: model.id, source: "host" });
  }

  return pool;
}
```

- [ ] **Step 5: Select routes under the configured subagent policy**

Add:

```js
function selectRoute(candidate, bindingPin, subagents = "auto") {
  const allowed = candidate.routes.filter((route) => {
    if (subagents === "blocked") return false;
    if (subagents === "native") return route.binding === "host-native";
    if (subagents === "external") return route.binding !== "host-native";
    return true;
  });
  if (bindingPin) return allowed.find((route) => route.binding === bindingPin) ?? null;
  return allowed.find((route) => route.binding === "host-native") ?? allowed[0] ?? null;
}
```

Replace `autoPick` and the role-selection body with route-aware code:

```js
function autoPick(pool, { needTags, notGroups, role, subagents }) {
  const candidates = pool
    .filter((model) => needTags.every((tag) => (model.tags ?? []).includes(tag)))
    .filter((model) => !notGroups.has(model.group));
  const costRank = { cheap: 0, standard: 1, premium: 2 };
  candidates.sort((a, b) =>
    (costRank[a.cost] ?? 1) - (costRank[b.cost] ?? 1) || a.priority - b.priority);
  for (const model of candidates) {
    const bindingPin = role.binding ?? model.registryBinding;
    const route = selectRoute(model, bindingPin, subagents);
    if (route) return { model, route, sawModelWithoutRoute: false };
  }
  return { model: null, route: null, sawModelWithoutRoute: candidates.length > 0 };
}

const subagents = cfg.runtime?.subagents ?? "auto";
let pick = null;
let route = null;
let reason = null;
let sawModelWithoutRoute = false;
let lastBindingPin = null;
const useList = overrides[rname] ? [overrides[rname]] : role.use;
for (const use of useList) {
  if (use === "auto") {
    const selected = autoPick(pool, { needTags, notGroups, role, subagents });
    sawModelWithoutRoute ||= selected.sawModelWithoutRoute;
    if (selected.model) {
      ({ model: pick, route } = selected);
      reason = `auto: ${needTags.length ? `tags [${needTags}] ` : ""}lowest-cost/priority pick`;
    }
  } else {
    const model = pool.find((candidate) => candidate.shortName === use || candidate.id === use);
    if (model && !notGroups.has(model.group)) {
      lastBindingPin = role.binding ?? model.registryBinding ?? null;
      const selectedRoute = selectRoute(model, lastBindingPin, subagents);
      if (selectedRoute) {
        pick = model;
        route = selectedRoute;
        reason = overrides[rname] ? "per-run override" : `pinned '${use}'`;
      } else {
        sawModelWithoutRoute = true;
      }
    } else if (model) {
      reason = `'${use}' skipped: same model as '${role.differentModelFrom}'`;
    }
  }
  if (pick) break;
}

if (!pick) {
  diagnostics.push({
    state: sawModelWithoutRoute ? "blocked_no_binding" : "blocked_no_model",
    role: rname,
    tried: useList,
    hint: sawModelWithoutRoute
      ? lastBindingPin
        ? `binding '${lastBindingPin}' does not serve an eligible route for this model`
        : `no ${subagents} subagent route serves this model`
      : "no candidate cleared the model and independence constraints",
  });
  continue;
}

const effort = role.effort ?? pick.effort ?? ["auto"];
roles[rname] = {
  model: route.modelId,
  shortName: pick.shortName,
  family: pick.family ?? null,
  group: pick.group,
  binding: route.binding,
  effort,
  effortRung: 0,
  selectionReason: `${reason}; route ${route.binding}`,
};
```

- [ ] **Step 6: Expose route data in pool rows**

Replace the singular fallback binding in `poolRow`:

```js
const poolRow = (model) => ({
  shortName: model.shortName,
  id: model.id,
  family: model.family ?? null,
  tags: model.tags,
  routes: model.routes.map((route) => ({ binding: route.binding, modelId: route.modelId })),
  source: model.sources.join("+"),
});
```

No registry-only model may display `host-native` unless its routes include a model supplied by `hostModels`.

- [ ] **Step 7: Run the complete MCP self-check**

Run:

```text
npm test
```

Expected: all synchronous discovery, resolution, state-machine, init, and existing tests PASS. Async spawn tests are added in Task 3.

- [ ] **Step 8: Commit real-capability routing**

```bash
git add moa-core/mcp/server.mjs moa-core/mcp/test.mjs
git commit -m "fix(mcp): route models through real capabilities"
```

---

### Task 3: Run-Bound External MCP Spawning

**Files:**
- Modify: `moa-core/mcp/server.mjs:11-17,377-464,548-574`
- Modify: `moa-core/mcp/test.mjs:7-22,133-280`

**Interfaces:**
- Consumes: `runId`, current `phase`, prompt, resolved role route, usable registered profile.
- Produces: `await opSpawn({ runId, phase, prompt }) -> { tool, model, family, phase, exitCode, durationMs, result } | { error, code, ... }`.
- Produces no manifest transition; the caller must invoke `opStepReport` separately.
- Removes: `opSpawnPrep`.

- [ ] **Step 1: Add an async test helper and deterministic fake worker**

After the synchronous `t` helper in `test.mjs`, add:

```js
const ta = async (name, fn) => {
  await fn();
  console.log(`ok ${++n} - ${name}`);
};

const FAKE_WORKER = path.join(TMP, "fake-worker.mjs");
fs.writeFileSync(FAKE_WORKER, `
import fs from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const mode = value("--mode") ?? "text";
const promptFile = value("--prompt-file");
const prompt = promptFile ? fs.readFileSync(promptFile, "utf8") : await new Promise((resolve) => {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => input += chunk);
  process.stdin.on("end", () => resolve(input));
});
if (mode === "exit") process.exit(7);
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "overflow") process.stdout.write("x".repeat(5 * 1024 * 1024));
else if (mode === "json") process.stdout.write(JSON.stringify({ response: { text: prompt } }));
else if (mode === "jsonl") process.stdout.write(JSON.stringify({ event: "start" }) + "\\n" + JSON.stringify({ response: { text: prompt } }) + "\\n");
else process.stdout.write(prompt);
`);
```

- [ ] **Step 2: Add a runnable-profile and external-run helper**

```js
function runnableProfile({ tool = "fakecli", mode = "text", promptVia = "file", timeoutSeconds = 2, output } = {}) {
  const promptArgs = promptVia === "file" ? ["--prompt-file", "{promptFile}"] : [];
  return provenProfile({
    tool,
    run: {
      argv: [
        "{bin}", FAKE_WORKER, "--mode", mode,
        ...promptArgs,
        "--model", "{model}", "--cwd", "{cwd}", "--max-time", "{maxTime}",
      ],
      promptVia,
      timeoutSeconds,
    },
    output: output ?? { format: "text", resultPath: "stdout" },
  });
}

function startExternalRun(profile = runnableProfile()) {
  opBindingSave({ profile });
  const repo = writeRouteRepo(`spawn-${crypto.randomUUID()}`, "external", profile.tool);
  opLoad({ cwd: repo });
  opResolve({ hostModels: HOST });
  return {
    repo,
    run: opRunStart({
      task: "external spawn test",
      steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master",
      masterFamily: "host",
    }),
  };
}
```

Add `import crypto from "node:crypto";` to the test imports.

- [ ] **Step 3: Write failing success, safety, and state-boundary tests**

```js
await ta("spawn: executes the current external phase and preserves prompt bytes", async () => {
  const { run } = startExternalRun();
  const sideEffect = path.join(TMP, "must-not-exist");
  const prompt = `literal $(touch ${sideEffect}) and \`touch ${sideEffect}\``;
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result, prompt);
  assert.equal(result.tool, "fakecli");
  assert.equal(result.model, "vendor/fake-9");
  assert.equal(fs.existsSync(sideEffect), false);
});

await ta("spawn: does not advance the run", async () => {
  const { run } = startExternalRun();
  await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  const report = opStepReport({ runId: run.runId, phase: "wrong", summary: "must still expect work" });
  assert.match(report.error, /expected report for phase 'work'/);
});

await ta("spawn: rejects a non-current phase", async () => {
  const { run } = startExternalRun();
  const result = await opSpawn({ runId: run.runId, phase: "later", prompt: "hello" });
  assert.equal(result.code, "wrong_phase");
});

await ta("spawn: native phases remain host-owned", async () => {
  opLoad({ cwd: REPO });
  opResolve({ hostModels: HOST });
  const run = opRunStart({ task: "native", steps: [{ phase: "plan", role: "planner" }] });
  const result = await opSpawn({ runId: run.runId, phase: "plan", prompt: "hello" });
  assert.equal(result.code, "native_spawn_required");
});
```

- [ ] **Step 4: Write failing output-format and process-failure tests**

```js
await ta("spawn: extracts JSON and JSONL result paths", async () => {
  for (const format of ["json", "jsonl"]) {
    const profile = runnableProfile({
      tool: `fake-${format}`,
      mode: format,
      output: { format, resultPath: "response.text" },
    });
    const { run } = startExternalRun(profile);
    const result = await opSpawn({ runId: run.runId, phase: "work", prompt: format });
    assert.equal(result.result, format);
  }
});

await ta("spawn: supports stdin prompt transport", async () => {
  const profile = runnableProfile({ tool: "fake-stdin", promptVia: "stdin" });
  const { run } = startExternalRun(profile);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "stdin-prompt" });
  assert.equal(result.result, "stdin-prompt");
});

await ta("spawn: rejects unknown placeholders", async () => {
  const profile = runnableProfile({ tool: "fake-placeholder" });
  profile.run.argv.push("{unknown}");
  const { run } = startExternalRun(profile);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "unknown_placeholder");
});

await ta("spawn: reports nonzero exit, timeout, and output overflow", async () => {
  for (const [tool, mode, code] of [
    ["fake-exit", "exit", "nonzero_exit"],
    ["fake-hang", "hang", "timeout"],
    ["fake-overflow", "overflow", "output_limit_exceeded"],
  ]) {
    const profile = runnableProfile({ tool, mode, timeoutSeconds: mode === "hang" ? 1 : 2 });
    const { run } = startExternalRun(profile);
    const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
    assert.equal(result.code, code);
  }
});
```

- [ ] **Step 5: Run tests and confirm `opSpawn` behavior is absent**

Run:

```text
npm test
```

Expected: FAIL because `opSpawn` is not implemented and the old `opSpawnPrep` path cannot execute workers.

- [ ] **Step 6: Persist project directory in each run and advertise MCP execution**

In `opRunStart`, add `projectDir: state.loaded.projectDir` to the manifest. In `describeStep`, replace the profile note with:

```js
: { kind: "profile", tool: r.binding, note: "call moa_spawn with the role prompt" };
```

This makes the external process cwd part of the recorded run instead of deriving it from the MCP server's startup directory.

- [ ] **Step 7: Add invocation and output helpers**

Import the process primitive:

```js
import { spawn } from "node:child_process";
```

Add constants and helpers before the run operations:

```js
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const PLACEHOLDER = /\{[^{}]+\}/;

function errorResult(code, error, extra = {}) {
  return { error, code, ...extra };
}

function valueAtPath(value, resultPath) {
  return resultPath.split(".").reduce((current, key) => current?.[key], value);
}

function normalizeResult(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function extractResult(stdout, output = {}) {
  const format = output.format ?? "text";
  const resultPath = output.resultPath ?? "stdout";
  if (resultPath === "stdout") return stdout;
  try {
    if (format === "json") {
      const value = valueAtPath(JSON.parse(stdout), resultPath);
      if (value === undefined) return errorResult("output_parse_failed", `result path '${resultPath}' was not found`);
      return normalizeResult(value);
    }
    if (format === "jsonl") {
      const records = stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
      for (let index = records.length - 1; index >= 0; index--) {
        const value = valueAtPath(records[index], resultPath);
        if (value !== undefined) return normalizeResult(value);
      }
      return errorResult("output_parse_failed", `result path '${resultPath}' was not found`);
    }
    return errorResult("output_parse_failed", `text output supports only resultPath 'stdout'`);
  } catch (error) {
    return errorResult("output_parse_failed", error.message);
  }
}
```

- [ ] **Step 8: Execute a child with timeout and bounded output**

Add an async helper that never invokes a shell:

```js
function runChild({ bin, args, cwd, stdin, timeoutSeconds }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer;
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let forcedCode = null;
    let settled = false;

    const stop = (code) => {
      if (forcedCode) return;
      forcedCode = code;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 1000).unref();
    };
    const collect = (target) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return stop("output_limit_exceeded");
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
    };

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(errorResult("spawn_failed", error.message, { durationMs: Date.now() - started }));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forcedCode) {
        resolve(errorResult(forcedCode, forcedCode === "timeout" ? "external tool timed out" : "external tool exceeded output limit", {
          exitCode, signal, stderr, durationMs: Date.now() - started,
        }));
        return;
      }
      resolve({ exitCode, signal, stdout, stderr, durationMs: Date.now() - started });
    });

    timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
    if (stdin !== null) child.stdin.end(stdin);
  });
}
```

- [ ] **Step 9: Replace `opSpawnPrep` with async `opSpawn`**

Implement the run-bound operation:

```js
export async function opSpawn({ runId, phase, prompt } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return errorResult("unknown_run", `unknown runId '${runId}'`);
  if (manifest.status !== "running") return errorResult("run_finished", `run is '${manifest.status}'`);

  const step = manifest.steps[manifest.current];
  if (phase !== step.phase)
    return errorResult("wrong_phase", `current phase is '${step.phase}', not '${phase}'`);
  if (step.role === "master")
    return errorResult("master_phase", `phase '${phase}' belongs to the master`);

  const resolved = manifest.resolved[step.role];
  if (resolved.binding === "host-native")
    return errorResult("native_spawn_required", "use the host's native subagent capability");

  const { bindings } = loadBindings();
  const profile = bindings.find((item) => item.tool === resolved.binding);
  if (!profile) return errorResult("tool_unavailable", `registered tool '${resolved.binding}' is unavailable`);
  if (!profile.models.some((model) => model.id === resolved.model))
    return errorResult("model_not_served", `'${resolved.binding}' does not serve '${resolved.model}'`);

  const dir = runDir(runId);
  fs.mkdirSync(dir, { recursive: true });
  const promptFile = path.join(dir, `prompt-${phase}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt);
  const timeoutSeconds = profile.run.timeoutSeconds ?? 1800;
  const values = {
    "{bin}": profile.resolvedBin,
    "{model}": resolved.model,
    "{promptFile}": promptFile,
    "{cwd}": manifest.projectDir,
    "{maxTime}": String(timeoutSeconds),
  };
  const argv = profile.run.argv.map((arg) => {
    let expanded = String(arg);
    for (const [placeholder, value] of Object.entries(values))
      expanded = expanded.replaceAll(placeholder, value);
    return expanded;
  });
  const unknown = argv.find((arg) => PLACEHOLDER.test(arg));
  if (unknown) return errorResult("unknown_placeholder", `unexpanded placeholder in '${unknown}'`);
  if (resolveExecutable(argv[0]) !== profile.resolvedBin)
    return errorResult("spawn_failed", "run.argv[0] does not resolve to profile.bin");

  const execution = await runChild({
    bin: profile.resolvedBin,
    args: argv.slice(1),
    cwd: manifest.projectDir,
    stdin: profile.run.promptVia === "stdin" ? prompt : null,
    timeoutSeconds,
  });
  if (execution.error) return execution;
  if (execution.exitCode !== 0)
    return errorResult("nonzero_exit", `external tool exited with ${execution.exitCode}`, execution);

  const result = extractResult(execution.stdout, profile.output);
  if (result?.error) return result;
  return {
    tool: profile.tool,
    model: resolved.model,
    family: resolved.family,
    phase,
    exitCode: execution.exitCode,
    durationMs: execution.durationMs,
    result,
  };
}
```

Delete `opSpawnPrep` completely.

- [ ] **Step 10: Run all MCP tests**

Run:

```text
npm test
```

Expected: every test passes, including literal metacharacter transport, JSON/JSONL extraction, stdin, timeout, non-zero exit, output limit, current-phase enforcement, and no automatic transition.

- [ ] **Step 11: Commit external execution**

```bash
git add moa-core/mcp/server.mjs moa-core/mcp/test.mjs
git commit -m "feat(mcp): execute registered agent tools"
```

---

### Task 4: Publish the Stable MCP Contract

**Files:**
- Modify: `moa-core/mcp/server.mjs:675-767`
- Modify: `moa-core/mcp/README.md:1-48`
- Modify: `moa-core/SKILL.md:1-56`
- Modify: `moa-core/references/learn-tool.md:49-80,146-162,220-226`
- Modify: `moa-core/mcp/package.json:1-9`
- Modify: `moa-core/mcp/package-lock.json:1-10`

**Interfaces:**
- Registers MCP tools `moa_tools` and async `moa_spawn`.
- Removes MCP tool `moa_spawn_prep`.
- Documents the exact conductor flow: load → tools/resolve → run start → spawn → inspect → step report.

- [ ] **Step 1: Register `moa_tools` and `moa_spawn`**

Set the MCP server version to `0.7.0`. Add discovery after `moa_load`:

```js
server.tool(
  "moa_tools",
  "Lists registered external agent tools that are currently executable, their models and capabilities, and the stable MCP call used to run them. Reloads profiles on every call, so newly learned tools appear without a server restart.",
  {},
  async () => json(opTools())
);
```

Replace the `moa_spawn_prep` registration with:

```js
server.tool(
  "moa_spawn",
  "Executes the current run phase through its resolved registered external agent tool. Validates phase order and model support, transports the prompt by file or stdin without a shell, enforces timeout/output limits, and returns the normalized worker result. Does not advance the run; inspect the result and call moa_step_report separately.",
  {
    runId: z.string(),
    phase: z.string().describe("must be the run's current non-master external phase"),
    prompt: z.string(),
  },
  async (args) => json(await opSpawn(args))
);
```

- [ ] **Step 2: Update the hot-path skill without adding launcher-specific knowledge**

Change `moa-core/SKILL.md` version to `0.7.0`. Replace lines 49-50 with:

```markdown
   - `spawn.kind: profile` → call `moa_spawn` with the role's prompt; inspect the normalized
     result and actual workspace effects, then report the phase. The MCP server owns safe execution.
```

At the end of step 1, clarify that `moa_tools` provides an on-demand compact list if connected-tool details are needed; do not duplicate model lists or commands in the skill.

- [ ] **Step 3: Update learn-tool registration and execution language**

In `moa-core/references/learn-tool.md`:

- Keep the profile format and T1–T4 probe requirements.
- Change Phase 5 from “read it and run the tool with your own shell” to “save through `moa_binding_save`; the server validates it and it appears immediately in `moa_tools`.”
- Change the orchestration section to: resolve a model to the registered tool, call `moa_spawn(runId, phase, prompt)`, inspect the normalized result/workspace, then call `moa_step_report`.
- Document supported placeholders `{bin}`, `{model}`, `{promptFile}`, `{cwd}`, and `{maxTime}`.
- State that `file` and `stdin` are supported and `arg` is refused.
- Preserve the rule that concrete CLI commands live only in profiles.

- [ ] **Step 4: Update MCP README and versions**

In `moa-core/mcp/README.md`:

- Change “the actual spawning” from master-owned to MCP-owned for learned tools.
- Add `moa_tools` and `moa_spawn` rows.
- Remove `moa_spawn_prep` and all shell handoff language.
- Document that host-native phases still use the host capability and external phases use `moa_spawn`.
- Document `moa_spawn`'s non-transition boundary.

Set these exact versions:

```json
// package.json
"version": "0.7.0"
```

```json
// package-lock.json, root and packages[""]
"version": "0.7.0"
```

- [ ] **Step 5: Run focused behavioral verification after documentation changes**

Run from `moa-core/mcp` via context-mode:

```text
npm test
```

Expected: all checks pass with a final `N checks passed` line and exit code 0.

- [ ] **Step 6: Check active docs for the removed path**

Use the repository search tool for `moa_spawn_prep` under `moa-core/`.

Expected: no matches in `moa-core/SKILL.md`, `moa-core/references/`, `moa-core/mcp/README.md`, `server.mjs`, or `test.mjs`. Historical mentions in the approved design spec are allowed because they describe the removed behavior.

- [ ] **Step 7: Commit the public contract**

```bash
git add moa-core/SKILL.md moa-core/references/learn-tool.md moa-core/mcp/README.md moa-core/mcp/server.mjs moa-core/mcp/package.json moa-core/mcp/package-lock.json
git commit -m "docs(mcp): publish registered tool execution"
```

---

### Task 5: Dogfood Routing, Real OMP Spawn, and Independent Gate

**Files:**
- Verify only: `moa-core/mcp/server.mjs`
- Verify only: `moa-core/mcp/test.mjs`
- Verify only: `moa-core/SKILL.md`
- Verify only: `moa-core/references/learn-tool.md`
- Temporary and removed before completion: `moa--feat-mcp/.moa.yml`

**Interfaces:**
- Exercises the real profile at `~/.moa/bindings/omp/profile.yml` through the exported `opLoad`, `opResolve`, `opRunStart`, `opSpawn`, and `opStepReport` functions.
- Produces verification evidence only; no delivered source mutation.

- [ ] **Step 1: Run the complete deterministic suite in context-mode**

Run from `/Users/jeancarlojavier/pr26/moa--feat-mcp/moa-core/mcp`:

```text
npm test
```

Expected: exit code 0 and every discovery, route, spawn, process-failure, state-machine, and init check passes.

- [ ] **Step 2: Reproduce the original dogfood resolution with the fixed server**

Use context-mode JavaScript from the feature worktree to import `./moa-core/mcp/server.mjs`, then execute:

```js
const server = await import("./moa-core/mcp/server.mjs");
server.opLoad({ cwd: "/Users/jeancarlojavier/pr26/moa" });
const resolved = server.opResolve({
  hostModels: [{ id: "openai-codex/gpt-5.6-sol", family: "gpt", tags: ["strong"] }],
});
console.log(JSON.stringify({
  planner: resolved.roles.planner,
  editor: resolved.roles.editor,
  validator: resolved.roles.validator,
}, null, 2));
```

Expected:

- `planner.binding === "omp"` and `planner.model` ends in `claude-opus-4-8`.
- `editor.binding === "omp"` and `editor.model` ends in `claude-sonnet-4-6`.
- `validator.binding === "host-native"` and `validator.model === "openai-codex/gpt-5.6-sol"`.

- [ ] **Step 3: Execute a real cheap OMP liveness phase through `opSpawn`**

In a new context-mode JavaScript call, import the modified server, create a temporary directory and config, then run:

```js
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const crypto = await import("node:crypto");
const server = await import("./moa-core/mcp/server.mjs");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "moa-omp-live-"));
const nonce = `MOA_${crypto.randomBytes(8).toString("hex")}`;
try {
  fs.writeFileSync(path.join(scratch, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: external
models:
  worker: { id: minimax-1m/MiniMax-M3, family: minimax, tags: [strong, cheap], binding: omp }
roles:
  worker: { use: [worker] }
pipelines:
  live:
    steps:
      - { phase: live, role: worker }
`);
  server.opLoad({ cwd: scratch });
  server.opResolve({ hostModels: [] });
  const run = server.opRunStart({
    task: "external liveness",
    pipeline: "live",
    masterModel: "openai-codex/gpt-5.6-sol",
    masterFamily: "gpt",
  });
  const result = await server.opSpawn({
    runId: run.runId,
    phase: "live",
    prompt: `Reply with exactly ${nonce} and nothing else.`,
  });
  if (!result.result?.includes(nonce)) throw new Error(JSON.stringify(result));
  console.log(JSON.stringify({ tool: result.tool, model: result.model, nonceSeen: true }));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
```

Expected: `{ "tool": "omp", "model": "minimax-1m/MiniMax-M3", "nonceSeen": true }` and no shell invocation by the master.

- [ ] **Step 4: Run an independent cross-family review through the new path**

First confirm `/Users/jeancarlojavier/pr26/moa--feat-mcp/.moa.yml` does not exist; abort rather than overwrite user work. Then temporarily write it with one external strong verifier role:

```yaml
schemaVersion: 1
runtime:
  subagents: external
models:
  verifier:
    id: google-antigravity/gemini-3-pro
    family: gemini
    tags: [strong]
    binding: omp
roles:
  verifier:
    use: [verifier]
pipelines:
  verify:
    steps:
      - { phase: verify, role: verifier, gate: critical }
```

Load, resolve, and start `verify` with master model `openai-codex/gpt-5.6-sol`. Call `opSpawn` with a prompt that instructs the verifier to read the approved design, implementation plan, changed server/tests/docs, run `npm test` under `moa-core/mcp`, and return exactly one leading verdict line `APPROVE` or `REVISE`, followed by evidence. Parse the leading verdict and pass it to `opStepReport` with the verifier's actual model/family.

Expected:

- Gate grade is cross-family before execution.
- Verifier returns `APPROVE`.
- `opStepReport` returns terminal `done` with `verify` in `gatesPassed`.

If the verifier returns `REVISE`, implement every concrete finding at the source, rerun Tasks 1–4 checks, and repeat this gate. Do not overrule it.

- [ ] **Step 5: Remove temporary config and verify no delivered scratch artifacts remain**

Delete only the temporary worktree config:

```bash
rm /Users/jeancarlojavier/pr26/moa--feat-mcp/.moa.yml
```

Confirm through the file tools that no probe file, temp prompt, or fake worker was created inside the repository. Run the focused deterministic suite once more if the independent reviewer required any code change.

- [ ] **Step 6: Record final evidence**

Final delivery must name:

- Deterministic MCP test result.
- Correct dogfood routes for planner, editor, and validator.
- Real OMP model used for liveness and nonce result.
- Independent verifier model, family, verdict, and gate grade.
- Any residual limitation: unregistered-tool T1–T4 probing remains outside the MCP server in this increment.
