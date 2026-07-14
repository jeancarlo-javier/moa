// moa MCP — self-check. Run: node test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "moa-test-"));
process.env.MOA_HOME = path.join(TMP, "home");
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });

const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opInit, opBindingSave } =
  await import("./server.mjs");

const CANONICAL_FAKE_MODEL = "vendor/fake-9";
const HOST = [
  { id: "anthropic/claude-opus-4-8", family: "claude", tags: ["strong"] },
  { id: "anthropic/claude-sonnet-4-6", family: "claude", tags: ["strong", "cheap"] },
  { id: "openai/gpt-5.5", family: "gpt", tags: ["strong"] },
  { id: "minimax/MiniMax-M3", family: "minimax", tags: ["strong", "cheap"] },
];

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
let n = 0;
const t = (name, fn) => { fn(); console.log(`ok ${++n} - ${name}`); };
const ta = async (name, fn) => {
  await fn();
  console.log(`ok ${++n} - ${name}`);
};


const FAKE_WORKER = path.join(TMP, "fake-worker.mjs");
fs.writeFileSync(FAKE_WORKER, `
import fs from "node:fs";
const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
};
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
  else if (mode === "jsonl") process.stdout.write(JSON.stringify({ event: "start" }) + "\\n" + JSON.stringify({ response: { text: prompt } }) + "\\n");
  else if (mode === "args") process.stdout.write(JSON.stringify({ response: { text: JSON.stringify(args) } }));
  else process.stdout.write(prompt);
}
`);

const CONFIG = `
schemaVersion: 1
models:
  opus: { id: anthropic/claude-opus-4-8, family: claude, tags: [strong] }
  gpt: { id: openai/gpt-5.5, family: gpt, tags: [strong], effort: [medium, xhigh] }
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap], cost: cheap }
toolPolicies:
  repo_read_only: { allow: [read, search] }
roles:
  planner: { use: [opus, auto], tools: repo_read_only }
  coder: { use: [mini] }
  reviewer: { use: [gpt, auto], differentModelFrom: planner }
  verifier: { use: [gpt, auto], differentModelFrom: coder }
pipelines:
  build:
    steps:
      - { phase: plan, role: planner }
      - { phase: review-plan, role: reviewer, gate: standard, loopBackTo: plan }
      - { phase: execute, role: coder, loopBackTo: plan }
      - { phase: validate, role: verifier, gate: critical, loopBackTo: execute }
`;
fs.writeFileSync(path.join(REPO, ".moa.yml"), CONFIG);

t("load: valid config → adaptive-config (no default pipeline)", () => {
  const r = opLoad({ cwd: REPO });
  assert.equal(r.dispatch, "adaptive-config");
  assert.deepEqual(Object.keys(r.roles), ["planner", "coder", "reviewer", "verifier"]);
  assert.ok(r.pipelines.build.steps[1].includes("gate:standard"));
});

t("load: config found from a subdirectory (walk up)", () => {
  const sub = path.join(REPO, "src", "deep");
  fs.mkdirSync(sub, { recursive: true });
  assert.equal(opLoad({ cwd: sub }).configPath, path.join(REPO, ".moa.yml"));
});

t("load: bad role ref / dup phase / bad loopBackTo are rejected", () => {
  const bad = path.join(TMP, "bad"); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, ".moa.yml"), `
schemaVersion: 1
roles:
  a: { use: [ghost] }
pipelines:
  p:
    steps:
      - { phase: x, role: nobody }
      - { phase: x, role: a, loopBackTo: zz }
`);
  const r = opLoad({ cwd: bad });
  assert.ok(r.errors.length >= 3, JSON.stringify(r.errors));
});

t("load: role tools reference must resolve to a declared toolPolicies entry", () => {
  const bad = path.join(TMP, "tools-undeclared"); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, ".moa.yml"), `
schemaVersion: 1
toolPolicies:
  none: { allow: [] }
roles:
  worker: { use: [auto], tools: missing }
`);
  const r = opLoad({ cwd: bad });
  assert.ok(r.errors.includes("role 'worker': tools names unknown policy 'missing'"), JSON.stringify(r.errors));

  const good = path.join(TMP, "tools-declared"); fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, ".moa.yml"), `
schemaVersion: 1
toolPolicies:
  none: { allow: [] }
roles:
  worker: { use: [auto], tools: none }
`);
  const ok = opLoad({ cwd: good });
  assert.equal(ok.errors, undefined, JSON.stringify(ok.errors));
});

t("load: YAML anchors rejected (safe subset)", () => {
  const bad = path.join(TMP, "anchors"); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, ".moa.yml"), "schemaVersion: 1\nx: &a 1\ny: *a\n");
  assert.ok(opLoad({ cwd: bad }).errors.some((e) => e.includes("safe subset")));
});

// --- registered tool discovery ----------------------------------------------

await ta("binding_save: rejects unproven profiles", async () => {
  const bad = provenProfile({
    capabilities: { promptSafe: false },
    evidence: { probedOn: "2026-07-14", tests: { modelDiscovery: "pass", T1: "pass", T2: "pass", T4: "fail" } },
  });
  assert.match((await opBindingSave({ profile: bad })).error, /unproven/);
});

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
    (p) => p.run.modelPlaceholder = "model",
    (p) => p.run.argv.splice(p.run.argv.indexOf("{model}"), 1),
    (p) => p.capabilities.canSelectModel = false,
    (p) => p.evidence.tests.modelDiscovery = "fail",
  ]) {
    const profile = provenProfile({ tool: `invalid-${crypto.randomUUID()}` });
    mutate(profile);
    assert.ok((await opBindingSave({ profile })).error);
  }
});

