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
const GLOBAL_CONFIG = path.join(process.env.MOA_HOME, ".moa", "config.yml");
const writeGlobal = (source) => {
  fs.mkdirSync(path.dirname(GLOBAL_CONFIG), { recursive: true });
  fs.writeFileSync(GLOBAL_CONFIG, source);
};
const clearGlobal = () => fs.rmSync(GLOBAL_CONFIG, { force: true });

const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opSpawnStatus, opSpawnCancel, opSpawnWait, opInit, opBindingSave } =
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

async function waitFor(check, { timeoutMs = 3000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}


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
  const readyFile = value("--ready-file");
  const releaseFile = value("--release-file");
  const countFile = value("--count-file");
  if (countFile) fs.appendFileSync(countFile, "launch\\n");
  if (mode === "wait") {
    if (!readyFile || !releaseFile) throw new Error("wait mode requires ready and release files");
    fs.writeFileSync(readyFile, String(process.pid));
    while (!fs.existsSync(releaseFile))
      await new Promise((resolve) => setTimeout(resolve, 10));
    process.stdout.write(prompt);
  }
  else if (mode === "exit") process.exit(7);
  else if (mode === "hang") setInterval(() => {}, 1000);
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

await ta("load: global-only config anchors adaptive mode to cwd", async () => {
  const cwd = path.join(TMP, "global-only");
  fs.mkdirSync(cwd, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, tags: [strong] }
roles:
  planner: { use: [g] }
`);
  try {
    const loaded = opLoad({ cwd });
    assert.equal(loaded.dispatch, "adaptive-config");
    assert.equal(loaded.configPath, GLOBAL_CONFIG);
    assert.deepEqual(loaded.configPaths, { global: GLOBAL_CONFIG, project: null });
    assert.deepEqual(Object.keys(loaded.roles), ["planner"]);
    const resolved = await opResolve({ hostModels: HOST });
    assert.equal(resolved.effectiveConfig, path.join(cwd, ".moa", "effective-config.json"));
  } finally {
    clearGlobal();
  }
});

t("load: global boundary rejects project policy keys with its path", () => {
  const cases = [
    ["pipelines", "pipelines: {}\n"],
    ["template", "template: { base: custom }\n"],
    ["master", "master: { mode: auto }\n"],
    ["runtime", "runtime: { subagents: auto }\n"],
    ["instructions", "roles:\n  planner: { use: [g], instructions: no }\n"],
    ["effort", "roles:\n  planner: { use: [g], effort: [xhigh] }\n"],
  ];
  try {
    for (const [key, extra] of cases) {
      const roles = extra.startsWith("roles:") ? "" : "roles:\n  planner: { use: [g] }\n";
      writeGlobal(`schemaVersion: 1\nmodels:\n  g: { id: openai/gpt-5.5 }\n${roles}${extra}`);
      const errors = opLoad({ cwd: path.join(TMP, "no-project") }).errors;
      assert.ok(errors, `${key} loaded in the global layer`);
      assert.match(errors.join("\n"), new RegExp(key));
      assert.ok(errors.every((error) => error.includes(GLOBAL_CONFIG)), JSON.stringify(errors));
      if (extra.startsWith("roles:"))
        assert.match(errors.join("\n"), /project \.moa\.yml/, `${key} error lacks the redirect hint`);
    }
  } finally {
    clearGlobal();
  }
});

await ta("load: project roles inherit global staffing without role union", async () => {
  const repo = path.join(TMP, "layered");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, family: gpt }
  shared: { id: anthropic/claude-opus-4-8, family: global, tags: [strong] }
roles:
  instructed: { use: [g], differentModelFrom: empty }
  empty: { use: [shared] }
  globalOnly: { use: [g] }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  shared: { id: minimax/MiniMax-M3 }
roles:
  instructed: { instructions: project-only }
  empty: {}
  direct: { use: [g] }
`);
  try {
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.roles.instructed, {
      use: ["g"],
      differentModelFrom: "empty",
      instructions: "project-only",
    });
    assert.deepEqual(loaded.roles.empty.use, ["shared"]);
    assert.deepEqual(loaded.roles.direct.use, ["g"]);
    assert.equal(loaded.roles.globalOnly, undefined);
    assert.deepEqual(loaded.models.shared, { id: "minimax/MiniMax-M3" });
    assert.deepEqual(loaded.configPaths, { global: GLOBAL_CONFIG, project: path.join(repo, ".moa.yml") });
    const resolved = await opResolve({ hostModels: HOST });
    assert.ok(!resolved.error, JSON.stringify(resolved));
    const run = opRunStart({ task: "layered", steps: [{ phase: "work", role: "direct" }] });
    assert.ok(run.frame.config.includes(GLOBAL_CONFIG));
    assert.ok(run.frame.config.includes(path.join(repo, ".moa.yml")));
  } finally {
    clearGlobal();
  }
});

t("load: a merged role with no use fails full validation", () => {
  const repo = path.join(TMP, "missing-use");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5 }
roles:
  staffed: { use: [g] }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), "schemaVersion: 1\nroles:\n  orphan: {}\n");
  try {
    const errors = opLoad({ cwd: repo }).errors;
    assert.ok(errors);
    assert.match(errors.join("\n"), /roles\.orphan\.use/);
    assert.ok(errors.every((error) => error.includes(path.join(repo, ".moa.yml"))));
  } finally {
    clearGlobal();
  }
});

