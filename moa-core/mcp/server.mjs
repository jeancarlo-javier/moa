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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { z } from "zod";

const SKILL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const MOA_HOME = () => process.env.MOA_HOME ?? os.homedir();
const BINDINGS_DIR = () => path.join(MOA_HOME(), ".moa", "bindings");
const TEMPLATES = ["solo-research", "research-synth", "lite-build", "full-engineering", "design"];

// --- config schema (zod mirror of schema/config.schema.json) -------------

const zEffort = z.array(z.string()).min(1);
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

const zModelEntry = z.object({
  id: z.string().regex(CANONICAL_MODEL_ID).optional(),
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
  instructions: z.string().optional(),
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
    workDir: z.string().optional(),
    defaults: z.object({
      maxGateLoops: z.number().int().min(0).optional(),
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
  // mirrors schema/config.schema.json: roles may be absent, but never an empty map
  roles: z.record(z.string(), zRole).refine((r) => Object.keys(r).length > 0, {
    message: "must declare at least one role",
  }).optional(),
  pipelines: z.record(z.string(), zPipeline).optional(),
}).strict();

const PLACEHOLDER = /\{[^{}]+\}/;
// The only placeholders opSpawn expands in a profile's run.argv.
const RUN_PLACEHOLDERS = new Set(["{bin}", "{model}", "{promptFile}", "{cwd}", "{maxTime}"]);

const zProfile = z.object({

  tool: z.string().regex(/^[\w.-]+$/),
  bin: z.string(),
  version: z.string().optional(),
  run: z.object({
    argv: z.array(z.string()).min(1),
    promptVia: z.enum(["file", "stdin", "arg"]).optional(),
    modelPlaceholder: z.string().optional(),
    timeoutSeconds: z.number().int().positive().optional(),
  }).strict(),
  output: z.object({ format: z.enum(["text", "json", "jsonl"]).optional(), resultPath: z.string().optional() }).optional(),
  modelDiscovery: zModelDiscovery,
  capabilities: z.object({
    canProduce: z.boolean().optional(),
    canSelectModel: z.boolean().optional(),
    promptSafe: z.boolean(),
  }).strict(),
  evidence: z.object({
    probedOn: z.string(),
    tests: z.record(z.string(), z.string()),
  }).strict(),
}).strict();

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
  if (profile.run.modelPlaceholder !== "{model}" ||
      !profile.run.argv.some((arg) => arg.includes("{model}")))
    return "invalid_profile";
  if (profile.modelDiscovery.argv[0] !== "{bin}")
    return "invalid_profile";
  if (profile.modelDiscovery.argv.some((arg) =>
      arg.replaceAll("{bin}", "").match(PLACEHOLDER)))
    return "invalid_profile";
  // Reject at save what spawn could only fail on later: run.argv may name no
  // placeholder the spawn expander does not define (see `values` in opSpawn).
  if (profile.run.argv.some((arg) =>
      (arg.match(/\{[^{}]+\}/g) ?? []).some((ph) => !RUN_PLACEHOLDERS.has(ph))))
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
  for (const [mname, entry] of Object.entries(cfg.models ?? {})) {
    if (mname === "auto") continue;
    const id = entry.id ?? mname;
    if (!CANONICAL_MODEL_ID.test(id))
      errs.push(`models.${mname}: id '${id}' is not canonical (expected '<provider>/<model>')`);
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
      if (!fs.statSync(candidate).isFile()) continue;
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
    modelDiscovery: { registered: Boolean(profile.modelDiscovery) },
    usage: {
      start: { tool: "moa_spawn", arguments: ["runId", "phase", "prompt", "requestKey"] },
      wait: { tool: "moa_spawn_wait", arguments: ["runId", "spawnId", "waitMs"] },
      status: { tool: "moa_spawn_status", arguments: ["runId", "spawnId"] },
      cancel: { tool: "moa_spawn_cancel", arguments: ["runId", "spawnId"] },
    },
  };
}

function discoveryError(result) {
  if (result.code === "cancelled")
    return errorResult("cancelled", "model discovery cancelled", {
      durationMs: result.durationMs,
    });
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

async function discoverToolModels(profile, resolvedBin = resolveExecutable(profile.bin), signal) {
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
    signal,
  });
  if (execution.error) return discoveryError(execution);
  if (execution.exitCode !== 0)
    return discoveryError({ ...execution, code: "nonzero_exit" });

  const parsed = parseDiscoveredModels(execution.stdout, profile.modelDiscovery.output);
  if (parsed.error) return parsed;
  return {
    tool: profile.tool,
    checkedAt: new Date().toISOString(),
    models: parsed.models,
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

// independence keys on the MODEL: collapse provider aliases + effort suffixes
function independenceGroup(id) {
  const base = String(id).split("/").pop().split(":")[0].toLowerCase();
  return base;
}
const shortName = (id) => String(id).split("/").pop().split(":")[0];

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
    const routes = routesById.get(id) ?? [];
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
      routes: [...routes],
      sources: ["registry", ...new Set(routes.map((route) => route.source))],
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
      use: r.use, differentModelFrom: r.differentModelFrom,
      instructions: r.instructions ?? null,
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

function autoPick(pool, { needTags, notGroups, subagents }) {
  const candidates = pool
    .filter((model) => needTags.every((tag) => (model.tags ?? []).includes(tag)))
    .filter((model) => !notGroups.has(model.group));
  const costRank = { cheap: 0, standard: 1, premium: 2 };
  candidates.sort((a, b) =>
    (costRank[a.cost] ?? 1) - (costRank[b.cost] ?? 1) || a.priority - b.priority);
  for (const model of candidates) {
    const bindingPin = model.registryBinding;
    const route = selectRoute(model, bindingPin, subagents);
    if (route) return { model, route, sawModelWithoutRoute: false };
  }
  return { model: null, route: null, sawModelWithoutRoute: candidates.length > 0 };
}

export async function opResolve({ hostModels = [], overrides = {} } = {}) {
  if (!state.loaded) return { error: "call moa_load first" };
  const invalidHost = hostModels.find((model) => !CANONICAL_MODEL_ID.test(model.id));
  if (invalidHost)
    return errorResult("invalid_model_id", `host model '${invalidHost.id}' is not canonical`);

  const { config: cfg } = state.loaded;
  const { bindings } = loadBindings();
  const discovered = await discoverBindingInventories(bindings);
  const pool = candidatePool(cfg, discovered.inventories, hostModels);
  const diagnostics = [...discovered.diagnostics];
  if (!cfg) {
    state.resolved = { pool, roles: {} };
    return { pool: pool.map(poolRow), roles: {}, diagnostics, note: "no config — staff ad-hoc roles from this pool; pass explicit models in run_start steps" };
  }
  const hardTags = cfg.master?.hardVerificationTags ?? ["strong"];
  // criticality: a role is hard-verifier if any pipeline step running it has gate: critical
  const criticalRoles = new Set();
  for (const pipeline of Object.values(cfg.pipelines ?? {}))
    for (const step of pipeline.steps)
      if (step.gate === "critical") criticalRoles.add(step.role);

  // resolve in dependency order: roles without differentModelFrom first
  const names = Object.keys(cfg.roles ?? {});
  names.sort((a, b) =>
    (cfg.roles[a].differentModelFrom ? 1 : 0) - (cfg.roles[b].differentModelFrom ? 1 : 0));
  const roles = {};
  const subagents = cfg.runtime?.subagents ?? "auto";
  for (const rname of names) {
    const role = cfg.roles[rname];
    const notGroups = new Set();
    if (role.differentModelFrom && roles[role.differentModelFrom])
      notGroups.add(roles[role.differentModelFrom].group);
    const needTags = criticalRoles.has(rname) ? hardTags : [];
    let pick = null;
    let route = null;
    let reason = null;
    let sawModelWithoutRoute = false;
    let lastBindingPin = null;
    const useList = overrides[rname] ? [overrides[rname]] : role.use;
    for (const use of useList) {
      if (use === "auto") {
        lastBindingPin = null;
        const selected = autoPick(pool, { needTags, notGroups, subagents });
        sawModelWithoutRoute ||= selected.sawModelWithoutRoute;
        if (selected.model) {
          ({ model: pick, route } = selected);
          lastBindingPin = pick.registryBinding ?? null;
          reason = `auto: ${needTags.length ? `tags [${needTags}] ` : ""}lowest-cost/priority pick`;
        }
      } else {
        const model = pool.find((candidate) =>
          candidate.shortName === use || candidate.id === use);
        if (model && !notGroups.has(model.group)) {
          lastBindingPin = model.registryBinding ?? null;
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
const poolRow = (model) => ({
  shortName: model.shortName,
  id: model.id,
  family: model.family ?? null,
  tags: model.tags,
  sources: model.sources,
  routes: model.routes.map((route) => ({
    binding: route.binding,
    modelId: route.modelId,
    source: route.source,
  })),
});

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

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
      if (value === undefined)
        return errorResult("output_parse_failed", `result path '${resultPath}' was not found`);
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
    return errorResult(
      "output_parse_failed",
      "text output supports only resultPath 'stdout'",
    );
  } catch (error) {
    return errorResult("output_parse_failed", error.message);
  }
}

// --- run state machine ----------------------------------------------------

// The only statuses a manifest may carry, and the single source of truth for them:
// saveRun refuses anything else, and moa_step_report's description is generated from
// this map — so a client never has to guess the list, and the list cannot drift from
// the code that assigns it.
const RUN_STATUS = Object.freeze({
  running: "mid-pipeline; not terminal",
  done: "finished clean — nothing was mutated, or a critical gate approved after the last change",
  done_unverified: "finished, but the last repo mutation was never covered by a passed critical gate",
  max_loops_exceeded: "a gate returned REVISE more times than maxGateLoops allows",
  blocked_verifier_disagreement: "a gate returned BLOCKED; needs an independent arbiter",
  verification_unavailable: "the next gate has no independent verifier to route to",
});
function runChild({ bin, args, cwd, stdin, timeoutSeconds, signal, onSpawn }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let timer;
    let killTimer;
    const child = spawn(bin, args, {
      cwd,
      shell: false,
      stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let bytes = 0;
    let forcedCode = null;
    let settled = false;

    const stop = (code) => {
      if (forcedCode || settled) return;
      forcedCode = code;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
      // keep killTimer referenced — the escalation must survive even if nothing else holds
      // the event loop, otherwise a child that ignores SIGTERM would run to its external timeout.
    };
    const onAbort = () => stop("cancelled");
    const collect = (chunks) => (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return stop("output_limit_exceeded");
      chunks.push(chunk);
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };

    child.stdout.on("data", collect(stdoutChunks));
    child.stderr.on("data", collect(stderrChunks));
    child.once("spawn", () => {
      onSpawn?.(child.pid);
      if (signal?.aborted) stop("cancelled");
    });
    child.on("error", (error) => finish(errorResult("spawn_failed", error.message, {
      durationMs: Date.now() - started,
    })));
    child.on("close", (exitCode, childSignal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (forcedCode) {
        finish(errorResult(
          forcedCode,
          forcedCode === "timeout" ? "external tool timed out" :
            forcedCode === "cancelled" ? "external tool cancelled" :
              "external tool exceeded output limit",
          { exitCode, signal: childSignal, stderr, durationMs: Date.now() - started },
        ));
        return;
      }
      finish({ exitCode, signal: childSignal, stdout, stderr, durationMs: Date.now() - started });
    });

    signal?.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => stop("timeout"), timeoutSeconds * 1000);
    if (stdin !== null) child.stdin.end(stdin);
  });
}
const TERMINAL_STATUS = Object.entries(RUN_STATUS).filter(([s]) => s !== "running");
const JOB_STATUS = Object.freeze({
  queued: false,
  discovering: false,
  running: false,
  completed: true,
  failed: true,
  timed_out: true,
  cancelled: true,
  interrupted: true,
});
const SPAWN_ID = /^spawn-[a-f0-9]{24}$/;
const activeSpawns = new Map();

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// True when `pid` is registered as an integer AND the OS still has it. EPERM means the
// child exists but belongs to another user — still alive, just unreachable. Used by the
// status reader to decide whether a foreign process is currently driving the job, so we
// never demote a live record to `interrupted` and never promote a dead one to `running`.
function pidIsAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === "EPERM"; }
}

function spawnDir(runId) {
  return path.join(runDir(runId), "spawns");
}
function spawnPath(runId, spawnId) {
  if (!SPAWN_ID.test(spawnId)) throw new Error("invalid spawnId");
  return path.join(spawnDir(runId), `${spawnId}.json`);
}
function spawnIdFor(runId, phase, requestKey) {
  const digest = crypto.createHash("sha256")
    .update(runId).update("\0").update(phase).update("\0").update(requestKey)
    .digest("hex").slice(0, 24);
  return `spawn-${digest}`;
}
function saveSpawn(file, job, patch = {}) {
  const next = { ...job, ...patch, updatedAt: new Date().toISOString() };
  if (!Object.hasOwn(JOB_STATUS, next.status))
    throw new Error(`unknown spawn status '${next.status}'`);
  writeJsonAtomic(file, next);
  return next;
}
function loadSpawn(runId, spawnId) {
  const file = spawnPath(runId, spawnId);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}
// Exclusive create on the FINAL job path. Two server processes racing on the same
// requestKey (or a losing process retrying after the origin persisted) both call this
// helper; only the one whose link wins sees a return value — the loser observes EEXIST
// and must re-read, then fall through to the replay/conflict branch above.
// The final path is published ATOMICALLY by writing the complete job JSON to a unique
// temp file, then `linkSync(temp, final)`. linkSync refuses an existing final path
// (EEXIST) without overwriting, so the final path is never observed with partial bytes.
// The temp file is unlinked on every branch (winner, loser, error) so it never lingers.
// Only the winning linker writes `prompt-${spawnId}.md` and schedules execution; the
// loser's prompt bytes never reach disk.
function createSpawnExclusive({ runId, spawnId, job, prompt }) {
  fs.mkdirSync(spawnDir(runId), { recursive: true });
  const file = spawnPath(runId, spawnId);
  fs.mkdirSync(path.dirname(job.promptFile), { recursive: true });
  const body = JSON.stringify(job, null, 2) + "\n";
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(temp, body);
  try {
    fs.linkSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch {}
    if (error?.code === "EEXIST") return { created: false, file };
    throw error;
  }
  try { fs.unlinkSync(temp); } catch {}
  fs.writeFileSync(job.promptFile, prompt);
  return { created: true, file };
}
function publicSpawn(job) {
  const base = {
    spawnId: job.spawnId,
    runId: job.runId,
    phase: job.phase,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    pollAfterMs: JOB_STATUS[job.status] ? undefined : 250,
  };
  if (job.status === "completed") return { ...base, result: job.result, durationMs: job.durationMs };
  if (JOB_STATUS[job.status]) return { ...base, failure: job.failure, durationMs: job.durationMs };
  return base;
}
function latestSpawnForCurrentStep(manifest) {
  const dir = spawnDir(manifest.runId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((name) => name.endsWith(".json")); }
  catch { return null; }
  return files
    .map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")))
    .filter((job) => job.stepIndex === manifest.current)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

function runDir(runId) {
  if (!state.loaded) throw new Error("call moa_load first");
  const wd = workDirOf(state.loaded);
  return path.join(wd, "runs", runId);
}
function loadRun(runId) {
  const p = path.join(runDir(runId), "manifest.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function saveRun(m) {
  if (!Object.hasOwn(RUN_STATUS, m.status))
    throw new Error(`unknown run status '${m.status}' — must be one of ${Object.keys(RUN_STATUS).join(", ")}`);
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
      : { kind: "profile", tool: r.binding, note: "call moa_spawn with the role prompt" };
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
    // The same rule the loader enforces on config pipelines (see 'duplicate phase' above):
    // a phase name identifies a step, and finish(), loopBackTo and the loop counters all key
    // on it. Ad-hoc steps skipped this, so a duplicate name let a plain phase inherit an
    // earlier step's critical gate tier and falsely certify an ungated write.
    const dupe = steps.map((s) => s.phase).find((p, i, all) => all.indexOf(p) !== i);
    if (dupe) return { error: `duplicate phase '${dupe}' in steps — phase names must be unique within a run` };
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
    projectDir: state.loaded.projectDir,
    mode: cfg?.master?.mode ?? "auto",
    dispatch,
    maxGateLoops: cfg?.runtime?.defaults?.maxGateLoops ?? 2,
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

  // Refuse if ANY current-step spawn job is still running — the spawn may have produced
  // output the conductor never saw, and accepting the report would advance past it
  // silently. Run BEFORE any in-memory mutation so a refused report leaves no half-pushed
  // phase record that finish() would still see.
  // A foreign server is allowed to recover a dead owner here too: nonterminal + dead
  // ownerPid → {interrupted} so the guard does not block forever on a vanished origin.
  let currentFiles = [];
  try { currentFiles = fs.readdirSync(spawnDir(runId)).filter((n) => n.endsWith(".json")); }
  catch { /* no spawns yet */ }
  for (const name of currentFiles) {
    const siblingPath = path.join(spawnDir(runId), name);
    let sibling = JSON.parse(fs.readFileSync(siblingPath, "utf8"));
    if (sibling.stepIndex !== manifest.current || JOB_STATUS[sibling.status]) continue;
    // origin lost → promote in place, then refuse if the promotion didn't make it terminal
    if (!pidIsAlive(sibling.ownerPid) && !pidIsAlive(sibling.pid)) {
      sibling = saveSpawn(siblingPath, sibling, {
        status: "interrupted",
        failure: { code: "server_restarted", message: "MCP server restarted during external execution" },
        completedAt: new Date().toISOString(),
      });
      if (JOB_STATUS[sibling.status]) continue;
    }
    return {
      error: `spawn '${sibling.spawnId}' is still '${sibling.status}'`,
      code: "spawn_in_progress",
      spawn: publicSpawn(sibling),
    };
  }

  manifest.phases.push({
    phase, role: step.role, verdict: verdict ?? null, summary: summary ?? null,
    changedFiles, producerModel: producerModel ?? null, producerFamily: producerFamily ?? null,
    ts: new Date().toISOString(),
  });
  if (usage) manifest.usage.push({ phase, ...usage });



  const finish = () => {
    // The mutation floor (references/anti-self-certification.md): every write must be covered by
    // a passed critical gate independent of THE MODEL THAT WROTE IT, and coverage is ORDERED —
    // a gate vouches only for what existed when it ran. So walk the run carrying the authors of
    // writes nothing has vouched for; each passed critical gate clears the authors it differs
    // from; whatever is left was never verified, however many gates ran. Asking one summary
    // question instead ("was the LAST write covered?") let two writers cover for each other:
    // mini writes a.js, gpt writes b.js, mini gates — independent of gpt, yet a.js is mini's.
    // A phase's model: the one the reporter named, else the model moa routed that role to, else
    // (for the master) itself — the same fallback producerFor uses. Without that last case a
    // master that right-sizes a write reads as an unknown author, which nothing can be
    // independent of, and a run its verifier really did check would finish 'unverified'.
    const modelOf = (p) => p?.producerModel ??
      (p?.role === "master" ? manifest.masterModel : manifest.resolved[p?.role]?.model) ?? null;
    const gateOf = (p) => manifest.steps.find((s) => s.phase === p.phase)?.gate ?? "none";
    let uncovered = [];        // models whose writes no gate has vouched for
    let gateFellShort = false; // a gate ran and still could not vouch for them
    for (const p of manifest.phases) {
      // The master is never an independent verifier, whatever model it names: it may never be
      // the final word on a gate. Clear before recording this phase's own writes — a gate
      // cannot vouch for a change it made itself.
      if (gateOf(p) === "critical" && p.verdict === "APPROVE" && p.role !== "master") {
        const verifier = modelOf(p);
        uncovered = uncovered.filter((author) => !(verifier && author &&
          independenceGroup(verifier) !== independenceGroup(author)));
        if (uncovered.length) gateFellShort = true;
      }
      if (p.changedFiles?.length) uncovered.push(modelOf(p));
    }
    if (uncovered.length) {
      manifest.status = "done_unverified";
      saveRun(manifest);
      // Name the reason: "no gate ran" and "a gate ran but was the author's own model" call for
      // different fixes, and conflating them is how a fake gate reads as a missing one.
      return { terminal: manifest.status, runId,
        label: gateFellShort
          ? "unverified — a critical gate approved a change written by its own model: nothing can certify its own work"
          : "unverified — the repo was mutated with no passed critical gate covering the last change" };
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

function terminalStatusFor(result) {
  if (result?.code === "timeout") return "timed_out";
  if (result?.code === "cancelled") return "cancelled";
  return "failed";
}

async function executeSpawnJob({ file, job, manifest, profile, resolved, prompt, signal }) {
  const started = Date.now();
  try {
    job = saveSpawn(file, job, { status: "discovering" });
    const discovery = await discoverToolModels(profile, profile.resolvedBin, signal);
    if (discovery.error || discovery.code) {
      saveSpawn(file, job, {
        status: terminalStatusFor(discovery),
        failure: { code: discovery.code, message: discovery.error, details: discovery },
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
      return;
    }
    if (!discovery.models.some((model) => model.id === resolved.model)) {
      saveSpawn(file, job, {
        status: "failed",
        failure: { code: "model_not_served", message: `registered tool '${resolved.binding}' no longer serves '${resolved.model}'` },
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
      return;
    }

    const timeoutSeconds = profile.run.timeoutSeconds ?? 1800;
    const values = {
      "{bin}": profile.resolvedBin,
      "{model}": resolved.model,
      "{promptFile}": job.promptFile,
      "{cwd}": manifest.projectDir,
      "{maxTime}": String(timeoutSeconds),
    };
    const argv = profile.run.argv.map((arg) => {
      let expanded = String(arg);
      for (const [placeholder, value] of Object.entries(values))
        expanded = expanded.replaceAll(placeholder, value);
      return expanded;
    });
    if (resolveExecutable(argv[0]) !== profile.resolvedBin) {
      saveSpawn(file, job, {
        status: "failed",
        failure: { code: "spawn_failed", message: "run.argv[0] does not resolve to profile.bin" },
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
      });
      return;
    }

    const execution = await runChild({
      bin: profile.resolvedBin,
      args: argv.slice(1),
      cwd: manifest.projectDir,
      stdin: profile.run.promptVia === "stdin" ? prompt : null,
      timeoutSeconds,
      signal,
      onSpawn: (pid) => {
        job = saveSpawn(file, job, { status: "running", pid, startedAt: new Date().toISOString() });
      },
    });
    if (execution.error) {
      saveSpawn(file, job, {
        status: terminalStatusFor(execution),
        failure: { code: execution.code, message: execution.error, details: execution },
        completedAt: new Date().toISOString(),
        durationMs: execution.durationMs,
      });
      return;
    }
    if (execution.exitCode !== 0) {
      saveSpawn(file, job, {
        status: "failed",
        failure: { code: "nonzero_exit", message: `external tool exited with ${execution.exitCode}`, details: execution },
        completedAt: new Date().toISOString(),
        durationMs: execution.durationMs,
      });
      return;
    }
    const result = extractResult(execution.stdout, profile.output);
    if (result?.error) {
      saveSpawn(file, job, {
        status: "failed",
        failure: { code: result.code, message: result.error, details: result },
        completedAt: new Date().toISOString(),
        durationMs: execution.durationMs,
      });
      return;
    }
    saveSpawn(file, job, {
      status: "completed",
      result,
      completedAt: new Date().toISOString(),
      durationMs: execution.durationMs,
    });
  } catch (error) {
    saveSpawn(file, job, {
      status: signal.aborted ? "cancelled" : "failed",
      failure: { code: signal.aborted ? "cancelled" : "spawn_failed", message: error.message },
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    });
  } finally {
    activeSpawns.delete(job.spawnId);
  }
}

export function opSpawn({ runId, phase, prompt, requestKey } = {}, { signal } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return errorResult("unknown_run", `unknown runId '${runId}'`);
  if (manifest.status !== "running") return errorResult("run_finished", `run is '${manifest.status}'`);
  if (typeof requestKey !== "string" || requestKey.length < 1 || requestKey.length > 128)
    return errorResult("invalid_request_key", "requestKey must contain 1-128 characters");

  const step = manifest.steps[manifest.current];
  if (phase !== step.phase) return errorResult("wrong_phase", `current phase is '${step.phase}', not '${phase}'`);
  if (step.role === "master") return errorResult("master_phase", `phase '${phase}' belongs to the master`);
  const resolved = manifest.resolved[step.role];
  if (!resolved) return errorResult("role_unresolved", `phase '${phase}' has no resolved role '${step.role}'`);
  if (resolved.binding === "host-native")
    return errorResult("native_spawn_required", "use the host's native subagent capability");
  const { bindings } = loadBindings();
  const profile = bindings.find((item) => item.tool === resolved.binding);
  if (!profile) return errorResult("tool_unavailable", `registered tool '${resolved.binding}' is unavailable`);

  const spawnId = spawnIdFor(runId, phase, requestKey);
  const promptHash = crypto.createHash("sha256").update(prompt).digest("hex");
  const existing = loadSpawn(runId, spawnId);
  if (existing) {
    if (existing.promptHash !== promptHash || existing.stepIndex !== manifest.current)
      return { ...errorResult("idempotency_conflict", "requestKey was already used with different spawn input"), spawnId };
    return publicSpawn(existing);
  }

  fs.mkdirSync(runDir(runId), { recursive: true });
  const now = new Date().toISOString();
  const job = {
    schemaVersion: 1,
    spawnId, runId, phase,
    stepIndex: manifest.current,
    promptHash,
    promptFile: path.join(runDir(runId), `prompt-${spawnId}.md`),
    tool: profile.tool,
    model: resolved.model,
    family: resolved.family,
    status: "queued",
    pid: null,
    ownerPid: process.pid,
    result: null,
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
  // Exclusive create on the FINAL job path: only the winner writes the queued record AND
  // the prompt file. A concurrent origin in another process must observe EEXIST, re-read,
  // and fall through to the replay/conflict branch — never overwrite the winner's bytes
  // nor launch a duplicate worker.
  const created = createSpawnExclusive({ runId, spawnId, job, prompt });
  if (!created.created) {
    const reread = loadSpawn(runId, spawnId);
    if (!reread) return errorResult("spawn_race", "another start raced and won but left no record");
    if (reread.promptHash !== promptHash || reread.stepIndex !== manifest.current)
      return { ...errorResult("idempotency_conflict", "requestKey was already used with different spawn input"), spawnId };
    return publicSpawn(reread);
  }
  const file = created.file;

  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? "MCP request cancelled");
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  activeSpawns.set(spawnId, { controller, file });
  // Defer discovery + launch to a macrotask so {opSpawn} returns the persisted queued
  // record before any subprocess runs — the contract is "returns immediately".
  setImmediate(() => {
    void executeSpawnJob({ file, job, manifest, profile, resolved, prompt, signal: controller.signal })
      .finally(() => signal?.removeEventListener("abort", abort));
  });
  return publicSpawn(job);
}

export function opSpawnStatus({ runId, spawnId } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return errorResult("unknown_run", `unknown runId '${runId}'`);
  let job;
  try {
    job = spawnId ? loadSpawn(runId, spawnId) : latestSpawnForCurrentStep(manifest);
  } catch {
    return errorResult("invalid_spawn_id", "spawnId is invalid");
  }
  if (!job) return errorResult("unknown_spawn", "no matching spawn job exists");
  // Promote nonterminal records to {interrupted} only when no live controller remains
  // anywhere for this job. The owning server's PID is the authoritative signal: if that
  // process is still alive, it is driving the child and a foreign status reader must NOT
  // mark interrupted. Same-process callers additionally gate on the child PID; foreign
  // callers gate on the owner PID (process.kill 0 probes any process the user can signal).
  if (!JOB_STATUS[job.status] && !activeSpawns.has(job.spawnId)) {
    const sameOwner = job.ownerPid === process.pid;
    const alive = sameOwner ? pidIsAlive(job.pid) || pidIsAlive(job.ownerPid) : pidIsAlive(job.ownerPid);
    if (!alive) {
      const file = spawnPath(runId, job.spawnId);
      job = saveSpawn(file, job, {
        status: "interrupted",
        failure: { code: "server_restarted", message: "MCP server restarted during external execution" },
        completedAt: new Date().toISOString(),
      });
    }
  }
  return publicSpawn(job);
}

export function opSpawnCancel({ runId, spawnId } = {}) {
  const manifest = loadRun(runId);
  if (!manifest) return errorResult("unknown_run", `unknown runId '${runId}'`);
  let job;
  try { job = loadSpawn(runId, spawnId); }
  catch { return errorResult("invalid_spawn_id", "spawnId is invalid"); }
  if (!job) return errorResult("unknown_spawn", `unknown spawnId '${spawnId}'`);
  if (JOB_STATUS[job.status]) return publicSpawn(job);
  const active = activeSpawns.get(spawnId);
  if (!active) return opSpawnStatus({ runId, spawnId });
  active.controller.abort("cancelled by conductor");
  return publicSpawn(job);
}

// Sleeps up to `ms`, resolving early if `signal` aborts. Used by opSpawnWait's poll loop
// so aborting the WAIT (not the spawn) returns promptly. Removes its own abort listener
// both when the timer fires normally and when the signal aborts, and never schedules a
// timer for an already-aborted signal.
function abortableDelay(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    const onAbort = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Bounded long-poll over the same durable record opSpawnStatus reads, so same-process,
// foreign-process, and reconnect callers share one path. Sleeps only for the record's
// advertised pollAfterMs, never longer than the caller's remaining wait budget. Aborting
// this call (via signal) only stops the loop — the spawn's own controller is never
// touched, so the worker keeps running.
export async function opSpawnWait({ runId, spawnId, waitMs = 20_000 } = {}, { signal } = {}) {
  const deadline = Date.now() + waitMs;
  let job = opSpawnStatus({ runId, spawnId });
  while (!job.error && !JOB_STATUS[job.status]) {
    if (signal?.aborted) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await abortableDelay(Math.min(job.pollAfterMs ?? 250, remaining), signal);
    if (signal?.aborted) { job = opSpawnStatus({ runId, spawnId }); break; }
    job = opSpawnStatus({ runId, spawnId });
  }
  // Terminal results and structured errors stay verbatim — reconnect-safe and complete.
  // An active (nonterminal, non-error) record is compacted to its status alone; full
  // metadata for an in-flight spawn remains available via moa_spawn_status.
  return job.error || JOB_STATUS[job.status] ? job : { status: job.status };
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


export async function opBindingSave({ profile } = {}) {
  const validated = zProfile.safeParse(profile);
  if (!validated.success)
    return errorResult("invalid_profile", "invalid profile: " + validated.error.issues.map((issue) =>
      `${issue.path.join(".")}: ${issue.message}`).join("; "));
  const saved = validated.data;
  const rejection = profileRejectionReason(saved);
  if (rejection) {
    return errorResult(rejection, `refusing profile '${saved.tool}': ${rejection}`);
  }

  const resolvedBin = resolveExecutable(saved.bin);
  if (!resolvedBin)
    return errorResult("tool_unavailable", `tool '${saved.tool}' executable is unavailable`);
  const discovery = await discoverToolModels(saved, resolvedBin);
  if (discovery.error || discovery.code) return discovery;

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
  const server = new McpServer({ name: "moa", version: "1.0.0" });
  const json = (r) => ({ content: [{ type: "text", text: JSON.stringify(r) }], isError: !!r?.error });

  server.tool(
    "moa_load",
    "FIRST CALL of every moa run. Locates .moa.yml (cwd→root), parses + validates it, reads learned tool profiles (~/.moa/bindings) as metadata only. Returns the normalized config, dispatch mode (workflow|adaptive-config|adaptive-bare), roles, pipelines, and connected tools. Replaces reading the config by hand. Never runs an inventory subprocess — model inventory is fetched live through moa_tools / moa_resolve / moa_spawn.",
    { cwd: z.string().optional().describe("directory to search from; defaults to the server's cwd") },
    async (a) => json(opLoad(a))
  );

  server.tool(
    "moa_tools",
    "Runs every registered modelDiscovery recipe live (no caching, no persistence) and returns the models each learned tool currently serves plus the stable MCP call used to run them. External only — never reports host-native models as external. Newly learned tools appear on the next call without a server restart.",
    {},
    async () => json(await opTools())
  );

  server.tool(
    "moa_resolve",
    "SECOND CALL — and runnable independently. Re-runs live discovery across every learned tool, then intersects those live external routes with the models aliases in .moa.yml and the hostModels you pass; pins every role's model/effort/binding (model-level only — roles.<name>.binding is rejected) with a recorded reason, checks independence constraints, and writes effective-config.json. Calling moa_tools first is optional. Returns the per-role resolution + candidate pool + diagnostics.",
    {
      hostModels: z.array(z.object({
        id: z.string().regex(CANONICAL_MODEL_ID), family: z.string().optional(),
        tags: z.array(z.string()).optional(), context: z.number().int().optional(),
      })).describe("models spawnable via the host's native subagent capability; ids must be '<provider>/<model>'"),
      overrides: z.record(z.string(), z.string()).optional().describe("per-run role→model-short-name overrides (highest precedence)"),
    },
    async (a) => json(await opResolve(a))
  );
  // Spawn tools registered below — durable, returns immediately. After spawn, loop
  // moa_spawn_wait until terminal; only moa_step_report advances pipeline state.
  server.tool(
    "moa_spawn",
    "Durably starts the current external phase and returns immediately. requestKey makes retries idempotent. Loop moa_spawn_wait until terminal; spawning never advances the run. Use moa_spawn_cancel for the durable cancellation path — aborting the JSON-RPC request races the macrotask and may return before cancellation is observable.",
    {
      runId: z.string(),
      phase: z.string().describe("must be the run's current non-master external phase"),
      prompt: z.string(),
      requestKey: z.string().min(1).max(128).describe("stable idempotency key; reuse it only when retrying the same start request"),
    },
    async (args, extra) => json(opSpawn(args, { signal: extra.signal }))
  );

  server.tool(
    "moa_spawn_wait",
    "Durably waits on the current external spawn's record and returns as soon as it reaches a terminal state — the normal way to observe a moa_spawn to completion, replacing shell sleeps or manual backoff. Bounded 0-20000ms, default 20000ms (below the common 30-second MCP request deadline); waitMs: 0 is an immediate snapshot. Returns terminal results in full; an expired or aborted wait on a still-active spawn returns only {status} — aborting the wait does NOT cancel the spawn, which keeps running; use moa_spawn_status for full active metadata. Loop this call until terminal.",
    {
      runId: z.string(),
      spawnId: z.string().regex(SPAWN_ID),
      waitMs: z.number().int().min(0).max(20_000).optional().describe("bounded wait in ms, 0-20000; default 20000"),
    },
    async (args, extra) => json(await opSpawnWait(args, { signal: extra.signal }))
  );

  server.tool(
    "moa_spawn_status",
    "Non-blocking snapshot/recovery read of the full durable state for an external spawn — for reconnects, a one-off check, or full active metadata (moa_spawn_wait returns only {status} while active). Omit spawnId to recover the latest job for the current step. Terminal results are repeatable and survive reconnects. For the normal completion path, loop moa_spawn_wait instead of polling this.",
    {
      runId: z.string(),
      spawnId: z.string().regex(SPAWN_ID).optional(),
    },
    async (args) => json(opSpawnStatus(args))
  );


  server.tool(
    "moa_spawn_cancel",
    "Requests cancellation of an active external spawn. Loop moa_spawn_wait until the job reaches cancelled.",
    {
      runId: z.string(),
      spawnId: z.string().regex(SPAWN_ID),
    },
    async (args) => json(opSpawnCancel(args))
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
    "Report the current phase's outcome; the server records it and returns the NEXT step or a terminal state. Enforced here (not by you): gates need a verdict; REVISE loops back (maxGateLoops capped, effort ladder climbs); verifier independence is checked against the actual producer; a mutated repo without a passed critical gate finishes labeled 'unverified'. Never decide the next phase yourself. " +
      `A REVISE loop is NOT a terminal state — the run stays 'running'. The terminal states are exactly: ${
        TERMINAL_STATUS.map(([s, why]) => `'${s}' (${why})`).join("; ")}.`,
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
    "moa_init",
    "Write .moa.yml from a bundled template (comments preserved), splicing in the models registry (union of per-role picks ONLY — never the full discovered pool) and each role's use list. Guards an existing config unless force. You still do detection, picks, and user confirmation first.",
    {
      template: z.enum(["solo-research", "research-synth", "lite-build", "full-engineering", "design"]),
      registry: z.record(z.string(), z.object({
        id: z.string().regex(CANONICAL_MODEL_ID).optional(), family: z.string().optional(),
        tags: z.array(z.string()).optional(), context: z.number().int().optional(),
        effort: z.array(z.string()).optional(),
        binding: z.string().optional().describe("optional exact route pin: host-native or learned tool name"),
      })).optional().describe("models map — only models some role actually uses"),
      roles: z.record(z.string(), z.array(z.string())).optional().describe("role name → use list, e.g. {planner: ['opus','auto']}"),
      force: z.boolean().optional(),
      cwd: z.string().optional().describe("repo root to write into; defaults to server cwd"),
    },
    async (a) => json(opInit(a))
  );

  server.tool(
    "moa_binding_save",
    "Validate, discover (live), and persist a learn-tool profile to ~/.moa/bindings/<tool>/profile.yml. Refuses in code any profile whose evidence lacks modelDiscovery+T1+T2+T4 = pass, or that lacks promptSafe: true / canSelectModel: true, or whose run.argv names any placeholder beyond {bin} {model} {promptFile} {cwd} {maxTime}. Runs the discovery recipe once before persistence to confirm the model inventory currently served by the tool. The saved profile contains only run/output/capability metadata — never the resolved model list.",
    { profile: zProfile.describe("the full profile object per references/learn-tool.md") },
    async (a) => json(await opBindingSave(a))
  );

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (activeSpawns.size === 0) { process.exit(0); return; }
    for (const { controller } of activeSpawns.values())
      controller.abort("MCP server shutting down");
    // REFERENCED so a stubborn child still gets a chance to be SIGKILLed (runChild owns
    // its own 1-second grace of SIGTERM→SIGKILL). Only scheduled when there is work to
    // wait for; a clean test-client exit never pays this delay.
    setTimeout(() => process.exit(0), 1100);
  };
  // Wire shutdown BEFORE transport connect so SIGTERM/SIGINT/stdin-close abort every
  // active spawn. Without these registrations `srv.kill()` (and process exit) would
  // orphan every running child and leave nonterminal records behind.
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdin.once("end", shutdown);
  await server.connect(new StdioServerTransport());
}
