# `init` / `project` — configure default model choices or a project

Reached when the skill is invoked as `init` or `project` (see `SKILL.md` step 1).
Your job here is narrow: **write only valid init targets, then stop.** `init`
writes the machine defaults, `~/.moa/config.yml`; `project` writes the repo-root
`.moa.yml` — and on a machine with no default setup yet, `project` **offers to save
the confirmed choices as `~/.moa/config.yml` too** (one confirmation, two writes —
the default setup should exist from the first setup, not stay an expert feature).
You do not run a pipeline, create a run-store, or resolve routing — those happen later.

You stay CLI-agnostic the whole way: you never name a runtime or command. Models come from
the host-native capability plus any **learned tool profiles** in `~/.moa/bindings/` — a profile
is the sole place a concrete CLI lives (see `references/learn-tool.md`). `init` may *offer* to
learn a new tool, but it never spawns one or runs the pipeline.

## Speak plainly to the user (governs every prompt and message you show)
You reason internally in precise terms — *binding, profile, models registry, family/independence,
host-native*. **The user needs none of that vocabulary**, and showing it makes moa
feel broken and intimidating (a newcomer reading *"OMP binding is broken (symlink target missing,
parked model)"* will just ask "what's a binding?"). Translate at the boundary:

| you think… | you say to the user… |
|---|---|
| binding / profile / adapter | "a connected AI tool" or just "model" |
| models registry | "the AI models moa can use here" |
| layer / overlay / merge / staffing | "your default AI setup" / "this project's custom rules" |
| model family / independence / verifier | "a second, different AI to double-check the work" |
| host-native | "the AI I'm already running on" |
| parked · symlink · `serves()` · registry | *don't mention — internal* |
| a tool's internal id (e.g. `omp`) | use it only if the user used it first |

- **Lead with the outcome and the one next action**, not the internal cause. The user wants
  "what happens if I pick this," not a diagnosis of moa's plumbing.
- **Never surface an internal failure as a scary blocking question.** A missing or stale
  connection is something you quietly handle and *optionally* offer to fix — default to "I'll set
  things up now, you can add more later," not "something is broken, what do I do?"
- **Match the user's level.** They wrote in jargon → you may; new user → stay plain. When unsure,
  stay plain.

**Same moment, badly vs. well:**

> ✗ *"OMP binding is broken (symlink target missing, parked model). What should init do?
>   1. Write with empty models registry now, flag the gap  2. Run /moa learn-tool omp first…"*

> ✓ *"Setting up moa for this project. Right now I can only reach the AI I'm already running on —
>   I didn't find any others you've connected. Want me to:
>   1. **Set it up now** — you can connect more AI tools anytime (quickest).
>   2. **Connect another one** — I'll look for tools you have installed and walk you through it.
>   3. **Stop for now.**"*

Both say the same thing; the second hides nothing that matters and never sends the user to Google.

## Invocation forms
- `init` — choose the default AI setup for every project (`~/.moa/config.yml`); no
  project detection or template.
- `init --force` — regenerate `~/.moa/config.yml` if it exists.
- `project` — detect the project type, propose a template, confirm, write `.moa.yml`
  (offering to save `~/.moa/config.yml` first on a machine with no defaults — see step 5).
- `project <template>` — use that template directly (`solo-research`, `research-synth`,
  `lite-build`, `full-engineering`, `design`). Skips detection.
- `project --force` / `project <template> --force` — regenerate `.moa.yml` if it exists.
  `--force` never crosses commands: `project --force` authorizes only `.moa.yml`,
  `init --force` only `~/.moa/config.yml`.
- **Legacy forms** (from before the split): `init global` → treat as `init`.
  `init <template>` → say plainly that project setup moved to `/moa project <template>`
  and stop — do **not** write anything (bare `init --force` now regenerates the machine
  defaults, not the project file, so a stale habit must never overwrite the wrong target).

## How the two settings files combine

Your project’s custom rules sit on top of your default AI setup. Names you set in the project
replace or add to matching defaults; names you leave out stay available. If the project file
omits `models` or `roles`, it keeps that section from the default setup, so a project pipeline
can use a default role without repeating it.

## Procedure

1. **Parse args** — the command selects the target: `init` → global, `project` → project
   with an optional template name. Either command accepts `--force` (for its own target
   only); `init` rejects a template (see legacy forms above).

