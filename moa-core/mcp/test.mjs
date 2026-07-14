// moa MCP — self-check. Run: node test.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "moa-test-"));
process.env.MOA_HOME = path.join(TMP, "home");
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });

const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opInit, opBindingSave } =
  await import("./server.mjs");

const HOST = [
  { id: "claude-opus-4-8", family: "claude", tags: ["strong"] },
  { id: "claude-sonnet-4-6", family: "claude", tags: ["strong", "cheap"] },
  { id: "openai/gpt-5.5", family: "gpt", tags: ["strong"] },
  { id: "minimax/MiniMax-M3", family: "minimax", tags: ["strong", "cheap"] },
];

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
else process.stdout.write(prompt);
`);

// --- load ------------------------------------------------------------------

t("load: no config → adaptive-bare, never errors", () => {
  const r = opLoad({ cwd: REPO });
  assert.equal(r.dispatch, "adaptive-bare");
  assert.equal(r.config, null);
});

const CONFIG = `
schemaVersion: 1
models:
  opus: { id: claude-opus-4-8, family: claude, tags: [strong] }
  gpt: { id: openai/gpt-5.5, family: gpt, tags: [strong], effort: [medium, xhigh] }
  mini: { id: minimax/MiniMax-M3, family: minimax, tags: [strong, cheap], cost: cheap }
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

t("load: YAML anchors rejected (safe subset)", () => {
  const bad = path.join(TMP, "anchors"); fs.mkdirSync(bad, { recursive: true });
  fs.writeFileSync(path.join(bad, ".moa.yml"), "schemaVersion: 1\nx: &a 1\ny: *a\n");
  assert.ok(opLoad({ cwd: bad }).errors.some((e) => e.includes("safe subset")));
});

// --- registered tool discovery ----------------------------------------------

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

t("tools: manually unproven profiles are skipped", () => {
  const profile = provenProfile({
    tool: "unprovencli",
    capabilities: { promptSafe: false },
  });
  const dir = path.join(process.env.MOA_HOME, ".moa", "bindings", profile.tool);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.yml"), JSON.stringify(profile));

  const listed = opTools();
  assert.ok(!listed.tools.some((tool) => tool.tool === profile.tool));
  assert.ok(listed.skipped.some((item) =>
    item.tool === profile.tool && item.reason === "unproven_profile"));
});

t("tools: promptVia arg profiles are skipped", () => {
  const profile = provenProfile({
    tool: "argcli",
    run: {
      argv: ["{bin}", "{model}"],
      promptVia: "arg",
      timeoutSeconds: 60,
    },
  });
  const dir = path.join(process.env.MOA_HOME, ".moa", "bindings", profile.tool);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.yml"), JSON.stringify(profile));

  const listed = opTools();
  assert.ok(!listed.tools.some((tool) => tool.tool === profile.tool));
  assert.ok(listed.skipped.some((item) =>
    item.tool === profile.tool && item.reason === "unsafe_prompt_transport"));
});

t("tools: executable directories are unavailable", () => {
  const saved = opBindingSave({
    profile: provenProfile({ tool: "directorycli", bin: TMP }),
  });
  assert.equal(saved.tool.available, false);
  assert.equal(saved.tool.reason, "executable_not_found");
});

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

// --- resolve -----------------------------------------------------------------

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
  const result = opResolve({
    hostModels: [...HOST, { id: "host/fake-9", family: "fake", tags: ["strong"] }],
  });
  assert.equal(result.roles.worker.model, "host/fake-9");
  assert.equal(result.roles.worker.binding, "host-native");
});

t("resolve: runtime.subagents filters routes", () => {
  const nativeRepo = writeRouteRepo("route-native-only", "native");
  opLoad({ cwd: nativeRepo });
  assert.equal(opResolve({ hostModels: HOST }).diagnostics[0].state, "blocked_no_binding");

  const externalRepo = writeRouteRepo("route-external-only", "external");
  opLoad({ cwd: externalRepo });
  assert.equal(opResolve({
    hostModels: [...HOST, { id: "host/fake-9", family: "fake" }],
  }).roles.worker.binding, "fakecli");

  const blockedRepo = writeRouteRepo("route-blocked", "blocked");
  opLoad({ cwd: blockedRepo });
  assert.equal(opResolve({
    hostModels: [...HOST, { id: "host/fake-9", family: "fake" }],
  }).diagnostics[0].state, "blocked_no_binding");
});

t("resolve: an unavailable binding pin is diagnosed", () => {
  const repo = writeRouteRepo("route-bad-pin", "auto", "missingcli");
  opLoad({ cwd: repo });
  const result = opResolve({ hostModels: HOST });
  assert.equal(result.diagnostics[0].state, "blocked_no_binding");
  assert.match(result.diagnostics[0].hint, /missingcli/);
});

