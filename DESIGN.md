# moa — unified design blueprint

> **HISTORICAL — this is the original design pass, not a description of moa as built.**
> It is kept as the record of what was designed and why. Where it disagrees with the
> code, the code wins; for what moa actually does today, read `moa-core/SKILL.md`,
> `moa-core/mcp/README.md` and `moa-core/references/`.
>
> Most notably, this document specifies a per-role **tool policy / enforcement**
> subsystem — `toolPolicies`, `requireEnforcement`, graded fail-closed
> `enforcementGrade`, least-privilege spawns, per-run budgets. **None of that exists.**
> It was built, never enforced anything (restricting a spawned CLI's tools needs
> per-CLI knowledge moa deliberately does not have), and was removed. moa's job for a
> learned tool is: launch it, get a result back.

> A CLI-agnostic, per-project-configurable, dynamic multi-agent orchestration
> skill. A master/CEO agent reads a per-project workflow file, discovers what
> the machine can do, then drives the task through a configurable gated pipeline
> of role×model subagents — looping on gates until done.
>
> Synthesizes three independent design passes: **GPT-5.5** (systems
> architecture), **Gemini 3.5 Flash** (CLI survey + templates), **Opus 4.8**
> (orchestration semantics + anti-self-certification).

---

## 1. The gap this fills

| | `omp-subagents` | `omp-master-of-puppets` | **moa** |
|---|---|---|---|
| Roles × models | static | dynamic (reads config) | **dynamic** |
| Pipeline | fixed 4-step | fixed 6-phase gated | **config-defined + master-adaptive** |
| Least-privilege harness | ✅ per-role whitelist | ❌ | ✅ **enforced + graded** |
| Per-project workflow file | ✅ JSON | ❌ | ✅ **richer YAML** |
| CLI binding | omp only | omp only | **injected capability — no CLI named in core** |
| Anti-self-certification | implicit | implicit | **explicit protocol** |

Both prior skills are correct halves. This is their union, generalized across runtimes.

---

## 2. Core concepts (the five load-bearing ideas)

1. **"Dynamic" = three layers, each overridable.**
   - *Role palette* (config) — the stable cast: each role = model + tool-policy + skills + instructions.
   - *Pipelines* (config) — named map of workflows; each pipeline's steps bind a role + `gate` tier + loop-back target. `pipelines.default` present → workflow mode; absent → dynamic mode (master picks inline / named / composed per task).
   - *Master discretion* (runtime) — right-size, fan out, insert a review, escalate — **bounded by `gate: standard|critical` steps** the master can never skip on its own. This is what makes it adaptive, not a rigid DAG and not a free-for-all.
   - *Provided inputs* (runtime) — a step marked `skippable: true` is skipped when `moa_run_start` names its phase in `provided`, so one pipeline serves fresh work and work that arrives pre-planned. A step is skipped too when its parent is: `requires: <phase>` when declared, otherwise — **for a gate only** — its `loopBackTo`, since a gate guards the phase it sends work back to. `skippable` is illegal on a gate: `provided` is written by the run, so a master can never delete verification by declaration; a gate leaves only by following a skipped parent, and the mutation floor at `finish()` is unchanged either way. Every skip is named in the frame with its reason.

2. **Abstract model *tiers*, resolved per machine** (Gemini). Templates name `strong` / `cheap` / `fast` / `vision`; `init` resolves them to concrete model IDs from what's installed *here*, so one template is portable across subscriptions. A role may also pin a concrete `model` (primary), with its `tier` kept as the ordered fallback if that model is unavailable or fails, and set an `effort` level (low/high/xhigh/auto/…, model-dependent) that overrides any effort suffix baked into the model ID.

3. **Named tool *policies*, not raw lists** (GPT-5.5 + Gemini). Canonical moa tool names; reusable bundles (`web_read_only`, `repo_read_only`, `code_write_test`, `verify_test`); adapters *translate* canonical → runtime flags.