2. **Guard the selected target.** `project` guards `.moa.yml`; `init` guards
   `~/.moa/config.yml`. If that target exists and `--force` was not given, read it,
   summarize the current AI choices plainly, tell the user how to regenerate or edit
   it, and **stop**. Never silently overwrite either a team-shared project file or
   machine-wide defaults. The `project` guard runs **before** any global work — an
   already-configured project must stop here, never reach the step-5 default-setup offer.

3. **Resolve the template (`project` only; `init` skips this step).**
   - If a template arg was given and is one of the five known names → use it.
   - If it was given but is unknown → list the five valid names and stop.
   - Otherwise run **coarse detection** (one suggestion, not a taxonomy):

     | Signal at repo root | Propose |
     |---|---|
     | a build manifest **and** a test dir/target (`package.json`+`test/`, `Cargo.toml`+`tests/`, `go.mod`+`*_test.go`, `pyproject`/`setup.py`+`tests/`) | `full-engineering` |
     | mostly `.md`/docs, no build system | `solo-research` |
     | anything else / ambiguous | `full-engineering` (safe default — most gates) |

     Show the proposal **and the signal that triggered it**, and ask the user to
     confirm or name another template. `lite-build`, `research-synth`, and `design`
     are never auto-proposed — they are reachable only via an explicit arg.
     In a non-interactive `project` run, accept the detected proposal without prompting and
     flag the unconfirmed detection in the report.

4. **Discover the candidate model set — a working set in memory, NOT the registry** (both targets;
   fail-soft — a failed source alone never blocks a write). Get the live inventory through the
   MCP server, not by reading profile files by hand:
   0. **Call `moa_tools`** — the server runs the registered `modelDiscovery` recipe for every
      bound tool and returns the *current* inventory each learned tool serves now. This is the
      **only** read of external inventory you need: there is no stored `models`/`listModels`
      field on a profile to consult, and you do **not** parse `~/.moa/bindings/*/profile.yml`
      yourself. Host-native routes are **not** part of `moa_tools` — they come separately
      from the host's own subagent capability (see the next step).
   1. **Add your host-native models** to the same candidate set — the host always has models
      only it knows about, so append whatever the host can spawn subagents on; `moa_resolve`
      will intersect them with the discovered external routes.

   Hold each candidate as `{ short-name, id, family, context, tags, source }` — `source` labels
   the inventory (`host-native:<vendor>` vs `learned:<tool-name>`) so you can separate host and
   learned inventories in step 5. short-name is the last `/`-segment of the ref, minus any
   `:<effort>` suffix (keep the provider prefix only to break a collision). Seed `tags` from what
   the source reports: top-tier → `strong` · volume/cheap → `cheap` · fast/triage → `fast`;
   add `vision` to a vision-capable model. Capability labels live in `tags`, never in the key.

   **This set is your candidate pool, not the file.** Do NOT emit one model entry per discovered
   model — that full dump (often 50–70 models) is exactly the bloat to avoid; it costs the team
   tokens on every run and buries the few models that matter. The written `models` section is
   assembled in step 7 from **only the models selected in step 5**.

   If a learned tool's `moa_tools` row came back with a non-`ok` discovery status (stale,
   unparseable, or the binary is gone) — **quietly skip it.** Do not stop, and do not surface the
   raw failure to the user as a question (no "binding broken", no "symlink", no "registry"). At
   most, mention it in plain language *as an aside* with a fix offer: *"One tool you'd connected
   earlier isn't reachable anymore — I'll leave it out. You can reconnect it later."* The missing
   connection never removes healthy candidates; host-native remains available, and one failed
   learned tool never takes the healthy live/native routes down with it. The global target still
   must satisfy the checker constraint in step 5.

   For the `project` command without a global file, if host-native is the only source, there is one family and nothing to route
   between, so roles stay `[auto]` (the host resolves them live at run time) — the union of picks
   is empty and `models` stays `{}`, with the comment:
   `# only host-native models at init — connect more with /moa learn-tool, or they resolve live at run time`.

