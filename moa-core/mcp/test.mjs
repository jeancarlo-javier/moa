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

const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opSpawnStatus, opSpawnCancel, opSpawnWait, opInit, opBindingSave,
        workspaceSnapshot, computeDelta, sameModel, globToRegExp } =
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
  planner: { use: [g], effort: [xhigh] }
`);
  try {
    const loaded = opLoad({ cwd });
    assert.equal(loaded.dispatch, "adaptive-config");
    assert.equal(loaded.configPath, GLOBAL_CONFIG);
    assert.deepEqual(loaded.configPaths, { global: GLOBAL_CONFIG, project: null });
    assert.deepEqual(Object.keys(loaded.roles), ["planner"]);
    const resolved = await opResolve({ hostModels: HOST });
    assert.equal(resolved.effectiveConfig, path.join(cwd, ".moa", "effective-config.json"));
    assert.deepEqual(resolved.roles.planner.effort, ["xhigh"], "global-only role effort reaches resolve");
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

await ta("load: project roles union global staffing with per-key overrides", async () => {
  const repo = path.join(TMP, "layered");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, family: gpt }
  shared: { id: anthropic/claude-opus-4-8, family: global, tags: [strong] }
roles:
  instructed: { use: [g], differentModelFrom: empty, effort: [low] }
  empty: { use: [shared], effort: [medium] }
  globalOnly: { use: [g] }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  shared: { id: minimax/MiniMax-M3 }
roles:
  instructed: { instructions: project-only, effort: [xhigh] }
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
    assert.deepEqual(loaded.roles.globalOnly.use, ["g"]);
    assert.deepEqual(loaded.models.shared, { id: "minimax/MiniMax-M3" });
    assert.deepEqual(loaded.configPaths, { global: GLOBAL_CONFIG, project: path.join(repo, ".moa.yml") });
    const resolved = await opResolve({ hostModels: HOST });
    assert.ok(!resolved.error, JSON.stringify(resolved));
    assert.deepEqual(resolved.roles.instructed.effort, ["xhigh"], "project role effort overrides global");
    assert.deepEqual(resolved.roles.empty.effort, ["medium"], "global role effort survives the merge");
    const run = opRunStart({ task: "layered", steps: [{ phase: "work", role: "direct" }] });
    assert.ok(run.frame.config.includes(GLOBAL_CONFIG));
    assert.ok(run.frame.config.includes(path.join(repo, ".moa.yml")));
  } finally {
    clearGlobal();
  }
});

await ta("load: overlay without roles inherits the global palette", async () => {
  const repo = path.join(TMP, "layered-no-roles");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, family: gpt }
roles:
  planner: { use: [g] }
  coder: { use: [g] }
  verifier: { use: [g] }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
runtime: { workDir: project }
template: { base: engineering }
`);
  try {
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.deepEqual(Object.keys(loaded.roles), ["planner", "coder", "verifier"]);
  } finally {
    clearGlobal();
  }
});

await ta("load: overlay subset keeps its inherited differentModelFrom target", async () => {
  const repo = path.join(TMP, "layered-dependency");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  coderModel: { id: minimax/MiniMax-M3, family: minimax }
  verifierModel: { id: openai/gpt-5.5, family: gpt }
roles:
  coder: { use: [coderModel] }
  verifier: { use: [verifierModel], differentModelFrom: coder }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
roles:
  verifier: {}
`);
  try {
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.deepEqual(Object.keys(loaded.roles), ["coder", "verifier"]);
  } finally {
    clearGlobal();
  }
});

await ta("load: overlay pipeline may name a global-only role", async () => {
  const repo = path.join(TMP, "layered-pipeline");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  g: { id: openai/gpt-5.5, family: gpt }
roles:
  globalOnly: { use: [g] }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
pipelines:
  default:
    steps:
      - { phase: execute, role: globalOnly }
`);
  try {
    const loaded = opLoad({ cwd: repo });
    assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
    assert.equal(loaded.pipelines.default.steps[0], "execute(globalOnly)");
  } finally {
    clearGlobal();
  }
});

await ta("resolve: an inherited differentModelFrom constraint is still enforced", async () => {
  const repo = path.join(TMP, "layered-dependency-resolve");
  fs.mkdirSync(repo, { recursive: true });
  writeGlobal(`
schemaVersion: 1
models:
  coderModel: { id: minimax/MiniMax-M3, family: minimax }
  verifierModel: { id: openai/gpt-5.5, family: gpt }
roles:
  coder: { use: [coderModel] }
  verifier: { use: [verifierModel], differentModelFrom: coder }
`);
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
roles:
  verifier: {}
`);
  try {
    assert.ok(!opLoad({ cwd: repo }).errors);
    const resolved = await opResolve({ hostModels: HOST });
    assert.notEqual(resolved.roles.verifier.group, resolved.roles.coder.group);

    const blocked = await opResolve({ hostModels: [] });
    assert.equal(
      blocked.diagnostics.find((diagnostic) => diagnostic.role === "verifier")?.state,
      "blocked_dependency",
    );
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

await ta("resolve: clean config-present pool omits unselected discovery-only rows", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "trimcli", inventory: ["vendor/pick-1", "vendor/drop-1"] }) });
  const repo = path.join(TMP, "trim-clean");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  pick: { id: vendor/pick-1, family: fake }
roles:
  worker: { use: [pick] }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [{ id: "vendor/hosted-1", family: "fake" }] });
  assert.equal(result.roles.worker.model, "vendor/pick-1");
  assert.ok(!result.diagnostics.some((item) => item.state.startsWith("blocked_")));
  assert.equal(result.pool.length, 2);
  const ids = result.pool.map((model) => model.id);
  assert.ok(ids.includes("vendor/pick-1"));
  assert.ok(ids.includes("vendor/hosted-1"));
  assert.ok(!ids.includes("vendor/drop-1"));
});

await ta("resolve: auto-selected discovery-only model appears in roles AND pool", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "keepcli", inventory: ["vendor/keep-1", "vendor/lose-1"] }) });
  const repo = path.join(TMP, "trim-auto");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models: {}
roles:
  worker: { use: [auto] }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [] });
  assert.equal(result.roles.worker.model, "vendor/keep-1");
  assert.deepEqual(result.pool.map((model) => model.id), ["vendor/keep-1"]);
});

await ta("resolve: every blocked state returns the full candidate pool", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "rescuecli", inventory: ["vendor/work-1", "vendor/rescue-1"] }) });
  const cases = [
    ["blocked_no_binding", `
schemaVersion: 1
models:
  ghost: { id: nowhere/ghost-1, family: ghost }
roles:
  worker: { use: [ghost] }
pipelines: {}
`],
    ["blocked_no_model", `
schemaVersion: 1
models:
  work: { id: vendor/work-1, family: fake }
roles:
  a: { use: [work] }
  b: { use: [work], differentModelFrom: a }
pipelines: {}
`],
    ["blocked_dependency", `
schemaVersion: 1
models:
  work: { id: vendor/work-1, family: fake }
roles:
  a: { use: [work] }
  b: { use: [work], differentModelFrom: a }
  c: { use: [auto], differentModelFrom: b }
pipelines: {}
`],
  ];
  for (const [expected, config] of cases) {
    const repo = path.join(TMP, `blocked-pool-${expected}`);
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, ".moa.yml"), config);
    opLoad({ cwd: repo });
    const result = await opResolve({ hostModels: [] });
    assert.ok(result.diagnostics.some((item) => item.state === expected), expected);
    const rescue = result.pool.find((model) => model.id === "vendor/rescue-1");
    assert.ok(rescue, `${expected}: rescue row missing from pool`);
    assert.deepEqual(rescue.sources, ["binding:rescuecli"]);
    assert.ok(!Object.values(result.roles).some((role) => role.model === "vendor/rescue-1"));
  }
});

await ta("resolve: config-absent return keeps the full pool", async () => {
  resetBindings();
  clearGlobal();
  await opBindingSave({ profile: provenProfile({ tool: "barecli", inventory: ["vendor/bare-1"] }) });
  const bare = path.join(TMP, "trim-bare");
  fs.mkdirSync(bare, { recursive: true });
  opLoad({ cwd: bare });
  const result = await opResolve({ hostModels: [] });
  assert.deepEqual(result.roles, {});
  assert.ok(result.note);
  assert.ok(result.pool.some((model) => model.id === "vendor/bare-1"));
});

await ta("resolve: non-blocked diagnostics do not widen the pool", async () => {
  resetBindings();
  await opBindingSave({ profile: provenProfile({ tool: "diagcli", inventory: ["vendor/live-1", "vendor/spare-1"] }) });
  const repo = path.join(TMP, "trim-diag");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
models:
  typo: { id: vendor/liv-1, family: fake }
roles:
  worker: { use: [typo, auto] }
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [] });
  assert.equal(result.roles.worker.model, "vendor/live-1");
  assert.ok(result.diagnostics.some((item) => item.state === "unreachable_registry_model"));
  assert.ok(result.diagnostics.some((item) => item.state === "degraded_resolution"));
  assert.ok(!result.diagnostics.some((item) => item.state.startsWith("blocked_")));
  const ids = result.pool.map((model) => model.id);
  assert.ok(!ids.includes("vendor/spare-1"));
  assert.ok(ids.includes("vendor/liv-1"));
  assert.ok(ids.includes("vendor/live-1"));
});

await ta("resolve: a binding whose live discovery starts failing yields a diagnostic, not a throw", async () => {
  resetBindings();
  const flag = path.join(TMP, "exitcli-flag");
  fs.rmSync(flag, { force: true });
  const script = `if (require("fs").existsSync(${JSON.stringify(flag)})) process.exit(7); console.log("vendor/fake-9");`;
  const save = await opBindingSave({ profile: provenProfile({
    tool: "exitcli",
    modelDiscovery: { argv: ["{bin}", "-e", script], output: { format: "lines" }, timeoutSeconds: 10 },
  }) });
  assert.ok(!save.error, JSON.stringify(save));
  fs.writeFileSync(flag, ""); // live discovery now exits 7 CLEANLY — no spawn error, no stderr
  const repo = path.join(TMP, "discovery-exit"); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"),
    "schemaVersion: 1\nmodels:\n  fake: { id: vendor/fake-9, family: fake, tags: [strong] }\nroles:\n  worker: { use: [fake] }\npipelines: {}\n");
  opLoad({ cwd: repo });
  const result = await opResolve({ hostModels: [{ id: "vendor/fake-9", family: "fake", tags: ["strong"] }] });
  const diag = result.diagnostics.find((item) => item.tool === "exitcli");
  assert.equal(diag?.state, "model_discovery_failed", JSON.stringify(result.diagnostics));
  assert.ok(typeof diag.error === "string" && diag.error.length > 0, JSON.stringify(diag));
  assert.equal(result.roles.worker.model, "vendor/fake-9");
  fs.rmSync(path.join(process.env.MOA_HOME, ".moa", "bindings", "exitcli"), { recursive: true, force: true });
});


// --- run state machine --------------------------------------------------------

async function freshRun() {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  return opRunStart({ task: "test task", pipeline: "build", masterModel: "host/master", masterFamily: "host" });
}

// A fabricated snapshot. This is the payoff of injecting the snapshot instead of reading git
// inside op*: a snapshot is a plain object, so every delta case runs in-process,
// deterministically, with no subprocess and no filesystem.
const snap = (entries, { head = "h1", sinceHead = [] } = {}) =>
  ({ root: REPO, head, entries, sinceHead, reason: null });
// A snapshot moa REFUSED to take. Same shape workspaceSnapshot returns for a dirty submodule,
// an unreadable path, a truncated tree, or a failed HEAD diff.
const refusedSnap = (reason) => ({ root: REPO, head: "h1", entries: null, sinceHead: [], reason });

// ONE real-git fixture mechanism, many scenarios. A fresh repo per call keeps the scenarios
// order-independent (git init is ~10ms); returns null when there is no git binary, and each
// caller returns early — the check still counts, so the total is the same on a machine
// without git. Degrade, never fail: the same contract the runtime honors.
async function gitFixture(name) {
  const { execFileSync } = await import("node:child_process");
  const repo = path.join(TMP, `git-${name}`);
  fs.mkdirSync(repo, { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  try { git("init", "-q", "-b", "main"); } catch { return null; }
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  return { repo, git, write: (rel, body) => {
    const abs = path.join(repo, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    return abs;
  } };
}

const { execFileSync } = await import("node:child_process");

// The real git binary, resolved once — and BEFORE any shim is on PATH. gitFixture already returns
// null without git and every caller returns early, so this is only reached on a machine with one.
const REAL_GIT = (() => {
  try {
    return execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  } catch { return null; }
})();

// A REAL `git` on PATH that runs the real binary and performs one filesystem mutation either
// strictly BEFORE or strictly AFTER the invocation whose argv contains `on`. This is scheduling,
// not stubbing: git actually runs, and the mutation lands in a window no in-process hook can
// reach — `execFile` is destructured at server import, so a git read's completion has no hook.
// `execFile` resolves "git" through the child's inherited PATH at call time, so mutating
// process.env.PATH here is enough. `" $* "` with `*" status "*` matches the status read and
// matches NEITHER rev-parse, which is what makes the two windows addressable independently.
//
// The mutation is BARRIERED against the HEAD read, and that is not belt-and-braces. The snapshot
// launches `status` and `rev-parse HEAD` CONCURRENTLY, so a mutation scheduled off `status` alone
// races the HEAD child: land it while `.git` — or the project directory — sits between the two
// renames and HEAD fails, the snapshot takes the unreadable-HEAD refusal, and the row fails having
// proved nothing (seen twice in five runs under load). So the HEAD invocation writes a marker once
// the REAL read has returned, and the mutating branch waits for that marker before touching
// anything: the two windows are ordered by the filesystem rather than by hope.
//
// The wait is BOUNDED — 3s, comfortably under gitRead's 10s timeout. If the HEAD read never comes
// the shim refuses to run git and restore() throws, so a barrier wired to a command nobody calls
// fails the suite loudly instead of hanging it.
// Returns a restore function; ALWAYS call it in a finally — the fixture helpers shell out to git.
function gitShim(name, { on, when, sh }) {
  const dir = path.join(TMP, `shim-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const mark = path.join(dir, "head-read");
  const stuck = path.join(dir, "barrier-timeout");
  for (const p of [mark, stuck]) fs.rmSync(p, { force: true });
  // First case wins, so the HEAD read is never itself a mutation window. `rev-parse HEAD` is the
  // only argv here carrying a bare ` HEAD `: not --show-toplevel, not --absolute-git-dir, not
  // rev-list, not the sha-to-sha diff.
  const head = `case " $* " in *" HEAD "*) ${REAL_GIT} "$@"; s=$?; : > "${mark}"; exit $s ;; esac`;
  const wait = `i=0; while [ ! -f "${mark}" ]; do i=$((i+1)); ` +
    `if [ "$i" -gt 120 ]; then : > "${stuck}"; exit 99; fi; sleep 0.025; done`;
  fs.writeFileSync(path.join(dir, "git"), when === "before"
    ? `#!/bin/sh\n${head}\ncase " $* " in *" ${on} "*) ${wait}; ${sh} ;; esac\nexec ${REAL_GIT} "$@"\n`
    : `#!/bin/sh\n${head}\n${REAL_GIT} "$@"; s=$?\ncase " $* " in *" ${on} "*) ${wait}; ${sh} ;; esac\nexit $s\n`,
    { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = `${dir}${path.delimiter}${prev}`;
  return () => {
    process.env.PATH = prev;
    if (fs.existsSync(stuck))
      throw new Error(`gitShim(${name}): barrier timed out — the real HEAD read never completed, so the scheduled mutation never ran`);
  };
}

// A run in REPO with ad-hoc steps and an injected entry snapshot. Not a check — plumbing for
// the delta rows below, which all need the same three lines.
async function deltaRun(steps, snapshot) {
  opLoad({ cwd: REPO });
  await opResolve({ hostModels: HOST });
  return opRunStart({
    task: "delta", steps, snapshot,
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
  });
}
const manifestOf = (dir, runId) =>
  JSON.parse(fs.readFileSync(path.join(dir, ".moa", "runs", runId, "manifest.json"), "utf8"));

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
    roles: { planner: { use: ["opus", "auto"], effort: ["xhigh"] } } });
  assert.ok(r1.written.endsWith(".moa.yml"));
  assert.equal(r1.spliced, true);
  const written = fs.readFileSync(r1.written, "utf8");
  assert.ok(written.includes("anthropic/claude-opus-4-8"));
  assert.ok(written.includes("#"), "template comments survive");
  assert.deepEqual(YAML.parse(written).roles.planner.effort, ["xhigh"], "project splice persists role effort");

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

    const effortRepo = path.join(TMP, "invalid-project-effort");
    fs.mkdirSync(effortRepo, { recursive: true });
    const emptyEffort = await opInit({
      scope: "project",
      template: "lite-build",
      cwd: effortRepo,
      registry: { opus: { id: "anthropic/claude-opus-4-8" } },
      roles: { planner: { use: ["opus", "auto"], effort: [] } },
    });
    assert.match(emptyEffort.error, /effort/);
    assert.equal(fs.existsSync(path.join(effortRepo, ".moa.yml")), false);
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
      roles: { planner: { use: ["g", "auto"], effort: ["xhigh"] }, verifier: ["g", "auto"] },
    });
    assert.equal(result.written, GLOBAL_CONFIG);
    const config = YAML.parse(fs.readFileSync(GLOBAL_CONFIG, "utf8"));
    assert.deepEqual(Object.keys(config), ["schemaVersion", "models", "roles"]);
    assert.deepEqual(config.roles.planner.use, ["g", "auto"]);
    assert.deepEqual(config.roles.planner.effort, ["xhigh"], "global init persists role effort");
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
    const emptyEffort = await opInit({
      scope: "global",
      registry: { g: { id: "openai/gpt-5.5" } },
      roles: { planner: { use: ["g"], effort: [] } },
    });
    assert.match(emptyEffort.error, /effort/);
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
  globalOnly: { use: [reasoner, auto] }
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
    assert.deepEqual(loaded.roles.globalOnly.use, ["reasoner", "auto"]);
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