t("load: global and project schema versions must match", () => {
  const repo = path.join(TMP, "version-mismatch");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal("schemaVersion: 1\nroles:\n  staffed: { use: [auto] }\n");
  fs.writeFileSync(path.join(repo, ".moa.yml"), "schemaVersion: 2\nroles:\n  staffed: { use: [auto] }\n");
  try {
    const errors = opLoad({ cwd: repo }).errors;
    assert.match(errors.join("\n"), /schemaVersion mismatch/);
    assert.match(errors.join("\n"), new RegExp(GLOBAL_CONFIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    clearGlobal();
  }
});

t("load: invalid global YAML masks a valid project", () => {
  const repo = path.join(TMP, "global-yaml-mask");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), "schemaVersion: 1\nroles:\n  local: { use: [auto] }\n");
  writeGlobal("schemaVersion: [\n");
  try {
    const result = opLoad({ cwd: repo });
    assert.equal(result.configPath, GLOBAL_CONFIG);
    assert.match(result.errors.join("\n"), new RegExp(GLOBAL_CONFIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(result.hint, /\/moa init --force/);
  } finally {
    clearGlobal();
  }
});

t("load: standalone global cycle cannot be masked by project overrides", () => {
  const repo = path.join(TMP, "global-cycle-mask");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5 }
roles:
  a: { use: [g], differentModelFrom: b }
  b: { use: [g], differentModelFrom: a }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
roles:
  a: { use: [g], differentModelFrom: c }
  b: { use: [g] }
  c: { use: [g] }
`);
  try {
    const result = opLoad({ cwd: repo });
    assert.equal(result.configPath, GLOBAL_CONFIG);
    assert.match(result.errors.join("\n"), /differentModelFrom cycle/);
    assert.match(result.errors.join("\n"), new RegExp(GLOBAL_CONFIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    clearGlobal();
  }
});

await ta("load: errors clear prior loaded and resolved state", async () => {
  opLoad({ cwd: REPO });
  assert.ok(!(await opResolve({ hostModels: HOST })).error);
  writeGlobal("schemaVersion: [\n");
  try {
    assert.ok(opLoad({ cwd: REPO }).errors);
    assert.equal((await opResolve({ hostModels: HOST })).error, "call moa_load first");
    assert.equal(opRunStart({ task: "stale", steps: [{ phase: "x", role: "master" }] }).error, "call moa_load first");
  } finally {
    clearGlobal();
  }
});

await ta("load: project-only provenance reaches effective config", async () => {
  clearGlobal();
  const projectPath = path.join(REPO, ".moa.yml");
  const loaded = opLoad({ cwd: REPO });
  assert.equal(loaded.configPath, projectPath);
  assert.deepEqual(loaded.configPaths, { global: null, project: projectPath });
  assert.equal("projectDir" in loaded, false);
  const result = await opResolve({ hostModels: HOST });
  const effective = JSON.parse(fs.readFileSync(result.effectiveConfig, "utf8"));
  assert.equal(effective.configPath, projectPath);
  assert.deepEqual(effective.configPaths, { global: null, project: projectPath });
});

t("load: project differentModelFrom cycles are rejected", () => {
  clearGlobal();
  const repo = path.join(TMP, "project-cycle");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
roles:
  a: { use: [auto], differentModelFrom: b }
  b: { use: [auto], differentModelFrom: a }
`);
  assert.match(opLoad({ cwd: repo }).errors.join("\n"), /differentModelFrom cycle/);
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
    start: { tool: "moa_spawn", arguments: ["runId", "phase", "prompt", "requestKey"] },
    wait: { tool: "moa_spawn_wait", arguments: ["runId", "spawnId", "waitMs"] },
    status: { tool: "moa_spawn_status", arguments: ["runId", "spawnId"] },
    cancel: { tool: "moa_spawn_cancel", arguments: ["runId", "spawnId"] },
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

await ta("resolve: typo'd registry id → unreachable + degraded diagnostics, role still resolves", async () => {
  resetBindings();
  // vendor/gpt-5.1 is raw-edit-distance CLOSER to the typo than the true token-swap
  // target vendor/gpt-5.6-sol — the suggestion must still pick the token-swap match
  await opBindingSave({ profile: provenProfile({ tool: "fakecli", inventory: ["vendor/gpt-5.1", "vendor/gpt-5.6-sol"] }) });
  const repo = path.join(TMP, "typo-id"); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  fake: { id: vendor/gpt-sol-5.6, family: fake, tags: [strong] }
roles:
  worker: { use: [fake, auto] }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const r = await opResolve({ hostModels: HOST });
  const unreachable = r.diagnostics.find((d) => d.state === "unreachable_registry_model");
  assert.equal(unreachable.model, "fake");
  assert.match(unreachable.hint, /did you mean 'vendor\/gpt-5\.6-sol'/);
  const degraded = r.diagnostics.find((d) => d.state === "degraded_resolution");
  assert.equal(degraded.role, "worker");
  assert.match(degraded.hint, /'fake' \(no eligible route\)/);
  assert.ok(r.roles.worker.model); // fell through to auto, but loudly
});

await ta("resolve: failed 'auto' before an explicit pick is reported as degraded", async () => {
  const repo = path.join(TMP, "auto-first"); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  weak: { id: vendor/weak-1, family: fake }
roles:
  gatekeeper: { use: [auto, weak] }
pipelines:
  p:
    steps:
      - { phase: validate, role: gatekeeper, gate: critical }
`);
  opLoad({ cwd: repo });
  // critical gate demands [strong]; the only model has no tags → auto fails, explicit 'weak' resolves
  const r = await opResolve({ hostModels: [{ id: "vendor/weak-1", family: "fake" }] });
  assert.equal(r.roles.gatekeeper.model, "vendor/weak-1");
  const degraded = r.diagnostics.find((d) => d.state === "degraded_resolution");
  assert.equal(degraded.role, "gatekeeper");
  assert.match(degraded.hint, /'auto' \(no eligible candidate\)/);
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

await ta("resolve: dependency chains use topological role order", async () => {
  const repo = path.join(TMP, "dependency-chain");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  one: { id: anthropic/claude-opus-4-8, cost: cheap }
  two: { id: openai/gpt-5.5, cost: standard }
  three: { id: minimax/MiniMax-M3, cost: premium }
roles:
  A: { use: [auto], differentModelFrom: B }
  B: { use: [auto], differentModelFrom: C }
  C: { use: [auto] }
`);
  assert.ok(!opLoad({ cwd: repo }).errors);
  const result = await opResolve({ hostModels: HOST });
  assert.deepEqual(Object.keys(result.roles), ["C", "B", "A"]);
  assert.notEqual(result.roles.C.model, result.roles.B.model);
  assert.notEqual(result.roles.B.model, result.roles.A.model);
});

await ta("resolve: failed independence target blocks its dependent", async () => {
  const repo = path.join(TMP, "failed-dependency");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  ghost: { id: nowhere/ghost-1 }
roles:
  producer: { use: [ghost] }
  verifier: { use: [auto], differentModelFrom: producer }
`);
  assert.ok(!opLoad({ cwd: repo }).errors);
  const result = await opResolve({ hostModels: HOST });
  assert.equal(result.roles.producer, undefined);
  assert.equal(result.roles.verifier, undefined);
  const blocked = result.diagnostics.find((diagnostic) => diagnostic.role === "verifier");
  assert.equal(blocked.state, "blocked_dependency");
  assert.equal(blocked.dependsOn, "producer");
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

await ta("run_start: ad-hoc critical roles enforce hard verification tags", async () => {
  const repo = path.join(TMP, "critical-floor");
  fs.mkdirSync(repo, { recursive: true });
  const configPath = path.join(repo, ".moa.yml");
  const writeConfig = (tags) => fs.writeFileSync(configPath, `
schemaVersion: 1
models:
  checker: { id: vendor/checker-1${tags ? `, tags: [${tags}]` : ""} }
roles:
  verifier: { use: [checker] }
`);
  const steps = [{ phase: "verify", role: "verifier", gate: "critical" }];

  writeConfig("");
  opLoad({ cwd: repo });
  await opResolve({ hostModels: [{ id: "vendor/checker-1" }] });
  const rejected = opRunStart({ task: "weak", steps });
  assert.match(rejected.error, /verifier/);
  assert.match(rejected.error, /override/);

  writeConfig("strong");
  opLoad({ cwd: repo });
  await opResolve({ hostModels: [{ id: "vendor/checker-1" }] });
  assert.ok(opRunStart({ task: "strong", steps }).runId);
});

// --- external spawn ----------------------------------------------------------

function runnableProfile({
  tool = "fakecli",
  mode = "text",
  promptVia = "file",
  timeoutSeconds = 2,
  output,
  runArgs = [],
} = {}) {
  const promptArgs = promptVia === "file" ? ["--prompt-file", "{promptFile}"] : [];
  return provenProfile({
    tool,
    run: {
      argv: [
        "{bin}", FAKE_WORKER, "--mode", mode, ...runArgs,
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

async function spawnResult(runId, phase, prompt, requestKey = crypto.randomUUID()) {
  const start = opSpawn({ runId, phase, prompt, requestKey });
  if (start.error) return start;
  return waitFor(() => {
    const status = opSpawnStatus({ runId, spawnId: start.spawnId });
    return ["completed", "failed", "timed_out", "cancelled", "interrupted"].includes(status.status)
      ? status
      : null;
  }, { timeoutMs: 5000 });
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
  const result = await spawnResult(run.runId, "work", prompt);
  assert.equal(result.status, "completed");
  assert.equal(result.result, prompt);
  assert.equal(fs.existsSync(sideEffect), false);
});

await ta("spawn: does not advance the run", async () => {
  const { run } = await startExternalRun();
  const result = await spawnResult(run.runId, "work", "hello");
  assert.equal(result.status, "completed", JSON.stringify(result));
  // Spawning completes the EXTERNAL work but NEVER advances the manifest — the
  // current step is still 'work', and a report for any other phase is refused.
  const report = opStepReport({
    runId: run.runId,
    phase: "wrong",
    summary: "must still expect work",
  });
  assert.match(report.error, /expected report for phase 'work'/);
  // The matching report must still be accepted (proves the run did not advance past 'work').
  const ok = opStepReport({
    runId: run.runId,
    phase: "work",
    summary: "ok",
  });
  assert.equal(ok.terminal, "done", JSON.stringify(ok));
});

await ta("spawn: rejects unknown, finished, and non-current runs", async () => {
  const unknown = opSpawn({ runId: "run-missing", phase: "work", prompt: "hello", requestKey: crypto.randomUUID() });
  assert.equal(unknown.code, "unknown_run");

  const { run } = await startExternalRun();
  const wrongPhase = opSpawn({ runId: run.runId, phase: "later", prompt: "hello", requestKey: crypto.randomUUID() });
  assert.equal(wrongPhase.code, "wrong_phase");
  const done = await spawnResult(run.runId, "work", "x");
  assert.equal(done.status, "completed");
  opStepReport({ runId: run.runId, phase: "work", summary: "complete" });
  const finished = opSpawn({ runId: run.runId, phase: "work", prompt: "hello", requestKey: crypto.randomUUID() });
  assert.equal(finished.code, "run_finished");
});

await ta("spawn: native and master phases remain host-owned", async () => {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  const nativeRun = opRunStart({
    task: "native",
    steps: [{ phase: "plan", role: "planner" }],
  });
  assert.equal(opSpawn({
    runId: nativeRun.runId,
    phase: "plan",
    prompt: "hello",
    requestKey: crypto.randomUUID(),
  }).code, "native_spawn_required");

  const masterRun = opRunStart({
    task: "master",
    steps: [{ phase: "frame", role: "master" }],
  });
  assert.equal(opSpawn({
    runId: masterRun.runId,
    phase: "frame",
    prompt: "hello",
    requestKey: crypto.randomUUID(),
  }).code, "master_phase");
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
  assert.ok(resolved.diagnostics.some((d) => d.state === "blocked_no_binding"));
  assert.ok(resolved.diagnostics.some((d) => d.state === "unreachable_registry_model"));
  const run = opRunStart({ task: "blocked role", pipeline: "broken" });
  const result = opSpawn({ runId: run.runId, phase: "work", prompt: "hello", requestKey: crypto.randomUUID() });
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
  assert.equal(opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "hello",
    requestKey: crypto.randomUUID(),
  }).code, "tool_unavailable");
});

await ta("spawn: reports live model drift without rerouting", async () => {
  const profile = runnableProfile({ tool: "fake-model-drift" });
  const { repo, run } = await startExternalRun(profile);
  writeInventory(profile.tool, ["vendor/other-9"]);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "hello", requestKey: crypto.randomUUID() });
  const result = await waitFor(() => {
    const s = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return ["completed","failed","timed_out","cancelled","interrupted"].includes(s.status) ? s : null;
  });
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "model_not_served");

  const manifest = JSON.parse(fs.readFileSync(path.join(
    repo, ".moa", "runs", run.runId, "manifest.json",
  ), "utf8"));
  assert.equal(manifest.resolved.worker.model, CANONICAL_FAKE_MODEL);
});

await ta("spawn: malformed live inventory returns parse error and run stays on original phase", async () => {
  const profile = runnableProfile({ tool: "fake-bad-inventory" });
  const { repo, run } = await startExternalRun(profile);
  fs.writeFileSync(inventoryPath(profile.tool), "{");
  const result = await spawnResult(run.runId, "work", "hello");
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "model_discovery_parse_failed");
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
    const result = await spawnResult(run.runId, "work", format);
    assert.equal(result.status, "completed");
    assert.equal(result.result, format);
  }
});

await ta("spawn: supports stdin prompt transport", async () => {
  const profile = runnableProfile({ tool: "fake-stdin", promptVia: "stdin" });
  const { run } = await startExternalRun(profile);
  const result = await spawnResult(run.runId, "work", "stdin-prompt");
  assert.equal(result.status, "completed");
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
  const result = opSpawn({ runId: run.runId, phase: "work", prompt: "x", requestKey: crypto.randomUUID() });
  assert.equal(result.code, "tool_unavailable", JSON.stringify(result));
});

await ta("spawn: reports malformed and missing declared output", async () => {
  const malformed = runnableProfile({
    tool: "fake-bad-json",
    mode: "badjson",
    output: { format: "json", resultPath: "response.text" },
  });
  let run = (await startExternalRun(malformed)).run;
  let result = await spawnResult(run.runId, "work", "x");
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "output_parse_failed");

  const missing = runnableProfile({
    tool: "fake-missing-result",
    mode: "json",
    output: { format: "json", resultPath: "response.missing" },
  });
  run = (await startExternalRun(missing)).run;
  result = await spawnResult(run.runId, "work", "x");
  assert.equal(result.status, "failed");
  assert.equal(result.failure.code, "output_parse_failed");
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
    const result = await spawnResult(run.runId, "work", "x");
    assert.deepEqual(
      [result.status, result.failure.code],
      code === "timeout" ? ["timed_out", "timeout"] :
        code === "cancelled" ? ["cancelled", code] : ["failed", code],
    );
  }
});

await ta("spawn: prompt bytes remain exact through an external spawn", async () => {
  const profile = runnableProfile({ tool: `bytes-${crypto.randomUUID()}` });
  const { run } = await startExternalRun(profile);
  const prompt = `exact $(touch ${path.join(TMP, "must-not-exist-2")}) and \`echo hi\``;
  const result = await spawnResult(run.runId, "work", prompt);
  assert.equal(result.status, "completed");
  assert.equal(result.result, prompt);
});

await ta("spawn jobs: start returns before the worker and polling returns the exact result", async () => {
  const ready = path.join(TMP, `ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `release-${crypto.randomUUID()}`);
  const count = path.join(TMP, `count-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `async-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release, "--count-file", count],
  });
  const { run } = await startExternalRun(profile);
  const requestKey = crypto.randomUUID();
  const startedAt = Date.now();
  const first = opSpawn({ runId: run.runId, phase: "work", prompt: "exact-result", requestKey });
  assert.ok(Date.now() - startedAt < 250, JSON.stringify(first));
  assert.equal(first.status, "queued");
  assert.match(first.spawnId, /^spawn-[a-f0-9]{24}$/);

  await waitFor(() => fs.existsSync(ready));
  const running = opSpawnStatus({ runId: run.runId, spawnId: first.spawnId });
  assert.equal(running.status, "running");

  const replay = opSpawn({ runId: run.runId, phase: "work", prompt: "exact-result", requestKey });
  assert.equal(replay.spawnId, first.spawnId);
  fs.writeFileSync(release, "go");

  const completed = await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: first.spawnId });
    return status.status === "completed" ? status : null;
  });
  assert.equal(completed.result, "exact-result");
  assert.equal(fs.readFileSync(count, "utf8").trim().split("\n").length, 1);
});

await ta("spawn jobs: a reused request key with different input is rejected", async () => {
  const { run } = await startExternalRun(runnableProfile({ tool: `conflict-${crypto.randomUUID()}` }));
  const requestKey = crypto.randomUUID();
  const first = opSpawn({ runId: run.runId, phase: "work", prompt: "one", requestKey });
  const conflict = opSpawn({ runId: run.runId, phase: "work", prompt: "two", requestKey });
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(conflict.spawnId, first.spawnId);
});

await ta("spawn jobs: cancellation terminates the worker and persists cancellation", async () => {
  const ready = path.join(TMP, `cancel-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `cancel-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `cancel-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "cancel-me",
    requestKey: crypto.randomUUID(),
  });
  await waitFor(() => fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready, "utf8"));

  const blocked = opStepReport({ runId: run.runId, phase: "work", summary: "too soon" });
  assert.equal(blocked.code, "spawn_in_progress");
  opSpawnCancel({ runId: run.runId, spawnId: start.spawnId });

  const cancelled = await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return status.status === "cancelled" ? status : null;
  });
  assert.equal(cancelled.failure.code, "cancelled");
  assert.throws(() => process.kill(pid, 0));
});