4b. **Offer to bind more tools (the on-ramp — this is where moa "finds" your other CLIs).**
    Discovery reports what is *already* connected; it cannot *connect* anything. So, before
    choosing models, look at what you found and decide whether to offer `learn-tool`:
    - **Only one model family is available** (e.g. just the host) — gates still work when it
      serves several models (independence = a different *model*), but a **cross-family** verifier —
      the preferred grade — is impossible in this state; say so plainly and offer the upgrade.
      If only one *model* is available, independent gates are impossible — that is the real gap
      to fix, not silently write a weaker config.
    - **Probe for candidate launcher CLIs** the user could connect — names come from a *data*
      catalog of known launchers (outside the skill core) or from asking the user which CLI they
      have; never hardcode a CLI name here. For each plausible candidate found on `PATH` but not
      yet connected, offer in plain language: *"I found `<cli>` installed — want me to connect it
      so moa can use its models? It takes a minute."* (Behind the scenes that runs
      `/moa learn-tool <cli>`; you don't need to say "bind" or "profile" to the user.)
    - On accept, hand off to `references/learn-tool.md` (probe → prove → bind globally), then
      **re-run discovery** so the new models enter the candidate pool before you make the picks. On
      skip, continue with what you have and note the weaker independence grade in the report.
    In a non-interactive run, don't prompt — just record in the report which candidates were
    detected-but-unbound and that `/moa learn-tool` would connect them.