await ta("tools/call: retention invariant + trim survive the wire into run_start", async () => {
  resetBindings();
  clearGlobal();
  await opBindingSave({ profile: provenProfile({ tool: "retaincli", inventory: ["vendor/picked-1", "vendor/extra-1"] }) });
  const repo = path.join(TMP, "retention-wire"); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"),
    "schemaVersion: 1\nmodels: {}\nroles:\n  worker: { use: [auto] }\npipelines: {}\n");
  const c = await mcpClient({ cwd: repo });
  try {
    assert.ok(!(await c.call("moa_load", { cwd: repo })).error);
    const r = await c.call("moa_resolve", { hostModels: [{ id: "vendor/hosted-1", family: "fake" }] });
    assert.ok(!r.error, JSON.stringify(r));
    assert.ok(!r.diagnostics.some((d) => d.state.startsWith("blocked_")));
    const ids = r.pool.map((m) => m.id);
    for (const [name, role] of Object.entries(r.roles))
      assert.ok(ids.includes(role.model), `role ${name} model ${role.model} missing from pool`);
    const selected = new Set(Object.values(r.roles).map((role) => role.model));
    for (const m of r.pool)
      assert.ok(m.sources.includes("registry") || m.sources.includes("host") || selected.has(m.id),
        `row ${m.id} fails the retention predicate`);
    assert.equal(r.roles.worker.model, "vendor/picked-1");
    assert.ok(!ids.includes("vendor/extra-1"), "unselected discovery row must be trimmed");
    assert.ok(ids.includes("vendor/hosted-1"), "host row must be retained");
    const run = await c.call("moa_run_start", { task: "retention",
      steps: [{ phase: "work", role: "worker" }], masterModel: "host/master", masterFamily: "host" });
    assert.ok(run.runId, `discovery-only resolved role must survive into run_start: ${JSON.stringify(run)}`);
  } finally { c.stop(); }
});

await ta("tools/call: failing live discovery surfaces as a diagnostic over JSON-RPC, not an error", async () => {
  resetBindings();
  clearGlobal();
  const flag = path.join(TMP, "wire-exit-flag");
  fs.rmSync(flag, { force: true });
  const script = `if (require("fs").existsSync(${JSON.stringify(flag)})) process.exit(7); console.log("vendor/fake-9");`;
  const save = await opBindingSave({ profile: provenProfile({
    tool: "wireexitcli",
    modelDiscovery: { argv: ["{bin}", "-e", script], output: { format: "lines" }, timeoutSeconds: 10 },
  }) });
  assert.ok(!save.error, JSON.stringify(save));
  fs.writeFileSync(flag, ""); // discovery now exits 7 cleanly
  const repo = path.join(TMP, "wire-exit"); fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"),
    "schemaVersion: 1\nmodels:\n  fake: { id: vendor/fake-9, family: fake, tags: [strong] }\nroles:\n  worker: { use: [fake] }\npipelines: {}\n");
  const c = await mcpClient({ cwd: repo });
  try {
    assert.ok(!(await c.call("moa_load", { cwd: repo })).error);
    const r = await c.call("moa_resolve", { hostModels: [{ id: "vendor/fake-9", family: "fake", tags: ["strong"] }] });
    assert.ok(!r.error && !r._threw && !r._rpcError, JSON.stringify(r));
    const diag = r.diagnostics.find((item) => item.tool === "wireexitcli");
    assert.equal(diag?.state, "model_discovery_failed", JSON.stringify(r.diagnostics));
    assert.ok(typeof diag.error === "string" && diag.error.length > 0, JSON.stringify(diag));
    assert.equal(r.roles.worker.model, "vendor/fake-9");
    assert.ok(Array.isArray(r.pool) && r.pool.length > 0);
  } finally {
    c.stop();
    fs.rmSync(path.join(process.env.MOA_HOME, ".moa", "bindings", "wireexitcli"), { recursive: true, force: true });
  }
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

// --- observed provenance: A — computeDelta over fabricated snapshots ----------

await ta("delta: an edit to an already-dirty file is observed", async () => {
  // The 139333f shape: dirty at entry, edited again, still dirty at report. A set difference
  // over PATHS reports nothing here; only content identity sees it.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const r = opStepReport({ runId, phase: "execute", summary: "edited again",
    changedFiles: ["a.js"], snapshot: snap({ "a.js": "H2" }) });
  assert.equal(r.observed.source, "git", JSON.stringify(r.observed));
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
});

await ta("delta: a dirty→clean revert is observed", async () => {
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const r = opStepReport({ runId, phase: "execute", summary: "reverted",
    changedFiles: ["a.js"], snapshot: snap({}) });
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
});

await ta("delta: an untouched dirty file is not a mutation", async () => {
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const r = opStepReport({ runId, phase: "execute", summary: "touched nothing",
    snapshot: snap({ "a.js": "H1" }) });
  assert.equal(r.observed.source, "git", JSON.stringify(r.observed));
  assert.deepEqual(r.observed.files, [], JSON.stringify(r.observed));
});

