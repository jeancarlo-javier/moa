# Dogfood findings — v1 skeleton (2026-06-23)

Manual dogfood: installed the skeleton, smoke-tested the omp binding. Gaps found below.

## ✅ Works
- **Install**: symlinked into `~/.claude/skills/moa` and `~/.omp/agent/skills/moa`
  (live edits propagate). Invocable as `/moa` in a NEW session (discovery is session-start).
- **Binding `serves`**: runs `omp --list-models` and emits well-formed contract JSON per model:
  `{provider, modelFamily, modelId, capabilityTier, independenceGroup, contextWindow, cost,…}`.
  ~70 models enumerated across anthropic / google-antigravity / minimax / openai-codex / ollama.

## ✅ Gap 1 — FIXED (2026-06-23): `independenceGroup` now keyed on model family, not provider
Patched `adapter.py`: `independenceGroup = _family_from_model(...)` (prefix-hardened). Verified —
30 Claude models across `anthropic` + `google-antigravity` now collapse to one group `claude`;
no model keyed on provider remains. Anti-self-cert guarantee restored. Original bug below for record.

### (original) `independenceGroup` keyed on PROVIDER, not model family (SECURITY-CORRECTNESS BUG)
The anti-self-certification guarantee needs a verifier from a different *underlying model* than the
producer. But the binding derives `independenceGroup` from the **provider**, so:
- `anthropic/claude-opus-4-8` → group `anthropic`
- `google-antigravity/claude-opus-4-5` → group `google`
These would count as INDEPENDENT — but both are **Claude**. A Claude verifying Claude's work is exactly
the shared-blind-spot case the protocol forbids. **Fix:** key `independenceGroup` on `modelFamily`/lineage
(claude, gpt, gemini, minimax, …), not provider. Provider-via-aggregator must NOT launder independence.

## ✅ Gap 2 — FIXED (2026-06-25): metadata-driven tier + init confirmation gate
Rewrote `_capability_tier` in `adapter.py`: tier now derives from **price RANK within the catalog**
(quartiles, so it's unit-agnostic) plus the `reasoning` flag, with lineage names only as a fallback when
no price is reported. The substring bug is gone — `_DIMINUTIVE` is a word-boundary regex, so `MiniMax-M3`
no longer matches `mini`. Verified against the dogfood cases: `MiniMax-M3` → `cheap`, `gpt-5.4-mini` →
`fast`, frontier models → `strong`. UX half: `init.md` step 6 now shows the tier→model map + per-role
assignment and takes user overrides **before** writing config. Original bug below for record.

### (original) `capabilityTier` auto-assignment is crude
Heuristic mislabels: `minimax-code/MiniMax-M3` → `fast` (should be `cheap`/coder), `gpt-5.4-mini` → `strong`,
most models → `fast`. Tier is load-bearing (routing + "delegate to strongest"), so a bad guess routes work
to the wrong model. **Fix:** better heuristic (cost + context + reasoning flag) AND `init` must show the
proposed tier→model map and let the user confirm/override before writing config.

## ❌ Gap 3 — no runner yet (`init` / `validate` / `orchestrate`)
To actually RUN a workflow end-to-end, the config must be hand-written (or template-copied) and the master
drives the loop by reading SKILL.md. The automation named in the layout isn't built. Acceptable for a
skeleton, but it's the main thing between "skeleton" and "press-the-button".

## ✅ Gap 4 — FIXED (2026-06-25): zero-config master was domain-bound to coding, not task-agnostic
Live failure: asked to "run the definitive battle of sonnet-4.6 vs minimax-m3," the zero-config master
**refused**, answering *"moa dispatches subagents to write code against a repo, not to benchmark models."*
Root cause was a framing leak, not a missing feature: the skill is runtime-agnostic (no CLI names) but its
prose was **coding-bound** — zero-config staffed roles named `explorer/coder/verifier`, the pipeline said
*"Execute → delegate to a **coder** … fan out disjoint **file-sets**"*, and verify checked *"the **diff**, run
**test** commands."* A non-coding task had no role to map onto, so the master mistook moa's commonest
*instantiation* (code) for its *purpose*. **Fix** (modeled on Sakana Fugu / the TRINITY think→produce→verify
coordinator, which assembles capability roles for *any* task instead of one domain-specific workflow):
- `zero-config.md` — new **"Task-agnostic by construction"** section; roles re-cast as domain-neutral
  capabilities (decomposer / producer / verifier, "capabilities not job titles"); pipeline phases renamed
  Decompose→**Produce**→Verify with domain-following producers and evidence-following checks (tests for code,
  rubric/judge for a comparison, reproduction for a result); a worked **model-battle** example (one producer
  per contestant, independent judge of a third family — "a model may not certify its own victory").
- `SKILL.md` — intro now states the pipeline is task-agnostic; new anti-pattern: *refusing/narrowing a task
  because it is not framed as coding*.
- `evals/evals.json` — added regression eval `zeroconfig-task-agnostic-battle` (id 3): the exact failure case
  must now be accepted and orchestrated, never refused.

## Recommended order
1. Fix Gap 1 (independence) — it undermines the core safety promise; cheap fix in `adapter.py`.
2. Build `validate` (schema + precedence + effective-config) — unblocks reproducible runs.
3. Build `init` with user-confirmed tier mapping (fixes Gap 2's UX half).
4. Then a full end-to-end dogfood through the gated pipeline.

## Schema evolution note (2026-06-26)

Pipeline/gate shape superseded: `pipeline:` flat list and top-level `gatesRequired:` are gone; replaced by `pipelines:` map (named workflows) with per-step `gate: none|standard|critical` enum — `critical` is the top tier, `standard` is mandatory but without the hard-tag requirement. Dispatch is now four-way: `init` / learn-tool / `.moa.yml` with `pipelines.default` (workflow mode) / `.moa.yml` without `default` (dynamic mode, adaptive arc from config) / no `.moa.yml` (zero-config). Verification grade: cross-family > same-family native (labeled, not self-cert) > self-check; `runtime.subagents` (auto|native|external|blocked) governs source. The bugs logged above (adapter, runner, domain-binding) are unaffected by this shape change.
