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

The new binding is validated launcher data executed by the MCP server. A profile records the
non-interactive argv template, safe prompt channel, output contract, timeout, capabilities, and
models a launcher serves. Learning it means deriving that data by probing the launcher, proving it
with live round-trips, then registering it through `moa_binding_save`. The MCP server owns process
execution; the master never receives argv or hands the profile to a shell.

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
  argv: ["{bin}", <run-subcmd>, "--model", "{model}", "--file", "{promptFile}", "--cwd", "{cwd}"]
  promptVia: file                  # file | stdin; arg is refused
  modelPlaceholder: "{model}"
  isolationFlags: [<...>]          # e.g. a no-session / no-extensions flag set, if the CLI has one
  timeoutSeconds: 1800
output:
  format: text                     # text | json | jsonl
  resultPath: <how to extract the assistant's final text>   # e.g. "stdout" or a JSON path
modelDiscovery:                   # the live-inventory recipe (REQUIRED) — what the server
                                   # runs to re-enumerate the tool's current model list.
                                   # args expand `{bin}` only; the server validates canonical ids
                                   # from the output before the profile is accepted.
  argv: ["{bin}", models, --json]
  output:
    format: json
    listPath: models              # path inside the parsed JSON to the array of model records
    idPath: selector              # path inside each record to the canonical model id
  timeoutSeconds: 10
capabilities:                      # OBSERVED facts (see "Capability notes"), not a contract
  canProduce: true                 # passed the file-mutation round-trip (T3)
  canSelectModel: true             # the model flag works (T2)
  promptSafe: true                 # prompt-injection test passed (T4) — REQUIRED true to bind
  toolRestriction: observed-honors-readonly | observed-ignores | none
evidence:                          # what proved each claim, + date — so a reviewer can trust it
  probedOn: <absolute date>
  tests: { T1: pass, T2: pass, T3: pass, T4: pass, T5: <result|skipped> }
# A second example for a CLI that prints one canonical id per line:
#
# modelDiscovery:
#   argv: ["{bin}", models]
#   output:
#     format: lines
#   timeoutSeconds: 10
# The saved profile contains only the run/output/capability metadata above — it never
# stores a list of model ids; inventory is fetched live every time the tool is queried.

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

The executable template may use `{bin}`, `{model}`, `{promptFile}`, `{cwd}`, and `{maxTime}`.
### Phase 2 — Acquire the live model discovery recipe
You do NOT capture a list of models here — that would freeze a snapshot of the tool and turn
re-binding into a chore. What you capture is the **recipe** that the server will run whenever it
needs the tool's current inventory. The recipe lives in the profile's `modelDiscovery` block.
Run the discovered list-models command to confirm the recipe is real and the output is parseable,
but write the recipe, not the parsed list:
- the **argv template** — uses `{bin}` only; every other arg is a literal the tool accepts. The
  server expands `{bin}` and refuses any other placeholder.