await ta("delta: a deletion is a change, not an absence", async () => {
  // identityOf returns null for ENOENT; `undefined` (absent key) !== null, so it registers.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({}));
  const r = opStepReport({ runId, phase: "execute", summary: "deleted a.js",
    changedFiles: ["a.js"], snapshot: snap({ "a.js": null }) });
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
});

await ta("delta: a committed-and-clean phase is observed via the HEAD diff", async () => {
  // The working tree is clean at both ends; nothing but sinceHead witnesses the write.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const r = opStepReport({ runId, phase: "execute", summary: "committed",
    changedFiles: ["a.js"], snapshot: snap({}, { head: "h2", sinceHead: ["a.js"] }) });
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
});

await ta("delta: the run store workDir never appears, and is matched projectDir-relative", async () => {
  // REPO's default workDir is `.moa`; excludeRelFor converts the ABSOLUTE workDirOf() into the
  // projectDir-relative prefix the snapshot keys actually use. Compare the wrong frame and the
  // run store's own writes read as the phase's mutations.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({}));
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a and the run store",
    changedFiles: ["a.js"], snapshot: snap({ ".moa/runs/x.json": "H", "a.js": "H" }) });
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
});

await ta("delta: a workDir outside the project excludes nothing", async () => {
  // `workDir: ../shared` relative-izes to an escaping path. Returning "" or ".." there would
  // prefix-match EVERY path and blind observation entirely — the failure worth guarding.
  const dir = path.join(TMP, "workdir-outside");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
runtime:
  workDir: ../shared
models:
  fake: { id: vendor/fake-9, family: fake, tags: [strong] }
roles:
  coder: { use: [fake] }
pipelines: {}
`);
  assert.equal(opLoad({ cwd: dir }).errors, undefined);
  await opResolve({ hostModels: HOST });
  const { runId } = opRunStart({ task: "outside", steps: [{ phase: "execute", role: "coder" }],
    masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude", snapshot: snap({}) });
  const r = opStepReport({ runId, phase: "execute", summary: "wrote both",
    snapshot: snap({ ".moa/x": "H", "a.js": "H" }) });
  assert.deepEqual(r.observed.files, [".moa/x", "a.js"], JSON.stringify(r.observed));
});

await ta("delta: a refused snapshot degrades to unobserved and carries its reason", async () => {
  // Both refusals the failure-mode table creates. A refusal must never read as an observation.
  const cap = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const capped = opStepReport({ runId: cap.runId, phase: "execute", summary: "too dirty",
    changedFiles: ["a.js"], snapshot: refusedSnap("more than 2000 dirty paths") });
  assert.equal(capped.observed.source, "unobserved", JSON.stringify(capped.observed));
  assert.ok(/more than 2000/.test(capped.observed.reason), capped.observed.reason);

  const sub = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const refused = opStepReport({ runId: sub.runId, phase: "execute", summary: "dirty submodule",
    changedFiles: ["a.js"],
    snapshot: refusedSnap("a dirty path could not be identified — unreadable, or a directory git reports as a single path (a dirty submodule)") });
  assert.equal(refused.observed.source, "unobserved", JSON.stringify(refused.observed));
  assert.ok(/could not be identified/.test(refused.observed.reason), refused.observed.reason);
});

await ta("delta: a non-git projectDir yields unobserved and the declared fallback", async () => {
  // The tripwire for the environment assumption every other row rests on: TMP is NOT a git
  // repository, which is what keeps all 124 pre-existing checks on the declared path. If that
  // ever stops being true, this row fails loudly instead of twenty failing mysteriously.
  assert.equal(await workspaceSnapshot(REPO), null, "TMP must not be inside a git repository");
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }]);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a", changedFiles: ["a.js"] });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("delta: a legacy manifest without observed uses changedFiles", async () => {
  // Manifests written before this feature carry no `observed`; mutationsOf must fall back
  // rather than read undefined as "nothing changed" and hand out a free `done`.
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder" },
    { phase: "wrap", role: "coder" },
  ], snap({}));
  opStepReport({ runId, phase: "execute", summary: "wrote a", changedFiles: ["a.js"],
    snapshot: snap({ "a.js": "H1" }) });
  const file = path.join(REPO, ".moa", "runs", runId, "manifest.json");
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const p of m.phases) delete p.observed;
  fs.writeFileSync(file, JSON.stringify(m));
  const r = opStepReport({ runId, phase: "wrap", summary: "done" });
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("run_start: the initial snapshot is stored for the first step", async () => {
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], snap({ "a.js": "H1" }));
  const m = manifestOf(REPO, runId);
  assert.deepEqual(m.snapshotAtStepEntry.entries, { "a.js": "H1" }, JSON.stringify(m.snapshotAtStepEntry));
  assert.equal(m.attempt, 0);
});

// --- observed provenance: B — real git, invocation level ----------------------

await ta("snapshot: a staged rename with spaces, and git-ignored paths", async () => {
  // `-z` records are NUL-terminated with no quoting, and an R/C record is followed by a second
  // bare record carrying the counterpart path — parse that wrong and a renamed path silently
  // becomes two half-paths. No fabrication can check this.
  const fx = await gitFixture("rename");
  if (!fx) return; // no git binary: degrade, never fail — the check still counts
  fx.write("old name.txt", "x\n");
  fx.write(".gitignore", "ignored.txt\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");

  const before = await workspaceSnapshot(fx.repo);
  assert.ok(before?.entries, JSON.stringify(before));
  fs.renameSync(path.join(fx.repo, "old name.txt"), path.join(fx.repo, "new name.txt"));
  fx.write("ignored.txt", "noise\n");
  fx.git("add", "-A"); // stage so git reports R, not D + ??
  const after = await workspaceSnapshot(fx.repo, before.head);

  const d = computeDelta({ before, after, declaredFiles: [] });
  assert.equal(d.source, "git", JSON.stringify(d));
  assert.deepEqual(d.files, ["new name.txt", "old name.txt"], JSON.stringify(d));
  assert.ok(!d.files.includes("ignored.txt"), "git-ignored paths are out of scope");
});

await ta("snapshot: an already-dirty file edited again is observed", async () => {
  // The invocation-level 139333f proof. Status reports {a.js} at BOTH ends, so every
  // path-set implementation — one-way or symmetric — returns [] here.
  const fx = await gitFixture("dirty-again");
  if (!fx) return;
  fx.write("a.js", "one\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  fx.write("a.js", "two\n");
  const before = await workspaceSnapshot(fx.repo);
  assert.deepEqual(Object.keys(before.entries), ["a.js"], JSON.stringify(before));
  fx.write("a.js", "three\n");
  const after = await workspaceSnapshot(fx.repo, before.head);
  assert.deepEqual(Object.keys(after.entries), ["a.js"], "still exactly one dirty PATH");

  const d = computeDelta({ before, after, declaredFiles: [] });
  assert.deepEqual(d.files, ["a.js"], JSON.stringify(d));
});

await ta("snapshot: a dirty file reverted clean is observed", async () => {
  // Defeats a one-way `after \ before` subtraction; a symmetric difference also catches it.
  const fx = await gitFixture("revert");
  if (!fx) return;
  fx.write("a.js", "one\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  fx.write("a.js", "two\n");
  const before = await workspaceSnapshot(fx.repo);
  fx.git("checkout", "--", "a.js");
  const after = await workspaceSnapshot(fx.repo, before.head);
  assert.deepEqual(Object.keys(after.entries), [], "tree is clean again");

  const d = computeDelta({ before, after, declaredFiles: [] });
  assert.deepEqual(d.files, ["a.js"], JSON.stringify(d));
});

await ta("snapshot: a committed, clean tree is observed via sinceHead", async () => {
  // A worker that commits leaves nothing for status to report. Nothing but the HEAD diff sees it.
  const fx = await gitFixture("committed");
  if (!fx) return;
  fx.write("a.js", "one\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  const before = await workspaceSnapshot(fx.repo);
  assert.deepEqual(Object.keys(before.entries), [], "clean at entry");
  fx.write("a.js", "two\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "work");
  const after = await workspaceSnapshot(fx.repo, before.head);
  assert.deepEqual(after.sinceHead, ["a.js"], JSON.stringify(after));
  assert.deepEqual(Object.keys(after.entries), [], "clean at report too");

  const d = computeDelta({ before, after, declaredFiles: [] });
  assert.deepEqual(d.files, ["a.js"], JSON.stringify(d));
});

await ta("snapshot: a nested projectDir keys paths relative to itself", async () => {
  // Correction 3's executable proof: porcelain paths are repo-root-relative ALWAYS, and
  // projectDir is the CONFIG's directory. Compare those two frames directly and the workDir
  // exclusion silently matches nothing.
  const fx = await gitFixture("nested");
  if (!fx) return;
  fx.write("packages/api/a.js", "x\n");
  fx.write("root.js", "y\n");
  const s = await workspaceSnapshot(path.join(fx.repo, "packages", "api"));
  assert.ok(s?.entries, JSON.stringify(s));
  const keys = Object.keys(s.entries);
  assert.ok(keys.includes("a.js"), JSON.stringify(keys));
  assert.ok(!keys.includes("packages/api/a.js"), JSON.stringify(keys));
  assert.ok(!keys.includes("root.js"), "a sibling outside projectDir is out of scope");
  // `--show-toplevel` is physical, so compare against the resolved repo root, not the path we
  // happened to walk in with (on macOS os.tmpdir() alone differs: /var -> /private/var).
  assert.equal(s.root, fs.realpathSync(fx.repo), s.root);
});

await ta("snapshot: a file named __proto__ is a real entry, not the prototype", async () => {
  // `entries["__proto__"] = hash` on a `{}` literal hits the prototype SETTER and the entry
  // vanishes (0 own keys). Object.create(null) has no such setter, and a manifest round trip
  // must preserve it as a real own property.
  const fx = await gitFixture("proto");
  if (!fx) return;
  fx.write("__proto__", "danger\n");
  const s = await workspaceSnapshot(fx.repo);
  assert.ok(s?.entries, JSON.stringify(s));
  assert.ok(Object.keys(s.entries).includes("__proto__"), JSON.stringify(Object.keys(s.entries)));
  assert.match(s.entries["__proto__"], /^[0-9a-f]{64}$/);
  const round = JSON.parse(JSON.stringify(s));
  assert.ok(Object.keys(round.entries).includes("__proto__"), JSON.stringify(round.entries));
  assert.match(round.entries["__proto__"], /^[0-9a-f]{64}$/);
});

// --- observed provenance: C — the 139333f regression, both directions ---------

await ta("finalize cannot re-declare an earlier phase's writes as its own", async () => {
  // `execute` really wrote a.js; the gate approved it; `finalize` then DECLARES a.js again
  // while changing nothing. Declared-only, that is a post-gate mutation and the run finishes
  // unverified. Observed, finalize mutated nothing and the run is legitimately done.
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder" },
    { phase: "validate", role: "verifier", gate: "critical" },
    { phase: "finalize", role: "coder" },
  ], snap({}));
  const coder = { producerModel: "openai/gpt-5.5", producerFamily: "gpt" };
  const gate = { producerModel: "anthropic/claude-opus-4-8", producerFamily: "claude" };
  opStepReport({ runId, phase: "execute", summary: "wrote a", changedFiles: ["a.js"],
    snapshot: snap({ "a.js": "H1" }), ...coder });
  opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "lgtm",
    snapshot: snap({ "a.js": "H1" }), ...gate });
  const r = opStepReport({ runId, phase: "finalize", summary: "no-op",
    changedFiles: ["a.js"], snapshot: snap({ "a.js": "H1" }), ...coder });
  assert.deepEqual(r.observed.files, [], JSON.stringify(r.observed));
  assert.deepEqual(r.mutationDiscrepancy.phantom, ["a.js"], JSON.stringify(r.mutationDiscrepancy));
  assert.equal(r.terminal, "done", JSON.stringify(r));
});

await ta("finalize that really writes after the critical gate still finishes unverified", async () => {
  // The inverse, and the row that cannot pass without observation: with changedFiles: [] the
  // DECLARED-only floor sees no post-gate write and returns `done`.
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder" },
    { phase: "validate", role: "verifier", gate: "critical" },
    { phase: "finalize", role: "coder" },
  ], snap({}));
  const coder = { producerModel: "openai/gpt-5.5", producerFamily: "gpt" };
  const gate = { producerModel: "anthropic/claude-opus-4-8", producerFamily: "claude" };
  opStepReport({ runId, phase: "execute", summary: "wrote a", changedFiles: ["a.js"],
    snapshot: snap({ "a.js": "H1" }), ...coder });
  opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "lgtm",
    snapshot: snap({ "a.js": "H1" }), ...gate });
  const r = opStepReport({ runId, phase: "finalize", summary: "quietly edited a",
    changedFiles: [], snapshot: snap({ "a.js": "H2" }), ...coder });
  assert.deepEqual(r.observed.files, ["a.js"], JSON.stringify(r.observed));
  assert.deepEqual(r.mutationDiscrepancy.undeclared, ["a.js"], JSON.stringify(r.mutationDiscrepancy));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
  assert.match(r.label, /covering the last change/);
});

// --- observed provenance: D — route observation (advisory) --------------------

// Two ad-hoc steps against a registered external route: enough to report a phase and still
// have a gate left to report next.
async function twoStepExternalRun(profile = runnableProfile()) {
  const saved = await opBindingSave({ profile });
  assert.equal(saved.error, undefined, JSON.stringify(saved));
  const repo = writeRouteRepo(`route-obs-${crypto.randomUUID()}`, "external", profile.tool);
  assert.equal(opLoad({ cwd: repo }).errors, undefined);
  await opResolve({ hostModels: HOST });
  return opRunStart({
    task: "route observation",
    steps: [{ phase: "work", role: "worker" }, { phase: "check", role: "worker", gate: "critical" }],
    masterModel: "host/master", masterFamily: "host",
  });
}

await ta("step_report: a named spawnId observes the route", async () => {
  const { run } = await startExternalRun();
  const job = await spawnResult(run.runId, "work", "hello");
  assert.equal(job.status, "completed", JSON.stringify(job));
  const r = opStepReport({ runId: run.runId, phase: "work", summary: "did it",
    producerModel: "vendor/fake-9", spawnId: job.spawnId });
  assert.equal(r.routeObservation.source, "spawn-record", JSON.stringify(r.routeObservation));
  assert.equal(r.routeObservation.observedRoute, "vendor/fake-9");
  assert.equal(r.routeObservation.agrees, true, JSON.stringify(r.routeObservation));
});

await ta("step_report: a spawnId from another step is rejected", async () => {
  // Evidence about a different PHASE is a conductor bug, not a downgrade.
  const run = await twoStepExternalRun();
  const job = await spawnResult(run.runId, "work", "hello");
  assert.equal(job.status, "completed", JSON.stringify(job));
  opStepReport({ runId: run.runId, phase: "work", summary: "did it", spawnId: job.spawnId });
  const r = opStepReport({ runId: run.runId, phase: "check", verdict: "APPROVE",
    summary: "lgtm", spawnId: job.spawnId });
  assert.equal(r.code, "spawn_mismatch", JSON.stringify(r));
});

await ta("step_report: a stale completed job from a prior attempt is not observation", async () => {
  // Correction 4: `attempt` is server-internal and appears in no response, so refusing a report
  // over it would punish the conductor for information it is never given. Downgrade, never reject.
  const run = await twoStepExternalRun();
  opStepReport({ runId: run.runId, phase: "work", summary: "did it" });
  const job = await spawnResult(run.runId, "check", "verify");
  assert.equal(job.status, "completed", JSON.stringify(job));
  const errored = opStepReport({ runId: run.runId, phase: "check", verdict: "ERROR",
    summary: "gate blew up" });
  assert.ok(errored.retry, JSON.stringify(errored));
  const r = opStepReport({ runId: run.runId, phase: "check", verdict: "APPROVE",
    summary: "lgtm", spawnId: job.spawnId });
  assert.equal(r.error, undefined, JSON.stringify(r));
  assert.equal(r.routeObservation.source, "declared", JSON.stringify(r.routeObservation));
  assert.match(r.routeObservation.reason, /attempt 0/);
});

await ta("step_report: a native phase records 'declared', never a mismatch", async () => {
  const { runId } = await freshRun();
  const r = opStepReport({ runId, phase: "plan", summary: "planned" });
  assert.equal(r.routeObservation.source, "declared", JSON.stringify(r.routeObservation));
  assert.equal(r.routeObservation.agrees, null);
  assert.match(r.routeObservation.reason, /no spawn record/);
});

await ta("step_report: a failed spawn is not observation", async () => {
  // A route that ran and FAILED proves nothing about who authored the artifact.
  const { run } = await startExternalRun(runnableProfile({ tool: "exit-route", mode: "exit" }));
  const job = await spawnResult(run.runId, "work", "hello");
  assert.equal(job.status, "failed", JSON.stringify(job));
  const r = opStepReport({ runId: run.runId, phase: "work", summary: "it broke" });
  assert.equal(r.routeObservation.source, "declared", JSON.stringify(r.routeObservation));
  assert.match(r.routeObservation.reason, /spawn failed/);
});

await ta("step_report: decorated vs canonical model ids report indeterminate, not mismatch", () => {
  // Correction 2: a vendor deployment id and its canonical name are ONE model wearing two
  // names. A confident `false` there would teach the conductor to ignore the field.
  assert.equal(sameModel("bedrock/us.anthropic.claude-sonnet-4-6-v1:0", "anthropic/claude-sonnet-4-6"), null);
  assert.equal(sameModel("openai/gpt-5.5", "openai/gpt-5.5"), true);
  assert.equal(sameModel("vendor/fake-9", "vendor/checker-1"), false);
  assert.equal(sameModel(null, "x"), null);
});

await ta("step_report: a route mismatch is reported and the phase still advances", async () => {
  const run = await twoStepExternalRun();
  const job = await spawnResult(run.runId, "work", "hello");
  assert.equal(job.status, "completed", JSON.stringify(job));
  const r = opStepReport({ runId: run.runId, phase: "work", summary: "did it",
    producerModel: "openai/gpt-5.5", spawnId: job.spawnId });
  assert.equal(r.routeObservation.agrees, false, JSON.stringify(r.routeObservation));
  assert.ok(r.next, JSON.stringify(r));
});

await ta("step_report: route observation cannot lift a strict critical-gate halt", async () => {
  resetBindings();
  const profile = runnableProfile({ tool: `strict-route-${crypto.randomUUID()}` });
  assert.equal((await opBindingSave({ profile })).error, undefined);
  const repo = path.join(TMP, "strict-route"); fs.mkdirSync(repo, { recursive: true });
  // worker routes to fake-9 through the tool; verifier is host-native checker-1. The DECLARED
  // producer is checker-1 in BOTH runs, so the producer and verifier share a group -> self-check
  // -> strict + critical -> halt. Only the ROUTE differs from the declaration.
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
master:
  mode: strict
models:
  fake:  { id: vendor/fake-9, family: fake, tags: [strong], binding: ${profile.tool} }
  check: { id: vendor/checker-1, family: check, tags: [strong] }
roles:
  worker:   { use: [fake] }
  verifier: { use: [check] }
pipelines: {}
`);
  const hosts = [...HOST, { id: "vendor/checker-1", family: "check", tags: ["strong"] }];
  const steps = [{ phase: "work", role: "worker" },
                 { phase: "check", role: "verifier", gate: "critical" }];
  const declared = { producerModel: "vendor/checker-1", producerFamily: "check" };
  const start = async () => {
    assert.equal(opLoad({ cwd: repo }).errors, undefined);
    await opResolve({ hostModels: hosts });
    return opRunStart({ task: "strict route", steps, masterModel: "host/master", masterFamily: "host" });
  };

  const controlRun = await start();
  const control = opStepReport({ runId: controlRun.runId, phase: "work",
    summary: "wrote a", changedFiles: ["a.js"], ...declared });

  const mismatchRun = await start();
  const job = await spawnResult(mismatchRun.runId, "work", "x");
  assert.equal(job.status, "completed", JSON.stringify(job));
  const mismatch = opStepReport({ runId: mismatchRun.runId, phase: "work",
    summary: "wrote a", changedFiles: ["a.js"], ...declared, spawnId: job.spawnId });

  // the route evidence really fired — without this the equalities below are vacuous
  assert.equal(mismatch.routeObservation.source, "spawn-record");
  assert.equal(mismatch.routeObservation.observedRoute, "vendor/fake-9");
  assert.equal(mismatch.routeObservation.agrees, false, JSON.stringify(mismatch.routeObservation));
  assert.equal(control.routeObservation.source, "declared");

  // and it changed nothing that decides the run
  assert.equal(control.terminal, "verification_unavailable", JSON.stringify(control));
  assert.equal(mismatch.terminal, control.terminal, JSON.stringify(mismatch));
  assert.equal(control.step.independence.grade, "self-check");
  assert.equal(mismatch.step.independence.grade, control.step.independence.grade);
  assert.equal(control.step.independence.pass, false);
  assert.equal(mismatch.step.independence.pass, control.step.independence.pass);
  assert.equal(control.step.blocked, "verification_unavailable");
  assert.equal(mismatch.step.blocked, control.step.blocked);
});