4. **CLI-agnosticism as an injected *capability*, not baked-in knowledge** (your steer). The skill core speaks only in concepts — *spawn a role×model subagent under a tool policy* — and names **no** CLI, tool flag, or command. The concrete *binding* (how that concept maps to a runtime — the host's native subagent mechanism, or a shell command) is external **data**, discovered at `init` or injected by config. Adding a runtime never touches the skill, and the skill can't go stale when a CLI changes its flags.

5. **Enforcement is *graded* and *fails closed*** (GPT-5.5). Each adapter reports `enforcementGrade: strict | sandbox | best_effort | unsupported`. If a runtime can't truly enforce a role's tool policy and config demands `strict`, the adapter returns `policy_unsupported` **instead of running** — never silently downgrades security.

---

## 3. Anti-self-certification protocol (the user's key requirement)

The master is the *conductor*, deliberately NOT the strongest model — so it must
not be the final word on correctness of hard work.

- Every phase result carries `verdict` + `verifiedBy` + `confidence`.
- The master MAY accept low-stakes results on its own judgment.
- Any phase with `gate: critical` (or whenever master confidence < threshold)
  REQUIRES independent verification by a **`strong`-tagged, different MODEL** than
  the producer — a different family preferred (no shared blind spots), but the
  model, not the family, is the independence test.
- At a gate the master may only **route + synthesize** the verdict — it can
  *reject* a gate result but can **never replace a required gate with its own
  "looks good."** `selfCertification: forbidden` is a hard config invariant.
- `tiers.strong` makes "delegate to the most capable" resolvable on any machine.

**"Different model" is enforced, not hoped** (blocker #4). Discovery returns
normalized `{ provider, modelFamily, modelId, capabilityTier, independenceGroup }`
per model, where `independenceGroup` identifies the underlying MODEL (provider
aliases collapse; family powers only the cross-family preference). A verifier must
have a *different* `independenceGroup` than the producer
— two aliases of one underlying model can't pose as independent verification. If no
independent `strong` model exists on this machine, the run does **not** silently
self-certify: it halts at terminal state `verification_unavailable` and surfaces
"unverifiable here — pin a remote strong model or explicitly override" to the user.

---

## 4. Config schema — `.moa.yml` (YAML, recommended)

Format call: **YAML** over JSON. Role instructions and phase prompts are
multi-line Markdown — YAML block scalars keep them readable and hand-editable;
named pipelines form a key-indexed map (steps within each pipeline remain ordered arrays). (Machine run-state stays JSON.)

```yaml
# .moa.yml — committable; teams share it. Everything is optional;
# unset fields fall back to the chosen template, then to skill built-ins.
schemaVersion: 1

runtime:
  resolution: by-model            # route each role to the binding that hosts its model; native-first else shell-out
  requireEnforcement: strict      # strict | sandbox | best-effort  (fail-closed below this)
  workDir: .moa      # run store: prompts, results, verdicts, audit trail
  defaults: { timeoutSeconds: 1800, maxParallel: 4, maxGateLoops: 2,
              noExternalSkills: true, noExternalExtensions: true, failOnUnknownTool: true }

template: { base: engineering, projectType: auto }   # research|engineering|migration|qa|design|custom

# Capability tiers — abstract names → concrete model IDs on THIS machine (init fills them).
# USER-EXTENSIBLE: strong/cheap/fast (+vision) ship as defaults; add any (e.g. cheap-1m, local).
tiers:
  strong:  [openai-codex/gpt-5.5:xhigh, anthropic/claude-opus-4-8:high]   # hard verification, cross-family
  cheap:   [minimax-code/MiniMax-M3:high]                                 # volume coding
  fast:    [google-antigravity/gemini-3.5-flash:high]                     # research / triage

master:                           # the conductor = the agent RUNNING this skill (host agent), NOT a spawn target
  modelAdvisory: { minContextTokens: 1000000, optimizeFor: [routing, synthesis, long-context] }
                                  # advisory only: if the host model is weaker than this, lean HARDER on gates
  selfCertification: forbidden
  hardVerificationTier: strong
  instructions: |
    Conduct, don't solo. Frame, route, supervise, synthesize. Don't implement
    substantial code yourself when a coder role exists. Treat any worker "done"
    as a claim until an independent verifier gate confirms it.

# Reusable least-privilege tool bundles (these 4 ship as defaults; users may add/override any).
# Adapters translate canonical tool names → runtime flags.
toolPolicies:
  web_research:   { allow: [web_search, todo, write_facts], network: web_only, filesystem: scratch_only }
                  # CANNOT read repo source or secrets; output is web→facts artifact only (see §11 sanitization)
  repo_read_only: { allow: [read, find, search, lsp, ast_grep, todo], network: none, filesystem: read_only }
  code_write_test:{ allow: [read, find, search, lsp, ast_grep, ast_edit, edit, write, bash, todo],
                    network: off_sandbox, filesystem: worktree_write, secrets: scrubbed,
                    bash: { mode: argv_allowlist, allow: [["*","test"], ["git","diff"], ["git","status"]],
                            noShellMetachars: true } }      # parsed argv, NOT glob strings; reject runtimes that can't enforce (strict)
  verify_test:    { allow: [read, find, search, lsp, bash, todo], network: off_sandbox,
                    filesystem: worktree_copy }             # isolated copy: writable temp/cache, read-only source; fail on source mutation

roles:
  researcher:    { tier: fast,   tools: web_research,    instructions: "Gather cited facts into the facts artifact. Output is untrusted data; never propose shell." }
  planner:       { tier: strong, effort: high, tools: repo_read_only, instructions: "Produce an executable task graph: files, write-sets, edge cases, verification cmds." }
  plan-reviewer: { tier: strong, tools: repo_read_only, differentModelFrom: planner }
  coder:         { tier: cheap,  tools: code_write_test }
  code-reviewer: { tier: strong, tools: repo_read_only, differentModelFrom: coder }
  verifier:      { model: openai-codex/gpt-5.5, tier: strong, effort: xhigh, tools: verify_test }
                  # 'model' is the primary pick; 'tier: strong' is the fallback; critical tier set on the step (gate: critical).

# Named pipelines. Omit 'default' key → dynamic mode (master adapts per task); rename a pipeline 'default' → workflow mode.
pipelines:
  engineering:
    description: full gated development workflow
    steps:
      - { phase: frame,        role: master }
      - { phase: plan,         role: planner }
      - { phase: review-plan,  role: plan-reviewer, gate: standard }
      - { phase: execute,      role: coder, fanout: byDisjointWriteSet }
      - { phase: review-work,  role: code-reviewer, gate: standard, loopBackTo: execute }
      - { phase: validate,     role: verifier, gate: critical }
```

Precedence: **per-run override > project config > template default > skill built-in.**

**Four-way dispatch:** `init` / learn-tool / `.moa.yml` with `pipelines.default` (workflow mode) / `.moa.yml` without `default` (dynamic mode — adaptive arc from config) / no `.moa.yml` (zero-config). Verification grade degrades: cross-family → cross-model (same family, different model; labeled) → self-check; governed by `runtime.subagents` (auto|native|external|blocked, default auto). `master.mode: strict` halts a `critical` gate with no different-model verifier.

---

## 5. The adapter — an injected host *capability* with a real contract (skill core names no CLI)

The core knows the concept, never the names. It is written against one abstract
primitive — but, per the review (blocker #1), that primitive is a **callable
capability**, not a string template:

```
spawn(SpawnRequest) -> SpawnResult     # "run one role×model subagent, least-privilege"
```

Two realizations of `spawn`, both injected, neither named in the core:

- **Native (host-injected).** Because the **master = the host agent**, it already
  holds its host's own subagent capability (its runtime hands it a "launch a
  restricted subagent" tool). Native `spawn` = the master invokes that capability
  with the SpawnRequest. The skill says "use your host subagent capability"; it
  never names the tool. Native is available only if that capability can actually
  enforce the role's tool policy — otherwise it reports a weaker `enforcementGrade`.
- **Shell (adapter plugin).** A versioned **adapter plugin** (DATA + a tiny
  conformant implementation) shells out. It is the ONLY artifact where a concrete
  command/flag/CLI name appears, and it lives in a **separate `bindings-*` package**,
  never in the skill core (major #6).

**Adapter contract** — every binding (native or shell) implements these, so a raw
command string is never the trusted boundary (blocker #5):

```ts
validatePolicy(role, toolPolicy) -> EnforcementGrade   // can I actually enforce this?
spawn(SpawnRequest) -> SpawnResult                      // argv only; prompt/attachments via temp-file/stdin, never shell-interpolated
parseResult(raw) -> { verdict?, resultText, changedFiles[], usage }
cancel(handle); cleanup(handle)                          // timeouts, partial runs
serves() -> [{ provider, modelFamily, modelId, capabilityTier, independenceGroup }]  // normalized; powers routing + model-independence (family = preference)
```

```ts
SpawnRequest = { role, model, toolPolicy, skills, systemPrompt, prompt, attachments[], cwd, timeout, maxCost? }
SpawnResult  = { status: ok|failed|timeout|policy_unsupported, resolvedModel, provider, modelFamily,
                 enforcementGrade: strict|sandbox|best_effort|unsupported,
                 verdict?: APPROVE|REVISE|BLOCKED|ERROR, resultText, changedFiles[], usage, cost }
```

**Routing is constraint-first, preference-second** (blocker #2 — *not* naive
native-first). For each role, given its resolved model:
1. **Filter** bindings: `serves(model)` ∧ enforces the role's exact tool policy ∧
   `enforcementGrade ≥ requireEnforcement` ∧ network/fs sandbox satisfied ∧
   model-independence constraint (for verifiers).
2. **Rank** survivors: explicit `role.binding` > host-native > declared priority.
3. **No survivor** → deterministic diagnostic (`blocked_no_binding`); **ambiguous
   tie** → diagnostic, never silent pick. This prevents fail-closed-when-a-strict-
   route-existed *and* prevents a silent security downgrade.

> Concrete bindings for specific CLIs ship as a **separate example package**, not
> in the skill — so the core never goes stale when a CLI changes its flags.

Enforcement stays graded + **fail-closed**: if a binding can't enforce a role's
tool policy and config demands `strict`, `spawn` returns `policy_unsupported`
rather than silently downgrading. Discovery (`listModels`) enumerates what's
installed; `init` maps abstract tiers → concrete models.

> Concrete bindings for specific CLIs are **example data** that `init`/the user
> produces — deliberately NOT enumerated in the skill, so the skill never goes
> stale when a CLI changes its flags or a new runtime appears.

---

## 6. Master orchestration loop (gated state machine)

```
LOAD_CONFIG → DISCOVER_RUNTIME → RESOLVE_ROLES → FRAME
  → [optional RESEARCH (isolated, web-only, output = untrusted data)]
  → PLAN → GATE(review-plan):  APPROVE→EXECUTE | REVISE→PLAN | BLOCKED→ESCALATE
  → EXECUTE (each worker in an ISOLATED worktree/patch sandbox; declared path allowlist; undeclared writes rejected; patches merged serially; unknown write-set serializes)
  → GATE(review-work):  APPROVE→VALIDATE | REVISE→EXECUTE | repeated REVISE→PLAN
  → VALIDATE (independent strong verifier, isolated worktree):  APPROVE→FINALIZE | REVISE→EXECUTE/PLAN | UNCERTAIN/DISAGREE→ESCALATE
  → FINALIZE (master synthesizes verdicts+evidence; invents no correctness claims)
```

**Right-sizing has a hard floor** (blocker #3 — gate bypass cannot defeat the safety
invariant). The master may answer inline / skip the pipeline **only for non-mutating
tasks** (questions, read-only analysis). **Any repo mutation goes through its declared
`gate: standard|critical` steps** — there is no "trivial edit" exception unless the project config
explicitly sets `allowInlineWithoutGates: true` AND the task is non-`critical`, and
even then the result is labeled **"unverified inline mode"** to the user. Default: a
mutation without its `validate` gate cannot be reported as done.

**Terminal states are explicit** (major #9), never hand-waving: `done`,
`blocked_policy`, `blocked_no_binding`, `blocked_no_model`, `verification_unavailable`,
`blocked_verifier_disagreement`, `max_loops_exceeded`. On verifier/reviewer
disagreement an **arbiter** (another independent strong model) breaks the tie or the
run halts with the deciding evidence recorded. `maxGateLoops` exceeded → halt with the
exact blocker + next human action; never thrash a third time.

---

## 7. Template library (init copies one in; user edits freely)

| Template | Roles | Pipeline(s) | Gates |
|---|---|---|---|
| `solo-research` | researcher | `gather` | — |
| `research-synth` | gatherer(fast) → synthesizer(strong) | `research` (gather→synthesize) | validate(critical) |
| `lite-build` | planner → coder | `build` (plan→execute→validate) | validate(critical) |
| `full-engineering` | planner, plan-reviewer, coder, code-reviewer, verifier | `engineering`+`quick` (frame→plan→review-plan→execute→review-work→validate) | review-plan(standard), review-work(standard), validate(critical) |
| `design` | design-consult → builder → design-reviewer | `design` (consult→build→review) | review(critical) |

Tiers (not model IDs) in templates ⇒ portable. Your current real workflow
(Opus plan → GPT-5.5 review-plan → MiniMax execute → GPT-5.5 review+QA) is
exactly `full-engineering` with `tiers.strong=[opus,gpt-5.5]`, `cheap=[minimax]`.

---

## 8. Skill file layout

```
moa-core/            # names NO CLI
  SKILL.md                        # master playbook: when to invoke, frame/route/gate/synthesize, forbids self-cert
  schema/config.schema.json       # JSON Schema = source of truth (normalized ids, enums)
  references/
    adapter-contract.md           # spawn() capability + validatePolicy/spawn/parseResult/cancel/cleanup/serves
    anti-self-certification.md    # model-independence verification protocol + terminal states
    run-store.md                  # run manifest, patches-first, resume, effective-config
  templates/ solo-research.yml  research-synth.yml  lite-build.yml  full-engineering.yml  design.yml
  scripts/
    init        # pick template + discovery (normalized model meta) + tiers→models → write config + effective-config
    validate    # schema + policy validation; materialize effective-config.json before any run
    orchestrate # the router + gate loop (calls the injected spawn capability)

moa-bindings-<host>/ # SEPARATE package(s) — the ONLY place a CLI name appears
  adapter.<impl>                  # implements the adapter contract (argv, temp-file prompts) + conformance tests
```

---

## 9. Decisions to lock (recommendations in bold)

1. **Config format** → **YAML** for the human-edited workflow file (block scalars for prompts); JSON for machine run-state.
2. **Master discretion** → **adaptive within `gate: standard|critical` steps** (3-layer model; 4-way dispatch: init / learn-tool / workflow / dynamic+zero-config).
3. **Adapter knowledge** → **none in the skill core** (your steer). Skill ships only the binding *schema* + the abstract `spawn()` primitive; concrete bindings are discovered/generated per environment, native-first. v1 proves the abstraction by generating a binding for whatever host it's dogfooded on — without naming a single CLI in SKILL.md.
4. **Naming** → `moa` (descriptive) vs `agent-orchestra` / `conductor`.
5. **Enforcement default** → **`strict`, fail-closed**; `sandbox` opt-in per project.

---

## 10. Build plan (phased)

Two packages (major #6): **`moa-core`** (SKILL.md + schema + master
playbook — names NO CLI) and **`moa-bindings-*`** (example adapter
plugins — the only place a CLI appears).

1. Core skeleton: `SKILL.md` + JSON Schema for the config + `full-engineering` template + the abstract `spawn()` contract + gate/verdict parsing. No CLI named.
2. One example adapter plugin (shell path) for whatever host we dogfood on, in a *separate* bindings package, implementing the full adapter contract + conformance tests.
3. `init`/`validate`: discovery (normalized model metadata) + tier resolution + materialize `effective-config.json` + run-store scaffolding.
4. Native-capability binding (master uses host subagent tool) + constraint-first router.
5. Remaining templates; remaining example bindings. Dogfood on a real project; iterate.

---

## 11. Review hardening (v2) — resolutions to the GPT-5.5 adversarial review

`VERDICT: REVISE` (5 blockers, 9 majors, 2 minors). Blockers 1–5 and majors 6–10,13
are resolved inline above (§3, §5, §6, §4 toolPolicies). Remaining resolutions:

- **Run-store, resume, idempotency** (major #11). `workDir/.moa/runs/<id>/`
  holds an append-only **run manifest**: per-phase `{status, attempt, inputHash,
  artifacts, changedFiles, lockOwner, retryPolicy}`. Workers **produce patches first**;
  applying a patch to the real workspace is a separate committed transition, so a
  mid-phase crash is resumable (replay from last committed phase) and revertible.
- **Determinism + cost/quota** (majors #12, #14). Before execution, `validate`
  materializes **`effective-config.json`** — exact `{model, provider, family, ctxLimit,
  adapter, enforcementGrade, selectionReason}` per role — so a reviewer sees what
  *actually* ran, not just the optional source YAML. Per-run `maxCost/maxTokens/maxTime`
  budgets; release-critical/CI templates must **pin** models (no `auto`).
- **Research→implement sanitization** (major #8, concrete). Research output is a typed
  **`research-facts.json`**: `[{ claim, source, quote, confidence, relevance }]`. Raw
  pages are **never** attached to a write-capable role; facts are rendered inside a
  quoted, explicitly-non-instruction data block. Web roles cannot read repo files/secrets
  (enforced by `web_research` policy, §4).
- **Canonical schema first** (minor #15). Ship a **JSON Schema** as the source of truth
  with normalized identifiers (one casing convention), enum values, and `pipeline` as a
  single canonical shape; template names fixed (`solo-research`, `research-synth`,
  `lite-build`, `full-engineering`, `design`).
- **Strict YAML** (minor #16). Parse a YAML-1.2 **safe subset**: no anchors, no merge
  keys, no duplicate keys, known-keys-only, then normalize to canonical JSON before
  execution — so the reviewed config equals the executed config.

Net: the authoritative design is this document **as revised**. Open product call left
for you: §6 `allowInlineWithoutGates` — keep it as an explicit, labeled opt-in (my
recommendation) or forbid entirely.
```