- the **output shape** — `format: json` with a `listPath` (array) and an `idPath` (each
  record's id) — or `format: lines` when the tool prints one canonical id per line.
- a sensible `timeoutSeconds` (10s is fine for a list).
The profile itself never stores a model list; the server validates the recipe by running it
during `moa_binding_save` and rejects it if the output cannot be parsed, the array is empty,
or any id fails the canonical shape (see the rules below). After binding, `moa_tools` and
`moa_resolve` re-run the recipe live every call — there is no cached inventory.
If the CLI has no programmatic list command, ask the user which models to expose and probe one
known id; without a real recipe the tool is not bindable as a model server (it can still
surface as a read-only launcher after the user accepts the smaller role set).
### Phase 3 — Trial launch (the live tests — the crux)
Run real subagents through the *draft* profile, cheapest model, in a scratch dir. Generate a
fresh random **nonce** per test and require it in the result — this is what stops a false
"it works" from an empty or canned reply.

- **T1 — liveness / echo (required).** Prompt: *"Reply with exactly this token and nothing else:
  `<nonce>`."* Confirm the captured output contains the nonce. One test proves three things: you
  can invoke it, it runs the prompt, and you can read its answer. **T1 fail ⇒ not bindable** —
  stop, surface the captured stderr.
- **T2 — model selection (required).** Repeat T1 with an explicit model id — and the model id
  MUST be one of the ids the `modelDiscovery` recipe just returned, copied verbatim. Confirms
  the selector works against a model the tool genuinely serves *right now*.
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

### Phase 5 — Register globally
Save the proven profile through `moa_binding_save`, including the evidence block (test results,
date, captured version). The server re-runs `modelDiscovery` to confirm the recipe still
parses, persists the profile under `~/.moa/bindings/<tool>/profile.yml`, and makes it
immediately visible through `moa_tools`. Global registration means every project can resolve
it without restarting the MCP server — and because the profile never stores a model list,
adding or removing a model tomorrow is a discovery event, not a re-bind.

## The ten learning rules (all required for a clean bind)
Every successful `learn-tool` workflow satisfies these in order. The server enforces the ones
that are mechanically checkable; the rest are master judgment the user audits:
1. **Start with the root `--help`.** Inspect the help, then drill into the run/list subcommand
   help. Do not write a recipe from a single page of docs.
2. **Require a programmatic model-list operation.** No list command ⇒ not bindable as a model
   server (offer the smaller read-only role set or stop).
3. **Require canonical IDs.** Every id the recipe emits must match `^[^\s/]+/[^\s]+$`
   (`<provider>/<model>`) — display-name inventories are rejected.
4. **Reject display-name inventories.** Claude, "Claude Opus 4.6 (Thinking)", gpt-5.5,
   `MiniMax-M3` alone — anything that is not a strict `<provider>/<model>` fails discovery.
5. **Use an exact returned id for T2.** Copy the id from the discovery output verbatim; do not
   normalize, capitalize, or guess variants. T2 with a non-listed id ⇒ the evidence is invalid.
6. **Require safe prompt transport (T4).** File or stdin only — argv is refused at registration.
7. **Submit through `moa_binding_save` for independent server execution.** The master writes
   the profile; the server runs the discovery recipe and the rejections — never self-validate.
8. **Persist no list output.** The profile carries `modelDiscovery`, never a stored list of
   `models`/`listModels`. Re-discovery is the only way to learn the current inventory.
9. **Call `moa_tools` after binding to observe the current inventory.** That confirms the bind
   end-to-end before you offer the user the new models.
10. **Re-learn only on invocation/parser drift, not on model-catalog drift.** The tool adding or
    removing a model is a discovery event the next `moa_tools` call will surface; only flag
    changes to the run argv, the output shape, or the binary/version require a re-bind.

### Phase 6 — Report + close the independence loop
Show the user: the tool bound, the models now available **with their families** (queried live
through `moa_tools` after the bind), the roles it can serve, the capability/safety notes, and
any role it *can't* serve and why. Then the key move: if this bind introduced a **new model
family**, say so — *"cross-family verification (the preferred grade) is now available."* If
only the host family still exists, repeat the offer. Point them at `/moa init` (or a
  re-resolve) so the new models actually get used.

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
During a run (workflow or adaptive), call `moa_tools` when connected-tool details are needed, then
resolve the role normally. For a current phase routed to a registered external tool, call
`moa_spawn(runId, phase, prompt)`. The MCP server selects the registered profile, expands
`{bin}`, `{model}`, `{promptFile}`, `{cwd}`, and `{maxTime}` as individual argv elements, transports
the prompt by file or stdin, executes without a shell, enforces timeout/output limits, and returns
the normalized result. Inspect that result and the actual workspace effects, then call
`moa_step_report`; spawning never advances the run.

## Re-learning & staleness <a id="re-learning"></a>
Re-running `learn-tool` on an already-bound tool re-probes and **overwrites** its profile
(idempotent). What triggers a re-bind is **invocation/parser drift**, not model-catalog drift:

- **Binary/version drift** — the tool's `--version` differs from `evidence.probedOn`'s captured
  version. The recipe or output shape may have changed; warn, offer a re-learn before relying
  on it. A CLI that changed flags can silently break the recipe, and you'd rather catch that
  at bind time than mid-orchestration.
- **Run-argv drift** — the tool renamed or removed the run subcommand, the model flag, or the
  prompt channel. Same remedy: re-probe and re-bind.
- **Output-shape drift** — the recipe still runs but the JSON/line shape changed (renamed
  field, new wrapper). Re-probe, re-write the `modelDiscovery` block, re-bind.

**Model-catalog drift is NOT a re-bind trigger.** Adding, removing, renaming, or retagging a
model the tool serves is what `moa_tools` discovers live on the next call — the profile
stores the recipe, not the list. The next `moa_resolve` or `moa_spawn` sees the change
automatically; you do not re-bind to track a catalog change.

## Terminal states <a id="terminal-states"></a>
- `bound` — profile written and proven (T1 ∧ T4, plus whatever else passed).
- `tool_incompatible` — T1 or T4 failed, or no non-interactive mode; reported with evidence.
- `tool_not_found` — the binary doesn't exist / isn't executable.
- `declined` — the user chose to skip; no profile written, host-native still works.

See also: SKILL.md, `references/init.md`, `references/adaptive.md`,
`references/anti-self-certification.md`, and `../../bindings/` (the parked enforced model).