await ta("step_report: advisories survive REVISE, BLOCKED, ERROR and terminal returns", async () => {
  // Every decorated return, and the spread order that keeps a result key winning.
  const carries = (r, label) => {
    assert.ok("observed" in r, `${label}: no observed — ${JSON.stringify(r)}`);
    assert.ok("routeObservation" in r, `${label}: no routeObservation — ${JSON.stringify(r)}`);
  };
  const gated = [{ phase: "execute", role: "coder" },
                 { phase: "validate", role: "verifier", gate: "critical", loopBackTo: "execute" }];

  const loop = await deltaRun(gated, snap({}));
  opStepReport({ runId: loop.runId, phase: "execute", summary: "wrote" });
  const looped = opStepReport({ runId: loop.runId, phase: "validate", verdict: "REVISE", summary: "no" });
  carries(looped, "REVISE"); assert.equal(looped.looped, true, JSON.stringify(looped));

  const err = await deltaRun(gated, snap({}));
  opStepReport({ runId: err.runId, phase: "execute", summary: "wrote" });
  const errored = opStepReport({ runId: err.runId, phase: "validate", verdict: "ERROR", summary: "boom" });
  carries(errored, "ERROR"); assert.ok(errored.retry, JSON.stringify(errored));

  const blk = await deltaRun(gated, snap({}));
  opStepReport({ runId: blk.runId, phase: "execute", summary: "wrote" });
  const blocked = opStepReport({ runId: blk.runId, phase: "validate", verdict: "BLOCKED", summary: "stop" });
  carries(blocked, "BLOCKED");
  assert.equal(blocked.terminal, "blocked_verifier_disagreement", JSON.stringify(blocked));

  const nxt = await deltaRun(gated, snap({}));
  const next = opStepReport({ runId: nxt.runId, phase: "execute", summary: "wrote" });
  carries(next, "next"); assert.ok(next.next, JSON.stringify(next));

  const fin = await deltaRun([{ phase: "execute", role: "coder" }], snap({}));
  const done = opStepReport({ runId: fin.runId, phase: "execute", summary: "wrote nothing" });
  carries(done, "terminal"); assert.equal(done.terminal, "done", JSON.stringify(done));

  const max = await deltaRun(gated, snap({}));
  opStepReport({ runId: max.runId, phase: "execute", summary: "wrote" });
  let last;
  for (let i = 0; i <= 2; i++) {
    opStepReport({ runId: max.runId, phase: "execute", summary: "reworked" });
    last = opStepReport({ runId: max.runId, phase: "validate", verdict: "REVISE", summary: "still no" });
  }
  carries(last, "max_loops_exceeded");
  assert.equal(last.terminal, "max_loops_exceeded", JSON.stringify(last));
});

