#!/usr/bin/env node
// moa — MCP server for the Master of Agents skill.
// Moves moa's deterministic contract (config load/validation, role→model
// resolution, gate sequencing, independence grading, run store) from prose
// into code. The master stays the conductor: it frames, spawns, synthesizes;
// this server holds state and refuses illegal transitions.
//
// CLI mode (debugging): `node server.mjs load [cwd]`
// MCP mode:             `node server.mjs`

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOA_HOME = () => process.env.MOA_HOME ?? os.homedir();
const BINDINGS_DIR = () => path.join(MOA_HOME(), ".moa", "bindings");
const TEMPLATES = ["solo-research", "research-synth", "lite-build", "full-engineering", "design"];

// --- config schema (zod mirror of schema/config.schema.json) -------------

const zEffort = z.array(z.string()).min(1);
const zModelEntry = z.object({
  id: z.string().optional(),
  effort: zEffort.optional(),
  tags: z.array(z.string()).optional(),
  family: z.string().optional(),
  binding: z.string().optional(),
  provider: z.string().optional(),
  context: z.number().int().positive().optional(),
  cost: z.enum(["cheap", "standard", "premium"]).optional(),
  priority: z.number().int().optional(),
  enabled: z.boolean().optional(),
}).strict();

const zRole = z.object({
  description: z.string().optional(),
  use: z.array(z.string()).min(1),
  effort: zEffort.optional(),
  binding: z.string().optional(),
  tools: z.string().optional(),
  skills: z.array(z.string()).optional(),
  instructions: z.string().optional(),
  instructionsFile: z.string().optional(),
  differentModelFrom: z.string().optional(),
}).strict();

const zStep = z.object({
  phase: z.string(),
  role: z.string(),
  gate: z.enum(["none", "standard", "critical"]).optional(),
  fanout: z.enum(["none", "byDisjointWriteSet"]).optional(),
  loopBackTo: z.string().optional(),
}).strict();

const zPipeline = z.object({
  description: z.string().optional(),
  steps: z.array(zStep).min(1),
}).strict();

const zConfig = z.object({
  schemaVersion: z.literal(1),
  runtime: z.object({
    resolution: z.literal("by-model").optional(),
    subagents: z.enum(["auto", "native", "external", "blocked"]).optional(),
    requireEnforcement: z.enum(["strict", "sandbox", "best-effort"]).optional(),
    workDir: z.string().optional(),
    defaults: z.object({
      timeoutSeconds: z.number().int().positive().optional(),
      maxParallel: z.number().int().positive().optional(),
      maxGateLoops: z.number().int().min(0).optional(),
      maxCost: z.number().min(0).optional(),
      maxTokens: z.number().int().min(0).optional(),
      noExternalSkills: z.boolean().optional(),
      noExternalExtensions: z.boolean().optional(),
      failOnUnknownTool: z.boolean().optional(),
      allowInlineWithoutGates: z.boolean().optional(),
    }).strict().optional(),
  }).strict().optional(),
  template: z.object({
    base: z.enum(["research", "engineering", "migration", "qa", "design", "custom"]).optional(),
    projectType: z.string().optional(),
  }).strict().optional(),
  models: z.record(z.string(), zModelEntry).optional(),
  master: z.object({
    mode: z.enum(["strict", "auto"]).optional(),
    modelAdvisory: z.object({
      minContextTokens: z.number().int().min(0).optional(),
      optimizeFor: z.array(z.string()).optional(),
    }).strict().optional(),
    selfCertification: z.literal("forbidden").optional(),
    hardVerificationTags: z.array(z.string()).optional(),
    instructions: z.string().optional(),
  }).strict().optional(),
  toolPolicies: z.record(z.string(), z.any()).optional(),
  roles: z.record(z.string(), zRole).optional(),
  pipelines: z.record(z.string(), zPipeline).optional(),
}).strict();

const zProfile = z.object({
  tool: z.string().regex(/^[\w.-]+$/),
  bin: z.string(),
  version: z.string().optional(),
  run: z.object({
    argv: z.array(z.string()).min(1),
    promptVia: z.enum(["file", "stdin", "arg"]).optional(),
    modelPlaceholder: z.string().optional(),
    isolationFlags: z.array(z.string()).optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  }),
  output: z.object({ format: z.enum(["text", "json", "jsonl"]).optional(), resultPath: z.string().optional() }).optional(),
  models: z.array(z.object({ id: z.string(), family: z.string(), tags: z.array(z.string()).optional() })).min(1),
  listModels: z.array(z.string()).optional(),
  capabilities: z.object({
    canProduce: z.boolean().optional(),
    canSelectModel: z.boolean().optional(),
    promptSafe: z.boolean(),
    toolRestriction: z.string().optional(),
  }),
  evidence: z.object({
    probedOn: z.string(),
    tests: z.record(z.string(), z.string()),
  }),
});

