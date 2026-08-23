## Context

See proposal.md — Why. The relevant constraints, all in `moa-core/mcp/server.mjs`:

- `mergeConfigLayers:319` is the only place layers combine, and it has exactly two call sites:
  `opLoad:1069` (runtime) and `opInit:2321` (validating what `/moa project` is about to write).
- `models` already merges by union (`:323-324`); only `roles` intersects. The two branches sit four
  lines apart.
- Layer schemas: `zGlobalRole:144` is `zRole.pick({ use, differentModelFrom, effort })` — no
  `instructions`. `zProjectRole:154` is the full `zRole` with `use` made optional. Both role maps
  reject `{}` via a `.refine` that demands at least one key.
- `crossCheck:273` runs on the *merged* config, so any dangling `differentModelFrom` or pipeline role
  reference surfaces as a load error rather than a runtime surprise.
- Consumers read the merged map only: `roleGraph`/`opResolve:1161` and `opRunStart:1671`.

## Goals / Non-Goals

**Goals:**
- One merge rule for both named collections, so `roles` and `models` are no longer special-cased
  relative to each other.
- Delete the `absent → erase` branch rather than compensate for it with a better error message.

**Non-Goals:**
- Touching `opInit`'s generation path. All five templates declare `roles:`, so the generated overlay
  never trips this; changing generation would be unrelated churn.
- Rewriting `crossCheck`'s "unknown role" message. Under the union rule the message stops firing for
  the case that motivated this change, and it remains correct for a genuine typo.

## Decisions

### D1: Union role keys (option B) over inherit-only-when-absent (option A)

Both fix the reported symptom. B was chosen because A leaves two of the three failure modes alive.

Three distinct breakages come from the same intersection:

| overlay | today | under A | under B |
|---|---|---|---|
| omits `roles` | zero roles | inherits all | inherits all |
| declares a subset | global-only roles vanish | still vanish | retained |
| declares a role whose inherited `differentModelFrom` targets an undeclared role | load error | still errors | loads |

The third is the deciding one, and it is a correctness argument rather than an ergonomic one: the
overlay inherits a constraint without its target, so the author must hand-maintain the transitive
closure of `differentModelFrom`. That constraint exists to enforce anti-self-certification — a layering
rule that can quietly dismantle it is the wrong rule. Verified against current `main`; the repro is in
proposal.md.

The counter-argument for keeping intersection was palette isolation: a project pipeline should not be
able to reach a global role it never named. That does not survive scrutiny here. Ad-hoc steps are
already validated against the resolved role set (`opRunStart:1638-1640`), and `opLoad` returns the final
role list to the master, so a wider palette is visible rather than smuggled in. Meanwhile `SKILL.md`
describes the project layer as "pipelines, role instructions, overrides; project wins" — overlay
semantics. An overlay that erases what it does not mention is not an overlay.

B is also the smaller diff: the `if/else` and the `delete` both go, replaced by a spread plus a loop,
leaving `roles` and `models` visibly parallel.

### D2: Do not extend `zGlobalRole` with `instructions` in this change

Under B, a role inherited from the global layer arrives with `instructions: null`
(`opRunStart:1671`), because `zGlobalRole` cannot express them. In adaptive mode the master can
therefore staff an inherited role with a model but no guidance.

Deferred rather than folded in, for two reasons: a role without `instructions` is already legal today
(`zRole.instructions` is optional), so this introduces no new state; and allowing global instructions
widens the global layer from "staffing" to "staffing plus policy", which is a separate decision about
what belongs at machine level. Worth revisiting once someone actually wants a machine-wide role
instruction — not before.

### D3: No syntax for narrowing the palette

Intersection gave projects an implicit way to shrink the role set; union removes it. No template,
fixture, or reported use case wants that. If it is ever needed, `roles: { designer: null }` as an
explicit tombstone is the obvious extension and costs nothing to add later.

### D4: Fix the schema description, not just the code

`moa-core/schema/config.schema.json` is the authoring surface and currently says nothing about layers
at all — the merge semantics live only in a commit message and a test name. That gap is why the
behavior read as a bug rather than a documented rule. The union rule needs one sentence each on
`roles` and `models`.

## Risks / Trade-offs

- **An existing hand-written overlay relied on narrowing the palette** → It would now see a wider role
  set. Nothing in this repo does, and the widened set is inert unless a pipeline or ad-hoc step names
  the extra role. Accepted.
- **A global role name collides with a project role name the author believed was new** → Fields merge
  instead of the project definition standing alone, so an inherited `differentModelFrom` or `effort`
  can appear unbidden. This is already true today for any role the overlay declares; union does not
  change per-key behavior, only which keys are present.
- **Adaptive master staffs an inherited role with no instructions** → See D2. Visible in `moa_load`'s
  returned role list; not silent.
- **The inverted test looks like a regression to a future reader** → The rewritten case is named for
  the new rule and the change is referenced from `design.md`, so the intent is recoverable.

## Migration Plan

No data or config migration. The change is backward-compatible for every overlay that declares the full
role set it uses — which includes all five shipped templates and everything `/moa init --scope project`
generates. Rollback is reverting the merge function; no persisted state depends on the old semantics.
