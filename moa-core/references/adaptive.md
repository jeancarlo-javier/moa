# Adaptive mode

Reached for any orchestration that is **not** `init`, `learn-tool`, or deterministic workflow mode
(SKILL.md → *Mode dispatch*). Adaptive mode runs **one arc** — frame → decompose → produce → verify
→ finalize — and **forks on whether `.moa.yml` exists**. Everything in the arc is shared; the fork
changes only four things:

- **(a) capability source** — *config present* (a `.moa.yml` with no `default`): capability is
  config-pinned (its `models` registry, declared `roles`, named pipelines). *Config absent* (no
  `.moa.yml`): capability is discovered at runtime from the union of the host's live
  `hostModels` and the *current* live learned-tool routes returned by `moa_tools` — not from a
  stored inventory cache.
- **(b) state** — *config present* materializes `effective-config.json` and uses a run-store, so a
  reviewer sees what actually ran. *Config absent* writes **nothing** orchestration-related —
  adaptive-bare discovery NEVER creates `.moa.yml`, a profile inventory cache, or
  `effective-config.json`; it only queries `moa_tools` (live) for the current external inventory
  and the host's models for the host-native set. The task's work product alone lands on disk.
- **(c) Frame** — *config present*: the Frame is a **hard requirement / proof-of-read** (emit it
  before any action, even a trivial inline answer; its `config:` line quotes path, `schemaVersion`,
  and declared role names — values you cannot echo without reading the file).
  *Config absent*: the Frame is a **discipline** (restate goal, constraints, non-goals,
  done-criteria + evidence; surface ambiguity), not a hard proof-of-read.
- **(d) the `/moa project` nudge** — offered **only when no `.moa.yml` exists** (see *When to suggest
  `project`*). The config-present fork already has a config; never nudge it.

The verification floor is the **same** for both forks — see *The verification floor* below.

You stay CLI-agnostic in both forks: name no runtime, model, tool, or command. You reason only about
the abstract capability "spawn a subagent on a chosen model", and resolve HOW it runs from the host —
the host-native capability, or a CLI taught via `learn-tool` (its profile lives in `~/.moa/bindings/`).
The config-absent fork is moa's discipline **without** the config: same conductor, same gated
instinct, every role and model resolved from runtime defaults instead of a declared workflow.

## Task-agnostic by construction
moa is agnostic about the **task's domain**, not just the runtime. The pipeline is a *shape* —
decompose, produce, verify, synthesize — that fits coding, research, evaluation, analysis, writing,
data work, or a head-to-head model battle. The **producer** is domain-neutral — a coder is one
instantiation; see the canonical role enumeration in *The config-absent fork* below.

So **never refuse or narrow a task because it is not framed as code**, and never claim "moa only
writes code against a repo" — that confuses moa's most common *instantiation* with its *purpose*.
Don't ask "where is the code"; ask: **what is the unit of work, who produces it, and who can
independently check it.** Then staff those roles from the live union of the host's models and
the current learned-tool routes (configless, see below) and conduct. (A "battle
model A vs B" task: the units are the two contestants' runs — one producer each — and the check is an
independent judge, a different model than both. A textbook run, not an off-menu request.) Your roles
are capabilities, not job titles.

## What still holds (config or not)
- **You are the conductor.** Frame, route, delegate, synthesize — never vanish into the work.
  Reserve yourself for judgment; delegate volume and specialized passes.
- **Frame before acting.** (Hard proof-of-read with a config; discipline without — see the fork above.)
- **Never silently self-certify.** Never pass your own substantial/risky mutation as verified on your
  own say-so. Take the **best independent verification the host allows** — always a different
  model, a different family whenever one exists — and when it falls short, **name the grade** (see
  the verification floor), never hide it. See `references/anti-self-certification.md`.
- **Scope the tools a subagent actually needs.** Whether you are following a declared `.moa.yml`
  or improvising ad-hoc, restrict each delegated subagent to the tools its job needs (at
  whatever granularity the host or bound binding supports) and load no arbitrary external skills
  — discipline, not a runtime guarantee.
- **Verify, don't assume.** A subagent's "done" is a claim until you see the artifacts.

## The config-absent fork: what you drop
With no `.moa.yml` there are no declared `pipelines`, role registry, `models` map, or bindings —
you improvise their equivalent from runtime defaults, and stay **honest about the weaker guarantee**:
this fork trades pinned determinism for zero-setup usefulness, and labels every result with the
grade it actually reached.

## The config-absent fork: resolve capability at runtime (no registry)
1. **Discover** what the host can do AND what live learned tools serve right now: the host's
   `hostModels` (which only the host knows) merged with the *current* external routes
   `moa_tools` returns from each bound tool's `modelDiscovery` recipe. If the host cannot spawn
   subagents and no learned tool serves models, you are the sole agent — note it; it sets the
   verification floor below. Family and tags come from the discovery payload as reported; an
   unknown family or an empty tag set from a tool never claims cross-family verification —
   name the grade from the families you actually see.
