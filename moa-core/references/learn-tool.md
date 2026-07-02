# `learn-tool` — teach moa to spawn subagents through a CLI

Reached when the skill is invoked as `learn-tool` (see SKILL.md → *Mode dispatch*), and
offered automatically by `init` and on the first adaptive run with no config (config-absent fork) when the host has only one
model family. Its job: take a CLI the user already has, **learn how to drive it as a
subagent launcher**, prove that it works, and **bind it globally** so every future moa run can
spawn role×model subagents on it.

## The shift this mode embodies (read first)

The old binding was a *program the master called* — a hand-written adapter implementing an
enforced `spawn()` (archived in `../../bindings/`). It required authoring a security-sensitive
plugin and a language runtime the user may not have.

The new binding is **data the master learns and then drives with its own shell.** You — the
master — *are* the host agent, so you already have a shell. "Spawn a subagent on tool *T*" just
means: run *T*'s non-interactive command with a prompt and read back its output. So a binding is
nothing more than **the recipe for that command + how to read the result + which models *T* can
drive.** Learning it = deriving that recipe by probing *T*, then *proving* it with a live
round-trip. No adapter process. No Python. No runtime dependency.

This keeps the founding invariant intact: **the skill core still names no CLI.** Every concrete
command lives in the *profile* you write to disk (data), never in your reasoning or this file.