await ta("spawn jobs: MCP request cancellation signal aborts background execution", async () => {
  const ready = path.join(TMP, `signal-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `signal-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `signal-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const request = new AbortController();
  const start = opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "signal-cancel",
    requestKey: crypto.randomUUID(),
  }, { signal: request.signal });
  await waitFor(() => fs.existsSync(ready));
  request.abort("client cancelled tools/call");
  const cancelled = await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return status.status === "cancelled" ? status : null;
  });
  assert.equal(cancelled.failure.code, "cancelled");
});

// Foreign-recovery regression: when the report guard meets a nonterminal sibling whose
// ownerPid and pid are both dead, it must (a) promote the record to `interrupted`,
// (b) NOT throw `Assignment to constant variable` (the prior bug reassigned a `const`),
// and (c) the report itself then succeeds and advances the run. Without the `let`
// fix this throws on the very first such sibling — TypeError in the test.
await ta("spawn jobs: opStepReport recovers a dead-owner sibling instead of throwing", async () => {
  const { repo, run } = await startExternalRun(runnableProfile({ tool: `dead-owner-${crypto.randomUUID()}` }));
  const spawnId = `spawn-${crypto.randomBytes(12).toString("hex")}`;
  const spawnsDir = path.join(repo, ".moa", "runs", run.runId, "spawns");
  fs.mkdirSync(spawnsDir, { recursive: true });
  // Owner + child PIDs deliberately dead (PID 1 / 0x7fffffff are not allocatable here).
  // stepIndex = 0 matches the run's current step so the guard's per-spawn check engages.
  const dead = {
    schemaVersion: 1,
    spawnId, runId: run.runId, phase: "work",
    stepIndex: 0,
    promptFile: path.join(repo, ".moa", "runs", run.runId, `prompt-${spawnId}.md`),
    tool: "dead-owner", model: "vendor/fake-9", family: "fake",
    status: "discovering",
    pid: 0x7ffffffe, ownerPid: 0x7ffffffd,
    result: null, failure: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(spawnsDir, `${spawnId}.json`), JSON.stringify(dead, null, 2) + "\n");
  // The report MUST NOT throw and MUST advance the manifest: a foreign process or
  // restart should not leave a conductor stuck behind a vanished origin.
  const rep = opStepReport({ runId: run.runId, phase: "work", summary: "advanced past dead owner" });
  assert.equal(rep.terminal, "done", JSON.stringify(rep));
  // The sibling was promoted to `interrupted` in place.
  const onDisk = JSON.parse(fs.readFileSync(path.join(spawnsDir, `${spawnId}.json`), "utf8"));
  assert.equal(onDisk.status, "interrupted", JSON.stringify(onDisk));
  assert.equal(onDisk.failure?.code, "server_restarted");
});

// Two real MCP server processes, same run, same requestKey, concurrent — proves the
// exclusive initial create on the FINAL job path (not a unique tmp file that renameSync
// overwrites), so only one of them persists a launch, and the loser replays / conflicts
// instead of interleaving writes onto a single record or overwriting the winner's prompt.
await ta("spawn jobs: two server processes race on the same requestKey — only the winner launches", async () => {
  const count = path.join(TMP, `race-count-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `race-${crypto.randomUUID()}`,
    timeoutSeconds: 2,
    runArgs: ["--count-file", count],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`race-${crypto.randomUUID()}`, "external", profile.tool);
  const setup = await mcpClient({ cwd: repo });
  let cA = null, cB = null;
  try {
    const send = (c, name, args) => c.call(name, args, { requestTimeoutMs: 10_000 });
    assert.ok(!(await send(setup, "moa_load", { cwd: repo })).error);
    assert.ok(!(await send(setup, "moa_resolve", { hostModels: HOST })).error);
    const run = await send(setup, "moa_run_start", {
      task: "race", steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    });
    setup.stop();
    cA = await mcpClient({ cwd: repo });
    cB = await mcpClient({ cwd: repo });
    for (const c of [cA, cB]) {
      assert.ok(!(await send(c, "moa_load", { cwd: repo })).error);
      assert.ok(!(await send(c, "moa_resolve", { hostModels: HOST })).error);
    }
    const requestKey = crypto.randomUUID();
    // fire both with the same prompt and requestKey — the loser must observe the winner
    // via replay, NOT overwrite the winner's queued record with its own launch.
    const [a, b] = await Promise.all([
      send(cA, "moa_spawn", {
        runId: run.runId, phase: "work", prompt: "race-text", requestKey,
      }),
      send(cB, "moa_spawn", {
        runId: run.runId, phase: "work", prompt: "race-text", requestKey,
      }),
    ]);
    assert.ok(!a.error && !b.error, JSON.stringify({ a, b }));
    assert.equal(a.spawnId, b.spawnId, "both processes must agree on the same spawnId");
    // status may differ between the two responses (one saw the other process's macrotask
    // flip to `discovering` while the other returned with its local copy) — the invariant
    // the Fable flag demanded is: only ONE actual worker launch, asserted by the count
    // file below; the persisted spawnId is the same so the loser did not write a second
    // queued record or overwrite the winner's prompt bytes.
    assert.ok(["queued", "discovering", "running"].includes(a.status) && ["queued", "discovering", "running"].includes(b.status),
      JSON.stringify({ a, b }));
    const completed = await waitFor(async () => {
      const status = await send(cA, "moa_spawn_status", {
        runId: run.runId, spawnId: a.spawnId,
      });
      return status.status === "completed" ? status : null;
    });
    assert.equal(completed.result, "race-text");
    await waitFor(() => fs.existsSync(count) && fs.readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length >= 1);
    // give the loser a moment to (incorrectly) launch if it would
    await new Promise((r) => setTimeout(r, 250));
    const launches = fs.readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(launches, 1, `expected exactly one launch, got ${launches}`);
  } finally {
    if (setup?.stop) try { setup.stop(); } catch {}
    if (cA) try { cA.stop(); } catch {}
    if (cB) try { cB.stop(); } catch {}
  }
});

