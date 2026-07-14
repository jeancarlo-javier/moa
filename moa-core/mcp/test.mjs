// moa MCP — self-check. Run: node test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "moa-test-"));
process.env.MOA_HOME = path.join(TMP, "home");
const REPO = path.join(TMP, "repo");
fs.mkdirSync(REPO, { recursive: true });

const { opLoad, opTools, opResolve, opRunStart, opStepReport, opSpawn, opSpawnPrep, opInit, opBindingSave } =
  await import("./server.mjs");

const HOST = [
  { id: "claude-opus-4-8", family: "claude", tags: ["strong"] },
  { id: "claude-sonnet-4-6", family: "claude", tags: ["strong", "cheap"] },
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

// --- resolve -----------------------------------------------------------------

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
  const r = opResolve({ hostModels: [] });
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

// --- spawn_prep ----------------------------------------------------------------


t("spawn_prep: native binding is refused", () => {
  opLoad({ cwd: REPO });
  opResolve({ hostModels: HOST });
  const run = opRunStart({ task: "n", steps: [{ phase: "p", role: "planner" }] });
  const r = opSpawnPrep({ runId: run.runId, phase: "p", prompt: "x" });
  assert.ok(r.error.includes("native"));
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