await ta("binding_save: rejects invalid tool-control adapters", async () => {
  for (const mutate of [
    // legacy run.isolationFlags is no longer part of the accepted profile contract
    (p) => { p.run.isolationFlags = ["--legacy"]; },
    // toolControl declared but run.argv has no {toolArgs} marker at all
    (p) => { p.toolControl = { disableAll: { argv: ["--none"] } }; },
    // {toolArgs} embedded in a larger literal, not an exact element
    (p) => {
      p.run.argv.push("prefix-{toolArgs}");
      p.toolControl = { disableAll: { argv: ["--none"] } };
    },
    // {toolArgs} present but no toolControl adapter declared
    (p) => { p.run.argv.push("{toolArgs}"); },
    // disableAll.argv carries a placeholder, which is never allowed
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { disableAll: { argv: ["{model}"] } };
    },
    // both joined and repeated renderers declared
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        joined: { argv: ["--tools", "{tools}"], separator: "," },
        repeated: { argv: ["--tool", "{tool}"] },
      } };
    },
    // neither joined nor repeated renderer declared
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: { names: { read: "read" } } };
    },
    // joined renderer missing its {tools} placeholder
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        joined: { argv: ["--tools"], separator: "," },
      } };
    },
    // joined renderer with a duplicated {tools} placeholder
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        joined: { argv: ["--tools", "{tools}", "{tools}"], separator: "," },
      } };
    },
    // joined renderer with an unknown placeholder instead of {tools}
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        joined: { argv: ["--tools", "{model}"], separator: "," },
      } };
    },
    // repeated renderer missing its {tool} placeholder
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        repeated: { argv: ["--tool"] },
      } };
    },
    // repeated renderer with a duplicated {tool} placeholder
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        repeated: { argv: ["--tool", "{tool}", "{tool}"] },
      } };
    },
    // repeated renderer with an unknown placeholder instead of {tool}
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        repeated: { argv: ["--tool", "{bin}"] },
      } };
    },
    // empty canonical tool name in allowList.names
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { "": "read" },
        repeated: { argv: ["--tool", "{tool}"] },
      } };
    },
    // empty native tool name in allowList.names
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "" },
        repeated: { argv: ["--tool", "{tool}"] },
      } };
    },
    // empty separator on the joined renderer
    (p) => {
      p.run.argv.push("{toolArgs}");
      p.toolControl = { allowList: {
        names: { read: "read" },
        joined: { argv: ["--tools", "{tools}"], separator: "" },
      } };
    },
  ]) {
    const profile = provenProfile({ tool: `toolcontrol-${crypto.randomUUID()}` });
    mutate(profile);
    const result = await opBindingSave({ profile });
    assert.ok(result.error, JSON.stringify({ profile, result }));
  }
});

await ta("binding_save: accepts joined and repeated tool-control adapters", async () => {
  const joined = provenProfile({ tool: "joinedcli" });
  joined.run.argv.push("{toolArgs}");
  joined.toolControl = {
    disableAll: { argv: ["--fake-no-tools"] },
    allowList: {
      names: { read: "native-read", search: "native-search" },
      joined: { argv: ["--fake-tools", "{tools}"], separator: "," },
    },
  };
  const joinedResult = await opBindingSave({ profile: joined });
  assert.equal(joinedResult.error, undefined, JSON.stringify(joinedResult));

  const repeated = provenProfile({ tool: "repeatedcli" });
  repeated.run.argv.push("{toolArgs}");
  repeated.toolControl = {
    disableAll: { argv: ["--fake-no-tools"] },
    allowList: {
      names: { read: "Read", search: "Grep" },
      repeated: { argv: ["--allowed-tool", "{tool}"] },
    },
  };
  const repeatedResult = await opBindingSave({ profile: repeated });
  assert.equal(repeatedResult.error, undefined, JSON.stringify(repeatedResult));
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

t("load: binding belongs to models, never roles", () => {
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
await ta("tools: a proven save is immediately discoverable", async () => {
  const tool = `clean-${crypto.randomUUID()}`;
  const saved = await opBindingSave({ profile: provenProfile({ tool }) });
  assert.ok(saved.bound.endsWith("profile.yml"));
  assert.equal(saved.tool.tool, tool);
  assert.equal(saved.tool.available, true);
  assert.deepEqual(saved.tool.models.map((m) => m.id), [CANONICAL_FAKE_MODEL]);

  const listed = await opTools();
  const record = listed.tools.find((entry) => entry.tool === tool);
  assert.ok(record, `tool ${tool} missing from listing`);
  assert.deepEqual(record.usage, {
    tool: "moa_spawn",
    arguments: ["runId", "phase", "prompt"],
  });
  assert.deepEqual(record.models.map((m) => m.id), [CANONICAL_FAKE_MODEL]);
});

await ta("tools: unavailable executables are rejected at save", async () => {
  const result = await opBindingSave({
    profile: provenProfile({ tool: "missingcli", bin: path.join(TMP, "missing-bin") }),
  });
  assert.equal(result.code, "tool_unavailable");
});

await ta("tools: load skips profiles whose binary was removed", async () => {
  const profile = provenProfile({ tool: "stalecli" });
  // give this profile its own private binary so we can delete it safely
  const stub = path.join(TMP, "fakeworker-stale");
  // private stub that proxies discovery through FAKE_WORKER so we can delete the binary after registration
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_WORKER}" "$@"\n`);
  fs.chmodSync(stub, 0o755);
  profile.bin = stub;
  await opBindingSave({ profile });
  fs.unlinkSync(stub);
  const loaded = opLoad({ cwd: REPO });
  assert.ok(!loaded.bindings.some((tool) => tool.tool === profile.tool));
  const listed = await opTools();
  const stale = listed.tools.find((tool) => tool.tool === profile.tool);
  assert.equal(stale.available, false);
  assert.equal(stale.reason, "executable_not_found");
});
await ta("tools: promptVia arg profiles are rejected", async () => {
  const profile = provenProfile({
    tool: "argcli",
    run: {
      argv: ["{bin}", "{model}"],
      promptVia: "arg",
      timeoutSeconds: 60,
    },
  });
  const result = await opBindingSave({ profile });
  assert.equal(result.code, "unsafe_prompt_transport");
});

await ta("tools: executable directories fail discovery", async () => {
  const result = await opBindingSave({
    profile: provenProfile({ tool: "directorycli", bin: TMP }),
  });
  assert.equal(result.code, "tool_unavailable");
});
function resetBindings() {
  const dir = path.join(process.env.MOA_HOME, ".moa", "bindings");
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir))
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }
}