// Same race but prompt bytes differ — only the winner may own prompt-<spawnId>.md, and
// the loser MUST observe idempotency_conflict (not overwrite the winner's prompt bytes).
await ta("spawn jobs: two server processes race on the same key with conflicting prompts — neither overwrites the other's prompt, exactly one launch occurs", async () => {
  const count = path.join(TMP, `conflict-count-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `conflict-race-${crypto.randomUUID()}`,
    timeoutSeconds: 2,
    runArgs: ["--count-file", count],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`conflict-race-${crypto.randomUUID()}`, "external", profile.tool);
  const setup = await mcpClient({ cwd: repo });
  let cA = null, cB = null;
  try {
    const send = (c, name, args) => c.call(name, args, { requestTimeoutMs: 10_000 });
    assert.ok(!(await send(setup, "moa_load", { cwd: repo })).error);
    assert.ok(!(await send(setup, "moa_resolve", { hostModels: HOST })).error);
    const run = await send(setup, "moa_run_start", {
      task: "conflict race",
      steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    });
    setup.stop();
    cA = await mcpClient({ cwd: repo });
    cB = await mcpClient({ cwd: repo });
    for (const c of [cA, cB]) {
      assert.ok(!(await send(c, "moa_load", { cwd: repo })).error);
      assert.ok(!(await send(c, "moa_resolve", { hostModels: HOST })).error);
    }
    // Pair each response with the prompt that the client actually sent, so the assertion
    // below can derive the expected on-disk bytes from the real winner regardless of
    // which `Promise.all` slot the scheduler picks.
    const requestKey = crypto.randomUUID();
    const responses = await Promise.all([
      send(cA, "moa_spawn", {
        runId: run.runId, phase: "work", prompt: "winner-prompt", requestKey,
      }).then((r) => ({ prompt: "winner-prompt", r })),
      send(cB, "moa_spawn", {
        runId: run.runId, phase: "work", prompt: "loser-prompt", requestKey,
      }).then((r) => ({ prompt: "loser-prompt", r })),
    ]);
    const ids = responses.map((p) => p.r.spawnId);
    // Both responses reference the SAME spawnId so the loser wrote nothing if it lost.
    assert.equal(ids[0], ids[1], JSON.stringify(responses));
    const winner = responses.find((p) => !p.r.error)?.r;
    const loserEntry = responses.find((p) => p.r.error);
    assert.ok(winner, `both spawn calls errored: ${JSON.stringify(responses)}`);
    assert.ok(loserEntry, `no spawn observed the idempotency_conflict: ${JSON.stringify(responses)}`);
    assert.equal(loserEntry.r.code, "idempotency_conflict", JSON.stringify(responses));
    assert.equal(winner.status, "queued", JSON.stringify(winner));
    // Only the winner may own prompt-<spawnId>.md, and the bytes must match the prompt
    // the winning client sent — not a hardcoded "winner-prompt" label, because either
    // client can legitimately win the exclusive create. workDir defaults to '.moa'.
    const promptFile = path.join(repo, ".moa", "runs", run.runId, `prompt-${ids[0]}.md`);
    const written = fs.readFileSync(promptFile, "utf8");
    const winningPrompt = responses.find((p) => p.r === winner).prompt;
    assert.equal(written, winningPrompt,
      `prompt file does not match the winning client's bytes (${winningPrompt}): ${written}`);
    // one conflict, no second launch — the loser must NOT have written its prompt bytes
    assert.notEqual(written, loserEntry.prompt,
      `loser's prompt bytes (${loserEntry.prompt}) overwrote the winner's on disk`);
    // Exactly one worker launch — the count file the fake-worker appends to on every
    // spawn is the ground-truth receipt. The loser's createSpawnExclusive returned
    // {created:false} before setImmediate(schedule), so the loser never launched a worker.
    await waitFor(() => fs.existsSync(count) && fs.readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length >= 1);
    await new Promise((r) => setTimeout(r, 250));
    const launches = fs.readFileSync(count, "utf8").trim().split("\n").filter(Boolean).length;
    assert.equal(launches, 1, `expected exactly one worker launch, got ${launches}`);
    // Persisted result must match the WINNING client's prompt bytes — the loser cannot
    // have raced the partial record and corrupted the result the winner's worker returned.
    const completed = await waitFor(async () => {
      const status = await send(cA, "moa_spawn_status", {
        runId: run.runId, spawnId: ids[0],
      });
      return status.status === "completed" ? status : null;
    });
    assert.equal(completed.result, winningPrompt,
      `persisted result does not match the winning client's prompt (${winningPrompt}): ${completed.result}`);
  } finally {
    if (setup?.stop) try { setup.stop(); } catch {}
    if (cA) try { cA.stop(); } catch {}
    if (cB) try { cB.stop(); } catch {}
  }
});

