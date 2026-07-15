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
roles:
  planner: { use: [opus, auto], effort: [low, high] }
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

t("load: an empty roles map is rejected, matching the JSON schema", () => {
  // the JSON schema says minProperties: 1; zod must not quietly accept roles: {}
  const dir = path.join(TMP, "no-roles");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), "schemaVersion: 1\nroles: {}\n");
  assert.ok(opLoad({ cwd: dir }).errors, "roles: {} loaded without error");
});

t("load: every removed tool-policy key is rejected, not silently ignored", () => {
  // moa no longer tries to control a spawned CLI's tools, and no runtime default
  // below was ever read. The config schema is .strict(), so each must surface as an
  // unrecognized key rather than lull a user into thinking it still does something.
  const cases = [
    ["toolPolicies:\n  p: { allow: [read] }\n", "toolPolicies"],
    ["roles:\n  solo: { use: [auto], tools: p }\n", "tools"],
    ["roles:\n  solo: { use: [auto], skills: [git] }\n", "skills"],
    ["runtime:\n  requireEnforcement: strict\n", "requireEnforcement"],
    ["runtime:\n  defaults: { timeoutSeconds: 60 }\n", "timeoutSeconds"],
    ["runtime:\n  defaults: { maxParallel: 4 }\n", "maxParallel"],
    ["runtime:\n  defaults: { maxCost: 1 }\n", "maxCost"],
    ["runtime:\n  defaults: { maxTokens: 10 }\n", "maxTokens"],
    ["runtime:\n  defaults: { noExternalSkills: true }\n", "noExternalSkills"],
    ["runtime:\n  defaults: { noExternalExtensions: true }\n", "noExternalExtensions"],
    ["runtime:\n  defaults: { failOnUnknownTool: true }\n", "failOnUnknownTool"],
    ["runtime:\n  defaults: { allowInlineWithoutGates: true }\n", "allowInlineWithoutGates"],
  ];
  for (const [snippet, key] of cases) {
    const dir = path.join(TMP, `dead-${key}`);
    fs.mkdirSync(dir, { recursive: true });
    const base = snippet.startsWith("roles:") ? "" : "roles:\n  solo: { use: [auto] }\n";
    fs.writeFileSync(path.join(dir, ".moa.yml"), `schemaVersion: 1\n${base}${snippet}`);
    const errs = opLoad({ cwd: dir }).errors;
    assert.ok(errs, `'${key}' loaded without error — the key is back`);
    assert.ok(
      errs.some((e) => e.includes(key)),
      `'${key}' rejected but not named: ${JSON.stringify(errs)}`,
    );
  }
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
  // Assert each validator fired by name. A count (>= 3) passes with any one of them deleted —
  // this YAML trips four, so the check had a whole validator's worth of slack in it.
  const all = JSON.stringify(r.errors);
  for (const expected of [/ghost/, /nobody/, /duplicate phase 'x'/, /zz/])
    assert.match(all, expected);
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
await ta("binding_save: rejects legacy profile keys outside the strict contract", async () => {
  // The profile schema is .strict() on the top level and on `run`, so legacy
  // off-contract keys like run.isolationFlags and a top-level toolControl must
  // be refused at save time.
  const mutators = [
    (p) => { p.run.isolationFlags = ["--legacy"]; },
    (p) => { p.toolControl = { disableAll: { argv: ["--none"] } }; },
    (p) => { p.capabilities.toolRestriction = "observed-ignores"; },
  ];
  for (const mutate of mutators) {
    const profile = provenProfile({ tool: `legacy-${crypto.randomUUID()}` });
    mutate(profile);
    const result = await opBindingSave({ profile });
    assert.equal(
      result.code,
      "invalid_profile",
      JSON.stringify({ profile, result }),
    );
  }
});
await ta("binding_save: rejects run.argv placeholders spawn cannot expand", async () => {
  // Caught at save, not left to fail at every spawn with unknown_placeholder.
  // {toolArgs} is the dead tool-policy slot; {nope} stands for any typo.
  for (const bad of ["{toolArgs}", "prefix-{toolArgs}", "{nope}"]) {
    const profile = provenProfile({ tool: `ph-${crypto.randomUUID()}` });
    profile.run.argv.push(bad);
    const result = await opBindingSave({ profile });
    assert.equal(result.code, "invalid_profile", JSON.stringify({ bad, result }));
  }
  // ...while every placeholder opSpawn does expand still saves fine.
  const okProfile = provenProfile({ tool: `ph-ok-${crypto.randomUUID()}` });
  okProfile.run.argv.push("--cwd", "{cwd}", "--limit", "{maxTime}");
  const okResult = await opBindingSave({ profile: okProfile });
  assert.ok(!okResult.code, JSON.stringify(okResult));
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
  // A fresh module instance is the only way to see this guard: state.loaded is module-level
  // and every earlier check has already loaded. Asserting !error on the loaded module tested
  // the happy path under this name and would have passed with the guard deleted.
  const fresh = await import("./server.mjs?unloaded");
  assert.equal((await fresh.opResolve({ hostModels: HOST })).error, "call moa_load first");
  assert.ok(!(await opResolve({ hostModels: HOST })).error); // loaded here — still fine
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
  const run = await freshRun();
  // planner declares effort: [low, high] — rung 0 before any loop-back.
  assert.equal(run.next.effort, "low");
  opStepReport({ runId: run.runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId: run.runId, phase: "review-plan", verdict: "REVISE", summary: "missing edge case" });
  assert.equal(r.looped, true);
  assert.equal(r.next.phase, "plan");
  // the point of the loop-back: retry the same phase with more thinking.
  assert.equal(r.next.effort, "high");
  opStepReport({ runId: run.runId, phase: "plan", summary: "replanned" });
  const gate = opStepReport({ runId: run.runId, phase: "plan", summary: "dup" });
  assert.ok(gate.error);
});

await ta("effort ladder clamps at its top rung, never past the end", async () => {
  const run = await freshRun();
  opStepReport({ runId: run.runId, phase: "plan", summary: "planned" });
  let r = opStepReport({ runId: run.runId, phase: "review-plan", verdict: "REVISE", summary: "again" });
  assert.equal(r.next.effort, "high");
  opStepReport({ runId: run.runId, phase: "plan", summary: "replanned" });
  // second REVISE: loops = 2 but the ladder only has 2 rungs — stay on the top one.
  r = opStepReport({ runId: run.runId, phase: "review-plan", verdict: "REVISE", summary: "still" });
  assert.equal(r.looped, true);
  assert.equal(r.next.effort, "high");
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

// RUN_STATUS declares six statuses; before these two, a probe showed the suite only ever
// wrote four. done_unverified was reachable in production (an ungated pipeline whose worker
// writes a file) with nothing asserting it, and verification_unavailable needs strict mode,
// which no test config had.
await ta("mutation with no critical gate → done_unverified", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const { runId } = opRunStart({
    task: "gather facts into an artifact",
    steps: [{ phase: "gather", role: "coder" }],
    masterModel: "host/master", masterFamily: "host",
  });
  const r = opStepReport({
    runId, phase: "gather", summary: "wrote the artifact",
    changedFiles: ["research-facts.json"],
    producerModel: "minimax/MiniMax-M3", producerFamily: "minimax",
  });
  assert.equal(r.terminal, "done_unverified");
  assert.match(r.label, /mutated with no passed critical gate/);
});

await ta("ad-hoc steps reject duplicate phase names", async () => {
  // Config pipelines are loader-checked for this; ad-hoc steps were not. A duplicate name let
  // a gate:none phase inherit an earlier step's critical tier, and an ungated write finished 'done'.
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({
    task: "duplicate phase names",
    steps: [
      { phase: "check", role: "verifier", gate: "critical" },
      { phase: "execute", role: "coder" },
      { phase: "check", role: "coder" },
    ],
    masterModel: "host/master", masterFamily: "host",
  });
  assert.match(r.error, /duplicate phase 'check'/);
});

await ta("write landing after the last critical gate → done_unverified", async () => {
  // The floor is ordered: a gate can only vouch for what existed when it ran. This finished
  // as 'done' while b.js had passed no gate at all, because the check was two unordered
  // existence tests ("something mutated" AND "some critical gate approved").
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const { runId } = opRunStart({
    task: "write, gate, then write again",
    steps: [
      { phase: "execute", role: "coder" },
      { phase: "validate", role: "verifier", gate: "critical" },
      { phase: "execute2", role: "coder" },
    ],
    masterModel: "host/master", masterFamily: "host",
  });
  const mut = { producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" };
  opStepReport({ runId, phase: "execute", summary: "wrote a", changedFiles: ["a.js"], ...mut });
  opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "a.js is fine" });
  const r = opStepReport({ runId, phase: "execute2", summary: "wrote b after the gate", changedFiles: ["b.js"], ...mut });
  assert.equal(r.terminal, "done_unverified");
  assert.match(r.label, /covering the last change/);
});

await ta("a gate moa graded self-check cannot earn 'done'", async () => {
  // moa computed pass:false for these and then counted the APPROVE anyway, so the producer's
  // own model certified its own mutation and the run finished 'done' — the exact thing
  // references/anti-self-certification.md forbids. Auto mode still completes; it just cannot
  // claim the work was verified.
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const mut = { producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" };
  const runFloor = async (gateRole, gateReport) => {
    const { runId } = opRunStart({
      task: "self-certify",
      steps: [{ phase: "write", role: "coder" }, { phase: "check", role: gateRole, gate: "critical" }],
      masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
    });
    opStepReport({ runId, phase: "write", summary: "wrote x", changedFiles: ["x.js"], ...mut });
    return opStepReport({ runId, phase: "check", verdict: "APPROVE", summary: "lgtm", ...gateReport });
  };

  const own = await runFloor("coder", mut);           // producer grading itself
  assert.equal(own.terminal, "done_unverified");
  assert.match(own.label, /approved a change written by its own model/);

  // a provider alias is the same model wearing a different name — independenceGroup collapses it
  assert.equal((await runFloor("verifier", { producerModel: "bedrock/MiniMax-M3", producerFamily: "minimax" })).terminal,
    "done_unverified");

  // the master may route and reject, but it is never the final word on a gate
  assert.equal((await runFloor("master", { producerModel: "anthropic/claude-opus-4-8", producerFamily: "claude" })).terminal,
    "done_unverified");

  // and the legitimate path still earns it
  const real = await runFloor("verifier", { producerModel: "openai/gpt-5.5", producerFamily: "gpt" });
  assert.equal(real.terminal, "done", JSON.stringify(real));
});

await ta("a rework naming another model cannot launder the author's self-check", async () => {
  // Coverage was graded against the producing phase's LATEST report instead of against whoever
  // wrote the code still on disk. So a loop-back whose rework changed nothing but reported a
  // different model re-labelled the original author as independent, and the author's own
  // APPROVE of its own mutation finished 'done'.
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const mini = { producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" };
  const gpt = { producerModel: "openai/gpt-5.5", producerFamily: "gpt" };
  const { runId } = opRunStart({
    task: "launder",
    steps: [
      { phase: "execute", role: "coder" },
      { phase: "check", role: "coder", gate: "critical", loopBackTo: "execute" },
    ],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
  opStepReport({ runId, phase: "execute", summary: "mini wrote a.js", changedFiles: ["a.js"], ...mini });
  opStepReport({ runId, phase: "check", verdict: "REVISE", summary: "needs work", ...mini });
  opStepReport({ runId, phase: "execute", summary: "gpt looked, changed nothing", changedFiles: [], ...gpt });
  // a.js is still mini's code, so mini approving it is self-certification however it is routed
  const r = opStepReport({ runId, phase: "check", verdict: "APPROVE", summary: "lgtm", ...mini });
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
  assert.match(r.label, /approved a change written by its own model/);
});

await ta("the legitimate paths still earn 'done'", async () => {
  // The floor is only useful if honest work passes it. Both of these broke (or would have gone
  // unnoticed if broken) while the escapes above were being closed: verifying that a run CANNOT
  // cheat proves nothing if no test says which runs must succeed.
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const mini = { producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" };
  const gpt = { producerModel: "openai/gpt-5.5", producerFamily: "gpt" };

  // the master right-sizes the write and hands the check to an independent verifier. It names
  // no producerModel — moa knows its model from run_start, and without that fallback the write
  // reads as an unknown author that nothing can be independent of.
  const rs = opRunStart({
    task: "right-size",
    steps: [{ phase: "execute", role: "master" }, { phase: "validate", role: "verifier", gate: "critical" }],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
  opStepReport({ runId: rs.runId, phase: "execute", summary: "master wrote a.js itself", changedFiles: ["a.js"] });
  assert.equal(opStepReport({ runId: rs.runId, phase: "validate", verdict: "APPROVE", summary: "checked", ...gpt }).terminal,
    "done", "the master may author a write and hand the gate to an independent verifier");

  // a REVISE loop is not a failure: rework, then an independent APPROVE, still earns 'done'
  const lb = opRunStart({
    task: "rework",
    steps: [{ phase: "execute", role: "coder" },
            { phase: "validate", role: "verifier", gate: "critical", loopBackTo: "execute" }],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
  opStepReport({ runId: lb.runId, phase: "execute", summary: "v1", changedFiles: ["a.js"], ...mini });
  assert.equal(opStepReport({ runId: lb.runId, phase: "validate", verdict: "REVISE", summary: "bug", ...gpt }).to, "execute");
  opStepReport({ runId: lb.runId, phase: "execute", summary: "v2 reworked", changedFiles: ["a.js"], ...mini });
  assert.equal(opStepReport({ runId: lb.runId, phase: "validate", verdict: "APPROVE", summary: "fixed", ...gpt }).terminal,
    "done", "rework then an independent APPROVE is verified work");
});

await ta("two writers cannot cover for each other", async () => {
  // Coverage is per-author, not per-run: asking only whether the LAST write was covered let a
  // gate that is independent of the last writer certify an earlier write it made itself.
  // mini writes a.js, gpt writes b.js, mini gates — independent of gpt, but a.js is mini's own.
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const mini = { producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" };
  const gpt = { producerModel: "openai/gpt-5.5", producerFamily: "gpt" };
  const { runId } = opRunStart({
    task: "two writers",
    steps: [
      { phase: "write-a", role: "coder" },
      { phase: "write-b", role: "coder" },
      { phase: "check", role: "coder", gate: "critical" },
    ],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
  opStepReport({ runId, phase: "write-a", summary: "mini wrote a.js", changedFiles: ["a.js"], ...mini });
  opStepReport({ runId, phase: "write-b", summary: "gpt wrote b.js", changedFiles: ["b.js"], ...gpt });
  const r = opStepReport({ runId, phase: "check", verdict: "APPROVE", summary: "lgtm", ...mini });
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));

  // and a gate independent of BOTH writers covers the run
  const two = opRunStart({
    task: "two writers, real gate",
    steps: [
      { phase: "write-a", role: "coder" },
      { phase: "write-b", role: "coder" },
      { phase: "check", role: "coder", gate: "critical" },
    ],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
  opStepReport({ runId: two.runId, phase: "write-a", summary: "mini wrote a.js", changedFiles: ["a.js"], ...mini });
  opStepReport({ runId: two.runId, phase: "write-b", summary: "mini wrote b.js", changedFiles: ["b.js"], ...mini });
  assert.equal(opStepReport({ runId: two.runId, phase: "check", verdict: "APPROVE", summary: "ok", ...gpt }).terminal,
    "done");
});

await ta("no mutation, no gate → plain done ('done' is not a verification claim)", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const { runId } = opRunStart({
    task: "answer a read-only question",
    steps: [{ phase: "gather", role: "coder" }],
    masterModel: "host/master", masterFamily: "host",
  });
  const r = opStepReport({
    runId, phase: "gather", summary: "answered; wrote nothing",
    producerModel: "minimax/MiniMax-M3", producerFamily: "minimax",
  });
  assert.equal(r.terminal, "done");
  assert.deepEqual(r.gatesPassed, []);
});

await ta("strict mode + critical gate + no independent verifier → verification_unavailable", async () => {
  const srepo = path.join(TMP, "strict-repo");
  fs.mkdirSync(srepo, { recursive: true });
  fs.writeFileSync(path.join(srepo, ".moa.yml"), `
schemaVersion: 1
master:
  mode: strict
models:
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong] }
roles:
  coder: { use: [mini] }
  verifier: { use: [mini] }
pipelines:
  build:
    steps:
      - { phase: execute, role: coder }
      - { phase: validate, role: verifier, gate: critical }
`);
  opLoad({ cwd: srepo });
  await opResolve({ hostModels: HOST });
  const { runId } = opRunStart({ task: "t", pipeline: "build", masterModel: "host/master", masterFamily: "host" });
  // producer and verifier both resolve to mini → self-check → strict halts rather than pretend
  const r = opStepReport({
    runId, phase: "execute", summary: "coded", changedFiles: ["a.js"],
    producerModel: "minimax/MiniMax-M3", producerFamily: "minimax",
  });
  assert.equal(r.terminal, "verification_unavailable");
  assert.equal(r.step.independence.grade, "self-check");
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
} = {}) {
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
      modelPlaceholder: "{model}",
      timeoutSeconds,
    },
    output: output ?? { format: "text", resultPath: "stdout" },
  });
}

async function startExternalRun(profile = runnableProfile()) {
  const saved = await opBindingSave({ profile });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const repo = writeRouteRepo(`spawn-${crypto.randomUUID()}`, "external", profile.tool);
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

await ta("profile tampered with after save is skipped, never spawned", async () => {
  // A placeholder spawn cannot expand is refused at binding_save; loadBindings
  // re-checks every profile on every read, so hand-editing one onto disk after it
  // was proven gets it skipped rather than run with a literal '{unknown}' in argv.
  const profile = runnableProfile({ tool: "fake-placeholder" });
  const { run } = await startExternalRun(profile);
  const saved = path.join(
    process.env.MOA_HOME, ".moa", "bindings", "fake-placeholder", "profile.yml",
  );
  const doc = YAML.parse(fs.readFileSync(saved, "utf8"));
  doc.run.argv.push("{unknown}");
  fs.writeFileSync(saved, YAML.stringify(doc));

  assert.deepEqual(
    (await opTools()).skipped.find((s) => s.tool === "fake-placeholder"),
    { tool: "fake-placeholder", reason: "invalid_profile" },
  );
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "tool_unavailable", JSON.stringify(result));
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

await ta("spawn: prompt bytes remain exact through an external spawn", async () => {
  const profile = runnableProfile({ tool: `bytes-${crypto.randomUUID()}` });
  const { run } = await startExternalRun(profile);
  const prompt = `exact $(touch ${path.join(TMP, "must-not-exist-2")}) and \`echo hi\``;
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt });
  assert.equal(result.result, prompt);
});

await ta("init: each template inits and loads with zero errors", async () => {
  for (const template of [
    "solo-research",
    "research-synth",
    "lite-build",
    "full-engineering",
    "design",
  ]) {
    const irepo = path.join(TMP, `init-${template}`);
    fs.mkdirSync(irepo, { recursive: true });
    // pick a representative role + alias set per template so splice is exercised
    const seed = template === "solo-research" ? { role: "researcher", alias: "opus" } :
      template === "research-synth" ? { role: "gatherer", alias: "opus" } :
      template === "lite-build" ? { role: "planner", alias: "opus" } :
      template === "full-engineering" ? { role: "planner", alias: "opus" } :
      /* design */                { role: "design-consult", alias: "opus" };
    const r = await opInit({
      template,
      cwd: irepo,
      registry: { [seed.alias]: { id: "anthropic/claude-opus-4-8", family: "claude", tags: ["strong"] } },
      roles: { [seed.role]: [seed.alias, "auto"] },
    });
    assert.ok(r.written?.endsWith(".moa.yml"), JSON.stringify({ template, r }));
    assert.equal(r.spliced, true, JSON.stringify({ template, r }));
    const loaded = opLoad({ cwd: irepo });
    assert.ok(!loaded.errors, `${template}: ${JSON.stringify(loaded.errors)}`);
  }
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

// Every check above calls the ops in-process, so none of them sees the tool boundary:
// a param declared z.any() emits JSON Schema {} — no "type" — and MCP clients then
// transport it as a string, making the tool uncallable while the suite stays green.
// A real server process over real JSON-RPC is the only way to see what a client sees.
async function mcpClient({ cwd } = {}) {
  const { spawn } = await import("node:child_process");
  const srv = spawn("node", [path.join(import.meta.dirname, "server.mjs")], {
    stdio: ["pipe", "pipe", "ignore"], cwd,
  });
  let buf = "", id = 0;
  const pending = new Map();
  srv.stdout.on("data", (d) => {
    buf += d;
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m);
      pending.delete(m.id);
    }
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => reject(new Error(`${method} timed out`)), 10_000);
    pending.set(mid, (m) => { clearTimeout(timer); resolve(m); });
    srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
  });
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
  srv.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  return {
    list: async () => (await rpc("tools/list")).result.tools,
    // Returns what the server actually put on the wire, not an in-process return value.
    // isError alone does not mean the handler broke — json() sets it for ordinary refusals too
    // (server.mjs: isError: !!r?.error). What separates them is the shape: a refusal is JSON
    // carrying an {error} field, a thrown handler is a bare message that will not parse.
    // Matching on message text instead only catches the wordings you thought to list.
    call: async (name, args) => {
      const m = await rpc("tools/call", { name, arguments: args });
      if (m.error) return { _rpcError: m.error.message };
      const text = m.result?.content?.[0]?.text ?? "";
      try { return JSON.parse(text); }
      catch { return m.result?.isError ? { _threw: text } : { _raw: text }; }
    },
    stop: () => srv.kill(),
  };
}

await ta("tools/list: every param declares a JSON Schema type", async () => {
  const c = await mcpClient();
  const tools = await c.list().finally(() => c.stop());

  assert.ok(tools.length >= 8, `expected the full tool set, got ${tools.length}`);
  // Deliberately strict: a bare enum/const/combinator is not a declared type, and the
  // ambiguity is the whole bug. Every param carries a literal type today, so if a future
  // one does not, that should fail here and be thought about.
  const typed = (s) => s.type || s.$ref;
  for (const tool of tools)
    for (const [param, schema] of Object.entries(tool.inputSchema?.properties ?? {}))
      assert.ok(typed(schema), `${tool.name}.${param} has no JSON Schema type — clients will send it as a string`);

  // the regression that motivated this: profile must arrive as a real object
  const profile = tools.find((t) => t.name === "moa_binding_save").inputSchema.properties.profile;
  assert.equal(profile.type, "object");
  assert.deepEqual(profile.required.sort(),
    ["bin", "capabilities", "evidence", "modelDiscovery", "run", "tool"]);

  // Terminal states must be discoverable from the tool itself. When they were not, a
  // client invented a plausible-looking list (with 'revise' and 'blocked', neither real).
  const report = tools.find((t) => t.name === "moa_step_report").description;
  for (const status of ["done", "done_unverified", "max_loops_exceeded",
                        "blocked_verifier_disagreement", "verification_unavailable"])
    assert.ok(report.includes(`'${status}'`), `moa_step_report does not name '${status}'`);
  assert.ok(/REVISE loop is NOT a terminal state/.test(report));
});

// tools/list only proves a tool is advertised. This drives real runs through tools/call —
// the transport where a handler that throws, misroutes arguments or serializes wrong stays
// invisible to every in-process check above.
await ta("tools/call: gated runs over JSON-RPC — the floor holds at the boundary", async () => {
  const c = await mcpClient({ cwd: REPO });
  try {
    assert.ok(!(await c.call("moa_load", { cwd: REPO })).error);
    assert.ok(!(await c.call("moa_resolve", { hostModels: HOST })).error);
    const run = async (steps) => {
      const r = await c.call("moa_run_start", {
        task: "e2e", steps, masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude" });
      assert.ok(r.runId, `run_start failed over the wire: ${JSON.stringify(r)}`);
      return r.runId;
    };
    const wrote = (runId, phase) => c.call("moa_step_report", { runId, phase, summary: "wrote a.js",
      changedFiles: ["a.js"], producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });

    // an independent critical gate covering the write → the label moa exists to earn
    let runId = await run([{ phase: "execute", role: "coder" },
                           { phase: "validate", role: "verifier", gate: "critical" }]);
    await wrote(runId, "execute");
    const ok = await c.call("moa_step_report", { runId, phase: "validate", summary: "checked",
      verdict: "APPROVE", producerModel: "openai/gpt-5.5", producerFamily: "gpt" });
    assert.equal(ok.terminal, "done", JSON.stringify(ok));

    // the producer's own model grading its own mutation is self-certification, not a gate
    runId = await run([{ phase: "execute", role: "coder" },
                       { phase: "validate", role: "coder", gate: "critical" }]);
    await wrote(runId, "execute");
    const self = await c.call("moa_step_report", { runId, phase: "validate", summary: "lgtm",
      verdict: "APPROVE", producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
    assert.equal(self.terminal, "done_unverified", JSON.stringify(self));
    assert.match(self.label, /approved a change written by its own model/);
  } finally { c.stop(); }
});

// The run path above still left most of the toolset unproven over the wire — including
// moa_binding_save, the one tool whose schema bug started all this. A handler that throws or
// mis-transports its arguments must not be able to hide behind in-process tests.
await ta("tools/call: every advertised tool answers over the wire", async () => {
  const c = await mcpClient({ cwd: REPO });
  try {
    const advertised = (await c.list()).map((t) => t.name);
    const initDir = fs.mkdtempSync(path.join(TMP, "wire-init-"));
    // Each tool gets an argument AND a claim only its own handler could satisfy. "It did not
    // throw" would pass for a handler wired to the wrong op, or one that returns {}.
    const calls = {
      moa_load: [{ cwd: REPO }, (r) => assert.equal(r.configPath, path.join(REPO, ".moa.yml"))],
      moa_resolve: [{ hostModels: HOST }, (r) => assert.ok(r.roles.coder.model, JSON.stringify(r).slice(0, 120))],
      moa_tools: [{}, (r) => assert.ok(Array.isArray(r.tools), JSON.stringify(r).slice(0, 120))],
      // A real template — "nope" never reaches the handler at all, the schema enum rejects it
      // at the boundary. The proof it arrived is the config on disk.
      moa_init: [{ template: "lite-build", cwd: initDir },
        () => assert.ok(fs.existsSync(path.join(initDir, ".moa.yml")), "moa_init wrote no config")],
      // A real profile, so the handler actually RUNS: a stub is refused by the schema, which
      // proves the argument crossed the wire but nothing about the code behind it.
      moa_binding_save: [{ profile: provenProfile({ tool: "wirecli" }) },
        () => assert.ok(fs.existsSync(path.join(process.env.MOA_HOME, ".moa", "bindings", "wirecli", "profile.yml")),
          "moa_binding_save persisted no profile")],
      moa_run_start: [{ task: "wire", steps: [{ phase: "p", role: "coder" }] },
        (r) => assert.match(r.runId, /^run-/)],
      // these two must reach their op to know the run does not exist
      moa_step_report: [{ runId: "no-such-run", phase: "p", summary: "s" },
        (r) => assert.match(r.error, /unknown runId/)],
      moa_spawn: [{ runId: "no-such-run", phase: "p", prompt: "hi" },
        (r) => assert.match(JSON.stringify(r), /unknown_run|unknown runId/)],
    };
    assert.deepEqual(advertised.filter((t) => !(t in calls)), [], "a tool is advertised but never called here");
    for (const name of advertised) {
      const [args, expect] = calls[name];
      const r = await c.call(name, args);
      // Never acceptable: a transport failure, a thrown handler, or an argument arriving as the
      // wrong type. Then the tool-specific claim, which only the right handler can meet.
      assert.ok(!r._rpcError, `${name} failed at the transport: ${r._rpcError}`);
      assert.ok(!r._threw, `${name} threw instead of answering: ${r._threw?.slice(0, 160)}`);
      assert.ok(!/received string/i.test(JSON.stringify(r)),
        `${name} mis-transported its arguments: ${JSON.stringify(r).slice(0, 160)}`);
      expect(r);
    }
  } finally { c.stop(); }
});

console.log(`\n${n} checks passed`);