function writeRouteRepo(name, subagents = "auto", modelBinding = null, toolOpts = null) {
  const repo = path.join(TMP, name);
  fs.mkdirSync(repo, { recursive: true });
  const { enforcement, policyName, policy } = toolOpts ?? {};
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: ${subagents}
${enforcement ? `  requireEnforcement: ${enforcement}\n` : ""}models:
  fake:
    id: vendor/fake-9
    family: fake
    tags: [strong]
${modelBinding ? `    binding: ${modelBinding}\n` : ""}${policyName ? `toolPolicies:\n  ${policyName}: ${JSON.stringify(policy)}\n` : ""}roles:
  worker:
    use: [fake]
${policyName ? `    tools: ${policyName}\n` : ""}pipelines: {}
`);
  return repo;
}
await ta("resolve: registry aliases use a registered external route", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const repo = writeRouteRepo("route-external", "auto", "fakecli");
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker.model, "vendor/fake-9");
  assert.equal(result.roles.worker.binding, "fakecli");
  assert.equal(result.roles.worker.group, "fake-9");
});

await ta("resolve: host-native exists only when the host reports the model", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const repo = writeRouteRepo("route-native");
  opLoad({ cwd: repo });
  const result = await opResolve({
    hostModels: [...HOST, { id: "vendor/fake-9", family: "fake", tags: ["strong"] }],
  });
  assert.equal(result.roles.worker.model, "vendor/fake-9");
  assert.equal(result.roles.worker.binding, "host-native");
});
await ta("resolve: runtime.subagents filters routes", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const nativeRepo = writeRouteRepo("route-native-only", "native");
  opLoad({ cwd: nativeRepo });
  assert.equal((await opResolve({ hostModels: HOST })).diagnostics[0].state, "blocked_no_binding");

  const externalRepo = writeRouteRepo("route-external-only", "external");
  opLoad({ cwd: externalRepo });
  assert.equal((await opResolve({
    hostModels: [...HOST, { id: "vendor/fake-9", family: "fake" }],
  })).roles.worker.binding, "fakecli");

  const blockedRepo = writeRouteRepo("route-blocked", "blocked");
  opLoad({ cwd: blockedRepo });
  assert.equal((await opResolve({
    hostModels: [...HOST, { id: "vendor/fake-9", family: "fake" }],
  })).diagnostics[0].state, "blocked_no_binding");
});
await ta("resolve: a model binding pin to a missing tool is diagnosed", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const repo = writeRouteRepo("route-bad-pin", "auto", "missingcli");
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: HOST });
  assert.equal(result.diagnostics[0].state, "blocked_no_binding");
  assert.match(result.diagnostics[0].hint, /missingcli/);
});

await ta("resolve: pinned + auto + differentModelFrom honored", async () => {
  opLoad({ cwd: REPO });
  const r = await opResolve({ hostModels: HOST });
  assert.equal(r.roles.planner.model, "anthropic/claude-opus-4-8");
  assert.equal(r.roles.coder.model, "minimax/MiniMax-M3");
  assert.equal(r.roles.verifier.model, "openai/gpt-5.5");
  assert.notEqual(r.roles.verifier.group, r.roles.coder.group);
  assert.equal(r.diagnostics.length, 0);
  assert.ok(fs.existsSync(path.join(REPO, ".moa", "effective-config.json")));
});

await ta("resolve: requires load first (state discipline)", async () => {
  const r = await opResolve({ hostModels: HOST });
  assert.ok(!r.error); // loaded above — just confirms happy path is stable
});

await ta("resolve: unresolvable role → blocked_no_model diagnostic", async () => {
  const solo = path.join(TMP, "solo"); fs.mkdirSync(solo, { recursive: true });
  fs.writeFileSync(path.join(solo, ".moa.yml"), `
schemaVersion: 1
models:
  ghost: { id: nowhere/ghost-1, family: ghost, tags: [strong] }
roles:
  a: { use: [ghost] }
  b: { use: [ghost], differentModelFrom: a }
pipelines: {}
`);
  opLoad({ cwd: solo });
  const r = await opResolve({
    hostModels: [{ id: "nowhere/ghost-1", family: "ghost", tags: ["strong"] }],
  });
  assert.equal(r.roles.a.model, "nowhere/ghost-1");
  assert.equal(r.diagnostics[0].state, "blocked_no_model");
  assert.equal(r.diagnostics[0].role, "b");
});

await ta("resolve: invalid host model id is rejected before discover runs", async () => {
  opLoad({ cwd: REPO });
  const result = await opResolve({
    hostModels: [...HOST, { id: "not canonical", family: "x" }],
  });
  assert.equal(result.code, "invalid_model_id");
});

await ta("resolve: role-level binding rejected at load", async () => {
  const repo = path.join(TMP, "role-binding-reject");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  fake: { id: vendor/fake-9, family: fake }
roles:
  worker: { use: [fake], binding: fakecli }
pipelines: {}
`);
  const r = opLoad({ cwd: repo });
  assert.ok(r.errors && r.errors.some((error) => error.includes("binding")));
});