5. **Choose model assignments.**
   **`init` (the default setup):** make three assignments (2–3 distinct models):
   - **Main reasoning AI** → `planner`, `design-consult`, `synthesizer`, `researcher`.
   - **AI that carries out the work** → `coder`, `builder`, `gatherer`.
   - **A second, different AI to double-check the work** → `plan-reviewer`, `code-reviewer`,
     `design-reviewer`, `verifier`.

   The checker **must be a different model from both other choices**; prefer a different
   family when available. The reasoning and implementation choices may be the same model.
   If no candidate can satisfy the checker constraint, explain plainly that one more AI is
   needed and stop before writing. Do not assign `differentModelFrom` here; those relationships
   come from each project's rules.

   **`project` with no global file (the machine's first setup):** make the **three global
   choices above first** — they become the default AI setup, and this template's roles are a
   subset of the roles they cover. If the checker constraint cannot be satisfied, or the pool
   is host-native-only with nothing to route between (the `[auto]`/`models: {}` case below),
   **skip the default-setup save** — never block or weaken the project write for it — and
   fall back to the self-contained emission in step 7. In a **non-interactive** run, skip the
   default-setup save too — machine defaults are never written without an explicit `init`
   invocation or an in-conversation confirmation — and put the `/moa init` tip in the report.
   Otherwise continue below as if the default setup existed, treating the three choices as its
   role choices.

   **`project`:** use a matching choice from the default AI setup when one exists, and run
   the existing process below only for roles without one or for an explicit project-specific
   choice. Resolve each remaining role's `use` list — one capable, current pick per role. Pick *per role* from the
   candidate pool; never blanket every role with `[auto]`. Match the role's purpose
   (`description`/`instructions`) and its criticality — derived from whether any phase running it has
   `gate: critical` (criticality lives on the phase, not the role) — against the
   pool's `tags`/`context`/`cost`,
   then take the **smallest model that clears its bar AND is the most current in its line**
   (reasoning/critical → `strong` · high-volume coding → `cheap`/`smol`/coder · design →
   `designer`/`vision` · large inputs → high `context`). Apply *Pick few, pick current* below.
   - **Shape:** write `use: [<primary>, auto]` — one primary short-name plus a trailing `auto`
     for resilience. Add a second explicit name **only** with a concrete reason (a known-flaky
     primary, or a context/independence gap the fallback must cover); never pad the list. Three
     explicit names on one role is a smell, not thoroughness.
   - **Independence:** resolve roles in dependency order so a `differentModelFrom`/verifier role is
     pinned to a **different model** than the role it guards (verifier independence is vs the
     *producer* it checks; different family preferred). Keep verifiers/critical roles in
     `master.hardVerificationTags` (`strong`).
- **Stay `[auto]`** for a role only when the pool is empty, no model clearly fits, or independence
  can't be guaranteed here (one model) — and name which roles stayed `auto` and why.
- **Pinning a model to a tool (the model-level binding rule).** When the user wants a specific
  alias to always run through one specific route (e.g. "this opus always goes through `omp`"),
  record that as `models.<alias>.binding: <host-native | learned-tool-name>`. **Never** set
  `roles.<name>.binding` — the schema rejects it, and even if it didn't, the tool route is a
  property of the *model* the role picks through `use`, not of the role. Bindings only live on
  `models.<alias>` entries.
- **Reject or omit noncanonical model ids.** Any id the discovery step surfaced that does not
  match `^[^\s/]+/[^\s]+$` (display names like "Claude Opus 4.6", bare `MiniMax-M3`, anything
  that isn't a strict `<provider>/<model>`) is not a candidate. The server would reject it at
  resolve-time; do not normalize or coerce — drop it and tell the user in plain language that
  one inventory returned display names only and was not used.

### Project picks: few and current
The project's saved models are the **union of its explicit per-role picks**, nothing more — so
fewer, newer models is the whole game.
- **Pick current.** Among models that clear a role's bar, take the **latest in its line**
  (`claude-opus-4-8` over `…-4-7`; `gpt-5.5` over `gpt-5.2`; `code/MiniMax-M3` over `MiniMax-M2.x`).
  Pin an older/smaller one only with a one-line **Why** (cost, context, independence).
- **Pick few.** One primary per role; let roles **share** a model (planner and verifier can both be
  the strong one) before introducing a new one.
- **Invariant** (reference, not a count): **every entry is referenced by some role** — a reasoned
  second fallback counts; an unreferenced leftover from discovery is bloat, drop it.

**Example — `full-engineering`:** planner `claude-opus-4-8`, coder `code/MiniMax-M3`, reviewers +
verifier `gpt-5.5` (family ≠ coder) — each `[<pick>, auto]`. **Registry = 3 models**; add a fast web
model only if a research role exists. Everything else the host serves stays out of the file.

6. **Confirm the choices before any write.** Tags are a *heuristic* the source infers (price rank
   within the catalog plus reasoning support, not ground truth), and they steer routing, so show
   only the **shortlist**, never the whole candidate pool:
   - **`init`:** show the three choices under the plain-language labels in step 5 and state
     that the checker differs from both other choices.
   - **`project`:** show every role's chosen model(s), the one-line reason, and any **Why**
     for an older/smaller choice; then show the small set of AI models this project will save with
     their seeded tags. If defaults exist, distinguish them from this project's custom choices.
     On the machine's first `project` run, also state plainly: *"I'll save these choices as your
     default AI setup, so every project can reuse them — this project keeps its own rules in
     `.moa.yml`."* — one confirmation covers both writes.
     If the user declines the default-setup save, respect it: write only the self-contained
     project file (step 7).

   Ask the user to confirm or correct the choices before writing. Their correction always wins —
   with one exception: a correction that makes the checker the same model as another choice.
   Explain plainly that the double-check must be a different AI; if they insist, honor their
   choices **for this project only** and skip the default-setup save (under `init`, write
   nothing) — a default without an independent checker would quietly weaken every project.
   In a non-interactive run, skip the prompt but flag in the report that tags are unconfirmed.
   Non-interactive `init` still writes the defaults — invoking `init` is itself the
   authorization. A non-interactive `project` run never writes them (see step 5): it emits
   the self-contained project file and notes the `/moa init` tip in the report.

7. **Render and write the selected target via `moa_init`.**

   **`init`:**
   - Call `moa_init` with `scope: "global"`. Pass only the 2–3 selected models and all 11 role
     names from step 5, each with one `use: [<pick>, auto]` entry.
   - Emit only `schemaVersion`, `models`, and `roles`: no `differentModelFrom`, template,
     instructions, or pipelines. Do not detect or splice a template.
   - `moa_init` validates the complete global result before writing. If invalid, it reports the
     problem and writes nothing.

   **`project`:**
   - **First-run default save (when step 5 made the three global choices):** call `moa_init`
     with `scope: "global"` first, exactly as `init` above — and **without** force semantics,
     even when the user passed `project --force` (that flag authorizes regenerating `.moa.yml`
     only). If it fails **for any reason** — validation, an existing-file guard, or the write
     itself (e.g. an unwritable home directory) — say so plainly, skip the default setup, and
     continue with the self-contained emission below; the project write never fails or weakens
     because the default save did. On success, the global file now exists: use the *"global
     file exists"* emission. If the global save succeeds but the project write then fails,
     report exactly that — defaults saved, project file not written — never a blanket success.
   - Start from `templates/<name>.yml` **verbatim** — its comments are the in-file
     docs and must survive.
   - **No global file (and none was just created):** emit today's full self-contained project file. Assemble `models` from
     every explicit role choice in step 5, one entry each (`id`, `family`, `context` if known,
     seeded `tags`, optional `binding`) and nothing else; replace each role's `use: [auto]`
     placeholder with its assignment.
   - **Global file exists:** emit this project's custom rules. Omit `use` for roles whose global
     choice is accepted. For every role without a global choice or with an explicit project
     override, keep `use` and the minimal model entries it references. Preserve project
     `differentModelFrom`, `instructions`, `pipelines`, and `template`.
   - A user-pinned route remains `models.<alias>.binding`; never emit `roles.<name>.binding`.
   - **Keep pipelines named; never emit a `default`.** Templates ship **named** pipeline(s) — e.g.
     full-engineering's `engineering`+`quick` — and no `default`, so a fresh config runs in **adaptive
     mode** (config-present fork: the master picks the approach per task); don't rewrite, rename, or prune them. Emit a
     pipeline's `description:` **only when the config has ≥2 pipelines** (a single-pipeline config
     selects by name). Omit `runtime.subagents` (default `auto`); write it only to pin.
   - Call `moa_init` with `scope: "project"`. When global defaults exist, it combines the rendered
     project file with the actual global file and validates the effective result before writing;
     otherwise it validates the self-contained file. On failure it reports the problem and writes
     nothing.

8. **Report.**
   - **`init`:** print the written path and the three confirmed choices under the
     plain-language labels from step 5, including that the checker differs from both others.
   - **`project`:** print the path, template, per-role AI choices (including any left
     automatic and why), the reachable double-check grade, and any installed AI tools offered
     for connection. Say plainly that **moa picks the right approach per task** because this
     project sets no `default`, and that **to always run one workflow exactly, make it the
     default** — showing the exact one-line key rename:

   ```
   pipelines:            pipelines:
     engineering:   →      default:
   ```

   End with the next action: run `/moa <task>`, connect another AI tool, or edit `.moa.yml`.
   If a first-run `project` command also saved the default setup, say so in one line: *"Saved
   these AI choices as your default — new projects will reuse them automatically."* If it
   instead wrote a self-contained file (user declined, non-interactive run, or the default
   save was skipped), append exactly one closing tip: *"Run `/moa init` once to make these AI
   choices your default for every project."*

## Edge cases
- `project` without a global file and with only host-native models available → one family, nothing to route: roles stay
  `[auto]`, so the union of picks is empty and `models` is `{}` + comment; success — gates can
  still use different host models — but say plainly that stronger cross-family double-checking
  needs another connected AI tool. The first-run default save is skipped in this state (there
  are no picks to save); connecting another AI tool and re-running `/moa init` enables it.
- First-run `project` where the checker constraint cannot be satisfied → skip the default
  save, write the self-contained project file, and say plainly that one more AI enables both
  the stronger double-check and the shared default setup.
- `init` without a checker model different from both other picks → report that a second AI
  is needed and write nothing.
- A broken `~/.moa/config.yml` (load reports it invalid) → still route here: `init --force`
  regenerates it; never fall back to project-only picks while the defaults stay broken.
- Legacy `init <template>` → point to `/moa project <template>`, write nothing;
  legacy `init global` → same as `init`.
- A learned tool that fails live discovery during step 4 → that tool is skipped; register the
  rest of the inventory and tell the user in plain language which tool to re-learn. Healthy
  live and host-native routes keep working; one failed tool never takes the rest down.
- A learned profile that won't parse / is stale → use what remains, skip it, and tell the user
  which connected AI tool they can reconnect.
- Unknown template arg → list the five names, stop.
- Unrecognizable project → detection falls to `full-engineering`; user confirms.
- Discovery returns display-name or otherwise noncanonical ids → reject that tool's rows,
  not normalize them; proceed with what survived.

## Role intent (advisory, never a runtime constraint)
`roles.<name>.instructions` is advisory prompt steering the master passes to the role — it is
*not* enforced and never constrains the spawned agent. `init` never edits or removes it; the
`instructions:` reference passes through the chosen template verbatim.

## Stay agnostic
Never write a CLI name, flag, or command into `.moa.yml` or your reasoning. The `models`
registry holds only the model refs the roles use (drawn from `moa_tools` and the host-native
capability); how those models run is profile data resolved at orchestration time, not here.
Binding a model to a specific route belongs on the `models.<alias>` entry, not on a role.

See also: SKILL.md, `references/learn-tool.md`, `references/adaptive.md`,
`schema/config.schema.json`, `templates/`.