// A status reader in another server process must NOT mark a queued/discovering job
// interrupted while the origin's child is still alive. The job is only interrupted when
// there is no live controller AND no live PID — origin-driven recovery closes the flap.
await ta("spawn jobs: a foreign status call honors the origin's live child instead of marking interrupted", async () => {
  const ready = path.join(TMP, `foreign-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `foreign-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `foreign-${crypto.randomUUID()}`,
    mode: "wait", timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`foreign-${crypto.randomUUID()}`, "external", profile.tool);
  const setup = await mcpClient({ cwd: repo });
  let origin = null, foreign = null;
  try {
    const osend = (name, args) => origin.call(name, args, { requestTimeoutMs: 10_000 });
    const fsend = (name, args) => foreign.call(name, args, { requestTimeoutMs: 10_000 });
    assert.ok(!(await setup.call("moa_load", { cwd: repo }, { requestTimeoutMs: 10_000 })).error);
    assert.ok(!(await setup.call("moa_resolve", { hostModels: HOST }, { requestTimeoutMs: 10_000 })).error);
    const run = await setup.call("moa_run_start", {
      task: "foreign",
      steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    }, { requestTimeoutMs: 10_000 });
    setup.stop();
    origin = await mcpClient({ cwd: repo });
    foreign = await mcpClient({ cwd: repo });
    for (const c of [origin, foreign]) {
      assert.ok(!(await c.call("moa_load", { cwd: repo }, { requestTimeoutMs: 10_000 })).error);
      assert.ok(!(await c.call("moa_resolve", { hostModels: HOST }, { requestTimeoutMs: 10_000 })).error);
    }
    const start = await osend("moa_spawn", {
      runId: run.runId, phase: "work", prompt: "foreign-text",
      requestKey: crypto.randomUUID(),
    });
    await waitFor(() => fs.existsSync(ready));
    // foreign status call sees a running child still controlled by origin — must NOT
    // transiently flip the persisted record to interrupted
    const foreignView = await fsend("moa_spawn_status", { runId: run.runId, spawnId: start.spawnId });
    assert.notEqual(foreignView.status, "interrupted",
      `foreign status marked a live child interrupted: ${JSON.stringify(foreignView)}`);
    const originView = await osend("moa_spawn_status", { runId: run.runId, spawnId: start.spawnId });
    assert.notEqual(originView.status, "interrupted", JSON.stringify(originView));
    fs.writeFileSync(release, "go");
    const completed = await waitFor(async () => {
      const status = await osend("moa_spawn_status", { runId: run.runId, spawnId: start.spawnId });
      return status.status === "completed" ? status : null;
    });
    assert.equal(completed.result, "foreign-text");
  } finally {
    if (setup?.stop) try { setup.stop(); } catch {}
    if (origin) try { origin.stop(); } catch {}
    if (foreign) try { foreign.stop(); } catch {}
  }
});

// --- spawn wait ----------------------------------------------------------------

await ta("spawn wait: returns the exact terminal result shortly after release", async () => {
  const ready = path.join(TMP, `wait-ok-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wait-ok-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wait-ok-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "wait-result", requestKey: crypto.randomUUID() });
  await waitFor(() => fs.existsSync(ready));
  const waitPromise = opSpawnWait({ runId: run.runId, spawnId: start.spawnId, waitMs: 5000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const releasedAt = Date.now();
  fs.writeFileSync(release, "go");
  const result = await waitPromise;
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.result, "wait-result");
  assert.ok(Date.now() - releasedAt < 1000, `wait resolved too slowly after release: ${Date.now() - releasedAt}ms`);
});

await ta("spawn wait: expires within the bounded window with the latest nonterminal state and leaves the worker alive", async () => {
  const ready = path.join(TMP, `wait-expire-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wait-expire-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wait-expire-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "expire-me", requestKey: crypto.randomUUID() });
  await waitFor(() => fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready, "utf8"));

  const startedAt = Date.now();
  const result = await opSpawnWait({ runId: run.runId, spawnId: start.spawnId, waitMs: 300 });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 300 && elapsed < 900, `expiry did not respect waitMs: ${elapsed}ms`);
  assert.deepEqual(Object.keys(result), ["status"], `expected compact { status } shape: ${JSON.stringify(result)}`);
  assert.ok(["queued", "discovering", "running"].includes(result.status), JSON.stringify(result));
  assert.doesNotThrow(() => process.kill(pid, 0), "worker should still be alive after wait expiry");

  opSpawnCancel({ runId: run.runId, spawnId: start.spawnId });
  await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return status.status === "cancelled" ? status : null;
  });
});