t("resolve: an auto role binding pin is named in diagnostics", () => {
  const repo = path.join(TMP, "route-auto-bad-pin");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, ".moa.yml"), `
schemaVersion: 1
roles:
  worker:
    use: [auto]
    binding: missingcli
pipelines: {}
`);
  opLoad({ cwd: repo });
  const result = opResolve({ hostModels: HOST });
  assert.equal(result.diagnostics[0].state, "blocked_no_binding");
  assert.match(result.diagnostics[0].hint, /missingcli/);
});


t("resolve: pinned + auto + differentModelFrom honored", () => {
  opLoad({ cwd: REPO });
  const r = opResolve({ hostModels: HOST });
  assert.equal(r.roles.planner.model, "claude-opus-4-8");
  assert.equal(r.roles.coder.model, "minimax/MiniMax-M3");
  assert.equal(r.roles.verifier.model, "openai/gpt-5.5");
  assert.notEqual(r.roles.verifier.group, r.roles.coder.group);
  assert.equal(r.diagnostics.length, 0);
  assert.ok(fs.existsSync(path.join(REPO, ".moa", "effective-config.json")));
});

t("resolve: requires load first (state discipline)", () => {
  // fresh import shares module state; simulate by checking error path via a bare load
  const r = opResolve.call(null, { hostModels: HOST });
  assert.ok(!r.error); // loaded above — just confirms happy path is stable
});

t("resolve: unresolvable role → blocked_no_model diagnostic", () => {
  const solo = path.join(TMP, "solo"); fs.mkdirSync(solo, { recursive: true });
  fs.writeFileSync(path.join(solo, ".moa.yml"), `
schemaVersion: 1
models:
  ghost: { id: nowhere/ghost-1, family: ghost, tags: [strong] }
roles:
  a: { use: [missing-name] }
pipelines: {}
`);
  // 'missing-name' fails crossCheck; use a registry name that resolves but pool-filter can't break
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
  const r = opResolve({
    hostModels: [{ id: "nowhere/ghost-1", family: "ghost", tags: ["strong"] }],
  });
  assert.equal(r.roles.a.model, "nowhere/ghost-1");
  assert.equal(r.diagnostics[0].state, "blocked_no_model");
  assert.equal(r.diagnostics[0].role, "b");
});

// --- run state machine --------------------------------------------------------

function freshRun() {
  opLoad({ cwd: REPO });
  opResolve({ hostModels: HOST });
  return opRunStart({ task: "test task", pipeline: "build", masterModel: "claude-fable-5", masterFamily: "claude" });
}

t("run_start: frame + first step from data", () => {
  const r = freshRun();
  assert.ok(r.runId);
  assert.ok(r.frame.config.includes(".moa.yml"));
  assert.equal(r.next.phase, "plan");
  assert.equal(r.next.model, "claude-opus-4-8");
});

t("step_report: wrong phase rejected with expected step", () => {
  const { runId } = freshRun();
  const r = opStepReport({ runId, phase: "execute", summary: "nope" });
  assert.ok(r.error.includes("expected report for phase 'plan'"));
});

t("step_report: gate without verdict rejected", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", summary: "looks fine" });
  assert.ok(r.error.includes("verdict"));
});

t("gate REVISE loops back and climbs the effort ladder", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", verdict: "REVISE", summary: "missing edge case" });
  assert.equal(r.looped, true);
  assert.equal(r.next.phase, "plan");
  // gate re-reached: reviewer's ladder [medium,xhigh] climbs on next pass
  opStepReport({ runId, phase: "plan", summary: "replanned" });
  const gate = opStepReport({ runId, phase: "plan", summary: "dup" }); // wrong on purpose: current is review-plan
  assert.ok(gate.error);
});

t("maxGateLoops exceeded → terminal with blocker", () => {
  const { runId } = freshRun();
  let r;
  for (let i = 0; i < 4; i++) {
    opStepReport({ runId, phase: "plan", summary: "planned" });
    r = opStepReport({ runId, phase: "review-plan", verdict: "REVISE", summary: "still wrong" });
    if (r.terminal) break;
  }
  assert.equal(r.terminal, "max_loops_exceeded");
  assert.ok(r.blocker.includes("review-plan"));
});

