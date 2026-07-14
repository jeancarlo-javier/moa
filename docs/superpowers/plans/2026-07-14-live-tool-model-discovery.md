# Live Tool Model Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace persisted learned-tool model inventories with server-owned live discovery while making `.moa.yml` model entries the sole place that pins a tool binding.

**Architecture:** Learned profiles persist a validated `modelDiscovery` argv/parser recipe and no model list. `moa_tools`, `moa_resolve`, `moa_binding_save`, and `moa_spawn` call one bounded, shell-free discovery helper; resolution builds current routes from those results plus `hostModels`, then applies configured model metadata and model-level binding pins. Configured aliases remain distinct candidates even when they share one canonical model identity.

**Tech Stack:** Node.js ESM, Node standard library (`fs`, `path`, `os`, `child_process`), Zod, YAML, MCP SDK, `node:assert/strict` self-checks.

## Global Constraints

- Do not persist external model inventories anywhere.
- Learned profiles must contain `modelDiscovery`; `models` and `listModels` are invalid.
- Every learned and host model ID must match `^[^\s/]+/[^\s]+$`.
- A learned profile must prove `modelDiscovery`, T1, T2, and T4 and must declare `canSelectModel: true`.
- `run.modelPlaceholder` is required and must occur in `run.argv`.
- `modelDiscovery.argv[0]` must be `{bin}`; discovery accepts only the `{bin}` placeholder.
- Discovery supports only JSON path extraction and one-canonical-ID-per-line output.
- Discovery timeout defaults to 10 seconds and is capped at 30 seconds.
- Discovery and worker execution use `shell: false` and a combined 4 MiB stdout/stderr bound.
- `.moa.yml` supports `binding` only under `models.<alias>`; `roles.<name>.binding` is invalid.
- Model matching is exact; never use a launcher's fuzzy model matching during resolution.
- Configless adaptive mode may use current live learned-tool models.
- Only `hostModels` create `host-native` routes.
- Freeze the chosen route in the run manifest; revalidate it before spawn and never silently reroute.
- Do not add an inventory cache, provider API calls, remote-catalog refresh, migration shim, compatibility alias, or stale fallback.
- Keep `SKILL.md`, MCP server, `package.json`, and `package-lock.json` synchronized at `0.8.0`.

## File Structure

- Modify `moa-core/mcp/server.mjs`: profile/config validation, safe discovery runner, live tool reporting, candidate construction, route resolution, binding registration, spawn revalidation, and public MCP handlers.
- Modify `moa-core/mcp/test.mjs`: deterministic fake discovery process, async operation coverage, route/binding tests, discovery failures, drift, and no-persistence checks.
- Modify `moa-core/schema/config.schema.json`: canonical model IDs, model-only binding, and removal of role binding.
- Modify `moa-core/SKILL.md`: live discovery call flow and strict native/external terminology.
- Modify `moa-core/references/learn-tool.md`: required discovery recipe, canonical IDs, T2, and profile persistence rules.
- Modify `moa-core/references/init.md`: obtain learned-tool models through live `moa_tools`; write optional model-level binding pins.
- Modify `moa-core/references/adaptive.md`: configless candidate pool includes current live learned-tool inventories.
- Modify `moa-core/mcp/README.md`: async live discovery semantics, model-only binding, errors, and version.
- Modify all five files under `moa-core/templates/`: document canonical IDs and optional model-level `binding` without adding inventory dumps.
- Modify `moa-core/mcp/package.json` and `moa-core/mcp/package-lock.json`: version `0.8.0`.
- No new runtime source file: the server already centralizes the MCP contract, and a second module would create a circular state/runner boundary for one focused helper.

---

### Task 1: Live Discovery, Resolution, and Spawn Cutover

**Files:**
- Modify: `moa-core/mcp/server.mjs:27-142,209-344,357-545,547-658,873-1024,1041-1144`
- Modify: `moa-core/mcp/test.mjs:1-709`
- Modify: `moa-core/schema/config.schema.json:51-80,132-152`

**Interfaces:**
- Produces: `discoverToolModels(profile, resolvedBin?) -> Promise<{ tool: string, checkedAt: string, models: Array<{ id: string }> } | { error: string, code: string, exitCode?: number, durationMs?: number }>`.
- Produces: async `opTools()`, async `opResolve({hostModels, overrides})`, and async `opBindingSave({profile})`.
- Preserves: sync `opLoad`, `opRunStart`, `opStepReport`, and `opInit`; async `opSpawn`.
- Produces: configured candidate `{ shortName, id, family, tags, context, cost, priority, effort, group, registryBinding, routes, sources }`, one candidate per configured alias.
- Produces: route `{ binding, modelId, source }`, where `modelId` is always the exact canonical selector returned by discovery or `hostModels`.
- Consumes: existing `runChild`, `valueAtPath`, `errorResult`, `resolveExecutable`, and `independenceGroup` helpers.

- [ ] **Step 1: Replace the test fixtures with live inventory fixtures**

Add a per-tool inventory file so tests can change availability without rewriting a profile:

```js
const CANONICAL_FAKE_MODEL = "vendor/fake-9";
const inventoryPath = (tool) => path.join(TMP, `${tool}-models.txt`);

function writeInventory(tool, ids = [CANONICAL_FAKE_MODEL], format = "json") {
  const file = inventoryPath(tool);
  const content = format === "lines"
    ? ids.join("\n") + "\n"
    : JSON.stringify({ models: ids.map((id) => ({ id })) });
  fs.writeFileSync(file, content);
  return file;
}

const provenProfile = (overrides = {}) => {
  const {
    tool = "fakecli",
    inventory = [CANONICAL_FAKE_MODEL],
    discoveryFormat = "json",
    ...profileOverrides
  } = overrides;
  const modelFile = writeInventory(tool, inventory, discoveryFormat);
  return {
    tool,
    bin: process.execPath,
    version: process.version,
    run: {
      argv: [
        "{bin}", FAKE_WORKER, "--mode", "text",
        "--prompt-file", "{promptFile}",
        "--model", "{model}", "--cwd", "{cwd}", "--max-time", "{maxTime}",
      ],
      promptVia: "file",
      modelPlaceholder: "{model}",
      timeoutSeconds: 60,
    },
    output: { format: "text", resultPath: "stdout" },
    modelDiscovery: {
      argv: ["{bin}", FAKE_WORKER, "--models-file", modelFile],
      output: discoveryFormat === "lines"
        ? { format: "lines" }
        : { format: "json", listPath: "models", idPath: "id" },
      timeoutSeconds: 10,
    },
    capabilities: { promptSafe: true, canProduce: true, canSelectModel: true },
    evidence: {
      probedOn: "2026-07-14",
      tests: { modelDiscovery: "pass", T1: "pass", T2: "pass", T3: "pass", T4: "pass" },
    },
    ...profileOverrides,
  };
};
```

Refactor the fake worker so discovery exits before it attempts to read a prompt:

```js
const modelsFile = value("--models-file");
if (modelsFile) {
  const mode = value("--mode") ?? "text";
  if (mode === "exit") process.exit(7);
  if (mode === "hang") setInterval(() => {}, 1000);
  else if (mode === "overflow") process.stdout.write("x".repeat(5 * 1024 * 1024));
  else if (mode === "badjson") process.stdout.write("{");
  else process.stdout.write(fs.readFileSync(modelsFile, "utf8"));
} else {
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
  else if (mode === "badjson") process.stdout.write("{");
  else if (mode === "json") process.stdout.write(JSON.stringify({ response: { text: prompt } }));
  else if (mode === "jsonl") process.stdout.write(JSON.stringify({ event: "start" }) + "\n" + JSON.stringify({ response: { text: prompt } }) + "\n");
  else process.stdout.write(prompt);
}
```

Make every fixture model canonical. In particular, replace `claude-opus-4-8`, `claude-sonnet-4-6`, `fake-9`, and `ghost-1` with namespaced IDs such as `anthropic/claude-opus-4-8`, `anthropic/claude-sonnet-4-6`, `vendor/fake-9`, and `nowhere/ghost-1`.

- [ ] **Step 2: Write failing discovery and schema tests**

Convert any test that calls `opTools`, `opResolve`, or `opBindingSave` to `await ta(...)`. Make `freshRun` and `startExternalRun` async and await them from every caller:

```js
async function freshRun() {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  return opRunStart({
    task: "test task",
    pipeline: "build",
    masterModel: "host/master",
    masterFamily: "host",
  });
}

async function startExternalRun(profile = runnableProfile()) {
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`spawn-${crypto.randomUUID()}`, "external", profile.tool);
  opLoad({ cwd: repo });
  await opResolve({ hostModels: HOST });
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

Add these table-driven checks before implementation:

```js
await ta("binding_save: rejects obsolete and incomplete discovery profiles", async () => {
  const obsolete = provenProfile();
  obsolete.models = [{ id: CANONICAL_FAKE_MODEL, family: "fake" }];
  assert.match((await opBindingSave({ profile: obsolete })).error, /invalid profile/);

  const oldList = provenProfile();
  oldList.listModels = ["{bin}", "models"];
  assert.match((await opBindingSave({ profile: oldList })).error, /invalid profile/);

  for (const mutate of [
    (p) => delete p.modelDiscovery,
    (p) => delete p.run.modelPlaceholder,
    (p) => p.run.argv.splice(p.run.argv.indexOf("{model}"), 1),
    (p) => p.capabilities.canSelectModel = false,
    (p) => p.evidence.tests.T2 = "fail",
  ]) {
    const profile = provenProfile({ tool: `invalid-${crypto.randomUUID()}` });
    mutate(profile);
    assert.ok((await opBindingSave({ profile })).error);
  }
});

await ta("tools: reads JSON and line inventories live without persisting them", async () => {
  await opBindingSave({ profile: provenProfile({ tool: "jsoncli" }) });
  await opBindingSave({ profile: provenProfile({
    tool: "linecli",
    inventory: ["vendor/line-1", "vendor/line-2"],
    discoveryFormat: "lines",
  }) });

  let listed = await opTools();
  assert.deepEqual(
    listed.tools.find((tool) => tool.tool === "jsoncli").models.map((model) => model.id),
    [CANONICAL_FAKE_MODEL],
  );
  assert.deepEqual(
    listed.tools.find((tool) => tool.tool === "linecli").models.map((model) => model.id),
    ["vendor/line-1", "vendor/line-2"],
  );

  writeInventory("jsoncli", ["vendor/new-10"]);
  listed = await opTools();
  assert.deepEqual(
    listed.tools.find((tool) => tool.tool === "jsoncli").models.map((model) => model.id),
    ["vendor/new-10"],
  );

  const saved = fs.readFileSync(path.join(
    process.env.MOA_HOME, ".moa", "bindings", "jsoncli", "profile.yml",
  ), "utf8");
  assert.ok(!saved.includes("vendor/fake-9"));
  assert.ok(!saved.includes("vendor/new-10"));
});

