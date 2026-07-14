# `init` — generate a project's `.moa.yml`

Reached when the skill is invoked as `init` (see SKILL.md → *Mode dispatch*).
Your job here is narrow: **produce one valid `.moa.yml` at the repo root, then
stop.** You do not run the pipeline, create a run-store, or resolve routing — those
are orchestration-time concerns.

You stay CLI-agnostic the whole way: you never name a runtime or command. Models come from
the host-native capability plus any **learned tool profiles** in `~/.moa/bindings/` — a profile
is the sole place a concrete CLI lives (see `references/learn-tool.md`). `init` may *offer* to
learn a new tool, but it never spawns one or runs the pipeline.

## Speak plainly to the user (governs every prompt and message you show)
You reason internally in precise terms — *binding, profile, models registry, family/independence,
enforcement, host-native*. **The user needs none of that vocabulary**, and showing it makes moa
feel broken and intimidating (a newcomer reading *"OMP binding is broken (symlink target missing,
parked model)"* will just ask "what's a binding?"). Translate at the boundary:

| you think… | you say to the user… |
|---|---|
| binding / profile / adapter | "a connected AI tool" or just "model" |
| models registry | "the AI models moa can use here" |
| model family / independence / verifier | "a second, different AI to double-check the work" |
| host-native | "the AI I'm already running on" |
| enforcement grade · parked · symlink · `serves()` · registry | *don't mention — internal* |
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
- `init` — detect the project type, propose a template, confirm, write.
- `init <template>` — use that template directly (`solo-research`, `research-synth`,
  `lite-build`, `full-engineering`, `design`). Skips detection.
- `init --force` / `init <template> --force` — regenerate even if `.moa.yml` exists.

## Procedure

1. **Parse args** — an optional template name and an optional `--force` flag.

2. **Guard.** If `.moa.yml` already exists and `--force` was not given: read its
   `template` and `models`, show them, tell the user to re-run with `--force` or edit
   the file directly, and **stop**. Never silently overwrite a committed,
   team-shared config.

3. **Resolve the template.**
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

4. **Discover the candidate model set — a working set in memory, NOT the registry** (fail-soft —
   never block a write). Get the live inventory through the MCP server, not by reading profile
   files by hand:
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

   **This set is your candidate pool, not the file.** Do NOT emit one registry entry per discovered
   model — that full dump (often 50–70 models) is exactly the bloat to avoid; it costs the team
   tokens on every run and buries the few models that matter. The written `models` registry is
   assembled in step 7 from **only the models the roles actually pick** (step 5).

   If a learned tool's `moa_tools` row came back with a non-`ok` discovery status (stale,
   unparseable, or the binary is gone) — **quietly skip it.** Do not stop, and do not surface the
   raw failure to the user as a question (no "binding broken", no "symlink", no "registry"). At
   most, mention it in plain language *as an aside* with a fix offer: *"One tool you'd connected
   earlier isn't reachable anymore — I'll leave it out. You can reconnect it later."* The missing
   connection is never a blocker; host-native always works, and one failed learned tool never
   takes the healthy live/native routes down with it.

   If host-native is the only source, there is one family and nothing to route between, so roles stay
   `[auto]` (the host resolves them live at run time) — the union of picks is empty and the registry
   stays `{}`, with the comment:
   `# only host-native models at init — connect more with /moa learn-tool, or they resolve live at run time`.

4b. **Offer to bind more tools (the on-ramp — this is where moa "finds" your other CLIs).**
    Discovery reports what is *already* connected; it cannot *connect* anything. So, before
    resolving roles, look at what you found and decide whether to offer `learn-tool`:
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
      **re-run discovery** so the new models enter the candidate pool before you resolve roles. On
      skip, continue with what you have and note the weaker independence grade in the report.
    In a non-interactive `init`, don't prompt — just record in the report which candidates were
    detected-but-unbound and that `/moa learn-tool` would connect them.

5. **Resolve each role's `use` list — one capable, current pick per role.** Pick *per role* from the
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

### Pick few, pick current (what keeps `.moa.yml` lean)
The registry is the **union of the per-role picks**, nothing more — so fewer, newer models is the
whole game.
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

6. **Confirm the picks — before any write.** Tags are a *heuristic* the source infers (price rank
   within the catalog plus reasoning support, not ground truth), and they steer routing, so show
   your work first — but show only the **shortlist**, never the whole candidate pool:
   - the **per-role assignment** from step 5 — each role, its picked model(s), the one-line reason,
     and (when you took an older/smaller model) its **Why**;
   - the **resulting registry** — the small union of those picks with each model's seeded tags, so an
     obvious mislabel jumps out.

   Ask the user to confirm or correct, and apply any override — retag a model, or repin a role to a
   different model — before writing. The user's choice always wins over the heuristic. In a
   non-interactive `init`, skip the prompt but flag in the report that the tags are unconfirmed.