await ta("describeStep: producerObservation labels the producer phase, not the verifier", async () => {
  const run = await twoStepExternalRun();
  const job = await spawnResult(run.runId, "work", "hello");
  assert.equal(job.status, "completed", JSON.stringify(job));
  const r = opStepReport({ runId: run.runId, phase: "work", summary: "did it",
    producerModel: "vendor/fake-9", spawnId: job.spawnId });
  assert.equal(r.next.independence.producerObservation, "observed-route", JSON.stringify(r.next.independence));
  const gate = opStepReport({ runId: run.runId, phase: "check", verdict: "APPROVE", summary: "lgtm" });
  assert.equal(gate.verifierExecution, "declared", JSON.stringify(gate));
});

await ta("finish: verification counts critical gates once per phase, not per attempt", async () => {
  const gated = [{ phase: "execute", role: "coder" },
                 { phase: "validate", role: "verifier", gate: "critical" }];
  const { runId } = await deltaRun(gated, snap({}));
  opStepReport({ runId, phase: "execute", summary: "wrote nothing" });
  opStepReport({ runId, phase: "validate", verdict: "ERROR", summary: "boom" });
  const r = opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "lgtm" });
  assert.equal(r.verification.criticalGates, 1, JSON.stringify(r.verification));
  assert.equal(r.verification.routeObserved + r.verification.declared, 1, JSON.stringify(r.verification));
});

// --- observed provenance: E — static write-set policy -------------------------

await ta("write-set: a path outside the declared globs is flagged, not blocked", async () => {
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder", writeSet: ["src/**"] },
    { phase: "validate", role: "verifier", gate: "critical" },
  ], snap({}));
  const r = opStepReport({ runId, phase: "execute", summary: "wrote infra",
    changedFiles: ["infra/main.tf"], snapshot: snap({ "infra/main.tf": "H1" }) });
  assert.deepEqual(r.writeSetViolation, ["infra/main.tf"], JSON.stringify(r));
  assert.ok(r.next, "advisory only — the run advances");
});

await ta("write-set: absent writeSet means unconstrained", async () => {
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder" },
    { phase: "validate", role: "verifier", gate: "critical" },
  ], snap({}));
  const r = opStepReport({ runId, phase: "execute", summary: "wrote infra",
    changedFiles: ["infra/main.tf"], snapshot: snap({ "infra/main.tf": "H1" }) });
  assert.ok(!("writeSetViolation" in r), JSON.stringify(r));
});

await ta("write-set: an unobserved delta never produces a violation", async () => {
  // Policy is checked against OBSERVATION only: flagging a declared list would report the
  // conductor's own words back to it as evidence.
  const { runId } = await deltaRun([
    { phase: "execute", role: "coder", writeSet: ["src/**"] },
    { phase: "validate", role: "verifier", gate: "critical" },
  ]);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote infra",
    changedFiles: ["infra/main.tf"] });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.ok(!("writeSetViolation" in r), JSON.stringify(r));
});

await ta("write-set: the dialect is anchored and ** crosses directories, * does not", () => {
  const yes = (p, f) => assert.ok(globToRegExp(p).test(f), `${p} should match ${f}`);
  const no = (p, f) => assert.ok(!globToRegExp(p).test(f), `${p} should NOT match ${f}`);
  yes("src/*.js", "src/a.js");   no("src/*.js", "src/a/b.js");  no("src/*.js", "lib/src/a.js");
  yes("src/**", "src/a/b.js");   no("src/**", "srcx/a.js");
  yes("**/x.ts", "a/b/x.ts");    yes("**/x.ts", "x.ts");        no("**/x.ts", "a/x.tsx");
  yes("infra/", "infra/main.tf"); yes("infra/", "infra/a/b.tf"); no("infra/", "infrax/a");
  yes("a/**/b", "a/b");          yes("a/**/b", "a/x/y/b");      no("a/**/b", "a/x/c");
  yes(".github/**", ".github/w/ci.yml");
  no("src/a.js", "src/aXjs"); // '.' is escaped, not a wildcard
});