await ta("spawn wait: aborting only the wait returns promptly and leaves the worker alive", async () => {
  const ready = path.join(TMP, `wait-abort-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wait-abort-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wait-abort-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "abort-me", requestKey: crypto.randomUUID() });
  await waitFor(() => fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready, "utf8"));

  const controller = new AbortController();
  const startedAt = Date.now();
  const waitPromise = opSpawnWait({ runId: run.runId, spawnId: start.spawnId, waitMs: 5000 }, { signal: controller.signal });
  setTimeout(() => controller.abort("test aborting the wait only"), 50);
  const result = await waitPromise;
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1000, `abort did not return promptly: ${elapsed}ms`);
  assert.deepEqual(Object.keys(result), ["status"], `expected compact { status } shape: ${JSON.stringify(result)}`);
  assert.ok(["queued", "discovering", "running"].includes(result.status), JSON.stringify(result));
  assert.doesNotThrow(() => process.kill(pid, 0), "worker should still be alive after aborting only the wait");

  opSpawnCancel({ runId: run.runId, spawnId: start.spawnId });
  await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return status.status === "cancelled" ? status : null;
  });
});

await ta("spawn wait: abort after the spawn reaches terminal state returns the terminal result, not a stale pre-sleep snapshot", async () => {
  const ready = path.join(TMP, `wait-abort-fresh-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wait-abort-fresh-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wait-abort-fresh-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "fresh-result", requestKey: crypto.randomUUID() });
  await waitFor(() => fs.existsSync(ready));

  try {
    const controller = new AbortController();
    // Enters opSpawnWait's poll loop and starts its 250ms abortableDelay almost immediately —
    // no earlier await stands between the initial status read and that delay.
    const waitPromise = opSpawnWait({ runId: run.runId, spawnId: start.spawnId, waitMs: 5000 }, { signal: controller.signal });

    // Release the worker right away and independently confirm — via a separate opSpawnStatus
    // poll, not opSpawnWait's own — that the durable record actually reached "completed".
    // This all happens while opSpawnWait is still asleep inside its first 250ms delay.
    fs.writeFileSync(release, "go");
    await waitFor(() => {
      const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
      return status.status === "completed" ? status : null;
    });

    // Abort the wait itself before that 250ms delay timer fires on its own, forcing the abort
    // branch of the poll loop instead of the ordinary "delay expired, re-read" branch.
    controller.abort("test aborting after the spawn went terminal");
    const result = await waitPromise;

    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.result, "fresh-result");
  } finally {
    opSpawnCancel({ runId: run.runId, spawnId: start.spawnId });
  }
});

await ta("spawn wait: terminal jobs and error results return immediately", async () => {
  let startedAt = Date.now();
  let result = await opSpawnWait({
    runId: "run-missing",
    spawnId: `spawn-${crypto.randomBytes(12).toString("hex")}`,
    waitMs: 5000,
  });
  assert.equal(result.code, "unknown_run");
  assert.ok(Date.now() - startedAt < 200, "unknown_run should not wait");

  const { run } = await startExternalRun(runnableProfile({ tool: `wait-unknown-spawn-${crypto.randomUUID()}` }));
  startedAt = Date.now();
  result = await opSpawnWait({
    runId: run.runId,
    spawnId: `spawn-${crypto.randomBytes(12).toString("hex")}`,
    waitMs: 5000,
  });
  assert.equal(result.code, "unknown_spawn");
  assert.ok(Date.now() - startedAt < 200, "unknown_spawn should not wait");

  const done = await spawnResult(run.runId, "work", "already-done");
  assert.equal(done.status, "completed");
  startedAt = Date.now();
  result = await opSpawnWait({ runId: run.runId, spawnId: done.spawnId, waitMs: 5000 });
  assert.ok(Date.now() - startedAt < 200, "terminal job should not wait");
  assert.equal(result.status, "completed");
  assert.equal(result.result, "already-done");
});

await ta("spawn wait: a dead-owner record is promoted to terminal interrupted during the initial read", async () => {
  const { repo, run } = await startExternalRun(runnableProfile({ tool: `wait-dead-owner-${crypto.randomUUID()}` }));
  const spawnId = `spawn-${crypto.randomBytes(12).toString("hex")}`;
  const spawnsDir = path.join(repo, ".moa", "runs", run.runId, "spawns");
  fs.mkdirSync(spawnsDir, { recursive: true });
  const dead = {
    schemaVersion: 1,
    spawnId, runId: run.runId, phase: "work",
    stepIndex: 0,
    promptFile: path.join(repo, ".moa", "runs", run.runId, `prompt-${spawnId}.md`),
    tool: "wait-dead-owner", model: "vendor/fake-9", family: "fake",
    status: "discovering",
    pid: 0x7ffffffe, ownerPid: 0x7ffffffd,
    result: null, failure: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(spawnsDir, `${spawnId}.json`), JSON.stringify(dead, null, 2) + "\n");
  const startedAt = Date.now();
  const result = await opSpawnWait({ runId: run.runId, spawnId, waitMs: 5000 });
  assert.ok(Date.now() - startedAt < 300, "dead-owner promotion should resolve on the initial read");
  assert.equal(result.status, "interrupted", JSON.stringify(result));
  assert.equal(result.failure?.code, "server_restarted");
});