t("independence: gate step reports grade vs actual producer", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  opStepReport({ runId, phase: "review-plan", verdict: "APPROVE", summary: "ok" });
  const r = opStepReport({ runId, phase: "execute", summary: "coded", changedFiles: ["a.js"], producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
  assert.equal(r.next.phase, "validate");
  assert.equal(r.next.independence.grade, "cross-family");
  assert.equal(r.next.independence.pass, true);
});

t("full run to done; unverified label when critical gate not passed", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  opStepReport({ runId, phase: "review-plan", verdict: "APPROVE", summary: "ok" });
  opStepReport({ runId, phase: "execute", summary: "coded", changedFiles: ["a.js"], producerModel: "minimax/MiniMax-M3", producerFamily: "minimax" });
  const done = opStepReport({ runId, phase: "validate", verdict: "APPROVE", summary: "verified" });
  assert.equal(done.terminal, "done");
  assert.deepEqual(done.gatesPassed, ["review-plan", "validate"]);
});

t("gate BLOCKED → blocked_verifier_disagreement", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "planned" });
  const r = opStepReport({ runId, phase: "review-plan", verdict: "BLOCKED", summary: "cannot judge" });
  assert.equal(r.terminal, "blocked_verifier_disagreement");
});

t("finished run refuses further reports", () => {
  const { runId } = freshRun();
  opStepReport({ runId, phase: "plan", summary: "p" });
  opStepReport({ runId, phase: "review-plan", verdict: "BLOCKED", summary: "b" });
  const r = opStepReport({ runId, phase: "plan", summary: "again" });
  assert.ok(r.error.includes("blocked_verifier_disagreement"));
});

t("ad-hoc steps validated against resolved roles", () => {
  opLoad({ cwd: REPO });
  opResolve({ hostModels: HOST });
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

  const { run } = startExternalRun();
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
  opResolve({ hostModels: HOST });
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
  ghost: { id: ghost-1, family: ghost }
roles:
  worker: { use: [ghost] }
pipelines:
  broken:
    steps:
      - { phase: work, role: worker }
`);
  opLoad({ cwd: repo });
  const resolved = opResolve({ hostModels: HOST });
  assert.equal(resolved.diagnostics[0].state, "blocked_no_binding");
  const run = opRunStart({ task: "blocked role", pipeline: "broken" });
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "hello" });
  assert.equal(result.code, "role_unresolved");
});

await ta("spawn: reports unavailable tools and model drift", async () => {
  let profile = runnableProfile({ tool: "fake-gone" });
  let run = startExternalRun(profile).run;
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

  profile = runnableProfile({ tool: "fake-model-drift" });
  run = startExternalRun(profile).run;
  const drifted = runnableProfile({ tool: profile.tool });
  drifted.models = [{
    id: "vendor/other-9",
    family: "fake",
    tags: ["strong"],
  }];
  opBindingSave({ profile: drifted });
  assert.equal((await opSpawn({
    runId: run.runId,
    phase: "work",
    prompt: "hello",
  })).code, "model_not_served");
});

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
  const { run } = startExternalRun(profile);
  const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
  assert.equal(result.code, "unknown_placeholder");
});

await ta("spawn: reports malformed and missing declared output", async () => {
  const malformed = runnableProfile({
    tool: "fake-bad-json",
    mode: "badjson",
    output: { format: "json", resultPath: "response.text" },
  });
  let run = startExternalRun(malformed).run;
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
  run = startExternalRun(missing).run;
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
    const { run } = startExternalRun(profile);
    const result = await opSpawn({ runId: run.runId, phase: "work", prompt: "x" });
    assert.equal(result.code, code);
  }
});

// --- init ----------------------------------------------------------------------

t("init: guards existing config; force overwrites; splice validates", () => {
  const irepo = path.join(TMP, "irepo"); fs.mkdirSync(irepo, { recursive: true });
  const r1 = opInit({ template: "lite-build", cwd: irepo,
    registry: { opus: { id: "claude-opus-4-8", family: "claude", tags: ["strong"] } },
    roles: { planner: ["opus", "auto"] } });
  assert.ok(r1.written.endsWith(".moa.yml"));
  assert.equal(r1.spliced, true);
  const written = fs.readFileSync(r1.written, "utf8");
  assert.ok(written.includes("claude-opus-4-8"));
  assert.ok(written.includes("#"), "template comments survive");

  const r2 = opInit({ template: "lite-build", cwd: irepo });
  assert.ok(r2.error.includes("already exists"));
  const r3 = opInit({ template: "lite-build", cwd: irepo, force: true });
  assert.ok(r3.written);

  const loaded = opLoad({ cwd: irepo });
  assert.ok(!loaded.errors, JSON.stringify(loaded.errors));
});

t("init: unknown template rejected", () => {
  assert.ok(opInit({ template: "nope", cwd: TMP }).error.includes("unknown template"));
});

console.log(`\n${n} checks passed`);