await ta("write-set: malformed patterns are rejected at config load", async () => {
  // One validator, three rejected forms plus a positive control — the dialect must fail loudly
  // rather than compile a pattern that can only ever match nothing.
  const dir = path.join(TMP, "writeset-config");
  fs.mkdirSync(dir, { recursive: true });
  const load = (pattern) => {
    fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  fake: { id: vendor/fake-9, family: fake, tags: [strong] }
roles:
  coder: { use: [fake] }
pipelines:
  build:
    steps:
      - { phase: execute, role: coder, writeSet: [${pattern}] }
`);
    return opLoad({ cwd: dir });
  };
  const deep = load('"a**b"').errors;
  assert.ok(deep, "a**b loaded without error");
  assert.match(JSON.stringify(deep), /writeSet/);
  assert.match(JSON.stringify(deep), /whole path segment/);

  const sep = load('"src\\\\a"').errors;
  assert.ok(sep, "src\\a loaded without error");
  assert.match(JSON.stringify(sep), /separator/);

  const empty = load('"a//b"').errors;
  assert.ok(empty, "a//b loaded without error");
  assert.match(JSON.stringify(empty), /empty path segment/);

  assert.equal(load('"src/**"').errors, undefined, "a legal pattern must load clean");
});

await ta("write-set: survives, and is rejected, at the real JSON-RPC boundary", async () => {
  const c = await mcpClient({ cwd: REPO });
  try {
    assert.ok(!(await c.call("moa_load", { cwd: REPO })).error);
    assert.ok(!(await c.call("moa_resolve", { hostModels: HOST })).error);
    const start = (step) => c.call("moa_run_start", {
      task: "write-set boundary", steps: [step],
      masterModel: "anthropic/claude-opus-4-8", masterFamily: "claude",
    });

    // (a) the field survives the boundary — the inline schema used to strip it
    const ok = await start({ phase: "execute", role: "coder", writeSet: ["src/**"] });
    assert.deepEqual(ok.next.writeSet, ["src/**"], JSON.stringify(ok));

    // (b) a malformed pattern is a zod failure: isError with a NON-JSON body
    const bad = await start({ phase: "execute", role: "coder", writeSet: ["a**b"] });
    assert.match(bad._threw ?? JSON.stringify(bad), /Input validation error/);
    assert.match(bad._threw ?? JSON.stringify(bad), /writeSet/);

    // (c) compatibility: an unknown ad-hoc step key is still SILENTLY STRIPPED, never rejected.
    // This is the row that fails if zStep is reused at the boundary without .strip().
    const legacy = await start({ phase: "execute", role: "coder", bogus: 1 });
    assert.ok(legacy.next, JSON.stringify(legacy));
    assert.equal("bogus" in legacy.next, false, JSON.stringify(legacy.next));
  } finally { c.stop(); }
});

// --- observed provenance: F — refusals: an unreadable HEAD, and a frame that will not hold ---

await ta("snapshot: an unreadable HEAD is refused, an unborn repo is still observed", async () => {
  // Both halves are required. gitRead collapses EVERY failure to null, so a corrupt ref arrives
  // in the same shape as an unborn repo — and accepting it would skip the sinceHead term and
  // report a committed-and-clean phase as ZERO mutations, as a confident observation.
  const broken = await gitFixture("head-broken");
  if (!broken) return;
  broken.write("a.js", "one\n");
  broken.git("add", "-A"); broken.git("commit", "-qm", "seed");
  const healthy = await workspaceSnapshot(broken.repo);
  assert.ok(healthy?.entries, JSON.stringify(healthy));
  broken.write("a.js", "two\n"); // status must be non-empty, so only HEAD is broken
  // the default branch name varies by machine — read it from .git/HEAD rather than assuming
  const ref = fs.readFileSync(path.join(broken.repo, ".git", "HEAD"), "utf8").trim().replace(/^ref:\s*/, "");
  fs.writeFileSync(path.join(broken.repo, ".git", ref), "not-a-sha-at-all\n");

  const s = await workspaceSnapshot(broken.repo, healthy.head);
  assert.equal(s.entries, null, JSON.stringify(s));
  assert.match(s.reason, /unborn/);
  const d = computeDelta({ before: healthy, after: s, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  // ...and the floor lands on the declared list rather than on a confident zero
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: s });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));

  // (b) a genuinely unborn repository is still OBSERVED — a fix that refuses on every null
  // head would break every repo before its first commit.
  const unborn = await gitFixture("head-unborn");
  if (!unborn) return;
  unborn.write("a.js", "one\n");
  const u = await workspaceSnapshot(unborn.repo);
  assert.ok(u?.entries, JSON.stringify(u));
  assert.equal(u.head, null, JSON.stringify(u));
  assert.deepEqual(u.sinceHead, [], JSON.stringify(u));
});

await ta("snapshot: a project directory that cannot be resolved is refused, not assumed", async () => {
  // The symlink fix's own failure mode, and the last silent degradation in this function. All
  // three git reads SUCCEED — only the frame is lost — so falling back to the unresolved path
  // leaves `source: "git"` with an empty entry map while the tree demonstrably changed. That is
  // a confident zero, and because observation outranks the declaration it clears the mutation
  // floor with no critical gate at all.
  const fx = await gitFixture("realpath-gone");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  // A symlink whose basename differs from its target, so the resolved and unresolved frames
  // disagree on EVERY platform — not only where os.tmpdir() is itself a symlink (macOS
  // /var -> /private/var). Without that the fallback would look correct on Linux.
  const link = path.join(TMP, "realpath-link");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(fx.repo, link);

  // The baseline is taken while the tree is CLEAN, on purpose. From a DIRTY baseline the
  // fallback's `{}` still differs from `{a.js: …}`, so the delta is non-empty and the run still
  // finishes `done_unverified` — the terminal assertion below would then pass with or without
  // the fix. From clean, the fallback yields `{}` on both sides: the actual false zero, reported
  // as `source: "git"` with terminal `done`.
  const healthy = await workspaceSnapshot(link);
  assert.ok(healthy?.entries, JSON.stringify(healthy));
  assert.deepEqual(Object.keys(healthy.entries), [], JSON.stringify(healthy));

  fx.write("a.js", "dirty\n"); // the mutation a fallback snapshot would miss
  // A STABLE symlink still observes normally: the frame is resolved twice and the two
  // resolutions agree, so nothing refuses. This is the row that fails if the guard is written
  // to refuse every symlinked project rather than only an unstable one.
  const stable = await workspaceSnapshot(link, healthy.head);
  assert.deepEqual(Object.keys(stable?.entries ?? {}), ["a.js"], JSON.stringify(stable));

  // realpath is the only caller of its kind inside workspaceSnapshot, so hooking it here is
  // scheduling, not stubbing: the real syscall runs and the ENOENT below is a real ENOENT.
  const realpath = fs.promises.realpath;
  let gonePre, gonePost;
  try {
    // (a) the link is gone before the frame is ever pinned
    fs.promises.realpath = (...a) => { fs.rmSync(link, { force: true }); return realpath(...a); };
    gonePre = await workspaceSnapshot(link, healthy.head);
    // (b) ...and gone only AFTER the three git reads returned, which nothing but the second
    // resolution can catch — the reads all succeeded and the frame died under them.
    fs.symlinkSync(fx.repo, link);
    let resolutions = 0;
    fs.promises.realpath = (...a) => {
      if (++resolutions === 2) fs.rmSync(link, { force: true });
      return realpath(...a);
    };
    gonePost = await workspaceSnapshot(link, healthy.head);
  } finally { fs.promises.realpath = realpath; }

  // (1) both refuse — restore the fallback and each is `{}` carrying reason null
  for (const s of [gonePre, gonePost]) {
    assert.equal(s.entries, null, JSON.stringify(s));
    assert.match(s.reason, /could not be resolved/);
  }
  // (2) so the delta is unobserved, not an observation of nothing
  const d = computeDelta({ before: healthy, after: gonePre, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.deepEqual(d.files, [], JSON.stringify(d));

  // (3) the declaration stays authoritative and (4) the ungated mutation cannot finish `done`.
  // Observation contributes NOTHING here, so only the declared list can hold the floor up.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: gonePre });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.deepEqual(r.observed.files, [], JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("snapshot: a project directory retargeted mid-observation is refused, not re-framed", async () => {
  // Retarget the symlink after the git reads returned and realpath SUCCEEDS — against a different
  // repository. With the frame pinned first every read goes through the PHYSICAL root, so a
  // retarget can no longer by itself re-frame the entry map; this refusal is now defence in depth
  // over computeDelta's cross-snapshot guard, and it is still the only thing that notices the
  // caller's path stopped naming the repository we photographed.
  //
  // The retarget is scheduled by a real git on PATH, not by hooking realpath: under the old hook
  // ("on the second realpath call") deleting the guard also deleted the second call, so the
  // retarget never happened and the row passed vacuously. Here it happens either way.
  const fx = await gitFixture("retarget-from");
  const other = await gitFixture("retarget-to");
  if (!fx || !other) return;
  fx.write("a.js", "seed\n"); fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  other.write("b.js", "seed\n"); other.git("add", "-A"); other.git("commit", "-qm", "seed");

  const link = path.join(TMP, "retarget-link");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(fx.repo, link);
  const healthy = await workspaceSnapshot(link); // clean baseline, same reason as the row above
  assert.ok(healthy?.entries, JSON.stringify(healthy));
  assert.deepEqual(Object.keys(healthy.entries), [], JSON.stringify(healthy));

  fx.write("a.js", "dirty\n"); // the mutation a re-framed snapshot would miss
  // Move the link once the status read has returned — i.e. after the reads, which is exactly
  // where the previous fix was broken. The real binary still runs; only its timing is ours.
  const restore = gitShim("retarget", { on: "status", when: "after",
    sh: `rm -f "${link}"; ln -s "${other.repo}" "${link}"` });
  let s;
  try { s = await workspaceSnapshot(link, healthy.head); }
  finally { restore(); }

  // (1) the shim really fired: the link now names the other repository
  assert.equal(fs.readlinkSync(link), other.repo, fs.readlinkSync(link));
  // (2) both resolutions succeeded and named different repositories, so it refuses
  assert.equal(s.entries, null, JSON.stringify(s));
  assert.match(s.reason, /retargeted/);
  // (3) the delta is unobserved, not an observation of a repository we never read
  const d = computeDelta({ before: healthy, after: s, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.deepEqual(d.files, [], JSON.stringify(d));
  // (4) and the ungated mutation cannot finish `done` on a re-framed zero
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: s });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("delta: a project swapped between the two snapshots is not a before and an after", async () => {
  // The frame guard inside workspaceSnapshot holds ONE observation together. Swap the project
  // between step entry and report and each snapshot is individually honest — two clean trees —
  // while the PAIR reports `files: []` as a confident `source: "git"` observation and the writes
  // to the first repository are never looked at. The two are compared by `root`.
  const from = await gitFixture("swap-from");
  if (!from) return;
  from.write("seed.txt", "seed\n");
  from.git("add", "-A"); from.git("commit", "-qm", "seed");
  // A CLONE, not a second fixture: it shares HEAD by construction, so the sinceHead term is not
  // taken and this row cannot pass on the HEAD-diff refusal instead of the one it is testing.
  const { execFileSync } = await import("node:child_process");
  const clone = path.join(TMP, "swap-clone");
  fs.rmSync(clone, { recursive: true, force: true });
  execFileSync("git", ["clone", "-q", from.repo, clone], { stdio: "pipe" });
  const link = path.join(TMP, "swap-link");
  fs.rmSync(link, { force: true });
  fs.symlinkSync(from.repo, link);

  const before = await workspaceSnapshot(link);
  from.write("a.js", "written by the worker\n"); // the mutation the swapped frame loses
  fs.rmSync(link, { force: true });
  fs.symlinkSync(clone, link);
  const after = await workspaceSnapshot(link, before.head);
  // both snapshots are individually clean and individually honest — that is exactly the problem
  assert.ok(before.entries && after.entries, JSON.stringify({ before, after }));
  assert.equal(before.head, after.head, JSON.stringify({ before, after }));
  assert.notEqual(before.root, after.root, JSON.stringify({ before, after }));

  // drop the root comparison and this is `source: "git"` with `files: []` and terminal `done`
  const d = computeDelta({ before, after, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.match(d.reason, /different repository/);
  assert.deepEqual(d.files, [], JSON.stringify(d));
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], before);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: after });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("delta: a project replaced at the same path between the two snapshots is not a before and an after", async () => {
  // The row above is the `root` witness: two different pathnames, and the root comparison alone
  // carries it. This row is the `frame` witness, and nothing else in the suite is one — `root`,
  // `head` and `entries` are all EQUAL across the pair, so filesystem identity is the ONLY field
  // that differs. Delete `before.frame !== after.frame` from computeDelta and this is the row
  // that fails.
  //
  // The replacement here is PERSISTENT and lands between the two observations, so each snapshot
  // holds its own frame for the length of its own observation and each is individually honest.
  // Nothing inside workspaceSnapshot can see this; only the cross-snapshot comparison can.
  const fx = await gitFixture("frame-witness");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  // A byte copy of the whole repository, `.git` included: the same HEAD by construction, so the
  // sinceHead term is not taken and this row cannot pass on the HEAD-diff refusal instead of the
  // comparison it is testing. Same paths and same content, so `entries` matches too.
  const copy = path.join(TMP, "frame-witness-copy");
  const aside = path.join(TMP, "frame-witness-aside");
  for (const p of [copy, aside]) fs.rmSync(p, { recursive: true, force: true });
  fs.cpSync(fx.repo, copy, { recursive: true });

  const before = await workspaceSnapshot(fx.repo);
  fs.writeFileSync(path.join(fx.repo, "a.js"), "written by the worker\n"); // the lost mutation
  // Swapped at the SAME pathname, so every string on both snapshots stays equal.
  fs.renameSync(fx.repo, aside);
  fs.renameSync(copy, fx.repo);
  const after = await workspaceSnapshot(fx.repo, before.head);

  // both individually clean and individually honest — that is exactly the problem
  assert.ok(before.entries && after.entries, JSON.stringify({ before, after }));
  assert.equal(before.root, after.root, JSON.stringify({ before, after }));   // NOT the root case
  assert.equal(before.head, after.head, JSON.stringify({ before, after }));
  assert.deepEqual(before.entries, after.entries, JSON.stringify({ before, after }));
  assert.ok(before.frame && after.frame, JSON.stringify({ before, after })); // neither is null
  assert.notEqual(before.frame, after.frame, JSON.stringify({ before, after })); // the ONE difference

  // drop the frame comparison and this is `source: "git"` with `files: []` and terminal `done`
  const d = computeDelta({ before, after, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.match(d.reason, /different repository/);
  assert.deepEqual(d.files, [], JSON.stringify(d));
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], before);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: after });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("snapshot: a project directory replaced at the same path mid-observation is refused", async () => {
  // The window a PATHNAME comparison cannot see, and the reason the frame is filesystem identity.
  // `status` runs against the real tree; the directory at that same pathname is REPLACED before
  // identitiesOf hashes anything; every string — projectDir, realpath, root, HEAD — stays equal.
  // The snapshot then keys the replacement's content to the real tree's status and answers
  // `source: "git"`, `files: []`, terminal `done`, about a workspace it never compared.
  const fx = await gitFixture("replace-dir");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");

  // The baseline is taken DIRTY on purpose. From a clean baseline the swapped-in tree's
  // `{a.js: hash}` would differ from `{}` and the delta would be non-empty for the wrong reason —
  // the row would pass without the guard. From dirty, both sides hash "dirty1": the actual zero.
  fx.write("a.js", "dirty1\n");
  const healthy = await workspaceSnapshot(fx.repo);
  assert.deepEqual(Object.keys(healthy?.entries ?? {}), ["a.js"], JSON.stringify(healthy));

  const copy = path.join(TMP, "replace-dir-copy");
  const aside = path.join(TMP, "replace-dir-aside");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.rmSync(aside, { recursive: true, force: true });
  fs.cpSync(fx.repo, copy, { recursive: true }); // baseline content, same HEAD, same paths
  fx.write("a.js", "dirty2\n"); // the mutation the replacement hides

  // AFTER status: git reports a.js off the real (dirty2) tree, then the renames complete before
  // the child exits, so gitRead resolves only once the swap is done and identitiesOf reads
  // "dirty1" out of the replacement.
  const restore = gitShim("replace-dir", { on: "status", when: "after",
    sh: `mv "${fx.repo}" "${aside}"; mv "${copy}" "${fx.repo}"` });
  let s;
  try { s = await workspaceSnapshot(fx.repo, healthy.head); }
  finally { restore(); }

  assert.ok(fs.existsSync(aside), "the shim did not fire — no swap happened");
  assert.equal(s.entries, null, JSON.stringify(s));
  assert.match(s.reason, /replaced at the same path/);
  const d = computeDelta({ before: healthy, after: s, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.deepEqual(d.files, [], JSON.stringify(d));
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: s });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("snapshot: a .git replaced at the same path before the reads is refused", async () => {
  // The same class one level in: the work tree is untouched and the METADATA is swapped, for a
  // git directory with the same root and the same HEAD whose index hides the edited file. This is
  // also the structural proof that the frame is pinned BEFORE the reads — pin it after `status`
  // instead and the swapped inode is the one recorded, so this row fails.
  const fx = await gitFixture("replace-gitdir");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");

  const gitdir = path.join(fx.repo, ".git");
  const hidden = path.join(TMP, "replace-gitdir-hidden");
  const real = path.join(TMP, "replace-gitdir-real");
  for (const p of [hidden, real]) fs.rmSync(p, { recursive: true, force: true });
  fs.cpSync(gitdir, hidden, { recursive: true });
  // assume-unchanged is a real, documented flag, not a corruption: same root, same HEAD, an index
  // that makes an edited file invisible to `status`.
  execFileSync("git", ["--git-dir", hidden, "--work-tree", fx.repo,
    "update-index", "--assume-unchanged", "a.js"], { stdio: "pipe" });

  const healthy = await workspaceSnapshot(fx.repo);
  assert.deepEqual(Object.keys(healthy?.entries ?? {}), [], JSON.stringify(healthy));
  fx.write("a.js", "dirty\n"); // the mutation the swapped index hides

  // BEFORE status, so the swap lands after the pin and before every read that depends on it — and,
  // via the shim's barrier, after the CONCURRENT `rev-parse HEAD` has returned. Without that
  // ordering the parallel HEAD child sometimes read the pathname between the two renames, failed,
  // and the snapshot refused with the unreadable-HEAD reason instead of this one: a green run that
  // never exercised the guard. The pin is still upstream of the swap, which is what the row is for.
  const restore = gitShim("replace-gitdir", { on: "status", when: "before",
    sh: `mv "${gitdir}" "${real}"; mv "${hidden}" "${gitdir}"` });
  let s;
  try { s = await workspaceSnapshot(fx.repo, healthy.head); }
  finally { restore(); }

  assert.ok(fs.existsSync(real), "the shim did not fire — no swap happened");
  assert.equal(s.entries, null, JSON.stringify(s));
  assert.match(s.reason, /replaced at the same path/);
  const d = computeDelta({ before: healthy, after: s, declaredFiles: ["a.js"] });
  assert.equal(d.source, "unobserved", JSON.stringify(d));
  assert.deepEqual(d.files, [], JSON.stringify(d));
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: s });
  assert.equal(r.observed.source, "unobserved", JSON.stringify(r.observed));
  assert.equal(r.terminal, "done_unverified", JSON.stringify(r));
});

await ta("snapshot: KNOWN LIMITATION — a directory replaced during hashing and restored before the recheck is NOT caught", async () => {
  // THIS ROW PINS A HOLE, NOT A GUARD. Every assertion below states what the observation
  // currently does, and what it currently does is MISS this case. Read `source: "git"` and
  // `terminal: "done"` here as the documented limitation they are, not as a passing check.
  //
  // The endpoint comparison sees identity at two instants and nothing in between. Replace the
  // project directory after `status`, let identitiesOf hash the replacement, then put the
  // original back before the final realpath/stat: both endpoints observe the SAME inode, the
  // frame holds, and the snapshot answers `source: "git"` with `files: []` about content it
  // never read — the declared write surviving only as `phantom`, and an ungated mutation
  // finishing `done`.
  //
  // What closing it would take: reads bound to a directory HANDLE instead of re-resolved from a
  // pathname — openat(2) semantics. Node exposes none of it. `fs.openat` and
  // `fs.promises.openat` are undefined (verified on v22.22.3), `fs.Dir` offers only
  // read/readSync/close/entries with no way to open a file relative to the handle, and there is
  // no /proc/self/fd on macOS to fall back through. `process.chdir` anchors the top component
  // only — every nested component and `$GIT_DIR` still resolve by name, git's own opens cannot
  // be anchored at all, and it costs global process state in a server that observes
  // concurrently — so it narrows the hole rather than closing it.
  //
  // So this is a NAMED BOUNDARY, documented in run-store.md and anti-self-certification.md
  // beside in-place `$GIT_DIR/index` replacement, and for the same reason: it takes an actor
  // manipulating the filesystem DURING the observation to hide a write, and any guard strong
  // enough to catch that also refuses on ordinary operation, which makes the observation inert.
  // If a runtime ever offers anchored reads, this row is the one that fails, and that failure is
  // the signal to close it rather than to update the expectation.
  const fx = await gitFixture("aba-restore");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  fx.write("a.js", "dirty1\n");
  const healthy = await workspaceSnapshot(fx.repo);
  assert.deepEqual(Object.keys(healthy?.entries ?? {}), ["a.js"], JSON.stringify(healthy));

  // An EMPTY commit, so the observation takes the `previousHead !== head` branch and runs one
  // more git process AFTER the hashing. That is the only seam between identitiesOf and the
  // recheck, and therefore the only place a real out-of-process actor can put the tree back —
  // which is the point: the restore is scheduled by the filesystem, not by a stubbed function.
  // Empty, so the diff is empty and `sinceHead` stays [] rather than manufacturing a delta this
  // case is not about.
  fx.git("commit", "--allow-empty", "-qm", "tick");
  const copy = path.join(TMP, "aba-restore-copy");
  const aside = path.join(TMP, "aba-restore-aside");
  for (const p of [copy, aside]) fs.rmSync(p, { recursive: true, force: true });
  fs.cpSync(fx.repo, copy, { recursive: true }); // holds dirty1, and BOTH commits so the diff works
  fx.write("a.js", "dirty2\n"); // the mutation the round trip hides

  // `-z` is on the argv of `status` and of `diff` and of NEITHER rev-parse, so one shim addresses
  // both windows: swap the replacement in after the status read, swap the original back after
  // the HEAD diff.
  const restore = gitShim("aba-restore", { on: "-z", when: "after", sh:
    `case " $* " in ` +
    `*" status "*) mv "${fx.repo}" "${aside}"; mv "${copy}" "${fx.repo}" ;; ` +
    `*" diff "*) mv "${fx.repo}" "${copy}"; mv "${aside}" "${fx.repo}" ;; esac` });
  let s;
  try { s = await workspaceSnapshot(fx.repo, healthy.head); }
  finally { restore(); }

  // (1) both windows fired: the observation hashed the REPLACEMENT's dirty1 — byte-identical to
  // the baseline identity — while the file back on disk is the original's dirty2.
  assert.equal(fs.readFileSync(path.join(fx.repo, "a.js"), "utf8"), "dirty2\n");
  assert.equal(s.entries?.["a.js"], healthy.entries["a.js"], JSON.stringify(s));
  // (2) ...and NOTHING refused: same frame at both endpoints, no reason. The limitation, asserted.
  assert.equal(s.reason, null, JSON.stringify(s));
  assert.equal(s.frame, healthy.frame, JSON.stringify(s));
  assert.deepEqual(s.sinceHead, [], JSON.stringify(s));
  // (3) so the pair is a CONFIDENT ZERO: observed, empty, the declared write only a phantom
  const d = computeDelta({ before: healthy, after: s, declaredFiles: ["a.js"] });
  assert.equal(d.source, "git", JSON.stringify(d));
  assert.equal(d.reason, null, JSON.stringify(d));
  assert.deepEqual(d.files, [], JSON.stringify(d));
  assert.deepEqual(d.phantom, ["a.js"], JSON.stringify(d));
  // (4) and end to end the ungated write finishes `done`, not `done_unverified`. Pinned so that
  // closing the hole surfaces here as a failing expectation rather than as silence.
  const { runId } = await deltaRun([{ phase: "execute", role: "coder" }], healthy);
  const r = opStepReport({ runId, phase: "execute", summary: "wrote a",
    changedFiles: ["a.js"], snapshot: s });
  assert.equal(r.observed.source, "git", JSON.stringify(r.observed));
  assert.deepEqual(r.observed.files, [], JSON.stringify(r.observed));
  assert.equal(r.terminal, "done", JSON.stringify(r));
});

await ta("snapshot: an ordinary project still observes — symlinked tmp, symlinked parent, relative path, plain directory", async () => {
  // The negative controls. A guard that refuses an ordinary project is not a safe guard, it is an
  // INERT feature: every phase would degrade to the declared list and the mutation floor would go
  // back to trusting the producer. All four halves must observe `a.js` with `reason: null`.
  const fx = await gitFixture("ordinary");
  if (!fx) return;
  fx.write("a.js", "seed\n");
  fx.git("add", "-A"); fx.git("commit", "-qm", "seed");
  fx.write("a.js", "dirty\n");

  // (b) a symlinked PARENT: the repo itself is a real directory reached through a link.
  const parentLink = path.join(TMP, "ordinary-parent");
  fs.rmSync(parentLink, { force: true });
  fs.symlinkSync(TMP, parentLink);

  const cases = {
    // (a) os.tmpdir() is itself a symlink on macOS (/var -> /private/var), so this path resolves
    // to a DIFFERENT string than it names. The two nevertheless stat to the identical {dev, ino}
    // — one directory, two spellings — and the guard only refuses when identity CHANGES.
    "symlinked tmp": fx.repo,
    "symlinked parent": path.join(parentLink, path.basename(fx.repo)),
    // (c) relative, resolved against the real cwd — no chdir, no global state. Proves the frame is
    // stat'd on the RESOLVED projectRoot and not on the caller's string.
    "relative path": path.relative(process.cwd(), fx.repo),
    // (d) fully resolved, no link anywhere in it
    "plain directory": fs.realpathSync(fx.repo),
  };
  for (const [label, dir] of Object.entries(cases)) {
    const s = await workspaceSnapshot(dir);
    assert.deepEqual(Object.keys(s?.entries ?? {}), ["a.js"], `${label}: ${JSON.stringify(s)}`);
    assert.equal(s.reason, null, `${label}: ${JSON.stringify(s)}`);
  }
});


// ─────────────────────────────────────────────────────────────────────────────
// provided-inputs: a run declares phases whose output already exists, and the
// steps that depend on them drop out. See openspec specs/provided-inputs/spec.md.
// ─────────────────────────────────────────────────────────────────────────────

// The spec's reference pipeline, verbatim: frame, plan(skippable), review-plan(gate→plan),
// execute(loopBackTo plan, NOT a gate), review-work(gate→execute), validate(critical→execute), finalize.
const PROVIDED_CONFIG = `
schemaVersion: 1
models:
  opus: { id: anthropic/claude-opus-4-8, family: claude, tags: [strong] }
  gpt: { id: openai/gpt-5.5, family: gpt, tags: [strong], effort: [medium, xhigh] }
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap], cost: cheap }
roles:
  planner: { use: [opus, auto], effort: [low, high] }
  coder: { use: [mini], effort: [low, high] }
  reviewer: { use: [gpt, auto], differentModelFrom: planner }
  verifier: { use: [gpt, auto], differentModelFrom: coder }