7. **Render and write `.moa.yml`** at the repo root.
   - Start from `templates/<name>.yml` **verbatim** — its comments are the in-file
     docs and must survive.
- **Assemble the registry** = the union of every model any role picked in step 5, one entry each
  (`id`, `family`, `context` if known, seeded `tags`, optional `binding`) — and *nothing the
  roles don't reference*. Fill the template's `models: {}` with it, and replace each role's
  `use: [auto]` placeholder with its step-5 assignment. **`.moa.yml` contains only the
  aliases roles selected, never the full live inventory** — anything `moa_tools` reported but
  no role picked stays out of the file. When the user pinned a route in step 5, the
  `binding:` key lives on the `models.<alias>` entry — never on a `roles.<name>` field.
   - **Keep pipelines named; never emit a `default`.** Templates ship **named** pipeline(s) — e.g.
     full-engineering's `engineering`+`quick` — and no `default`, so a fresh config runs in **adaptive
     mode** (config-present fork: the master picks the approach per task); don't rewrite, rename, or prune them. Emit a
     pipeline's `description:` **only when the config has ≥2 pipelines** (a single-pipeline config
     selects by name). Omit `runtime.subagents` (default `auto`); write it only to pin.
   - Before writing, confirm the result round-trips through the YAML safe subset and
     validates against `schema/config.schema.json`. If you cannot guarantee it is
     valid, write the **untouched template** (with `models: {}` and `use: [auto]` roles) rather than
     emit a broken file.

8. **Report.** Print the written path, the chosen template, the resolved registry, the **per-role
   model assignment** (and any roles left `auto`, with the reason), the **independence grade**
   reachable here (cross-family vs single-family, per step 4b), and any candidate CLIs
   detected-but-unbound. Then say plainly that **moa picks the right approach per task** (this config
   sets no `default`), and that **to always run one workflow exactly, make it the default** — showing
   the exact one-line key rename (keep `pipelines:`; rename the pipeline's own key):

   ```
   pipelines:            pipelines:
     engineering:   →      default:
   ```

   End with the next step: run `/moa <task>` to orchestrate, `/moa learn-tool <cli>` to connect
   another model, or edit `.moa.yml` first.

## Edge cases
- Only host-native models available → one family, nothing to route: roles stay `[auto]`, so the
  union of picks is empty and the registry is `{}` + comment; success — gates stay independent
  across the host's models — but flag that the preferred cross-family grade needs a second tool
  bound via `learn-tool`.
- A learned tool that fails live discovery during step 4 → that tool is skipped; register the
  rest of the inventory and tell the user in plain language which tool to re-learn. Healthy
  live and host-native routes keep working; one failed tool never takes the rest down.
- A learned profile that won't parse / is stale → register what's usable, skip the rest, say
  which models resolved and which profile to re-learn.
- Unknown template arg → list the five names, stop.
- Unrecognizable project → detection falls to `full-engineering`; user confirms.
- Discovery returns display-name or otherwise noncanonical ids → reject that tool's rows,
  not normalize them; proceed with what survived.

## Tool policy: canonical intent, launcher-specific enforcement
`roles.<name>.tools` names a canonical least-privilege bundle (`toolPolicies.<name>` — declared
by every bundled template you write from, never invented at init). `init` never edits or removes
these — it splices only `models` and each role's `use` list; the `toolPolicies` block and each
role's `tools:` reference pass through the chosen template verbatim. What that canonical policy
compiles into is a launcher-specific decision, made live at `moa_spawn` against the tool profile
currently loaded for that role — never at init time, and never named here.
`runtime.requireEnforcement: strict` or `sandbox`, when configured, fails a spawn closed before
the agent task launches when the selected binding's learned profile can't express the role's
policy; `best-effort` (the schema default) still launches but reports the degradation explicitly
in the result and run manifest — never hidden. Host-native phases receive the same frozen policy
only as a request: the host, not the server, is responsible for applying it.

## Stay agnostic
Never write a CLI name, flag, or command into `.moa.yml` or your reasoning. The `models`
registry holds only the model refs the roles use (drawn from `moa_tools` and the host-native
capability); how those models run is profile data resolved at orchestration time, not here.
Binding a model to a specific route belongs on the `models.<alias>` entry, not on a role.

See also: SKILL.md, `references/learn-tool.md`, `references/adaptive.md`,
`schema/config.schema.json`, `templates/`.