function profileRejectionReason(profile) {
  if (profile.capabilities.promptSafe !== true ||
      profile.evidence.tests.T1 !== "pass" ||
      profile.evidence.tests.T4 !== "pass")
    return "unproven_profile";
  if ((profile.run.promptVia ?? "file") === "arg")
    return "unsafe_prompt_transport";
  if ((profile.run.promptVia ?? "file") === "file" &&
      !profile.run.argv.some((arg) => arg.includes("{promptFile}")))
    return "invalid_profile";
  return null;
}

// --- helpers --------------------------------------------------------------

function parseYamlStrict(src, label) {
  const doc = YAML.parseDocument(src, { uniqueKeys: true });
  const errors = doc.errors.map((e) => `${label}: ${e.message.split("\n")[0]}`);
  YAML.visit(doc, {
    Alias() { errors.push(`${label}: anchors/aliases are outside the YAML safe subset`); return YAML.visit.BREAK; },
  });
  if (errors.length) return { errors };
  return { value: doc.toJS() };
}

function crossCheck(cfg) {
  const errs = [];
  const modelNames = new Set(Object.keys(cfg.models ?? {}));
  const roleNames = new Set(Object.keys(cfg.roles ?? {}));
  for (const [rname, role] of Object.entries(cfg.roles ?? {})) {
    for (const u of role.use)
      if (u !== "auto" && !modelNames.has(u))
        errs.push(`role '${rname}': use '${u}' is not in the models registry (and not 'auto')`);
    if (role.differentModelFrom && !roleNames.has(role.differentModelFrom))
      errs.push(`role '${rname}': differentModelFrom names unknown role '${role.differentModelFrom}'`);
  }
  if (modelNames.has("auto")) errs.push("models registry: 'auto' is reserved and cannot be a key");
  for (const [pname, pipe] of Object.entries(cfg.pipelines ?? {})) {
    const phases = new Set();
    for (const s of pipe.steps) {
      if (phases.has(s.phase)) errs.push(`pipeline '${pname}': duplicate phase '${s.phase}'`);
      phases.add(s.phase);
      if (s.role !== "master" && !roleNames.has(s.role))
        errs.push(`pipeline '${pname}': step '${s.phase}' names unknown role '${s.role}'`);
    }
    for (const s of pipe.steps)
      if (s.loopBackTo && !phases.has(s.loopBackTo))
        errs.push(`pipeline '${pname}': step '${s.phase}' loopBackTo names unknown phase '${s.loopBackTo}'`);
  }
  return errs;
}