pipelines:
  reference:
    steps:
      - { phase: frame, role: master }
      - { phase: plan, role: planner, skippable: true }
      - { phase: review-plan, role: reviewer, gate: standard, loopBackTo: plan }
      - { phase: execute, role: coder, loopBackTo: plan }
      - { phase: review-work, role: reviewer, gate: standard, loopBackTo: execute }
      - { phase: validate, role: verifier, gate: critical, loopBackTo: execute }
      - { phase: finalize, role: master }
`;
const PROVIDED_REPO = path.join(TMP, "provided-repo");
fs.mkdirSync(PROVIDED_REPO, { recursive: true });
fs.writeFileSync(path.join(PROVIDED_REPO, ".moa.yml"), PROVIDED_CONFIG);

// A one-off config in its own dir, for the load-time rejection cases.
const loadCfg = (name, body) => {
  const dir = path.join(TMP, `provided-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), body);
  return opLoad({ cwd: dir });
};
async function providedRun(provided, { pipeline = "reference" } = {}) {
  opLoad({ cwd: PROVIDED_REPO });
  await opResolve({ hostModels: HOST });
  return opRunStart({
    task: "provided task", pipeline, provided,
    masterModel: "host/master", masterFamily: "host",
  });
}
const phasesOf = (r) => r.frame.pipeline.split("→");

// ── 4.1 load-time ────────────────────────────────────────────────────────────

t("provided: a skippable non-gate step loads and is reported on the step", () => {
  const r = opLoad({ cwd: PROVIDED_REPO });
  assert.equal(r.errors, undefined, JSON.stringify(r.errors));
  const plan = r.pipelines.reference.steps.find((s) => s.startsWith("plan("));
  assert.ok(plan.includes("skippable"), plan);
});