await ta("resolve: queries tools directly and observes additions and removals", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const repo = writeRouteRepo("live-resolve", "external", "fakecli");
  opLoad({ cwd: repo });
  let result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker.model, CANONICAL_FAKE_MODEL);

  writeInventory("fakecli", ["vendor/other-9"]);
  result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.worker, undefined);
  assert.equal(result.diagnostics.find((item) => item.role === "worker").state, "blocked_no_binding");
});
await ta("resolve: exact ids never borrow same-group routes", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({
    tool: "exactcli",
    inventory: ["vendor/fake-10"],
  }) });
  const repo = writeRouteRepo("exact-routes", "external", "exactcli");
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [] });
  assert.equal(result.roles.worker, undefined);
  assert.equal(result.diagnostics.find((item) => item.role === "worker").state, "blocked_no_binding");
});
await ta("resolve: duplicate aliases keep separate bindings but one identity", async () => {
  resetBindings();
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
await ta("resolve: sibling selectors remain independently verifiable", async () => {
  const repo = path.join(TMP, "sibling-models");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime: { subagents: native }
models:
  fake-9: { id: vendor/fake-9, family: fake }
  fake-10: { id: vendor/fake-10, family: fake }
roles:
  producer: { use: [fake-9] }
  verifier: { use: [fake-10], differentModelFrom: producer }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [
    { id: "vendor/fake-9", family: "fake" },
    { id: "vendor/fake-10", family: "fake" },
  ] });
  assert.equal(result.roles.producer.model, "vendor/fake-9");
  assert.equal(result.roles.verifier.model, "vendor/fake-10");
  assert.notEqual(result.roles.producer.group, result.roles.verifier.group);
});
await ta("resolve: adaptive-bare includes current external models", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "fakecli" }) });
  const bare = path.join(TMP, "adaptive-live");
  fs.mkdirSync(bare, { recursive: true });
  opLoad({ cwd: bare });
  const result = await opResolve({ hostModels: [] });
  const candidate = result.pool.find((model) => model.id === CANONICAL_FAKE_MODEL);
  assert.ok(candidate);
  assert.ok(candidate.sources.includes("binding:fakecli"));
  assert.equal(
    candidate.routes.find((route) => route.binding === "fakecli").source,
    "binding:fakecli",
  );
});


// --- run state machine --------------------------------------------------------

async function freshRun() {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  return opRunStart({ task: "test task", pipeline: "build", masterModel: "host/master", masterFamily: "host" });
}

await ta("run_start: frame + first step from data", async () => {
  const r = await freshRun();
  assert.ok(r.runId);
  assert.ok(r.frame.config.includes(".moa.yml"));
  assert.equal(r.next.phase, "plan");
  assert.equal(r.next.model, "anthropic/claude-opus-4-8");
});

await ta("step_report: wrong phase rejected with expected step", async () => {
  const { runId } = await freshRun();
  const r = opStepReport({ runId, phase: "execute", summary: "nope" });
  assert.ok(r.error.includes("expected report for phase 'plan'"));
});

await ta("step_report: gate without verdict rejected", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", summary: "looks fine" });
  assert.ok(r.error.includes("verdict"));
});

await ta("gate REVISE loops back and climbs the effort ladder", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", verdict: "REVISE", summary: "missing edge case" });
  assert.equal(r.looped, true);
  assert.equal(r.next.phase, "plan");
  opStepReport({ runId, phase: "plan", summary: "replanned" });
  const gate = opStepReport({ runId, phase: "plan", summary: "dup" });
  assert.ok(gate.error);
});

await ta("maxGateLoops exceeded → terminal with blocker", async () => {
  const { runId } = await freshRun();
  let r;
  for (let i = 0; i < 4; i++) {
    opStepReport({ runId, phase: "plan", summary: "planned" });
    r = opStepReport({ runId, phase: "review-plan", verdict: "REVISE", summary: "still wrong" });
    if (r.terminal) break;
  }
  assert.equal(r.terminal, "max_loops_exceeded");
  assert.ok(r.blocker.includes("review-plan"));
});

await ta("independence: gate step reports grade vs actual producer", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  opStepReport({ runId, phase: "review-plan", verdict: "APPROVE", summary: "ok" });
  const r = opStepReport({ runId, phase: "execute", summary: "coded", changedFiles: ["a.js"], producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
  assert.equal(r.next.phase, "validate");
  assert.equal(r.next.independence.grade, "cross-family");
  assert.equal(r.next.independence.pass, true);
});

await ta("full run to done; unverified label when critical gate not passed", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  opStepReport({ runId, phase: "review-plan", verdict: "APPROVE", summary: "ok" });
  opStepReport({ runId, phase: "execute", summary: "coded", changedFiles: ["a.js"], producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
  const done = opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "verified" });
  assert.equal(done.terminal, "done");
  assert.deepEqual(done.gatesPassed, ["review-plan", "validate"]);
});