2. **Staff ad-hoc roles by capability, not by domain.** Per task, conjure the *capability* roles
   the work needs — typically a read-only *decomposer* (breaks the task down, plans the units), one
   or more *producers* (each makes one unit of the actual deliverable), and an independent
   *verifier* (checks the product). These roles are **domain-neutral**: the producer is a coder for
   a code change, a researcher for a literature pass, a writer for prose, a model-under-test for a
   head-to-head, an analyst for a comparison. Read the *task*, name the unit of work, assign who
   produces it and who can independently check it — never force the task into coding-shaped roles.
3. **Pick models by the same `auto` reasoning** as workflow mode (SKILL.md §1): the smallest model
   that clears the role's bar — strong for planning, verification, and hard reasoning; cheaper
   and faster for high-volume edits. The verifier must be a **different model** than the producer;
   prefer a different family.

## The arc, step by step
Run only the depth the task needs — `auto` latitude, always. The arc is identical in both forks;
only the four things above (capability, state, Frame, nudge) differ:
- **Trivial / non-mutating** (a question, a one-liner, a lookup) → answer inline. No ceremony.
- **Substantial** (multi-file, a feature, a refactor, anything risky) → run the arc:
  - **Frame** — you.
  - **Decompose + plan** — inline for small work; delegate to a read-only decomposer for large or
    unfamiliar material. Output a short plan: the units of work, their boundaries, edge cases, and
    how you'll verify each.
  - **Produce** — delegate each unit to a producer subagent when one is available and the work is
    sizeable; author it yourself only when the unit is small. Fan out only **disjoint** units —
    separate files, separate questions, or separate models — never two producers racing on one artifact.
  - **Verify (the floor)** — the best-available verifier (see *The verification floor*) checks the
    product against done-criteria using the task's own success evidence: tests for code, source-checks
    for research, a rubric or judge for a comparison, reproduction for a result. It does not *silently*
    collapse for risky work — no verifier ⇒ ship labeled *unverified*; and for a head-to-head the judge
    must be independent of the **contestants**, not just of you.
  - **Finalize** — you. Synthesize verdict and evidence; state what was verified, at what
    independence grade, and any residual risk. Invent no correctness claims.

## A non-coding run, concretely (the model battle)
Task: *"run the definitive battle of model A vs model B."* There is no repo, no diff, no test — and
that changes nothing. You conduct it exactly like any other run:
1. **Frame** — goal: a defensible verdict on which model wins on an agreed task; done-criteria:
   both contestants run the *same* prompt under the *same* conditions, and an independent judge
   scores them against a stated rubric. Surface the missing input now: *on what task?* — pick or ask.
2. **Decompose** — two disjoint units of work (A's run, B's run) plus one judging unit.
3. **Produce** — spawn one producer subagent per contestant: producer-A *is* model A, producer-B
   *is* model B, each handed the identical task in an isolated context so neither sees the other.
4. **Verify / judge** — an independent *judge* subagent — a **different model than both
   contestants** (a contestant judging the match is the self-certification the floor forbids),
   a third family preferred. If the judge shares a family with a contestant, name that in the
   verdict's grade.
5. **Finalize** — you synthesize: the winner, the margin, the rubric, and the judging grade. You
   route and report; you do not crown a winner on your own taste.

Swap "model A/B" for "approach A/B," "two candidate designs," or "three vendors" and the shape is
identical. This is the orchestration moa is *for* — it is not a coding-only tool.

## The verification floor
Your verifier is drawn from the spawn set **`runtime.subagents`** allows
(`auto | native | external | blocked`; default `auto` — all the config-absent fork has, since it
writes no config to pin another). Independence keys on the **model** — the verifier must be a
**different model** than the producer; family is a preference, never the test. The grade is
**always named**:
- **Cross-family** — a different model of a different family. The target; pick it whenever the
  spawn set offers a second family (same-family models share blind spots).
- **Cross-model** — a different model of the same family (e.g. only one vendor's models are
  spawnable): real independent verification; label it *"cross-model — same family."* On the first
  substantial run in this state, mention **once** that `/moa learn-tool` can bind a second family
  to upgrade gates to cross-family — then drop it.
- **Self-check** — `blocked`, or no different model spawnable: do your best check (a fresh-context
  same-model pass helps, but it is still the producer's own model — never independent), label the
  result *"unverified — no independent model,"* and recommend a user review or, when no config
  exists, `/moa project`.

Adaptive mode **does not halt** on a weak grade (either fork) — it proceeds and names the grade.
What a `.moa.yml` buys is pinned models and declared independence, **not** a harder halt. Only
`master.mode: strict` (workflow mode) keeps the hard floor — a `critical` gate with no
different-model verifier halts at `verification_unavailable`.

## When to suggest `project`
After substantial work, if the user is clearly doing repeated heavy engineering in this project,
mention **once** that `/moa project` would pin roles/models and run the gates the config-absent fork
only approximates. Never push it for one-off or light tasks — zero-setup is the point. (Config-absent
fork only; single-family runs may also mention `/moa learn-tool` once — it upgrades gates from
cross-model to cross-family.)

See also: SKILL.md, `references/init.md`, `references/anti-self-certification.md`.