await ta("spawn wait: waitMs 0 is an immediate snapshot", async () => {
  const ready = path.join(TMP, `wait-zero-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wait-zero-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wait-zero-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  const { run } = await startExternalRun(profile);
  const start = opSpawn({ runId: run.runId, phase: "work", prompt: "zero-wait", requestKey: crypto.randomUUID() });
  await waitFor(() => fs.existsSync(ready));
  const pid = Number(fs.readFileSync(ready, "utf8"));

  const startedAt = Date.now();
  const result = await opSpawnWait({ runId: run.runId, spawnId: start.spawnId, waitMs: 0 });
  assert.ok(Date.now() - startedAt < 200, "waitMs: 0 should not sleep");
  assert.deepEqual(Object.keys(result), ["status"], `expected compact { status } shape: ${JSON.stringify(result)}`);
  assert.ok(["queued", "discovering", "running"].includes(result.status), JSON.stringify(result));
  assert.doesNotThrow(() => process.kill(pid, 0));

  opSpawnCancel({ runId: run.runId, spawnId: start.spawnId });
  await waitFor(() => {
    const status = opSpawnStatus({ runId: run.runId, spawnId: start.spawnId });
    return status.status === "cancelled" ? status : null;
  });
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

await ta("init: invalid project splice writes nothing and does not guard retry", async () => {
  clearGlobal();
  const repo = path.join(TMP, "invalid-project-splice");
  const target = path.join(repo, ".moa.yml");
  fs.mkdirSync(repo, { recursive: true });
  try {
    const args = {
      scope: "project",
      template: "lite-build",
      cwd: repo,
      roles: { missing: ["auto"] },
    };
    const first = await opInit(args);
    assert.match(first.error, /template 'lite-build' has no role 'missing'/);
    assert.equal(fs.existsSync(target), false);
    const retry = await opInit(args);
    assert.equal(retry.error, first.error);
    assert.doesNotMatch(retry.error, /already exists/);
    assert.equal(fs.existsSync(target), false);

    const invalidRepo = path.join(TMP, "invalid-project-model");
    fs.mkdirSync(invalidRepo, { recursive: true });
    const invalid = await opInit({
      scope: "project",
      template: "lite-build",
      cwd: invalidRepo,
      registry: { broken: { id: "not-canonical" } },
      roles: { planner: ["broken", "auto"] },
    });
    assert.match(invalid.error, /models\.broken\.id/);
    assert.equal(fs.existsSync(path.join(invalidRepo, ".moa.yml")), false);
  } finally {
    clearGlobal();
  }
});

await ta("init: empty picks write the untouched host-native template", async () => {
  clearGlobal();
  const repo = path.join(TMP, "host-native-init");
  fs.mkdirSync(repo, { recursive: true });
  try {
    const result = await opInit({
      scope: "project",
      template: "lite-build",
      cwd: repo,
      registry: {},
      roles: {},
    });
    assert.equal(result.spliced, false);
    const source = fs.readFileSync(path.join(repo, ".moa.yml"), "utf8");
    const templateSource = fs.readFileSync(
      path.join(import.meta.dirname, "..", "templates", "lite-build.yml"), "utf8");
    assert.equal(source, templateSource);
    const config = YAML.parse(source);
    assert.deepEqual(config.models, {});
    assert.deepEqual(config.roles.planner.use, ["auto"]);
    assert.deepEqual(config.roles.coder.use, ["auto"]);
    assert.deepEqual(config.roles.verifier.use, ["auto"]);
  } finally {
    clearGlobal();
  }
});

await ta("init: global scope writes staffing, guards, and rejects templates", async () => {
  clearGlobal();
  try {
    const result = await opInit({
      scope: "global",
      registry: { g: { id: "openai/gpt-5.5", tags: ["strong"] } },
      roles: { planner: ["g", "auto"], verifier: ["g", "auto"] },
    });
    assert.equal(result.written, GLOBAL_CONFIG);
    const config = YAML.parse(fs.readFileSync(GLOBAL_CONFIG, "utf8"));
    assert.deepEqual(Object.keys(config), ["schemaVersion", "models", "roles"]);
    assert.deepEqual(config.roles.planner.use, ["g", "auto"]);
    assert.equal(config.roles.verifier.differentModelFrom, undefined);
    const guarded = await opInit({ scope: "global", roles: { planner: ["auto"] } });
    assert.match(guarded.error, new RegExp(GLOBAL_CONFIG.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match((await opInit({ scope: "global", template: "lite-build", force: true })).error, /does not accept a template/);
  } finally {
    clearGlobal();
  }
});

await ta("init: invalid global staffing never writes", async () => {
  clearGlobal();
  try {
    const result = await opInit({
      scope: "global",
      registry: {},
      roles: { planner: ["missing"] },
    });
    assert.match(result.error, /missing/);
    assert.equal(fs.existsSync(GLOBAL_CONFIG), false);
  } finally {
    clearGlobal();
  }
});

await ta("init: global-backed project emits a minimal loadable overlay", async () => {
  const repo = path.join(TMP, "overlay-init");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  reasoner: { id: anthropic/claude-opus-4-8, tags: [strong] }
  implementer: { id: minimax/MiniMax-M3, tags: [strong] }
roles:
  planner: { use: [reasoner, auto] }
  coder: { use: [implementer, auto] }
`);
  try {
    const result = await opInit({
      scope: "project",
      template: "lite-build",
      cwd: repo,
      registry: {
        reasoner: { id: "anthropic/claude-opus-4-8", tags: ["strong"] },
        implementer: { id: "minimax/MiniMax-M3", tags: ["strong"] },
        checker: { id: "openai/gpt-5.5", tags: ["strong"] },
      },
      roles: {
        planner: ["reasoner", "auto"],
        coder: ["implementer", "auto"],
        verifier: ["checker", "auto"],
      },
    });
    assert.equal(result.overlay, true);
    const overlay = YAML.parse(fs.readFileSync(path.join(repo, ".moa.yml"), "utf8"));
    assert.equal(Object.hasOwn(overlay.roles.planner, "use"), false);
    assert.equal(Object.hasOwn(overlay.roles.coder, "use"), false);
    assert.deepEqual(overlay.roles.verifier.use, ["checker", "auto"]);
    assert.deepEqual(Object.keys(overlay.models), ["checker"]);
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.roles.planner.use, ["reasoner", "auto"]);
    assert.deepEqual(loaded.roles.coder.use, ["implementer", "auto"]);
    assert.deepEqual(loaded.roles.verifier.use, ["checker", "auto"]);
  } finally {
    clearGlobal();
  }
});

