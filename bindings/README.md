# `bindings/` — the parked enforced-spawn (permissions) system

This folder archives moa's **original binding model**: a runtime *adapter* that implemented an
enforced, graded `spawn()` contract with least-privilege tool policies. It is **kept, not
deleted, and currently unused.** moa's active binding model is the lightweight *learned tool
profile* — see [`../moa-core/references/learn-tool.md`](../moa-core/references/learn-tool.md).

Nothing in `moa-core/` references this folder at runtime. It is documentation: the spec and a
worked example to re-implement enforcement from, once the lightweight path has proven itself.

## Why it was parked

The design is sound; the *first mile* and the *cost* were the problem.

1. **It required authoring a security-sensitive plugin per CLI.** A binding was a ~300-line
   adapter implementing six methods (`serves`, `validate-policy`, `spawn`, `parse-result`,
   `cancel`, `cleanup`) against a CLI's exact flags, plus a conformance test proving it really
   restricts tools. That is plugin development, not onboarding — a wall a normal user can't scale.
2. **It depended on a language runtime.** The reference adapter is Python. moa can't assume
   Python (or any one runtime) is installed on the user's machine, so an adapter-process model
   makes the *common* case fragile to serve the *strict* case.
3. **The enforcement it bought isn't earning its keep yet.** Graded, fail-closed tool-policy
   enforcement (argv-allowlisted bash, off-network sandboxes, undeclared-write rejection) is
   valuable for CI/release, but most real use is interactive and host-native, where the heavy
   permissions layer mostly added friction and dead config.

## What it does (so it can be rebuilt)

The whole system rests on one primitive the core depended on, and never on a CLI:

```
spawn(SpawnRequest) -> SpawnResult
```

- **A binding** is the only place a concrete command/flag is allowed to appear. Two
  realizations: *native* (the host's own restricted-subagent capability) and *shell* (an
  adapter subprocess that shells out, passing prompt/attachments by temp-file or stdin, never
  interpolated, with argv-level tool restriction).
- **Enforcement is graded and fail-closed.** Each binding answers honestly, per role, whether it
  can enforce the requested tool policy: `strict` · `sandbox` · `best_effort` · `unsupported`.
  If no binding can meet the role's floor (`runtime.requireEnforcement`), `spawn` returns
  `policy_unsupported` and the run halts — it never silently downgrades security.
- **Routing is constraint-first:** filter bindings by `serves(model)` ∧ can-enforce-the-policy ∧
  `enforcementGrade ≥ floor` ∧ sandbox satisfiable ∧ (for verifiers) family independence; then
  prefer explicit pin → host-native → declared priority.

The full spec is in [`adapter-contract.md`](adapter-contract.md); a complete worked
implementation (against one illustrative CLI) is in [`reference-adapter/`](reference-adapter/).

### Config surface that belongs to this system (parked, still in the schema)

These `.moa.yml` keys exist for enforcement and are inert while the system is parked. They are
left in `schema/config.schema.json` so old configs validate and re-implementation is a
re-wiring, not a schema migration:

- `runtime.requireEnforcement` — the fail-closed enforcement floor.
- `toolPolicies` — named least-privilege bundles (`allow`/`deny`/`network`/`filesystem`/
  `bash.argv_allowlist`/`secrets`).
- `roles.<r>.tools` — a role's tool-policy reference.

(`runtime.defaults.allowInlineWithoutGates` is **not** parked — it gates *verification*, not
permissions, and is still honored. Likewise `roles.<r>.binding` stays active as a binding pin.)

> Note: `master.hardVerificationTags`, `differentModelFrom`, and `independenceGroup`/`family`
> are **not** part of this parked system. They serve *verifier independence* (anti-self-
> certification), which is still fully active. Don't archive those.

## Re-implementing on top of profiles

The clean re-entry point is **not** to revive the adapter-process model — it's to grow the
learned tool profile (`learn-tool.md`) into an enforcing one:

1. Add a `toolRestriction` section to the profile descriptor (what the CLI *can* restrict —
   discovered during the learn-tool probe, which already *observes* this and records it as a
   capability note).
2. Have the master translate a role's `toolPolicy` to that CLI's restriction flags at spawn
   time, and **grade honestly** what it can and can't enforce — the same `strict`/`sandbox`/
   `best_effort`/`unsupported` ladder.
3. Re-introduce the fail-closed floor (`requireEnforcement`) and the
   `policy_unsupported`/`blocked_policy` terminal states in the master's pipeline.
4. Keep the **conformance test** idea: a profile claiming `strict` must *prove* it (restriction
   applied, prompt not shell-interpolated, undeclared writes rejected) before it's trusted.

That way enforcement comes back as *data on the profile the master already learns*, with no
per-CLI Python plugin and no runtime dependency — the best of both models.
