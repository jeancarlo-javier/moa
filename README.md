# moa — Master of Agents

> Multi-agent orchestration where **the model that wrote the code never gets to approve it.**

moa turns your AI coding agent into a **conductor**: it breaks work into roles
(plan → build → review → verify), routes each role to an appropriate model, and
drives a **gated pipeline** where every change is independently checked before
it is accepted. The core rule is simple and non-negotiable:

**No model certifies its own work.** Critical verification is delegated to an
independent model — preferably a *different model family* — so a model's blind
spots can't rubber-stamp its own output.

moa is **runtime-agnostic**. It names no CLI or vendor command; it speaks only
in roles and models, and resolves *how to actually run a subagent* from what
exists on **your** machine — host-native subagents (e.g. Claude Code) work out
of the box, and other CLIs can be taught via `learn-tool`.

## Why

LLM agents are confident self-graders. Ask the same model that wrote a function
whether it's correct, and it will usually say yes. moa removes self-certification
from the loop **by structure, not vibes**: a producer role writes; a separate
reviewer role (different family where possible) approves or sends it back; and a
critical verifier independently checks the done-criteria and runs your
verification commands before anything is called "done."

## Install

Via [skills.sh](https://skills.sh) — works with Claude Code, Cursor, Codex,
Gemini, and more:

```bash
npx skills add jeancarlo-javier/moa
```

(Manual: copy the `moa-core/` skill directory into your agent's skills folder.)

## Use

In your agent, just ask:

```
/moa add request-id propagation to the API client + a test
```

…or trigger it naturally — "moa", "orchestrate this", "run my workflow".

- `/moa` — orchestrate a task through the gated pipeline (adaptive if there's no config).
- `/moa init` — write a `.moa.yml` workflow config for the project.
- `/moa learn-tool` — connect another CLI as a runtime.

Skip it for one-liners; reach for it on features, refactors, migrations,
research, and any multi-file / multi-phase work.

## How it works

moa drives a gated pipeline and **never skips a gate**:

1. **Frame** — goal, constraints, non-goals, done-criteria.
2. **Plan** — a read-only planner emits a task graph: files, write-sets, edge
   cases, verification commands.
3. **Gate · review-plan** — an independent reviewer approves or loops (`REVISE`).
   No code before this.
4. **Execute** — coders implement, fanning out only on disjoint write-sets.
5. **Gate · review-work** — a read-only reviewer compares the diff to the plan.
6. **Validate (critical)** — an independent strong verifier checks the
   done-criteria and runs the commands, in isolation.
7. **Finalize** — synthesize verdicts and evidence; report what changed, what
   was verified, and residual risk.

Independence is enforced at the gates: the verifier must differ from the
producer (different model family preferred). Where the machine can't provide an
independent verifier, moa **degrades and labels** the result honestly rather
than pretending it was cross-checked.

## Status

Early and actively evolving. Expect rough edges — issues and feedback are very
welcome.

## License

MIT © 2026 Jeancarlo Javier