## Contents
- [When this mode runs](#when-this-mode-runs)
- [The tool profile — the artifact you produce](#the-tool-profile)
- [The learning protocol](#the-learning-protocol) ← the core
- [Suitability: what makes a CLI bindable](#suitability)
- [Capability notes are observed, not enforced](#capability-notes)
- [UX — what the user sees](#ux)
- [Using a bound profile at orchestration time](#using-a-profile)
- [Re-learning & staleness](#re-learning)
- [Terminal states](#terminal-states)

## When this mode runs <a id="when-this-mode-runs"></a>
- **Explicit** — `/moa learn-tool [hint]`, where the optional hint is a binary name or path the
  user wants bound (e.g. they tell you the command). With no hint, propose candidates (below).
- **Offered by `init`** — after the template is chosen, `init` checks what's bound; if only the
  host family is available, it surfaces candidate launcher CLIs and offers to learn one before
  writing `.moa.yml` (see `references/init.md`).
- **Offered on first adaptive run (no config)** — if the only model family is host-native, mention
  once that gates run cross-model, not cross-family (the preferred grade), and offer `learn-tool`
  to upgrade.

You never *require* it — binding is always opt-in, and the host-native capability always works
without it. learn-tool exists to add **more, and more independent, families**.

## The tool profile — the artifact you produce <a id="the-tool-profile"></a>

A profile is a small declarative descriptor saved **globally** so every project benefits:
`~/.moa/bindings/<tool>/profile.yml`. It is the entire binding — there is no code beside it.

```yaml
# ~/.moa/bindings/<tool>/profile.yml   (illustrative shape; you fill it from the probe)
tool: <short-name>                 # how moa refers to this binding
bin: <executable>                  # resolved on PATH or an absolute path
version: <captured --version>      # for staleness detection
run:                               # the recipe to launch ONE non-interactive subagent
  argv: [<bin>, <run-subcmd>, "--model", "{model}", "--file", "{promptFile}", "--cwd", "{cwd}"]
  promptVia: file                  # file | stdin | arg  (prefer file/stdin — never interpolated)
  modelPlaceholder: "{model}"
  isolationFlags: [<...>]          # e.g. a no-session / no-extensions flag set, if the CLI has one
  timeoutSeconds: 1800
output:
  format: text                     # text | json | jsonl
  resultPath: <how to extract the assistant's final text>   # e.g. "stdout" or a JSON path
models:                            # the serves() equivalent — learned from the list command
  - id: <full model ref>
    family: <model lineage>        # REQUIRED — cross-family preference + alias collapsing; infer + confirm
    tags: [<strong|cheap|fast|vision|...>]
listModels: [<bin>, <list-subcmd>, "--json"]   # how to re-enumerate models later
capabilities:                      # OBSERVED facts (see "Capability notes"), not a contract
  canProduce: true                 # passed the file-mutation round-trip (T3)
  canSelectModel: true             # the model flag works (T2)
  promptSafe: true                 # prompt-injection test passed (T4) — REQUIRED true to bind
  toolRestriction: observed-honors-readonly | observed-ignores | none
evidence:                          # what proved each claim, + date — so a reviewer can trust it
  probedOn: <absolute date>
  tests: { T1: pass, T2: pass, T3: pass, T4: pass, T5: <result|skipped> }
```

## The learning protocol <a id="the-learning-protocol"></a>

Binding is itself a small **gated moa task**: probe (read-only) → prove (live tests) → bind.
Run it cheaply — smallest model, trivial prompts, a scratch cwd, bounded timeouts — and **prove
before you trust.** Help text lies and you can misread it; only a live round-trip is truth.

### Phase 0 — Identify the candidate
Resolve *which* CLI without baking a name into the skill. Candidates come from, in order:
1. the **user's hint** (a binary name/path they gave);
2. a **data catalog** of known launcher CLIs that lives outside core (e.g. `~/.moa/known-tools.yml`
   or a bindings catalog) — names there are data, not skill knowledge;
3. **any executable the user points at.**

Reason only about the abstract shape — *"a CLI that can launch a non-interactive agent and
return its output."* Confirm the binary exists and is executable; if not, report and stop.

### Phase 1 — Surface probe (read-only, no agent launched yet)
Run the version and help commands (and help on likely run/list subcommands). These are
side-effect-free. From the help text, extract the *shape* and draft an invocation profile:
- a **non-interactive run mode** (a one-shot "run/prompt/exec" that takes a task and exits) —
  **required**; an interactive-only CLI with no headless mode is not bindable.
- how to **pass the prompt** — inline arg, `@file`, or stdin. Prefer file/stdin: no length limit
  and, crucially, no shell interpolation.
- how to **select a model** and how to **list models**.
- **effort/thinking** controls, if any.
- the **output shape** (text / JSON / JSONL) and where the assistant's final text lives.
- optional niceties: a **cwd** flag, a **no-session / no-extensions** flag, a **timeout** flag.

### Phase 2 — Acquire model knowledge
Call the discovered list-models command and parse it into the profile's `models` — `{ id,
family, tags }` per model. **Family is required** (it powers the cross-family preference and
collapses provider aliases of one model; independence itself keys on the model); when
the CLI doesn't report lineage, infer it and have the user confirm. No list command → ask the
user which models, or probe one known id.

### Phase 3 — Trial launch (the live tests — the crux)
Run real subagents through the *draft* profile, cheapest model, in a scratch dir. Generate a
fresh random **nonce** per test and require it in the result — this is what stops a false
"it works" from an empty or canned reply.

- **T1 — liveness / echo (required).** Prompt: *"Reply with exactly this token and nothing else:
  `<nonce>`."* Confirm the captured output contains the nonce. One test proves three things: you
  can invoke it, it runs the prompt, and you can read its answer. **T1 fail ⇒ not bindable** —
  stop, surface the captured stderr.
- **T2 — model selection (required if a model flag exists).** Repeat T1 with an explicit model.
  Confirms the selector works *and* that a listed model is actually real.
- **T3 — producer round-trip (required for producer use).** In the scratch dir, prompt: *"Create
  a file `moa_probe_<nonce>.txt` containing only `<nonce>`."* Then check the file exists with the
  right contents. This proves the tool can do real workspace-mutating work **and** that you can
  verify a producer's output by inspecting the filesystem/diff — which is how the orchestrator
  confirms producer work. Passes T1 but fails T3 ⇒ bindable for read-only roles (thinker,
  reviewer, verifier, judge) but **not** as a producer; record that.
- **T4 — prompt-injection safety (required).** Send a prompt full of shell metacharacters
  (backticks, `$()`, `;`, newlines). Confirm **none of it executes on the host** — i.e. the
  prompt truly traveled by file/stdin, not argv interpolation. This is the one load-bearing
  safety check carried over from the old conformance suite; it is cheap and it is the difference
  between "passing a worker a prompt" and "handing a worker host code execution." **T4 fail ⇒ do
  not bind** until the prompt channel is fixed.
- **T5 — tool-restriction observation (optional; only if Phase 1 found a restriction flag).**
  Launch read-only (deny write/edit) and ask it to write a file; observe whether the write was
  blocked. **Record the result as a capability note — do not grade or enforce it** (enforcement
  is parked; see `../../bindings/`).

### Phase 4 — Decide suitability + the roles it can serve
Minimum bar to bind at all: **T1 ∧ T4**. From the tests, set the profile's `capabilities` and
derive which roles the tool can staff: a producer needs `canProduce` (T3); thinker / reviewer /
verifier / judge need only T1. If T1 fails, end at terminal `tool_incompatible` **with the
evidence**, so the user learns *why*, not just "no."

### Phase 5 — Bind globally
Write the proven profile to `~/.moa/bindings/<tool>/profile.yml`, including the evidence block
(test results, date, captured version). This file *is* the binding: at orchestration time you
read it and run the tool with your own shell. Global location ⇒ every project sees it at once.

### Phase 6 — Report + close the independence loop
Show the user: the tool bound, the models now available **with their families**, the roles it
can serve, the capability/safety notes, and any role it *can't* serve and why. Then the key
move: if this bind introduced a **new model family**, say so — *"cross-family verification (the
preferred grade) is now available."* If only the host family still exists, repeat the offer. Point
them at `/moa init` (or a re-resolve) so the new models actually get used.

## Suitability: what makes a CLI bindable <a id="suitability"></a>
A CLI is *suitable for moa* when it can be driven as a **non-interactive, scriptable subagent**:
it accepts a task and exits (no required interactive REPL), it returns its answer on a channel
you can capture, and the prompt can be passed without shell interpolation (T4). Everything else
— model selection, restriction flags, JSON output — is a bonus that widens the roles it can
serve. A CLI that only runs an interactive session, or whose output can't be captured
programmatically, is *not* suitable; say so plainly and record why.

## Capability notes are observed, not enforced <a id="capability-notes"></a>
This mode **observes** what a tool can do; it does not **enforce** a permissions contract. There
is no `enforcementGrade`, no fail-closed `policy_unsupported`, no graded tool-policy here — that
whole layer is parked in `../../bindings/`. When you note `toolRestriction: observed-honors-
readonly`, that is honest knowledge for routing and for the user, **not** a guarantee moa
polices. Don't imply otherwise. (Re-introducing real enforcement later means growing this
profile's restriction section into something the master verifies — see `../../bindings/README.md`.)

What is **not** parked and stays fully active: **verifier independence.** Because the profile
records each model's `id` and `family`, the master can still route a gate to a different model
than the producer (different family preferred). Anti-self-certification does not depend on the
permissions layer — see
`references/anti-self-certification.md`.

## UX — what the user sees <a id="ux"></a>
Design the experience around these commitments:

0. **Speak plainly.** Never show users internal words (*binding, profile, registry, family,
   enforcement*) — say "a connected AI tool", "the models moa can use", "a second AI to
   double-check". Full rule + example: `references/init.md` → *Speak plainly* (governs here too).
1. **No silent dead-ends.** Never quietly orchestrate with one family when the user owns more.
   Surface the gap and offer to close it.
2. **The master does the work; the user confirms.** Probe and infer the recipe — don't make the
   user hand-write a descriptor. Offer a fast path ("tell me the run command and I'll verify it")
   and always allow *skip*.
3. **Legible progress.** Show the probe as a live checklist, one line per step with ✓/✗ and a
   one-line result, so a failure points at exactly which rung broke.
4. **Verify before you claim.** Never say "bound" without T1 green; report incompatibility with
   the *actual* captured error.
5. **Honest grade.** State what was observed, including "tool restriction not enforced — parked."
   Never over-promise.

```
$ moa learn-tool <hint>
Learning <tool> …
  detect binary        ✓  /usr/local/bin/<tool>  (v2.3.1)
  read help            ✓  found: run mode, --model, --file, models list, json output
  list models          ✓  4 models  (families: A, B)
  T1 liveness          ✓  nonce echoed
  T2 model select      ✓  ran on <model>
  T3 producer roundtrip✓  wrote moa_probe_<nonce>.txt
  T4 prompt safety     ✓  metacharacters not executed
  T5 read-only         ·  observed: honors read-only (note only — not enforced)
Bound globally → ~/.moa/bindings/<tool>/profile.yml
Now available: <models, with families>.  New family added → cross-family gates now possible.
Next: /moa init  (or re-run your task to pick up the new models).
```

## Using a bound profile at orchestration time <a id="using-a-profile"></a>
During a run (workflow or adaptive), the master discovers profiles in `~/.moa/bindings/*/`
exactly as it discovers the host-native capability. To spawn a role×model subagent on a profiled
tool: select the role's model, find the profile whose `models` includes it, write the role's
prompt to a temp file, fill the `run.argv` template (`{model}`, `{promptFile}`, `{cwd}`), run it
with your own shell under the profile's timeout, then read the result via `output.resultPath`.
Verify producer output by diffing the cwd — never by trusting the worker's self-report.

## Re-learning & staleness <a id="re-learning"></a>
Re-running `learn-tool` on an already-bound tool re-probes and **overwrites** its profile
(idempotent). If a run finds the tool's live `--version` differs from the profile's `evidence`,
treat the profile as **stale**: warn, and offer a re-learn before relying on it — a CLI that
changed flags can silently break the recipe, and you'd rather catch that at bind time than
mid-orchestration.

## Terminal states <a id="terminal-states"></a>
- `bound` — profile written and proven (T1 ∧ T4, plus whatever else passed).
- `tool_incompatible` — T1 or T4 failed, or no non-interactive mode; reported with evidence.
- `tool_not_found` — the binary doesn't exist / isn't executable.
- `declined` — the user chose to skip; no profile written, host-native still works.

See also: SKILL.md, `references/init.md`, `references/adaptive.md`,
`references/anti-self-certification.md`, and `../../bindings/` (the parked enforced model).