t("provided: skippable on a gate is rejected at load", () => {
  const r = loadCfg("gate-skippable", `
schemaVersion: 1
roles:
  planner: { use: [auto] }
  reviewer: { use: [auto] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner }
      - { phase: review-plan, role: reviewer, gate: standard, loopBackTo: plan, skippable: true }
`);
  assert.ok(r.errors?.some((e) => e.includes("review-plan") && e.includes("skippable")), JSON.stringify(r.errors));
});

t("provided: requires naming an unknown phase is rejected at load", () => {
  const r = loadCfg("bad-requires", `
schemaVersion: 1
roles:
  planner: { use: [auto] }
  qa: { use: [auto] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner }
      - { phase: q-and-a, role: qa, requires: nope }
`);
  assert.ok(r.errors?.some((e) => e.includes("q-and-a") && e.includes("nope")), JSON.stringify(r.errors));
});

t("provided: the step shape is still strict — an unknown field is rejected", () => {
  const r = loadCfg("unknown-field", `
schemaVersion: 1
roles:
  planner: { use: [auto] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner, skipabble: true }
`);
  assert.ok(r.errors?.length, "a misspelled 'skippable' loaded without error");
});

// ── 4.2 skip resolution ──────────────────────────────────────────────────────

await ta("provided: a provided plan skips the planner AND its review gate", async () => {
  const r = await providedRun(["plan"]);
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(phasesOf(r), ["frame", "execute", "review-work", "validate", "finalize"]);
  const m = manifestOf(PROVIDED_REPO, r.runId);
  assert.deepEqual(m.skipped, [
    { phase: "plan", reason: "provided" },
    { phase: "review-plan", reason: "child of plan" },
  ]);
  assert.deepEqual(m.provided, ["plan"]);
  assert.equal(r.next.phase, "frame");
});

await ta("provided: absent → every step runs and nothing is recorded skipped", async () => {
  const r = await providedRun(undefined);
  assert.deepEqual(phasesOf(r), ["frame", "plan", "review-plan", "execute", "review-work", "validate", "finalize"]);
  const m = manifestOf(PROVIDED_REPO, r.runId);
  assert.deepEqual(m.skipped, []);
  assert.equal(m.provided, null);
});

await ta("provided: a NON-gate loopBackTo does not make a step a dependent", async () => {
  // execute carries loopBackTo: plan in every shipped pipeline. If loopBackTo cascaded on
  // non-gates too, providing a plan would delete the one step that does the work.
  const r = await providedRun(["plan"]);
  assert.ok(phasesOf(r).includes("execute"));
});

await ta("provided: requires cascades where there is no loopBackTo to infer from", async () => {
  const dir = path.join(TMP, "provided-requires");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap] }
roles:
  coder: { use: [mini] }
  qa: { use: [mini] }
pipelines:
  p:
    steps:
      - { phase: execute, role: coder, skippable: true }
      - { phase: q-and-a, role: qa, requires: execute }
      - { phase: finalize, role: master }
`);
  opLoad({ cwd: dir });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "t", pipeline: "p", provided: ["execute"], masterModel: "host/m", masterFamily: "host" });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.frame.pipeline.split("→"), ["finalize"]);
  assert.deepEqual(manifestOf(dir, r.runId).skipped, [
    { phase: "execute", reason: "provided" },
    { phase: "q-and-a", reason: "child of execute" },
  ]);
});

await ta("provided: requires overrides a gate's loopBackTo as the parent", async () => {
  const dir = path.join(TMP, "provided-override");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  gpt: { id: openai/gpt-5.5, family: gpt, tags: [strong] }
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap] }
roles:
  planner: { use: [mini] }
  reviewer: { use: [gpt] }
pipelines:
  p:
    steps:
      - { phase: frame, role: master }
      - { phase: plan, role: planner, skippable: true }
      - { phase: review-plan, role: reviewer, gate: standard, loopBackTo: plan, requires: frame }
`);
  opLoad({ cwd: dir });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "t", pipeline: "p", provided: ["plan"], masterModel: "host/m", masterFamily: "host" });
  assert.equal(r.error, undefined, r.error);
  // parent is frame, which survived — so the gate survives even though loopBackTo points at plan
  assert.deepEqual(r.frame.pipeline.split("→"), ["frame", "review-plan"]);
});

await ta("provided: the cascade is transitive", async () => {
  const dir = path.join(TMP, "provided-transitive");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  gpt: { id: openai/gpt-5.5, family: gpt, tags: [strong] }
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap] }
roles:
  planner: { use: [mini] }
  reviewer: { use: [gpt] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner, skippable: true }
      - { phase: review-plan, role: reviewer, gate: standard, loopBackTo: plan }
      - { phase: sign-off, role: reviewer, requires: review-plan }
      - { phase: finalize, role: master }
`);
  opLoad({ cwd: dir });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "t", pipeline: "p", provided: ["plan"], masterModel: "host/m", masterFamily: "host" });
  assert.equal(r.error, undefined, r.error);
  assert.deepEqual(r.frame.pipeline.split("→"), ["finalize"]);
  assert.deepEqual(manifestOf(dir, r.runId).skipped.map((s) => s.reason), [
    "provided", "child of plan", "child of review-plan",
  ]);
});

await ta("provided: a repeated entry is idempotent", async () => {
  const once = await providedRun(["plan"]);
  const twice = await providedRun(["plan", "plan"]);
  assert.deepEqual(phasesOf(twice), phasesOf(once));
  assert.deepEqual(manifestOf(PROVIDED_REPO, twice.runId).skipped,
    manifestOf(PROVIDED_REPO, once.runId).skipped);
});

// ── 4.3 run-start errors ─────────────────────────────────────────────────────

const runsUnder = (dir) => {
  try { return fs.readdirSync(path.join(dir, ".moa", "runs")).length; }
  catch { return 0; }
};

await ta("provided: naming a phase the pipeline does not have is refused, no manifest", async () => {
  const before = runsUnder(PROVIDED_REPO);
  const r = await providedRun(["research"]);
  assert.ok(r.error?.includes("research"), r.error);
  assert.ok(r.error.includes("plan"), "the error should list the skippable phases");
  assert.equal(runsUnder(PROVIDED_REPO), before);
});

await ta("provided: naming a phase that is not skippable is refused, no manifest", async () => {
  const before = runsUnder(PROVIDED_REPO);
  const r = await providedRun(["execute"]);
  assert.ok(r.error?.includes("execute") && r.error.includes("skippable"), r.error);
  assert.equal(runsUnder(PROVIDED_REPO), before);
});

await ta("provided: skipping every step is refused, no manifest", async () => {
  const dir = path.join(TMP, "provided-empty");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap] }
roles:
  planner: { use: [mini] }
  coder: { use: [mini] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner, skippable: true }
      - { phase: execute, role: coder, requires: plan }
`);
  opLoad({ cwd: dir });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "t", pipeline: "p", provided: ["plan"], masterModel: "host/m", masterFamily: "host" });
  assert.ok(r.error?.includes("nothing would run"), r.error);
  assert.equal(runsUnder(dir), 0);
});

await ta("provided: strict mode runs the pipeline verbatim and refuses provided", async () => {
  const dir = path.join(TMP, "provided-strict");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".moa.yml"), `
schemaVersion: 1
models:
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap] }
master:
  mode: strict
roles:
  planner: { use: [mini] }
  coder: { use: [mini] }
pipelines:
  p:
    steps:
      - { phase: plan, role: planner, skippable: true }
      - { phase: execute, role: coder }
`);
  opLoad({ cwd: dir });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({ task: "t", pipeline: "p", provided: ["plan"], masterModel: "host/m", masterFamily: "host" });
  assert.ok(r.error?.includes("strict"), r.error);
  assert.equal(runsUnder(dir), 0);
  // ...and the same config starts fine without provided
  const ok = opRunStart({ task: "t", pipeline: "p", masterModel: "host/m", masterFamily: "host" });
  assert.equal(ok.error, undefined, ok.error);
});

await ta("provided: an ad-hoc gate marked skippable is refused at the tool boundary", async () => {
  opLoad({ cwd: PROVIDED_REPO });
  await opResolve({ hostModels: HOST });
  const r = opRunStart({
    task: "t", masterModel: "host/m", masterFamily: "host",
    steps: [
      { phase: "plan", role: "planner" },
      { phase: "review-plan", role: "reviewer", gate: "critical", loopBackTo: "plan", skippable: true },
    ],
  });
  assert.ok(r.error?.includes("review-plan") && r.error.includes("skippable"), r.error);
});

// ── 4.4 frame ────────────────────────────────────────────────────────────────

await ta("provided: the frame names every skipped phase and its reason", async () => {
  const r = await providedRun(["plan"]);
  assert.equal(r.frame.skipped, "plan (provided), review-plan (child of plan)");
  assert.equal(r.frame.pipeline, "frame→execute→review-work→validate→finalize");
});

await ta("provided: no skipped line when nothing was skipped", async () => {
  const r = await providedRun(undefined);
  assert.equal("skipped" in r.frame, false, JSON.stringify(r.frame));
});

// ── 4.5 effort ladder ────────────────────────────────────────────────────────

await ta("provided: a REVISE still escalates a step whose loopBackTo target was skipped", async () => {
  // execute has loopBackTo: plan. With plan skipped, loops.plan is never written again, so
  // reading the rung from loopBackTo would freeze execute at rung 0 across every REVISE.
  const r = await providedRun(["plan"]);
  const step = (res) => res.next ?? res;
  // frame (master) → execute
  let cur = opStepReport({ runId: r.runId, phase: "frame", verdict: "APPROVE", summary: "framed" });
  assert.equal(step(cur).phase, "execute");
  assert.equal(step(cur).effort, "low", JSON.stringify(step(cur)));
  cur = opStepReport({ runId: r.runId, phase: "execute", verdict: "APPROVE", summary: "wrote", producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
  assert.equal(step(cur).phase, "review-work");
  cur = opStepReport({ runId: r.runId, phase: "review-work", verdict: "APPROVE", summary: "ok", producerModel: "openai/gpt-5.5", producerFamily: "gpt" });
  assert.equal(step(cur).phase, "validate");
  const looped = opStepReport({ runId: r.runId, phase: "validate", verdict: "REVISE", summary: "redo", producerModel: "openai/gpt-5.5", producerFamily: "gpt" });
  assert.equal(looped.to, "execute", JSON.stringify(looped));
  assert.equal(looped.next.effort, "high", "execute stayed at rung 0 after a REVISE — the ladder is frozen");
});

await ta("provided: escalation through a SURVIVING loopBackTo target is unchanged", async () => {
  const r = await providedRun(undefined);
  let cur = opStepReport({ runId: r.runId, phase: "frame", verdict: "APPROVE", summary: "framed" });
  assert.equal(cur.next.phase, "plan");
  assert.equal(cur.next.effort, "low");
  cur = opStepReport({ runId: r.runId, phase: "plan", verdict: "APPROVE", summary: "planned", producerModel: "anthropic/claude-opus-4-8", producerFamily: "claude" });
  assert.equal(cur.next.phase, "review-plan");
  const looped = opStepReport({ runId: r.runId, phase: "review-plan", verdict: "REVISE", summary: "redo", producerModel: "openai/gpt-5.5", producerFamily: "gpt" });
  assert.equal(looped.to, "plan");
  // plan's own rung climbed, and execute reads loops.plan because plan is still IN the run
  assert.equal(looped.next.effort, "high");
});
console.log(`\n${n} checks passed`);