await ta("tools: rejects malformed, empty, and noncanonical inventories", async () => {
  for (const [tool, content, code] of [
    ["bad-json", "{", "model_discovery_parse_failed"],
    ["empty-models", JSON.stringify({ models: [] }), "model_inventory_empty"],
    ["display-names", "Claude Opus 4.6 (Thinking)\n", "model_discovery_parse_failed"],
    ["missing-path", JSON.stringify({ wrong: [] }), "model_discovery_parse_failed"],
  ]) {
    const format = tool === "display-names" ? "lines" : "json";
    const profile = provenProfile({ tool, discoveryFormat: format });
    fs.writeFileSync(inventoryPath(tool), content);
    const result = await opBindingSave({ profile });
    assert.equal(result.code, code, `${tool}: ${JSON.stringify(result)}`);
  }
});

await ta("tools: reports discovery process boundaries", async () => {
  for (const [tool, mode, code] of [
    ["discover-exit", "exit", "model_discovery_failed"],
    ["discover-hang", "hang", "model_discovery_timeout"],
    ["discover-overflow", "overflow", "model_discovery_overflow"],
  ]) {
    const profile = provenProfile({ tool });
    profile.modelDiscovery.argv.push("--mode", mode);
    profile.modelDiscovery.timeoutSeconds = mode === "hang" ? 1 : 10;
    const result = await opBindingSave({ profile });
    assert.equal(result.code, code, `${tool}: ${JSON.stringify(result)}`);
  }
});
```

Add a config-load assertion proving role-level binding is invalid and model-level binding is valid:

```js
await ta("load: binding belongs to models, never roles", async () => {
  const bad = path.join(TMP, "role-binding");
  fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, ".moa.yml"), `
schemaVersion: 1
models:
  fake: { id: vendor/fake-9, binding: fakecli }
roles:
  worker: { use: [fake], binding: fakecli }
pipelines: {}
`);
  assert.ok(opLoad({ cwd: bad }).errors.some((error) => error.includes("binding")));

  const good = path.join(TMP, "model-binding");
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, ".moa.yml"), `
schemaVersion: 1
models:
  fake: { id: vendor/fake-9, family: fake, binding: fakecli }
roles:
  worker: { use: [fake] }
pipelines: {}
`);
  assert.equal(opLoad({ cwd: good }).errors, undefined);
});
```

- [ ] **Step 3: Run the focused self-check to confirm red state**

Run:

```bash
cd moa-core/mcp && npm test
```

Expected: nonzero exit. The first new failure must show that the current profile schema rejects `modelDiscovery`, accepts obsolete `models`, or that `opTools` is not awaitable/live. Do not proceed if the test fails first for a fixture syntax error.

- [ ] **Step 4: Replace the profile and configuration schemas**

In `server.mjs`, define the canonical ID and discovery schemas immediately before `zProfile`:

```js
const CANONICAL_MODEL_ID = /^[^\s/]+\/[^\s]+$/;

const zDiscoveryOutput = z.discriminatedUnion("format", [
  z.object({
    format: z.literal("json"),
    listPath: z.string().min(1),
    idPath: z.string().min(1),
  }).strict(),
  z.object({ format: z.literal("lines") }).strict(),
]);

const zModelDiscovery = z.object({
  argv: z.array(z.string()).min(1),
  output: zDiscoveryOutput,
  timeoutSeconds: z.number().int().positive().max(30).optional(),
}).strict();
```

Change `zModelEntry.id` to `z.string().regex(CANONICAL_MODEL_ID).optional()`. Remove `binding` from `zRole`. Replace the learned-profile `models` and `listModels` properties with:

```js
modelDiscovery: zModelDiscovery,
```

Keep `capabilities.canSelectModel` syntactically boolean so validation can return a structured profile error, but enforce `true` in `profileRejectionReason`:

```js
function profileRejectionReason(profile) {
  if (profile.capabilities.promptSafe !== true ||
      profile.capabilities.canSelectModel !== true ||
      profile.evidence.tests.modelDiscovery !== "pass" ||
      profile.evidence.tests.T1 !== "pass" ||
      profile.evidence.tests.T2 !== "pass" ||
      profile.evidence.tests.T4 !== "pass")
    return "unproven_profile";
  if ((profile.run.promptVia ?? "file") === "arg")
    return "unsafe_prompt_transport";
  if ((profile.run.promptVia ?? "file") === "file" &&
      !profile.run.argv.some((arg) => arg.includes("{promptFile}")))
    return "invalid_profile";
  if (!profile.run.modelPlaceholder ||
      !profile.run.argv.some((arg) => arg.includes(profile.run.modelPlaceholder)))
    return "invalid_profile";
  if (profile.modelDiscovery.argv[0] !== "{bin}")
    return "invalid_profile";
  if (profile.modelDiscovery.argv.some((arg) =>
      arg.replaceAll("{bin}", "").match(PLACEHOLDER)))
    return "invalid_profile";
  return null;
}
```

Extend `crossCheck` so `(entry.id ?? alias)` must match `CANONICAL_MODEL_ID`. Apply the same regex to the `hostModels[].id` and `moa_init.registry.*.id` MCP input schemas.

Mirror these changes in `schema/config.schema.json`:

- constrain `models.*.id` with `"pattern": "^[^\\s/]+/[^\\s]+$"`;
- explain that `binding` pins the exact learned tool or `host-native` route for that model alias;
- delete `roles.*.binding`;
- update `models` and `roles.use` descriptions to state that aliases remain distinct and role `use` is the only role-level route selector.

- [ ] **Step 5: Implement bounded live discovery**

Add these helpers near `runChild` and reuse the existing process lifecycle rather than creating another launcher:

```js
function discoveryError(result) {
  const code = {
    spawn_failed: "model_discovery_failed",
    nonzero_exit: "model_discovery_failed",
    timeout: "model_discovery_timeout",
    output_limit_exceeded: "model_discovery_overflow",
  }[result.code] ?? "model_discovery_failed";
  return errorResult(code, result.error, {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
  });
}

