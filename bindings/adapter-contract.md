# Adapter contract — the `spawn` capability

> **PARKED — archived spec, not the active path.** This describes the original *enforced*
> binding: a runtime adapter implementing a graded, fail-closed `spawn()` with least-privilege
> tool policies. moa no longer wires this in. The active binding model is the lightweight
> *learned tool profile* (`moa-core/references/learn-tool.md`), where the master drives a CLI
> with its own shell. This document is kept as the spec to re-implement enforcement from. See
> [`README.md`](README.md).

The skill core depends on exactly one runtime primitive and never on a CLI:

```
spawn(SpawnRequest) -> SpawnResult
```

A **binding** is any implementation of the adapter contract below. Bindings live in
separate `moa-bindings-<host>` packages — the only place a concrete command,
flag, or CLI name is allowed to appear. The core loads the *active* bindings as data.

## Two realizations (both injected, neither named in the core)

- **Native.** The master IS the host agent, so it already holds its host's own
  "launch a restricted subagent" capability. The native binding wraps that capability.
  Eligible only when it can enforce the requested tool policy (else it reports a weaker
  `enforcementGrade`).
- **Shell.** An adapter plugin shells out to another runtime as a subprocess. It passes
  prompt and attachments via temp file or stdin — **never** shell-interpolated — and
  restricts tools at the argv level.

## Data types

```ts
SpawnRequest = {
  role: string,                 // for labeling/audit
  model: string,                // resolved concrete model id
  toolPolicy: ToolPolicy,       // canonical tool names; the binding translates them
  skills: string[],             // explicitly granted skills only
  systemPrompt: string,         // injected via a real slot, or prepended as a quoted block
  prompt: string,               // task; passed by temp-file/stdin
  attachments: string[],        // file paths; passed by manifest, not interpolated
  cwd: string,
  timeout: number,
  maxCost?: number
}

SpawnResult = {
  status: "ok" | "failed" | "timeout" | "policy_unsupported",
  resolvedModel: string, provider: string, modelFamily: string,
  enforcementGrade: "strict" | "sandbox" | "best_effort" | "unsupported",
  verdict?: "APPROVE" | "REVISE" | "BLOCKED" | "ERROR",   // for gate phases
  resultText: string, changedFiles: string[], usage: object, cost: number
}
```

## Methods every binding implements

```ts
serves() -> ModelMeta[]                         // { provider, modelFamily, modelId, capabilityTier, independenceGroup }
validatePolicy(role, toolPolicy) -> EnforcementGrade   // honest answer to "can I enforce this?"
spawn(SpawnRequest) -> SpawnResult              // argv only; prompt/attachments via temp-file/stdin
parseResult(raw) -> { verdict?, resultText, changedFiles[], usage, cost }
cancel(handle); cleanup(handle)                 // timeouts, partial runs, temp dirs
```

A binding that cannot honestly enforce a policy MUST report the lower grade — it must
never claim `strict` it can't deliver. The argv-allowlist bash policy, the off-network
sandbox, and secret scrubbing are part of "enforce"; a binding that can't do them reports
`sandbox`/`best_effort`/`unsupported` accordingly.

## Routing: constraint-first, preference-second

Given a role and its resolved model, the core picks a binding by:

1. **Filter** — keep bindings where ALL hold:
   - `serves(model)` is true,
   - `validatePolicy(role, role.toolPolicy) >= runtime.requireEnforcement`,
   - network/filesystem sandbox of the policy is satisfiable,
   - for a gate-phase role (gate: standard or critical): the candidate's `independenceGroup` differs from the
     producer it verifies.
2. **Rank** survivors — explicit `role.binding` > host-native > declared priority.
3. **Resolve** — exactly one survivor runs. **Zero** survivors → terminal
   `blocked_no_binding` (or `verification_unavailable` for the independence case) with a
   deterministic diagnostic. **Tie** that ranking can't break → diagnostic, never a silent pick.

This prevents two failure modes: failing closed when a valid strict route existed
elsewhere, and silently downgrading security to satisfy a preference.

## Adding a runtime

Create `moa-bindings-<host>/` implementing the five methods plus the
**conformance tests** (a binding must prove it actually restricts tools, blocks the network
when asked, and rejects undeclared writes). The skill core changes not at all.