function findConfig(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const p = path.join(dir, ".moa.yml");
    if (fs.existsSync(p)) return p;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

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
      const rejection = profileRejectionReason(profile);
      if (rejection) {
        skipped.push({ tool: dir, reason: rejection });
        continue;
      }
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

export function opTools() {
  const { tools, skipped } = loadBindings();
  return { tools, skipped };
}

// independence keys on the MODEL: collapse provider aliases + effort suffixes
function independenceGroup(id) {
  const base = String(id).split("/").pop().split(":")[0].toLowerCase();
  return base;
}
const shortName = (id) => String(id).split("/").pop().split(":")[0];

function candidatePool(cfg, bindings, hostModels) {
  const pool = [];
  // dedupe by independence group: provider aliases collapse; first declaration wins (registry first)
  const add = (m) => {
    const group = independenceGroup(m.id);
    const existing = pool.find((p) => p.group === group);
    if (existing) { existing.sources.push(m.source); return; }
    pool.push({ ...m, group, sources: [m.source] });
  };
  let i = 0;
  for (const [name, entry] of Object.entries(cfg?.models ?? {})) {
    if (entry.enabled === false) continue;
    add({
      shortName: name, id: entry.id ?? name, family: entry.family,
      tags: entry.tags ?? [], context: entry.context, cost: entry.cost,
      priority: entry.priority ?? i++, effort: entry.effort,
      binding: entry.binding, source: "registry",
    });
  }
  for (const b of bindings)
    for (const m of b.models ?? [])
      add({ shortName: shortName(m.id), id: m.id, family: m.family, tags: m.tags ?? [],
            priority: 1000 + i++, binding: b.tool, source: `binding:${b.tool}` });
  for (const m of hostModels ?? [])
    add({ shortName: shortName(m.id), id: m.id, family: m.family, tags: m.tags ?? [],
          context: m.context, priority: 2000 + i++, binding: "host-native", source: "host" });
  return pool;
}

// --- session state (also persisted; runs reload from disk) ---------------

const state = { loaded: null, resolved: null };

function workDirOf(loaded) {
  const wd = loaded.config?.runtime?.workDir ?? ".moa";
  return path.join(loaded.projectDir, wd);
}

// --- operations -----------------------------------------------------------

export function opLoad({ cwd = process.cwd() } = {}) {
  const configPath = findConfig(cwd);
  const { bindings, tools, skipped } = loadBindings();
  if (!configPath) {
    const projectDir = path.resolve(cwd);
    state.loaded = {
      config: null,
      configPath: null,
      projectDir,
      dispatch: "adaptive-bare",
      bindings,
    };
    state.resolved = null;
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
  const parsed = parseYamlStrict(fs.readFileSync(configPath, "utf8"), path.basename(configPath));
  if (parsed.errors) return { configPath, errors: parsed.errors };
  const v = zConfig.safeParse(parsed.value);
  if (!v.success)
    return { configPath, errors: v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
  const errs = crossCheck(v.data);
  if (errs.length) return { configPath, errors: errs };
  const cfg = v.data;
  const dispatch = cfg.pipelines?.default ? "workflow" : "adaptive-config";
  const projectDir = path.dirname(configPath);
  state.loaded = { config: cfg, configPath, projectDir, dispatch, bindings };
  state.resolved = null;
  return {
    configPath, dispatch, mode: cfg.master?.mode ?? "auto",
    schemaVersion: cfg.schemaVersion,
    roles: Object.fromEntries(Object.entries(cfg.roles ?? {}).map(([n, r]) => [n, {
      use: r.use, tools: r.tools, differentModelFrom: r.differentModelFrom,
      instructions: r.instructions ?? (r.instructionsFile ?? null),
    }])),
    models: cfg.models ?? {},
    pipelines: Object.fromEntries(Object.entries(cfg.pipelines ?? {}).map(([n, p]) => [n, {
      description: p.description,
      steps: p.steps.map((s) => `${s.phase}(${s.role}${s.gate && s.gate !== "none" ? `,gate:${s.gate}` : ""})`),
    }])),
    defaults: cfg.runtime?.defaults ?? {},
    subagents: cfg.runtime?.subagents ?? "auto",
    bindings: tools.filter((tool) => tool.available),
    skippedBindings: skipped,
  };
}

function autoPick(pool, { role, roleName, needTags, notGroups, cfg }) {
  let c = pool.filter((m) => needTags.every((t) => (m.tags ?? []).includes(t)));
  if (notGroups.size) c = c.filter((m) => !notGroups.has(m.group));
  if (!c.length) return null;
  const costRank = { cheap: 0, standard: 1, premium: 2 };
  c.sort((a, b) =>
    (costRank[a.cost] ?? 1) - (costRank[b.cost] ?? 1) || (a.priority - b.priority));
  return c[0];
}

export function opResolve({ hostModels = [], overrides = {} } = {}) {
  if (!state.loaded) return { error: "call moa_load first" };
  const { config: cfg, bindings } = state.loaded;
  const pool = candidatePool(cfg, bindings, hostModels);
  if (!cfg) {
    state.resolved = { pool, roles: {} };
    return { pool: pool.map(poolRow), roles: {}, note: "no config — staff ad-hoc roles from this pool; pass explicit models in run_start steps" };
  }
  const hardTags = cfg.master?.hardVerificationTags ?? ["strong"];
  // criticality: a role is hard-verifier if any pipeline step running it has gate: critical
  const criticalRoles = new Set();
  for (const p of Object.values(cfg.pipelines ?? {}))
    for (const s of p.steps) if (s.gate === "critical") criticalRoles.add(s.role);

  // resolve in dependency order: roles without differentModelFrom first
  const names = Object.keys(cfg.roles ?? {});
  names.sort((a, b) => (cfg.roles[a].differentModelFrom ? 1 : 0) - (cfg.roles[b].differentModelFrom ? 1 : 0));
  const roles = {};
  const diagnostics = [];
  for (const rname of names) {
    const role = cfg.roles[rname];
    const notGroups = new Set();
    if (role.differentModelFrom && roles[role.differentModelFrom])
      notGroups.add(roles[role.differentModelFrom].group);
    const needTags = criticalRoles.has(rname) ? hardTags : [];
    let pick = null, reason = null;
    const useList = overrides[rname] ? [overrides[rname]] : role.use;
    for (const u of useList) {
      if (u === "auto") {
        pick = autoPick(pool, { role, roleName: rname, needTags, notGroups, cfg });
        if (pick) reason = `auto: ${needTags.length ? `tags [${needTags}] ` : ""}lowest-cost/priority pick`;
      } else {
        const m = pool.find((x) => x.shortName === u || x.id === u);
        if (m && !notGroups.has(m.group)) { pick = m; reason = overrides[rname] ? "per-run override" : `pinned '${u}'`; }
        else if (m) reason = `'${u}' skipped: same model as '${role.differentModelFrom}'`;
      }
      if (pick) break;
    }
    if (!pick) {
      diagnostics.push({ state: "blocked_no_model", role: rname, tried: useList, hint: "no candidate in registry/bindings/host cleared the constraints" });
      continue;
    }
    const effort = role.effort ?? pick.effort ?? ["auto"];
    roles[rname] = {
      model: pick.id, shortName: pick.shortName, family: pick.family ?? null,
      group: pick.group, binding: role.binding ?? pick.binding ?? "host-native",
      effort, effortRung: 0,
      selectionReason: reason,
    };
  }
  state.resolved = { pool, roles, hardTags };
  // materialize effective-config.json (config-present only)
  const wd = workDirOf(state.loaded);
  fs.mkdirSync(wd, { recursive: true });
  fs.writeFileSync(path.join(wd, "effective-config.json"),
    JSON.stringify({ resolvedAt: new Date().toISOString(), configPath: state.loaded.configPath, roles }, null, 2) + "\n");
  return {
    roles, diagnostics,
    pool: pool.map(poolRow),
    effectiveConfig: path.join(wd, "effective-config.json"),
  };
}
const poolRow = (m) => ({ shortName: m.shortName, id: m.id, family: m.family ?? null, tags: m.tags, binding: m.binding ?? "host-native", source: m.sources.join("+") });

// --- run state machine ----------------------------------------------------

function runDir(runId) {
  if (!state.loaded) throw new Error("call moa_load first");
  return path.join(workDirOf(state.loaded), "runs", runId);
}
function loadRun(runId) {
  const p = path.join(runDir(runId), "manifest.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveRun(m) {
  const d = runDir(m.runId);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
}

function gradeOf(verifier, producer) {
  if (!producer || !verifier) return "unknown";
  if (verifier.group === producer.group) return "self-check";
  if (verifier.family && producer.family && verifier.family !== producer.family) return "cross-family";
  return "cross-model";
}

// nearest preceding producing (non-gate, non-master) step before index i;
// falls back to master when none exists.
function producerFor(manifest, i) {
  for (let j = i - 1; j >= 0; j--) {
    const s = manifest.steps[j];
    if ((s.gate ?? "none") === "none" && s.role !== "master") {
      const rec = manifest.phases.findLast((p) => p.phase === s.phase);
      if (rec?.producerModel)
        return { group: independenceGroup(rec.producerModel), family: rec.producerFamily ?? null, model: rec.producerModel, phase: s.phase };
      const r = manifest.resolved[s.role];
      return r ? { group: r.group, family: r.family, model: r.model, phase: s.phase } : null;
    }
  }
  const mm = manifest.masterModel;
  return mm ? { group: independenceGroup(mm), family: manifest.masterFamily ?? null, model: mm, phase: "master" } : null;
}

function describeStep(manifest, i) {
  const s = manifest.steps[i];
  const isMaster = s.role === "master";
  const r = isMaster ? null : manifest.resolved[s.role];
  const gate = s.gate ?? "none";
  const out = {
    index: i, phase: s.phase, role: s.role, gate,
    loopBackTo: s.loopBackTo ?? null,
    isMaster,
  };
  if (r) {
    const rung = Math.min(manifest.loops[s.loopBackTo ?? s.phase] ?? 0, r.effort.length - 1);
    out.model = r.model;
    out.family = r.family;
    out.effort = r.effort[rung];
    out.binding = r.binding;
    out.spawn = r.binding === "host-native"
      ? { kind: "native", note: "use your host's subagent capability" }
      : { kind: "profile", tool: r.binding, note: "call moa_spawn_prep with the prompt to get safe argv" };
    out.instructions = manifest.roleInstructions?.[s.role] ?? null;
  }
  if (gate !== "none") {
    const prod = producerFor(manifest, i);
    const grade = gradeOf(r, prod);
    out.independence = {
      producer: prod ? `${prod.model} (${prod.phase})` : "unknown",
      verifier: r?.model ?? "master",
      grade,
      pass: grade === "cross-family" || grade === "cross-model",
      label: grade === "cross-model" ? "cross-model — same family" :
             grade === "self-check" ? "unverified — no independent model" : null,
    };
    if (!out.independence.pass && manifest.mode === "strict" && gate === "critical") {
      out.blocked = "verification_unavailable";
      out.note = "strict mode: a critical gate with no different-model verifier halts — pin a different model, connect a tool (/moa learn-tool), or override";
    }
    out.verdictRequired = true;
  }
  return out;
}

export function opRunStart({ task, pipeline, steps, masterModel, masterFamily } = {}) {
  if (!state.loaded) return { error: "call moa_load first" };
  if (!state.resolved) return { error: "call moa_resolve first (pass the host-native model list)" };
  const { config: cfg, dispatch, configPath } = state.loaded;
  let chosen, name;
  if (steps) {
    const v = z.array(zStep).min(1).safeParse(steps);
    if (!v.success) return { error: "invalid steps: " + v.error.issues.map((i) => i.message).join("; ") };
    for (const s of steps)
      if (s.role !== "master" && !state.resolved.roles[s.role])
        return { error: `steps name unresolved role '${s.role}' — declare it in .moa.yml or resolve it first` };
    chosen = steps; name = "ad-hoc";
  } else if (cfg) {
    name = pipeline ?? (dispatch === "workflow" ? "default" : null);
    if (!name) {
      const avail = Object.keys(cfg.pipelines ?? {});
      return { error: `adaptive mode: pass pipeline (one of: ${avail.join(", ") || "none declared"}) or explicit steps` };
    }
    if (!cfg.pipelines?.[name]) return { error: `unknown pipeline '${name}'` };
    chosen = cfg.pipelines[name].steps;
  } else return { error: "no config: pass explicit steps" };

  const runId = "run-" + new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "").replace(/^(\d{8})/, "$1-") + "-" + crypto.randomBytes(2).toString("hex");
  const manifest = {
    runId, task, pipeline: name,
    mode: cfg?.master?.mode ?? "auto",
    dispatch,
    maxGateLoops: cfg?.runtime?.defaults?.maxGateLoops ?? 2,
    allowInlineWithoutGates: cfg?.runtime?.defaults?.allowInlineWithoutGates ?? false,
    steps: chosen, current: 0,
    resolved: state.resolved.roles,
    roleInstructions: Object.fromEntries(Object.entries(cfg?.roles ?? {}).map(([n, r]) => [n, r.instructions ?? null])),
    masterModel: masterModel ?? null, masterFamily: masterFamily ?? null,
    phases: [], loops: {}, usage: [], status: "running",
    createdAt: new Date().toISOString(),
  };
  saveRun(manifest);
  const gates = chosen.filter((s) => (s.gate ?? "none") !== "none").map((s) => `${s.phase}(${s.gate})`);
  const frame = {
    config: configPath ? `${configPath} · schemaVersion ${cfg.schemaVersion} · roles: ${Object.keys(cfg.roles ?? {}).join(",")}` : "none",
    mode: manifest.mode, dispatch: name === "ad-hoc" ? "adaptive→composed" : dispatch === "workflow" ? "workflow:default" : `adaptive→named:${name}`,
    pipeline: chosen.map((s) => s.phase).join("→"),
    gates: gates.join(", ") || "none",
    roles: Object.fromEntries(Object.entries(manifest.resolved).map(([n, r]) => [n, `${r.model}:${r.effort[0]} (${r.family ?? "?"})`])),
  };
  return { runId, frame, next: describeStep(manifest, 0) };
}

export function opStepReport({ runId, phase, verdict, summary, changedFiles = [], producerModel, producerFamily, usage } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return { error: `unknown runId '${runId}'` };
  if (manifest.status !== "running") return { error: `run is '${manifest.status}' — start a new run`, status: manifest.status };
  const step = manifest.steps[manifest.current];
  if (phase !== step.phase)
    return { error: `expected report for phase '${step.phase}', got '${phase}'`, expected: describeStep(manifest, manifest.current) };
  const gate = step.gate ?? "none";
  if (gate !== "none" && !["APPROVE", "REVISE", "BLOCKED", "ERROR"].includes(verdict))
    return { error: `phase '${phase}' is a ${gate} gate — verdict APPROVE|REVISE|BLOCKED|ERROR is required` };

  manifest.phases.push({
    phase, role: step.role, verdict: verdict ?? null, summary: summary ?? null,
    changedFiles, producerModel: producerModel ?? null, producerFamily: producerFamily ?? null,
    ts: new Date().toISOString(),
  });
  if (usage) manifest.usage.push({ phase, ...usage });

  const finish = () => {
    const mutated = manifest.phases.some((p) => p.changedFiles?.length);
    const criticalPassed = manifest.steps.some((s, i) => s.gate === "critical" &&
      manifest.phases.some((p) => p.phase === s.phase && p.verdict === "APPROVE"));
    if (mutated && !criticalPassed) {
      manifest.status = "done_unverified";
      saveRun(manifest);
      return { terminal: manifest.status, label: "unverified inline mode — repo mutated without a passed critical gate", runId };
    }
    manifest.status = "done";
    saveRun(manifest);
    return {
      terminal: "done", runId,
      gatesPassed: manifest.phases.filter((p) => p.verdict === "APPROVE").map((p) => p.phase),
      phases: manifest.phases.length,
    };
  };

  if (gate !== "none" && verdict === "REVISE") {
    const target = step.loopBackTo ?? null;
    const ti = target ? manifest.steps.findIndex((s) => s.phase === target)
      : (() => { for (let j = manifest.current - 1; j >= 0; j--) if ((manifest.steps[j].gate ?? "none") === "none" && manifest.steps[j].role !== "master") return j; return -1; })();
    if (ti < 0) return { error: `REVISE at '${phase}' but no loop-back target — declare loopBackTo` };
    const key = phase;
    manifest.loops[key] = (manifest.loops[key] ?? 0) + 1;
    manifest.loops[manifest.steps[ti].phase] = manifest.loops[key]; // effort ladder climbs on the reworked phase
    if (manifest.loops[key] > manifest.maxGateLoops) {
      manifest.status = "max_loops_exceeded";
      saveRun(manifest);
      return {
        terminal: "max_loops_exceeded", runId,
        blocker: `gate '${phase}' returned REVISE ${manifest.loops[key]} times (max ${manifest.maxGateLoops})`,
        nextHumanAction: "review the recorded findings in the run manifest and decide: change the plan, relax the criteria, or take over",
      };
    }
    manifest.current = ti;
    saveRun(manifest);
    return { looped: true, to: manifest.steps[ti].phase, loop: manifest.loops[key], of: manifest.maxGateLoops, next: describeStep(manifest, ti) };
  }
  if (gate !== "none" && verdict === "BLOCKED") {
    manifest.status = "blocked_verifier_disagreement";
    saveRun(manifest);
    return {
      terminal: "blocked_verifier_disagreement", runId,
      note: "route to an independent arbiter (a third model, different from producer AND verifier) or halt with both positions recorded",
    };
  }
  if (gate !== "none" && verdict === "ERROR") {
    saveRun(manifest);
    return { retry: describeStep(manifest, manifest.current), note: "gate errored — re-spawn the verifier; report again" };
  }

  manifest.current += 1;
  if (manifest.current >= manifest.steps.length) return finish();
  saveRun(manifest);
  const next = describeStep(manifest, manifest.current);
  if (next.blocked === "verification_unavailable") {
    manifest.status = "verification_unavailable";
    saveRun(manifest);
    return { terminal: "verification_unavailable", runId, note: next.note, step: next };
  }
  return { next };
}

export function opSpawnPrep({ runId, phase, prompt } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return { error: `unknown runId '${runId}'` };
  const step = manifest.steps.find((s) => s.phase === phase);
  if (!step) return { error: `unknown phase '${phase}'` };
  const r = manifest.resolved[step.role];
  if (!r) return { error: `phase '${phase}' has no resolved role` };
  if (r.binding === "host-native") return { error: "native spawn — use your host's subagent capability directly; spawn_prep is for learned-tool bindings" };
  const { bindings } = loadBindings();
  const profile = bindings.find((b) => b.tool === r.binding);
  if (!profile) return { error: `binding profile '${r.binding}' not found in ~/.moa/bindings — re-run /moa learn-tool` };
  const d = runDir(runId);
  fs.mkdirSync(d, { recursive: true });
  const promptFile = path.join(d, `prompt-${phase}-${Date.now()}.md`);
  fs.writeFileSync(promptFile, prompt);
  const cwd = path.dirname(state.loaded?.configPath ?? process.cwd());
  const argv = profile.run.argv.map((a) =>
    String(a).replaceAll("{model}", r.model).replaceAll("{promptFile}", promptFile).replaceAll("{cwd}", cwd));
  return {
    argv,
    promptVia: profile.run.promptVia ?? "file",
    promptFile,
    timeoutSeconds: profile.run.timeoutSeconds ?? 1800,
    output: profile.output ?? { format: "text", resultPath: "stdout" },
    note: "run with your shell; prompt travels by file — never inline it into the command",
  };
}

// --- init ------------------------------------------------------------------

export function opInit({ template, registry = {}, roles = {}, force = false, cwd = process.cwd() } = {}) {
  if (!TEMPLATES.includes(template))
    return { error: `unknown template '${template}' — one of: ${TEMPLATES.join(", ")}` };
  const target = path.join(path.resolve(cwd), ".moa.yml");
  if (fs.existsSync(target) && !force) {
    const cur = parseYamlStrict(fs.readFileSync(target, "utf8"), ".moa.yml");
    return {
      error: ".moa.yml already exists — pass force:true to regenerate, or edit it directly",
      existing: { template: cur.value?.template ?? null, models: Object.keys(cur.value?.models ?? {}) },
    };
  }
  const tplSrc = fs.readFileSync(path.join(SKILL_DIR, "templates", `${template}.yml`), "utf8");
  const doc = YAML.parseDocument(tplSrc);
  // splice registry (union of per-role picks only) + role use lists; comments survive
  if (Object.keys(registry).length) {
    const node = doc.createNode(registry);
    doc.setIn(["models"], node);
  }
  for (const [rname, use] of Object.entries(roles)) {
    if (!doc.hasIn(["roles", rname])) return { error: `template '${template}' has no role '${rname}'` };
    const arr = doc.createNode(use);
    arr.flow = true;
    doc.setIn(["roles", rname, "use"], arr);
  }
  let out = doc.toString();
  const check = parseYamlStrict(out, ".moa.yml");
  const valid = !check.errors && zConfig.safeParse(check.value).success && !crossCheck(check.value ?? {}).length;
  if (!valid) { out = tplSrc; } // fall back to the untouched template rather than write a broken file
  fs.writeFileSync(target, out);
  return {
    written: target, template, spliced: valid,
    ...(valid ? {} : { note: "splice failed validation — wrote the untouched template (models: {} / use: [auto]); edit by hand" }),
    registry: valid ? Object.keys(registry) : [],
  };
}

// --- binding save (learn-tool persistence) ---------------------------------


export function opBindingSave({ profile } = {}) {
  const v = zProfile.safeParse(profile);
  if (!v.success) return { error: "invalid profile: " + v.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
  const p = v.data;
  const rejection = profileRejectionReason(p);
  if (rejection === "unproven_profile")
    return { error: "refusing to bind an unproven profile — T1 (liveness) and T4 (prompt-injection safety) must both be 'pass' and promptSafe must be true" };
  if (rejection === "unsafe_prompt_transport")
    return { error: "promptVia 'arg' is shell-interpolation territory — use file or stdin" };
  if (rejection === "invalid_profile")
    return { error: "run.argv must reference {promptFile} when promptVia is 'file'" };
  const dir = path.join(BINDINGS_DIR(), p.tool);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "profile.yml");
  fs.writeFileSync(file, YAML.stringify(p));
  const families = [...new Set(p.models.map((m) => m.family))];
  const discovered = opTools();
  return {
    bound: file,
    models: p.models.length,
    families,
    tool: discovered.tools.find((tool) => tool.tool === p.tool),
    note: `models from ${families.length} famil${families.length === 1 ? "y" : "ies"} now available to every project`,
  };
}

// --- CLI mode (debugging) --------------------------------------------------

// realpath both sides: node resolves ESM URLs to the real file, but argv keeps
// the symlink path (e.g. ~/.claude/skills/moa/mcp/server.mjs)
const isMain = process.argv[1] &&
  fileURLToPath(import.meta.url) === fs.realpathSync(path.resolve(process.argv[1]));
if (isMain && process.argv[2] === "load") {
  console.log(JSON.stringify(opLoad({ cwd: process.argv[3] ?? process.cwd() }), null, 2));
  process.exit(0);
}

// --- MCP mode ----------------------------------------------------------------

if (isMain) await startMcp();

async function startMcp() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const server = new McpServer({ name: "moa", version: "0.6.0" });
  const json = (r) => ({ content: [{ type: "text", text: JSON.stringify(r) }], isError: !!r?.error });

  server.tool(
    "moa_load",
    "FIRST CALL of every moa run. Locates .moa.yml (cwd→root), parses + validates it, reads learned tool profiles (~/.moa/bindings). Returns the normalized config, dispatch mode (workflow|adaptive-config|adaptive-bare), roles, pipelines, and connected tools. Replaces reading the config by hand.",
    { cwd: z.string().optional().describe("directory to search from; defaults to the server's cwd") },
    async (a) => json(opLoad(a))
  );

  server.tool(
    "moa_resolve",
    "SECOND CALL. Pass the host-native models you (the master) can spawn subagents on; the server merges them with the config registry + learned tools, resolves every role's model/effort/binding deterministically, checks independence constraints, and writes effective-config.json. Returns the per-role resolution + candidate pool + diagnostics.",
    {
      hostModels: z.array(z.object({
        id: z.string(), family: z.string().optional(),
        tags: z.array(z.string()).optional(), context: z.number().int().optional(),
      })).describe("models spawnable via the host's native subagent capability"),
      overrides: z.record(z.string(), z.string()).optional().describe("per-run role→model-short-name overrides (highest precedence)"),
    },
    async (a) => json(opResolve(a))
  );

  server.tool(
    "moa_run_start",
    "Start a gated run. Selects the pipeline (named; 'default' in workflow mode; or explicit ad-hoc steps in adaptive mode), creates the run store + manifest, and returns {runId, frame, next}. Print the frame to the user, then execute `next`.",
    {
      task: z.string().describe("one-line task statement"),
      pipeline: z.string().optional().describe("named pipeline from the config"),
      steps: z.array(z.object({
        phase: z.string(), role: z.string(),
        gate: z.enum(["none", "standard", "critical"]).optional(),
        fanout: z.enum(["none", "byDisjointWriteSet"]).optional(),
        loopBackTo: z.string().optional(),
      })).optional().describe("ad-hoc composed steps (adaptive mode)"),
      masterModel: z.string().optional().describe("YOUR host model id — required for correct independence checks when you author a phase yourself"),
      masterFamily: z.string().optional(),
    },
    async (a) => json(opRunStart(a))
  );

  server.tool(
    "moa_step_report",
    "Report the current phase's outcome; the server records it and returns the NEXT step or a terminal state. Enforced here (not by you): gates need a verdict; REVISE loops back (maxGateLoops capped, effort ladder climbs); verifier independence is checked against the actual producer; a mutated repo without a passed critical gate finishes labeled 'unverified'. Never decide the next phase yourself.",
    {
      runId: z.string(),
      phase: z.string().describe("the phase being reported — must be the current one"),
      verdict: z.enum(["APPROVE", "REVISE", "BLOCKED", "ERROR"]).optional().describe("required on gate phases"),
      summary: z.string().describe("1-3 line result summary (findings on REVISE)"),
      changedFiles: z.array(z.string()).optional().describe("files this phase mutated in the repo"),
      producerModel: z.string().optional().describe("model that actually produced this phase's work (pass your own model id if you authored it)"),
      producerFamily: z.string().optional(),
      usage: z.object({ tokens: z.number().optional(), cost: z.number().optional() }).optional(),
    },
    async (a) => json(opStepReport(a))
  );

  server.tool(
    "moa_spawn_prep",
    "For phases bound to a learned CLI tool: pass the role's prompt; the server writes it to a temp file and returns ready-to-run argv (model/promptFile/cwd filled from the profile). The prompt never transits the command line — run the argv with your shell, read the result per `output`.",
    { runId: z.string(), phase: z.string(), prompt: z.string() },
    async (a) => json(opSpawnPrep(a))
  );

  server.tool(
    "moa_init",
    "Write .moa.yml from a bundled template (comments preserved), splicing in the models registry (union of per-role picks ONLY — never the full discovered pool) and each role's use list. Guards an existing config unless force. You still do detection, picks, and user confirmation first.",
    {
      template: z.enum(["solo-research", "research-synth", "lite-build", "full-engineering", "design"]),
      registry: z.record(z.string(), z.object({
        id: z.string().optional(), family: z.string().optional(),
        tags: z.array(z.string()).optional(), context: z.number().int().optional(),
        effort: z.array(z.string()).optional(),
      })).optional().describe("models map — only models some role actually uses"),
      roles: z.record(z.string(), z.array(z.string())).optional().describe("role name → use list, e.g. {planner: ['opus','auto']}"),
      force: z.boolean().optional(),
      cwd: z.string().optional().describe("repo root to write into; defaults to server cwd"),
    },
    async (a) => json(opInit(a))
  );

  server.tool(
    "moa_binding_save",
    "Persist a learn-tool profile to ~/.moa/bindings/<tool>/profile.yml. Refuses in code any profile whose evidence lacks T1+T4 = pass or promptSafe: true — run the probe protocol (references/learn-tool.md) first and pass the proven result.",
    { profile: z.any().describe("the full profile object per references/learn-tool.md") },
    async (a) => json(opBindingSave(a))
  );

  await server.connect(new StdioServerTransport());
}