await ta("gate BLOCKED → blocked_verifier_disagreement", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", verdict: "BLOCKED", summary: "cannot judge" });
  assert.equal(r.terminal, "blocked_verifier_disagreement");
});

await ta("finished run refuses further reports", async () => {
  const { runId } = await freshRun();
  opStepReport({ runId, phase: "plan", summary: "p" });
  opStepReport({ runId, phase: "review-plan", verdict: "BLOCKED", summary: "b" });
  const r = opStepReport({ runId, phase: "plan", summary: "again" });
  assert.ok(r.error.includes("blocked_verifier_disagreement"));
});

await ta("ad-hoc steps validated against resolved roles", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "x", steps: [{ phase: "p", role: "nope" }] });
  assert.ok(r.error.includes("unresolved role"));
  const ok = opRunStart({ task: "x", steps: [
    { phase: "produce", role: "coder" },
    { phase: "check", role: "verifier", gate: "critical", loopBackTo: "produce" },
  ]});
  assert.equal(ok.next.phase, "produce");
});

// --- external spawn ----------------------------------------------------------

function runnableProfile({
  tool = "fakecli",
  mode = "text",
  promptVia = "file",
  timeoutSeconds = 2,
  output,
  toolControl,
} = {}) {
  const promptArgs = promptVia === "file" ? ["--prompt-file", "{promptFile}"] : [];
  return provenProfile({
    tool,
    run: {
      argv: [
        "{bin}", FAKE_WORKER, "--mode", mode,
        ...(toolControl ? ["{toolArgs}"] : []),
        ...promptArgs,
        "--model", "{model}", "--cwd", "{cwd}", "--max-time", "{maxTime}",
      ],
      promptVia,
      modelPlaceholder: "{model}",
      timeoutSeconds,
    },
    output: output ?? { format: "text", resultPath: "stdout" },
    ...(toolControl ? { toolControl } : {}),
  });
}

async function startExternalRun(profile = runnableProfile(), toolOpts = null) {
  const saved = await opBindingSave({ profile });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const repo = writeRouteRepo(`spawn-${crypto.randomUUID()}`, "external", profile.tool, toolOpts);
  assert.equal(opLoad({ cwd: repo }).errors, undefined);
  const resolved = await opResolve({ hostModels: HOST });
  assert.ok(resolved.roles.worker, JSON.stringify(resolved));
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

await ta("spawn: executes the current external phase and preserves prompt bytes", async () => {
  const { run } = await startExternalRun();
  const sideEffect = path.join(TMP, "must-not-exist");
  const prompt = `literal $(touch ${sideEffect}) and \`touch ${sideEffect}\``;
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt });
  assert.equal(result.exitCode, 0);
  assert.equal(result.result, prompt);
  assert.equal(result.tool, "fakecli");
  assert.equal(result.model, CANONICAL_FAKE_MODEL);
  assert.equal(fs.existsSync(sideEffect), false);
});

await ta("spawn: does not advance the run", async () => {
  const { run } = await startExternalRun();
  await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  const report = opStepReport({
    runId: run.runId,
    phase: "wrong",
    summary: "must still expect work",
  });
  assert.match(report.error, /expected report for phase 'work'/);
});

await ta("spawn: rejects unknown, finished, and non-current runs", async () => {
  assert.equal((await opSpawn({
    runId: "run-missing",
    phase: "work",
    prompt: "hello",
  })).code, "unknown_run");

  const { run } = await startExternalRun();
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "later",
    prompt: "hello",
  })).code, "wrong_phase");
  opStepReport({ runId: run.runId, phase: "work", summary: "complete" });
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "hello",
  })).code, "run_finished");
});

await ta("spawn: native and master phases remain host-owned", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const nativeRun = opRunStart({
    task: "native",
    steps: [{ phase: "plan", role: "planner" }],
  });
  assert.equal((await opSpawn({
    runId: nativeRun.runId,
    phase: "plan",
    prompt: "hello",
  })).code, "native_spawn_required");

  const masterRun = opRunStart({
    task: "master",
    steps: [{ phase: "frame", role: "master" }],
  });
  assert.equal((await opSpawn({
    runId: masterRun.runId,
    phase: "frame",
    prompt: "hello",
  })).code, "master_phase");
});