function parseDiscoveredModels(stdout, output) {
  let ids;
  try {
    if (output.format === "json") {
      const parsed = JSON.parse(stdout);
      const list = valueAtPath(parsed, output.listPath);
      if (!Array.isArray(list))
        return errorResult("model_discovery_parse_failed", `model list path '${output.listPath}' is not an array`);
      ids = list.map((item) => valueAtPath(item, output.idPath));
    } else {
      ids = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    }
  } catch (error) {
    return errorResult("model_discovery_parse_failed", `could not parse model inventory: ${error.message}`);
  }
  if (!ids.length)
    return errorResult("model_inventory_empty", "model discovery returned no models");
  if (ids.some((id) => typeof id !== "string" || !CANONICAL_MODEL_ID.test(id)))
    return errorResult("model_discovery_parse_failed", "model discovery returned a noncanonical model id");
  return { models: [...new Set(ids)].map((id) => ({ id })) };
}

async function discoverToolModels(profile, resolvedBin = resolveExecutable(profile.bin)) {
  if (!profile.modelDiscovery)
    return errorResult("model_discovery_unavailable", `tool '${profile.tool}' has no model discovery recipe`);
  if (!resolvedBin)
    return errorResult("model_discovery_failed", `tool '${profile.tool}' executable is unavailable`);

  const argv = profile.modelDiscovery.argv.map((arg) => arg.replaceAll("{bin}", resolvedBin));
  if (argv.some((arg) => PLACEHOLDER.test(arg)))
    return errorResult("model_discovery_unavailable", "model discovery contains an unknown placeholder");
  if (resolveExecutable(argv[0]) !== resolvedBin)
    return errorResult("model_discovery_unavailable", "model discovery executable does not match profile.bin");

  const execution = await runChild({
    bin: resolvedBin,
    args: argv.slice(1),
    cwd: os.tmpdir(),
    stdin: null,
    timeoutSeconds: profile.modelDiscovery.timeoutSeconds ?? 10,
  });
  if (execution.error) return discoveryError(execution);

  const parsed = parseDiscoveredModels(execution.stdout, profile.modelDiscovery.output);
  if (parsed.error) return parsed;
  return {
    tool: profile.tool,
    checkedAt: new Date().toISOString(),
    models: parsed.models,
  };
}
```

Do not write `parsed.models`, `stdout`, or a discovery cache to any file or module state.

- [ ] **Step 6: Make registration and tool reporting use live discovery**

Remove `models` from the static `toolRecord`. Return only executable/capability/discovery registration metadata until a caller asks for live data:

```js
function toolRecord(profile, resolvedBin) {
  return {
    tool: profile.tool,
    version: profile.version ?? null,
    available: Boolean(resolvedBin),
    ...(resolvedBin ? {} : { reason: "executable_not_found" }),
    capabilities: profile.capabilities ?? {},
    modelDiscovery: { registered: Boolean(profile.modelDiscovery) },
    usage: { tool: "moa_spawn", arguments: ["runId", "phase", "prompt"] },
  };
}
```

Make `opTools` async and attach live results without mutating the loaded profiles:

```js
export async function opTools() {
  const { bindings, tools, skipped } = loadBindings();
  const records = new Map(tools.map((tool) => [tool.tool, tool]));
  await Promise.all(bindings.map(async (profile) => {
    const result = await discoverToolModels(profile, profile.resolvedBin);
    const record = records.get(profile.tool);
    if (result.error) {
      record.models = [];
      record.modelDiscovery = { registered: true, status: "error", code: result.code, error: result.error };
    } else {
      record.models = result.models;
      record.modelDiscovery = { registered: true, status: "ok", checkedAt: result.checkedAt };
    }
  }));
  return { tools: [...records.values()], skipped };
}
```

Make `opBindingSave` async. Validate the profile, executable, and live discovery before writing:

```js
export async function opBindingSave({ profile } = {}) {
  const validated = zProfile.safeParse(profile);
  if (!validated.success)
    return errorResult("invalid_profile", "invalid profile: " + validated.error.issues.map((issue) =>
      `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const saved = validated.data;
  const rejection = profileRejectionReason(saved);
  if (rejection)
    return errorResult(rejection, `refusing profile '${saved.tool}': ${rejection}`);

  const resolvedBin = resolveExecutable(saved.bin);
  if (!resolvedBin)
    return errorResult("tool_unavailable", `tool '${saved.tool}' executable is unavailable`);
  const discovery = await discoverToolModels(saved, resolvedBin);
  if (discovery.error) return discovery;

  const dir = path.join(BINDINGS_DIR(), saved.tool);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "profile.yml");
  fs.writeFileSync(file, YAML.stringify(saved));
  return {
    bound: file,
    models: discovery.models,
    tool: { ...toolRecord(saved, resolvedBin), models: discovery.models,
      modelDiscovery: { registered: true, status: "ok", checkedAt: discovery.checkedAt } },
    note: `${discovery.models.length} models currently available through ${saved.tool}`,
  };
}
```

Update the unavailable-executable test: `moa_binding_save` must now reject it; retain the manual stale-profile test to prove `moa_tools` and `moa_load` report/skip a binary removed after registration.

- [ ] **Step 7: Replace snapshot-based candidate construction with live routes**

Add a live-inventory collector:

```js
async function discoverBindingInventories(bindings) {
  const results = await Promise.all(bindings.map(async (profile) => ({
    profile,
    discovery: await discoverToolModels(profile, profile.resolvedBin),
  })));
  return {
    inventories: results.filter((item) => !item.discovery.error),
    diagnostics: results.filter((item) => item.discovery.error).map((item) => ({
      state: item.discovery.code,
      tool: item.profile.tool,
      error: item.discovery.error,
    })),
  };
}
```

Replace `candidatePool` with a route-first implementation. Keep configured aliases distinct:

```js
function candidatePool(cfg, inventories, hostModels) {
  const routesById = new Map();
  const hostById = new Map();
  const addRoute = (id, route) => {
    const routes = routesById.get(id) ?? [];
    if (!routes.some((item) => item.binding === route.binding && item.modelId === route.modelId))
      routes.push(route);
    routesById.set(id, routes);
  };

  for (const { profile, discovery } of inventories)
    for (const model of discovery.models)
      addRoute(model.id, { binding: profile.tool, modelId: model.id, source: `binding:${profile.tool}` });

  for (const model of hostModels) {
    hostById.set(model.id, model);
    addRoute(model.id, { binding: "host-native", modelId: model.id, source: "host" });
  }

  const pool = [];
  const configuredIds = new Set();
  let declarationPriority = 0;
  for (const [name, entry] of Object.entries(cfg?.models ?? {})) {
    if (entry.enabled === false) continue;
    const id = entry.id ?? name;
    configuredIds.add(id);
    const host = hostById.get(id) ?? {};
    pool.push({
      shortName: name,
      id,
      family: entry.family ?? host.family,
      tags: entry.tags ?? host.tags ?? [],
      context: entry.context ?? host.context,
      cost: entry.cost,
      priority: entry.priority ?? declarationPriority++,
      effort: entry.effort,
      group: independenceGroup(id),
      registryBinding: entry.binding,
      routes: [...(routesById.get(id) ?? [])],
      sources: ["registry", ...new Set((routesById.get(id) ?? []).map((route) => route.source))],
    });
  }

  for (const [id, routes] of routesById) {
    if (configuredIds.has(id)) continue;
    const host = hostById.get(id) ?? {};
    pool.push({
      shortName: shortName(id),
      id,
      family: host.family,
      tags: host.tags ?? [],
      context: host.context,
      cost: undefined,
      priority: declarationPriority++,
      effort: undefined,
      group: independenceGroup(id),
      registryBinding: undefined,
      sources: [...new Set(routes.map((route) => route.source))],
      routes: [...routes],
    });
  }
  return pool;
}
```

Remove every read of `role.binding`. In `autoPick`, select routes with `model.registryBinding`. In explicit `use` resolution, set `lastBindingPin = model.registryBinding ?? null`. Keep default route choice `host-native` first in `auto` mode after applying `runtime.subagents`.

Make `opResolve` async:

```js
export async function opResolve({ hostModels = [], overrides = {} } = {}) {
  if (!state.loaded) return { error: "call moa_load first" };
  const invalidHost = hostModels.find((model) => !CANONICAL_MODEL_ID.test(model.id));
  if (invalidHost)
    return errorResult("invalid_model_id", `host model '${invalidHost.id}' is not canonical`);

  const { config: cfg } = state.loaded;
  const { bindings } = loadBindings();
  const discovered = await discoverBindingInventories(bindings);
  const pool = candidatePool(cfg, discovered.inventories, hostModels);
```

Retain the existing role loop and effective-config write, with these exact changes:

- initialize `diagnostics` from `discovered.diagnostics`;
- never inspect `role.binding`;
- resolve an explicit alias before a same-ID adaptive candidate by preserving pool declaration order;
- use the selected candidate's `registryBinding` as the sole pin;
- retain `blocked_no_binding`, including the model binding in its hint;
- for configless mode, save `state.resolved = { pool, roles: {} }` and return the live pool;
- do not write the full pool or discoveries into `effective-config.json`.

Add tests proving:

```js
await ta("resolve: queries tools directly and observes additions and removals", async () => {
  const repo = writeRouteRepo("live-resolve", "external", "fakecli");
  opLoad({ cwd: repo });
  let result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker.model, CANONICAL_FAKE_MODEL);

  writeInventory("fakecli", ["vendor/other-9"]);
  result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker, undefined);
  assert.equal(result.diagnostics.find((item) => item.role === "worker").state, "blocked_no_binding");
});

await ta("resolve: duplicate aliases keep separate bindings but one identity", async () => {
  await opBindingSave({ profile: provenProfile({ tool: "route-a" }) });
  await opBindingSave({ profile: provenProfile({ tool: "route-b" }) });
  const repo = path.join(TMP, "duplicate-aliases");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  fake-a: { id: vendor/fake-9, family: fake, binding: route-a }
  fake-b: { id: vendor/fake-9, family: fake, binding: route-b }
roles:
  producer: { use: [fake-a] }
  verifier: { use: [fake-b], differentModelFrom: producer }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [] });
  assert.equal(result.roles.producer.binding, "route-a");
  assert.equal(result.roles.verifier, undefined);
  assert.equal(result.diagnostics.find((item) => item.role === "verifier").state, "blocked_no_model");
});

await ta("resolve: adaptive-bare includes current external models", async () => {
  const bare = path.join(TMP, "adaptive-live");
  fs.mkdirSync(bare, { recursive: true });
  opLoad({ cwd: bare });
  const result = await opResolve({ hostModels: [] });
  assert.ok(result.pool.some((model) =>
    model.id === CANONICAL_FAKE_MODEL && model.routes.some((route) => route.binding === "fakecli")));
});
```

Change `writeRouteRepo` to accept `modelBinding` and emit it under the model entry:

```js
function writeRouteRepo(name, subagents = "auto", modelBinding = null) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: ${subagents}
models:
  fake:
    id: vendor/fake-9
    family: fake
    tags: [strong]
${modelBinding ? `    binding: ${modelBinding}\n` : ""}roles:
  worker:
    use: [fake]
pipelines: {}
`);
  return repo;
}
```

Delete the old role-binding resolution test; the schema rejection and model-binding diagnostics replace it.

- [ ] **Step 8: Revalidate the live inventory before external spawn**

In `opSpawn`, replace the stored `profile.models.some(...)` check with:

```js
const discovery = await discoverToolModels(profile, profile.resolvedBin);
if (discovery.error) return discovery;
if (!discovery.models.some((model) => model.id === resolved.model))
  return errorResult(
    "model_not_served",
    `registered tool '${resolved.binding}' no longer serves '${resolved.model}'`,
  );
```

Do not change the frozen manifest route and do not call `opResolve` from `opSpawn`.

Replace the existing model-drift test with file-backed inventory drift:

```js
await ta("spawn: reports live model drift without rerouting", async () => {
  const profile = runnableProfile({ tool: "fake-model-drift" });
  const { repo, run } = await startExternalRun(profile);
  writeInventory(profile.tool, ["vendor/other-9"]);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  assert.equal(result.code, "model_not_served");

  const manifest = JSON.parse(fs.readFileSync(path.join(
    repo, ".moa", "runs", run.runId, "manifest.json",
  ), "utf8"));
  assert.equal(manifest.resolved.worker.model, CANONICAL_FAKE_MODEL);
});
```

Add one test where the inventory becomes malformed after run start and assert `model_discovery_parse_failed`; assert `opStepReport` still expects the original phase.

- [ ] **Step 9: Await live operations in the MCP contract and expose model binding in init**

Update public handlers:

```js
async () => json(await opTools())
async (args) => json(await opResolve(args))
async (args) => json(await opBindingSave(args))
```

Update descriptions:

- `moa_tools` executes registered live discovery and returns external models only.
- `moa_resolve` independently executes discovery; calling `moa_tools` first is optional.
- `moa_binding_save` validates live discovery and T1/T2/T4 before persistence.
- `moa_spawn` revalidates current model service before launch.

Add `binding` to the `moa_init.registry` input object:

```js
binding: z.string().optional().describe("optional exact route pin: host-native or learned tool name"),
```

Add an init test whose registry contains `{ id: "vendor/fake-9", binding: "fakecli" }`, then parse the written config and assert the binding survives `opLoad`.

- [ ] **Step 10: Run the complete deterministic suite**

Run:

```bash
cd moa-core/mcp && npm test
```

Expected: exit `0`; every test prints `ok`; the final line reports a nonzero check count and ends with `checks passed`. Confirm the suite includes live addition/removal, JSON/lines, canonical rejection, model-only binding, adaptive-bare routes, no persistence, process boundaries, and spawn-time drift.

- [ ] **Step 11: Commit the behavioral cutover**

```bash
git add moa-core/mcp/server.mjs moa-core/mcp/test.mjs moa-core/schema/config.schema.json
git commit -m "feat(mcp): resolve live tool model inventories"
```

---

### Task 2: Skill, Init, Templates, and Version Contract

**Files:**
- Modify: `moa-core/SKILL.md`
- Modify: `moa-core/references/learn-tool.md`
- Modify: `moa-core/references/init.md`
- Modify: `moa-core/references/adaptive.md`
- Modify: `moa-core/mcp/README.md`
- Modify: `moa-core/templates/solo-research.yml`
- Modify: `moa-core/templates/research-synth.yml`
- Modify: `moa-core/templates/lite-build.yml`
- Modify: `moa-core/templates/full-engineering.yml`
- Modify: `moa-core/templates/design.yml`
- Modify: `moa-core/mcp/server.mjs:1041-1140`
- Modify: `moa-core/mcp/package.json`
- Modify: `moa-core/mcp/package-lock.json`

**Interfaces:**
- Consumes: Task 1 async `moa_tools`, async `moa_resolve`, async `moa_binding_save`, required `modelDiscovery`, canonical IDs, and model-level `binding`.
- Produces: one consistent `0.8.0` public contract and learning/init procedure.

- [ ] **Step 1: Update the skill's conductor flow**

In `SKILL.md`:

- set frontmatter `version: 0.8.0`;
- state that `moa_tools` executes current external inventories and never reports them as native;
- state that `moa_resolve` performs its own discovery and intersects live routes with `.moa.yml` and `hostModels`;
- state that roles choose model aliases and only model entries may pin `binding`;
- state that `moa_spawn` revalidates the frozen model against the tool's current inventory;
- remove wording that says the server merges model catalogs stored in learned profiles;
- keep the launcher-agnostic rule: concrete command names belong only in profile data and examples under `learn-tool.md`.

Use this compact routing example:

```yaml
models:
  opus-via-omp:
    id: anthropic/claude-opus-4-8
    family: claude
    tags: [strong, vision]
    effort: [high]
    binding: omp
roles:
  planner:
    use: [opus-via-omp]
```

Explicitly prohibit `roles.planner.binding`.

- [ ] **Step 2: Rewrite the learned-profile procedure**

In `references/learn-tool.md`, replace the stored `models`/`listModels` profile sample with the approved `modelDiscovery` objects:

```yaml
modelDiscovery:
  argv: ["{bin}", models, --json]
  output:
    format: json
    listPath: models
    idPath: selector
  timeoutSeconds: 10
```

and:

```yaml
modelDiscovery:
  argv: ["{bin}", models]
  output:
    format: lines
  timeoutSeconds: 10
```

Document these exact learning rules:

1. begin with root `--help`, then inspect relevant subcommand help;
2. require a programmatic model-list operation;
3. require canonical IDs matching `^[^\s/]+/[^\s]+$`;
4. reject display-name inventories;
5. require model selection and T2 using an exact returned ID;
6. require safe prompt transport and T4;
7. submit the recipe through `moa_binding_save` for independent server execution;
8. persist no list output;
9. call `moa_tools` to observe the current inventory after binding;
10. relearn only when invocation/parser behavior changes, not when models are added or removed.

Replace the old staleness section: binary/version or invocation drift requires relearning; model-catalog drift does not, because inventory is live.

- [ ] **Step 3: Update init and adaptive behavior**

In `references/init.md`:

- replace direct reads of `profile.models` with a live `moa_tools` call;
- preserve the rule that `.moa.yml` contains only models selected by roles, never the full live inventory;
- record the chosen external route as `models.<alias>.binding` when the user pins a tool;
- never put a binding under a role;
- label host inventory and each learned-tool inventory separately;
- reject or omit noncanonical model IDs instead of normalizing display names;
- explain that one failed learned tool is skipped while healthy live/native routes remain.

In `references/adaptive.md`:

- change configless discovery from “host model pool” to the union of current `hostModels` and current live learned-tool routes;
- preserve no-write behavior: adaptive-bare discovery does not create `.moa.yml`, a profile inventory cache, or `effective-config.json`;
- unknown family/tags never claim cross-family verification.

- [ ] **Step 4: Update templates without adding model inventories**

In all five template comments, describe model entries as selected preferences with canonical `id` and optional `binding`. Keep `models: {}` empty.

Use this exact illustrative comment shape, adjusted only for each template's surrounding prose:

```yaml
# Init writes ONLY aliases selected by roles, never the full live inventory.
# Each entry uses a canonical provider/model id. Optional `binding` pins that model to
# `host-native` or one learned tool; roles select aliases through `use` and never pin tools.
models: {}
```

Do not add a real OMP, OpenCode, Agy, or Codex entry to a reusable template.

- [ ] **Step 5: Update MCP README and versioned public descriptions**

In `mcp/README.md`, update the operation table and flow:

- `moa_load`: profile metadata only; no inventory subprocess;
- `moa_tools`: live external discovery, no persistence;
- `moa_resolve`: independently live, exact route intersection;
- `moa_binding_save`: required discovery plus T1/T2/T4;
- `moa_spawn`: live frozen-model revalidation.

Add the native/external definitions and the model-only binding example. List the seven discovery errors from the spec.

Set exact versions:

```json
// moa-core/mcp/package.json
"version": "0.8.0"

// moa-core/mcp/package-lock.json, root package and packages[""]
"version": "0.8.0"
```

Set the MCP server constructor to:

```js
const server = new McpServer({ name: "moa", version: "0.8.0" });
```

Update its tool descriptions to match the README and await behavior from Task 1.

- [ ] **Step 6: Verify documentation/config integration**

Run:

```bash
cd moa-core/mcp && npm test
```

Expected: exit `0` and the final `checks passed` line.

Then inspect the active contract with the repository's content-search tool and require:

- no active `profile.models` read;
- no active `listModels` field;
- no `roles.<name>.binding` instruction;
- `0.8.0` in `SKILL.md`, MCP server, `package.json`, and both lockfile package records;
- `modelDiscovery` documented in `SKILL.md`, `learn-tool.md`, and `README.md`;
- model-level `binding` documented in the schema, skill, init guide, README, and templates.

References to obsolete fields are allowed only in the migration section and tests asserting rejection.

- [ ] **Step 7: Commit the synchronized public contract**

```bash
git add moa-core/SKILL.md moa-core/references/learn-tool.md moa-core/references/init.md moa-core/references/adaptive.md moa-core/mcp/README.md moa-core/templates moa-core/mcp/server.mjs moa-core/mcp/package.json moa-core/mcp/package-lock.json
git commit -m "docs(moa): publish live model discovery"
```

---

### Task 3: Installed-CLI Dogfood and Final Acceptance

**Files:**
- Verify only: `moa-core/mcp/server.mjs`
- Verify only: `moa-core/mcp/test.mjs`
- Verify only: `moa-core/SKILL.md`
- Verify only: `moa-core/references/learn-tool.md`
- Verify only: `moa-core/mcp/README.md`
- Temporary only: isolated `MOA_HOME`, scratch projects, and learned profiles outside the repository

**Interfaces:**
- Consumes: complete `0.8.0` MCP contract from Tasks 1–2.
- Produces: evidence that OMP and OpenCode can be learned, Agy and Codex are rejected for the designed reasons, inventories remain live, and native/external reporting is accurate.

- [ ] **Step 1: Run the deterministic acceptance suite from a clean process**

Run:

```bash
cd moa-core/mcp && npm test
```

Expected: exit `0`; every check passes; the final line reports a nonzero check count and ends with `checks passed`.

- [ ] **Step 2: Dogfood OMP discovery with an isolated MOA home**

Use a temporary `MOA_HOME` so the user's real learned-tool registry remains untouched. Follow `/moa learn-tool` from root help and subcommand help; the resulting profile must contain:

```yaml
modelDiscovery:
  argv: ["{bin}", "models", "--json"]
  output:
    format: json
    listPath: models
    idPath: selector
```

Acceptance:

- `moa_binding_save` accepts the profile only after live model discovery and T1/T2/T4 pass;
- saved YAML contains no `models:` inventory and no `listModels`;
- `moa_tools` returns OMP's current canonical selectors;
- changing the fake/live catalog changes the next result without relearning or restarting the MCP server;
- an OMP model reports `binding: omp`, never `host-native`.

- [ ] **Step 3: Dogfood OpenCode line discovery**

Learn OpenCode through `opencode --help` and `opencode models --help` using:

```yaml
modelDiscovery:
  argv: ["{bin}", "models"]
  output:
    format: lines
```

Acceptance:

- every returned line is canonical, such as `opencode/big-pickle`;
- T2 proves one exact returned ID;
- a `.moa.yml` model with `binding: opencode` resolves only while that exact ID appears in the current line inventory.

- [ ] **Step 4: Verify designed rejection of Agy and Codex**

Probe root and model-subcommand help for each tool.

Expected Agy result:

```text
tool_incompatible: model discovery returns display names, not canonical provider/model IDs
```

Expected Codex result:

```text
tool_incompatible: no programmatic model-list subcommand
```

Neither rejection writes a learned profile.

- [ ] **Step 5: Verify native/external classification and model-only binding end to end**

Create a scratch `.moa.yml` containing:

```yaml
schemaVersion: 1
runtime:
  subagents: auto
models:
  external-reviewer:
    id: anthropic/claude-opus-4-8
    family: claude
    tags: [strong]
    binding: omp
roles:
  reviewer:
    use: [external-reviewer]
pipelines: {}
```


Acceptance:

- `moa_load` accepts the config;
- `moa_resolve` routes `reviewer` through `omp` even if the same ID is host-native;
- removing that ID from the live OMP inventory yields `blocked_no_binding`;
- asking for native models returns only current `hostModels`/`host-native` routes;
- adding `binding` under `roles.reviewer` fails schema validation.

- [ ] **Step 6: Remove temporary dogfood state and record evidence in the execution report**

Delete only the isolated temporary `MOA_HOME` and scratch projects created by this task. Do not touch the user's actual `~/.moa/bindings` directory.

The execution report must record:

- deterministic suite exit code and final check count;
- OMP discovered model count and one canonical nonce-proven model ID;
- OpenCode discovered model count and one T2-proven canonical ID;
- Agy rejection reason;
- Codex rejection reason;
- native-only filtering result;
- confirmation that no inventory was persisted.

No commit is needed when verification passes without code changes. Any code change caused by dogfood must repeat Task 1's focused red/green test cycle, rerun the full deterministic suite, and receive its own conventional commit before final review.