await ta("init: explicit project staffing overrides global defaults", async () => {
  const repo = path.join(TMP, "overlay-override-init");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  reasoner: { id: anthropic/claude-opus-4-8, tags: [strong] }
  implementer: { id: minimax/MiniMax-M3, tags: [strong] }
roles:
  planner: { use: [reasoner, auto] }
  coder: { use: [implementer, auto] }
`);
  try {
    const result = await opInit({
      scope: "project",
      template: "lite-build",
      cwd: repo,
      registry: {
        reasoner: { id: "anthropic/claude-opus-4-8", tags: ["strong"] },
        implementer: { id: "minimax/MiniMax-M3", tags: ["strong"] },
        override: { id: "openai/gpt-5.5", tags: ["strong"] },
      },
      roles: {
        planner: ["override", "auto"],
        coder: ["implementer", "auto"],
      },
    });
    assert.equal(result.overlay, true);
    const overlay = YAML.parse(fs.readFileSync(path.join(repo, ".moa.yml"), "utf8"));
    assert.deepEqual(overlay.roles.planner.use, ["override", "auto"]);
    assert.equal(Object.hasOwn(overlay.roles.coder, "use"), false);
    assert.deepEqual(Object.keys(overlay.models), ["override"]);
    assert.equal(overlay.models.override.id, "openai/gpt-5.5");
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.deepEqual(loaded.roles.planner.use, ["override", "auto"]);
  } finally {
    clearGlobal();
  }
});

await ta("init: invalid global-overlay merge never writes", async () => {
  const repo = path.join(TMP, "invalid-overlay-init");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, tags: [strong] }
roles:
  coder: { use: [g], differentModelFrom: verifier }
  verifier: { use: [g] }
`);
  try {
    const result = await opInit({ scope: "project", template: "lite-build", cwd: repo });
    assert.match(result.error, /differentModelFrom cycle/);
    assert.equal(fs.existsSync(path.join(repo, ".moa.yml")), false);
  } finally {
    clearGlobal();
  }
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
  const rpc = (method, params, { requestTimeoutMs = 10_000 } = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    const timer = setTimeout(() => {
      pending.delete(mid);
      reject(new Error(`${method} timed out`));
    }, requestTimeoutMs);
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
    call: async (name, args, opts) => {
      const m = await rpc("tools/call", { name, arguments: args }, opts);
      if (m.error) return { _rpcError: m.error.message };
      const text = m.result?.content?.[0]?.text ?? "";
      try { return JSON.parse(text); }
      catch { return m.result?.isError ? { _threw: text } : { _raw: text }; }
    },
    pid: () => srv.pid,
    killServer: (signal = "SIGTERM") => srv.kill(signal),
    waitExit: () => new Promise((resolve) => {
      if (srv.exitCode != null) return resolve(srv.exitCode);
      srv.once("exit", (code) => resolve(code));
    }),
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


await ta("tools/call: slow external work outlives the client deadline without losing its result", async () => {
  const ready = path.join(TMP, `wire-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wire-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wire-async-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`wire-async-${crypto.randomUUID()}`, "external", profile.tool);
  const c = await mcpClient({ cwd: repo });
  let resumed = null;
  try {
    const send = async (name, args, timeout) => c.call(name, args, { requestTimeoutMs: timeout });
    assert.ok(!(await send("moa_load", { cwd: repo }, 10_000)).error);
    assert.ok(!(await send("moa_resolve", { hostModels: HOST }, 10_000)).error);
    const run = await send("moa_run_start", {
      task: "wire async",
      steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master",
      masterFamily: "host",
    }, 10_000);
    const start = await send("moa_spawn", {
      runId: run.runId,
      phase: "work",
      prompt: "wire-result",
      requestKey: crypto.randomUUID(),
    }, 250);
    assert.equal(start.status, "queued");
    await waitFor(() => fs.existsSync(ready));
    fs.writeFileSync(release, "go");
    const completed = await waitFor(async () => {
      const status = await send("moa_spawn_status", { runId: run.runId, spawnId: start.spawnId }, 10_000);
      return status.status === "completed" ? status : null;
    });
    assert.equal(completed.result, "wire-result");

    // Result persists across server reconnect.
    const completedResult = completed.result;
    c.stop();
    resumed = await mcpClient({ cwd: repo });
    const rsend = (name, args) => resumed.call(name, args, { requestTimeoutMs: 10_000 });
    assert.ok(!(await rsend("moa_load", { cwd: repo })).error);
    const persisted = await rsend("moa_spawn_status", { runId: run.runId, spawnId: start.spawnId });
    assert.equal(persisted.status, "completed");
    assert.equal(persisted.result, completedResult);
  } finally {
    if (resumed) resumed.stop();
    else c.stop();
  }
});

// Shutdown wire regression: prove the SIGTERM/stdin-end path actually aborts live
// children instead of orphaning them — the prior missing-registration bug let every
await ta("tools/call: stopping the server mid-spawn terminates the child and persists cancellation", async () => {
  const ready = path.join(TMP, `shutdown-ready-${crypto.randomUUID()}`);
  // Never written — the child will be killed by SIGTERM long before it would block on this.
  const release = path.join(TMP, `shutdown-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `shutdown-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`shutdown-${crypto.randomUUID()}`, "external", profile.tool);
  const c = await mcpClient({ cwd: repo });
  try {
    const send = (name, args, timeout = 10_000) => c.call(name, args, { requestTimeoutMs: timeout });
    assert.ok(!(await send("moa_load", { cwd: repo })).error);
    assert.ok(!(await send("moa_resolve", { hostModels: HOST })).error);
    const run = await send("moa_run_start", {
      task: "shutdown", steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    });
    const start = await send("moa_spawn", {
      runId: run.runId, phase: "work", prompt: "shutdown-me",
      requestKey: crypto.randomUUID(),
    });
    assert.equal(start.status, "queued");
    // wait for the worker to actually be running so we know there is something to abort
    await waitFor(() => fs.existsSync(ready));
    const childPid = Number(fs.readFileSync(ready, "utf8"));
    assert.ok(Number.isInteger(childPid) && childPid > 0);
    assert.doesNotThrow(() => process.kill(childPid, 0),
      `child ${childPid} not alive right after ready file`);

    // SIGTERM the MCP server — this must trigger shutdown, which aborts the controller,
    // which runChild's escalation converts to SIGTERM → the child terminates.
    c.killServer("SIGTERM");
    await c.waitExit();

    // The child's PID is no longer alive: the active spawn was aborted, not orphaned.
    let childAlive = true;
    try { process.kill(childPid, 0); }
    catch (error) { childAlive = error?.code === "EPERM"; }
    assert.equal(childAlive, false,
      `child ${childPid} still alive after server SIGTERM — shutdown did not abort it`);

    // The durable record is terminal. Cooperative shutdown writes `cancelled`; if the
    // 1100 ms force-exit fires first, the next status call promotes it to `interrupted`.
    // Either is a valid demonstration that the record was NOT left nonterminal.
    const spawnFile = path.join(repo, ".moa", "runs", run.runId, "spawns", `${start.spawnId}.json`);
    const persisted = JSON.parse(fs.readFileSync(spawnFile, "utf8"));
    assert.ok(["cancelled", "interrupted"].includes(persisted.status),
      `expected cancelled/interrupted, got ${persisted.status}: ${JSON.stringify(persisted)}`);
    assert.equal(persisted.failure?.code, persisted.status, JSON.stringify(persisted));
  } finally { try { c.stop(); } catch {} }
});

await ta("tools/call: moa_spawn_wait rejects invalid waitMs bounds over JSON-RPC", async () => {
  const c = await mcpClient({ cwd: REPO });
  try {
    assert.ok(!(await c.call("moa_load", { cwd: REPO })).error);
    const args = { runId: "run-missing", spawnId: `spawn-${crypto.randomBytes(12).toString("hex")}` };
    for (const waitMs of [-1, 0.5, 20001]) {
      const r = await c.call("moa_spawn_wait", { ...args, waitMs });
      assert.ok(r._threw, `waitMs ${waitMs} should be rejected at the tool boundary: ${JSON.stringify(r)}`);
    }
    // in-bounds values pass the schema and reach the handler (unknown_run proves it)
    const ok = await c.call("moa_spawn_wait", { ...args, waitMs: 20000 });
    assert.match(JSON.stringify(ok), /unknown_run/);
  } finally { c.stop(); }
});

await ta("tools/call: moa_spawn_wait returns on completion", async () => {
  const ready = path.join(TMP, `wire-wait-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wire-wait-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wire-wait-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`wire-wait-${crypto.randomUUID()}`, "external", profile.tool);
  const c = await mcpClient({ cwd: repo });
  try {
    const send = (name, args, timeout = 10_000) => c.call(name, args, { requestTimeoutMs: timeout });
    assert.ok(!(await send("moa_load", { cwd: repo })).error);
    assert.ok(!(await send("moa_resolve", { hostModels: HOST })).error);
    const run = await send("moa_run_start", {
      task: "wire wait", steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    });
    const start = await send("moa_spawn", {
      runId: run.runId, phase: "work", prompt: "wire-wait-result",
      requestKey: crypto.randomUUID(),
    }, 250);
    assert.equal(start.status, "queued");
    await waitFor(() => fs.existsSync(ready));
    // issue the wait BEFORE releasing so it genuinely blocks then wakes on completion.
    const waitCall = send("moa_spawn_wait", {
      runId: run.runId, spawnId: start.spawnId, waitMs: 5000,
    }, 6000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.writeFileSync(release, "go");
    const completed = await waitCall;
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(completed.result, "wire-wait-result");
  } finally { c.stop(); }
});

await ta("tools/call: moa_spawn_wait returns a compact { status } shape while active over JSON-RPC", async () => {
  const ready = path.join(TMP, `wire-wait-compact-ready-${crypto.randomUUID()}`);
  const release = path.join(TMP, `wire-wait-compact-release-${crypto.randomUUID()}`);
  const profile = runnableProfile({
    tool: `wire-wait-compact-${crypto.randomUUID()}`,
    mode: "wait",
    timeoutSeconds: 5,
    runArgs: ["--ready-file", ready, "--release-file", release],
  });
  await opBindingSave({ profile });
  const repo = writeRouteRepo(`wire-wait-compact-${crypto.randomUUID()}`, "external", profile.tool);
  const c = await mcpClient({ cwd: repo });
  try {
    const send = (name, args, timeout = 10_000) => c.call(name, args, { requestTimeoutMs: timeout });
    assert.ok(!(await send("moa_load", { cwd: repo })).error);
    assert.ok(!(await send("moa_resolve", { hostModels: HOST })).error);
    const run = await send("moa_run_start", {
      task: "wire wait compact", steps: [{ phase: "work", role: "worker" }],
      masterModel: "host/master", masterFamily: "host",
    });
    const start = await send("moa_spawn", {
      runId: run.runId, phase: "work", prompt: "wire-wait-compact-result",
      requestKey: crypto.randomUUID(),
    }, 250);
    assert.equal(start.status, "queued");
    await waitFor(() => fs.existsSync(ready));
    // never release the worker — the wait must expire nonterminal.
    const expired = await send("moa_spawn_wait", {
      runId: run.runId, spawnId: start.spawnId, waitMs: 300,
    }, 2000);
    assert.deepEqual(Object.keys(expired), ["status"], `expected compact { status } shape over the wire: ${JSON.stringify(expired)}`);
    assert.ok(["queued", "discovering", "running"].includes(expired.status), JSON.stringify(expired));
    await send("moa_spawn_cancel", { runId: run.runId, spawnId: start.spawnId });
  } finally {
    fs.writeFileSync(release, "go");
    c.stop();
  }
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
      moa_spawn: [{ runId: "no-such-run", phase: "p", prompt: "hi", requestKey: "wire" },
        (r) => assert.match(JSON.stringify(r), /unknown_run|unknown runId/)],
      moa_spawn_status: [{ runId: "no-such-run" },
        (r) => assert.match(JSON.stringify(r), /unknown_run|unknown runId/)],
      moa_spawn_cancel: [{ runId: "no-such-run", spawnId: "spawn-000000000000000000000000" },
        (r) => assert.match(JSON.stringify(r), /unknown_run|unknown runId/)],
      moa_spawn_wait: [{ runId: "no-such-run", spawnId: "spawn-000000000000000000000000" },
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