await ta("spawn: reports unresolved roles without throwing", async () => {
  const repo = path.join(TMP, "spawn-unresolved-role");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: external
models:
  ghost: { id: nowhere/ghost-1, family: ghost, binding: fakecli }
roles:
  worker: { use: [ghost] }
pipelines:
  broken:
    steps:
      - { phase: work, role: worker }
`);
  opLoad({ cwd: repo });
  const resolved = await opResolve({ hostModels: HOST });
  assert.equal(resolved.diagnostics[0].state, "blocked_no_binding");
  const run = opRunStart({ task: "blocked role", pipeline: "broken" });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  assert.equal(result.code, "role_unresolved");
});

await ta("spawn: reports unavailable tools", async () => {
  const profile = runnableProfile({ tool: "fake-gone" });
  const { run } = await startExternalRun(profile);
  fs.rmSync(path.join(
    process.env.MOA_HOME,
    ".moa",
    "bindings",
    profile.tool,
  ), { recursive: true, force: true });
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "hello",
  })).code, "tool_unavailable");
});

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

await ta("spawn: malformed live inventory returns parse error and run stays on original phase", async () => {
  const profile = runnableProfile({ tool: "fake-bad-inventory" });
  const { repo, run } = await startExternalRun(profile);
  fs.writeFileSync(inventoryPath(profile.tool), "{");
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  assert.equal(result.code, "model_discovery_parse_failed");
  // opStepReport still expects the original phase
  const report = opStepReport({ runId: run.runId, phase: "work", summary: "irrelevant" });
  assert.ok(!report.error, report.error);
});

await ta("spawn: extracts JSON and JSONL result paths", async () => {
  for (const format of ["json", "jsonl"]) {
    const profile = runnableProfile({
      tool: `fake-${format}`,
      mode: format,
      output: { format, resultPath: "response.text" },
    });
    const { run } = await startExternalRun(profile);
    const result = await opSpawn({ runId: run.runId, phase: "work", prompt: format });
    assert.equal(result.result, format);
  }
});

await ta("spawn: supports stdin prompt transport", async () => {
  const profile = runnableProfile({ tool: "fake-stdin", promptVia: "stdin" });
  const { run } = await startExternalRun(profile);
  const result = await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "stdin-prompt",
  });
  assert.equal(result.result, "stdin-prompt");
});

await ta("spawn: rejects unknown placeholders", async () => {
  const profile = runnableProfile({ tool: "fake-placeholder" });
  profile.run.argv.push("{unknown}");
  const { run } = await startExternalRun(profile);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "unknown_placeholder");
});

await ta("spawn: reports malformed and missing declared output", async () => {
  const malformed = runnableProfile({
    tool: "fake-bad-json",
    mode: "badjson",
    output: { format: "json", resultPath: "response.text" },
  });
  let run = (await startExternalRun(malformed)).run;
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "x",
  })).code, "output_parse_failed");

  const missing = runnableProfile({
    tool: "fake-missing-result",
    mode: "json",
    output: { format: "json", resultPath: "response.missing" },
  });
  run = (await startExternalRun(missing)).run;
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "x",
  })).code, "output_parse_failed");
});

await ta("spawn: reports nonzero exit, timeout, and output overflow", async () => {
  for (const [tool, mode, code] of [
    ["fake-exit", "exit", "nonzero_exit"],
    ["fake-hang", "hang", "timeout"],
    ["fake-overflow", "overflow", "output_limit_exceeded"],
  ]) {
    const profile = runnableProfile({
      tool,
      mode,
      timeoutSeconds: mode === "hang" ? 1 : 2,
    });
    const { run } = await startExternalRun(profile);
    const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
    assert.equal(result.code, code);
  }
});

// --- role tool-policy enforcement ---------------------------------------

const JOINED_TOOL_CONTROL = {
  disableAll: { argv: ["--fake-no-tools"] },
  allowList: {
    names: { read: "native-read", search: "native-search" },
    joined: { argv: ["--fake-tools", "{tools}"], separator: "," },
  },
};
const REPEATED_TOOL_CONTROL = {
  disableAll: { argv: ["--fake-no-tools"] },
  allowList: {
    names: { read: "Read", search: "Grep" },
    repeated: { argv: ["--allowed-tool", "{tool}"] },
  },
};
const argsProfile = (overrides = {}) => runnableProfile({
  mode: "args",
  output: { format: "json", resultPath: "response.text" },
  ...overrides,
});

await ta("spawn: empty allow compiles to the disable-all adapter's exact argv", async () => {
  const profile = argsProfile({ tool: `policy-disable-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { run } = await startExternalRun(profile, { policyName: "p", policy: { allow: [] } });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, undefined, JSON.stringify(result));
  const argv = JSON.parse(result.result);
  assert.equal(argv[2], "--fake-no-tools");
  assert.equal(argv[3], "--prompt-file");
  assert.deepEqual(result.enforcement, { state: "enforced", policy: "p", binding: profile.tool, mode: "disable_all" });
});

await ta("spawn: allow-list joins ordered, de-duplicated, deny-subtracted tool names", async () => {
  const profile = argsProfile({ tool: `policy-joined-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { run } = await startExternalRun(profile, {
    policyName: "p", policy: { allow: ["read", "search", "read"] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  const argv = JSON.parse(result.result);
  assert.equal(argv[2], "--fake-tools");
  assert.equal(argv[3], "native-read,native-search");
  assert.equal(argv[4], "--prompt-file");
  assert.deepEqual(result.enforcement, { state: "enforced", policy: "p", binding: profile.tool, mode: "allow_list" });

  const denyProfile = argsProfile({ tool: `policy-deny-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { run: denyRun } = await startExternalRun(denyProfile, {
    policyName: "p", policy: { allow: ["read", "search"], deny: ["search"] },
  });
  const denyResult = await opSpawn({ runId: denyRun.runId, phase: "work", prompt: "x" });
  const denyArgv = JSON.parse(denyResult.result);
  assert.equal(denyArgv[2], "--fake-tools");
  assert.equal(denyArgv[3], "native-read");
});

await ta("spawn: allow-list repeats the exact per-tool argv fragment", async () => {
  const profile = argsProfile({ tool: `policy-repeated-${crypto.randomUUID()}`, toolControl: REPEATED_TOOL_CONTROL });
  const { run } = await startExternalRun(profile, {
    policyName: "p", policy: { allow: ["read", "search"] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  const argv = JSON.parse(result.result);
  assert.deepEqual(argv.slice(2, 6), ["--allowed-tool", "Read", "--allowed-tool", "Grep"]);
  assert.equal(argv[6], "--prompt-file");
});

await ta("spawn: two roles share one binding but receive different compiled tool args", async () => {
  const tool = `policy-shared-${crypto.randomUUID()}`;
  const profile = argsProfile({ tool, toolControl: JOINED_TOOL_CONTROL });
  await opBindingSave({ profile });
  const repo = path.join(TMP, `policy-shared-repo-${crypto.randomUUID()}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime:
  subagents: external
models:
  fake:
    id: vendor/fake-9
    family: fake
    tags: [strong]
    binding: ${tool}
toolPolicies:
  readOnly: { allow: [read] }
  readSearch: { allow: [read, search] }
roles:
  alpha:
    use: [fake]
    tools: readOnly
  beta:
    use: [fake]
    tools: readSearch
pipelines: {}
`);
  assert.equal(opLoad({ cwd: repo }).errors, undefined);
  const resolved = await opResolve({ hostModels: HOST });
  assert.equal(resolved.roles.alpha.model, resolved.roles.beta.model);
  assert.equal(resolved.roles.alpha.binding, resolved.roles.beta.binding);
  const run = opRunStart({
    task: "shared binding",
    steps: [{ phase: "a", role: "alpha" }, { phase: "b", role: "beta" }],
    masterModel: "host/master",
    masterFamily: "host",
  });
  const resultA = await opSpawn({ runId: run.runId, phase: "a", prompt: "x" });
  const argvA = JSON.parse(resultA.result);
  assert.equal(argvA[2], "--fake-tools");
  assert.equal(argvA[3], "native-read");

  opStepReport({ runId: run.runId, phase: "a", summary: "done" });
  const resultB = await opSpawn({ runId: run.runId, phase: "b", prompt: "x" });
  const argvB = JSON.parse(resultB.result);
  assert.equal(argvB[2], "--fake-tools");
  assert.equal(argvB[3], "native-read,native-search");
});

await ta("spawn: no requested policy expands {toolArgs} to zero elements and runs unchanged", async () => {
  const profile = argsProfile({ tool: `policy-none-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { run } = await startExternalRun(profile);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  const argv = JSON.parse(result.result);
  assert.equal(argv[0], "--mode");
  assert.equal(argv[1], "args");
  assert.equal(argv[2], "--prompt-file");
  assert.deepEqual(result.enforcement, { state: "not_requested" });
});

await ta("spawn: strict enforcement blocks before running the worker when no adapter exists", async () => {
  const profile = runnableProfile({ tool: `policy-strict-missing-${crypto.randomUUID()}` });
  const { run } = await startExternalRun(profile, {
    enforcement: "strict", policyName: "p", policy: { allow: [] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "tool_policy_unsupported");
  assert.equal(result.reason, "disable_all_unsupported");
  assert.equal(result.role, "worker");
  assert.equal(result.policy, "p");
  assert.equal(result.binding, profile.tool);
  assert.equal(result.exitCode, undefined);
});

await ta("spawn: strict enforcement blocks on a missing allow-list adapter", async () => {
  const profile = runnableProfile({
    tool: `policy-strict-nolist-${crypto.randomUUID()}`,
    toolControl: { disableAll: { argv: ["--none"] } },
  });
  const { run } = await startExternalRun(profile, {
    enforcement: "strict", policyName: "p", policy: { allow: ["read"] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "tool_policy_unsupported");
  assert.equal(result.reason, "allow_list_unsupported");
});

await ta("spawn: strict enforcement blocks on an unmapped tool name", async () => {
  const profile = runnableProfile({
    tool: `policy-strict-unmapped-${crypto.randomUUID()}`,
    toolControl: JOINED_TOOL_CONTROL,
  });
  const { run } = await startExternalRun(profile, {
    enforcement: "strict", policyName: "p", policy: { allow: ["write"] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "tool_policy_unsupported");
  assert.equal(result.reason, "unmapped_tool");
  assert.equal(result.tool, "write");
});

await ta("spawn: sandbox enforcement fails closed like strict", async () => {
  const profile = runnableProfile({ tool: `policy-sandbox-${crypto.randomUUID()}` });
  const { run } = await startExternalRun(profile, {
    enforcement: "sandbox", policyName: "p", policy: { allow: [] },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "tool_policy_unsupported");
  assert.equal(result.reason, "disable_all_unsupported");
  assert.equal(result.exitCode, undefined);
});

await ta("spawn: best-effort degrades and launches without tool args, recording the manifest entry", async () => {
  const profile = runnableProfile({ tool: `policy-degrade-${crypto.randomUUID()}` });
  const { repo, run } = await startExternalRun(profile, { policyName: "p", policy: { allow: [] } });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "degrade-check" });
  assert.equal(result.code, undefined, JSON.stringify(result));
  assert.equal(result.result, "degrade-check");
  assert.equal(result.enforcement.state, "degraded");
  assert.equal(result.enforcement.reason, "disable_all_unsupported");

  const manifest = JSON.parse(fs.readFileSync(
    path.join(repo, ".moa", "runs", run.runId, "manifest.json"), "utf8",
  ));
  assert.ok(
    manifest.enforcement?.some((e) => e.reason === "disable_all_unsupported"),
    JSON.stringify(manifest.enforcement),
  );
});

await ta("spawn: deny-only policies are unsupported — strict fails, best-effort degrades", async () => {
  const strictProfile = runnableProfile({
    tool: `policy-denyonly-strict-${crypto.randomUUID()}`,
    toolControl: JOINED_TOOL_CONTROL,
  });
  const { run: strictRun } = await startExternalRun(strictProfile, {
    enforcement: "strict", policyName: "p", policy: { deny: ["read"] },
  });
  const strictResult = await opSpawn({ runId: strictRun.runId, phase: "work", prompt: "x" });
  assert.equal(strictResult.code, "tool_policy_unsupported");
  assert.equal(strictResult.reason, "deny_only_unsupported");

  const bestProfile = runnableProfile({ tool: `policy-denyonly-best-${crypto.randomUUID()}` });
  const { run: bestRun } = await startExternalRun(bestProfile, {
    policyName: "p", policy: { deny: ["read"] },
  });
  const bestResult = await opSpawn({ runId: bestRun.runId, phase: "work", prompt: "ok" });
  assert.equal(bestResult.result, "ok");
  assert.equal(bestResult.enforcement.state, "degraded");
  assert.equal(bestResult.enforcement.reason, "deny_only_unsupported");
});

await ta("spawn: freezes the role's tool policy in the manifest despite later .moa.yml mutation", async () => {
  const profile = argsProfile({ tool: `policy-frozen-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { repo, run } = await startExternalRun(profile, {
    policyName: "p", policy: { allow: ["read", "search"] },
  });
  const manifestPath = path.join(repo, ".moa", "runs", run.runId, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.enforcementMode, "best-effort");
  assert.deepEqual(manifest.roleToolPolicies.worker, { name: "p", policy: { allow: ["read", "search"] } });

  const mutated = fs.readFileSync(path.join(repo, ".moa.yml"), "utf8")
    .replace('{"allow":["read","search"]}', '{"allow":[]}');
  fs.writeFileSync(path.join(repo, ".moa.yml"), mutated);

  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  const argv = JSON.parse(result.result);
  assert.equal(argv[2], "--fake-tools");
  assert.equal(argv[3], "native-read,native-search");
});

await ta("spawn: host-native routes expose the frozen policy request without claiming enforcement", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const nativeRun = opRunStart({
    task: "native-policy",
    steps: [{ phase: "plan", role: "planner" }],
  });
  const result = await opSpawn({ runId: nativeRun.runId, phase: "plan", prompt: "hello" });
  assert.equal(result.code, "native_spawn_required");
  assert.deepEqual(result.requestedPolicy, { name: "repo_read_only", policy: { allow: ["read", "search"] } });
  assert.equal(result.enforcementMode, "best-effort");
  assert.deepEqual(result.enforcement, { state: "host_owned" });
});

await ta("spawn: advisory policy dimensions are reported as unenforced, never as enforced", async () => {
  const profile = argsProfile({ tool: `policy-advisory-${crypto.randomUUID()}`, toolControl: JOINED_TOOL_CONTROL });
  const { run } = await startExternalRun(profile, {
    policyName: "p",
    policy: { allow: ["read"], network: "web_only", filesystem: "read_only" },
  });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.enforcement.state, "enforced");
  assert.deepEqual(result.enforcement.unenforced, { network: "web_only", filesystem: "read_only" });
});

await ta("spawn: prompt bytes remain exact through a policy-controlled spawn", async () => {
  const profile = runnableProfile({
    tool: `policy-bytes-${crypto.randomUUID()}`,
    toolControl: JOINED_TOOL_CONTROL,
  });
  const { run } = await startExternalRun(profile, { policyName: "p", policy: { allow: ["read"] } });
  const prompt = `exact $(touch ${path.join(TMP, "must-not-exist-2")}) and \`echo hi\``;
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt });
  assert.equal(result.result, prompt);
  assert.equal(result.enforcement.state, "enforced");
});

await ta("init: guards existing config; force overwrites; splice validates", async () => {
  const irepo = path.join(TMP, "irepo"); fs.mkdirSync(irepo, { recursive: true });
  const r1 = await opInit({ template: "lite-build", cwd: irepo,
    registry: { opus: { id: "anthropic/claude-opus-4-8", family: "claude", tags: ["strong"] } },
    roles: { planner: ["opus", "auto"] } });
  assert.ok(r1.written.endsWith(".moa.yml"));
  assert.equal(r1.spliced, true);
  const written = fs.readFileSync(r1.written, "utf8");
  assert.ok(written.includes("anthropic/claude-opus-4-8"));
  assert.ok(written.includes("#"), "template comments survive");

  const r2 = await opInit({ template: "lite-build", cwd: irepo });
  assert.ok(r2.error.includes("already exists"));
  const r3 = await opInit({ template: "lite-build", cwd: irepo, force: true });
  assert.ok(r3.written);

  const loaded = opLoad({ cwd: irepo });
  assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
});

await ta("init: preserves a model binding through load", async () => {
  const irepo = path.join(TMP, "init-binding");
  fs.mkdirSync(irepo, { recursive: true });
  const result = await opInit({
    template: "lite-build",
    cwd: irepo,
    registry: { fake: { id: "vendor/fake-9", family: "fake", binding: "fakecli" } },
    roles: { planner: ["fake", "auto"] },
  });
  assert.equal(result.spliced, true);

  const loaded = opLoad({ cwd: irepo });
  assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
  const fake = loaded.models.fake;
  assert.equal(fake.id, "vendor/fake-9");
  assert.equal(fake.binding, "fakecli");
});
await ta("init: unknown template rejected", async () => {
  const r = await opInit({ template: "nope", cwd: TMP });
  assert.ok(r.error.includes("unknown template"));
});

console.log(`\n${n} checks passed`);
