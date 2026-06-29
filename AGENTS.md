# AGENTS.md — working in the moa repo

moa is a runtime-agnostic orchestration **skill** (`moa-core/SKILL.md` + `references/`); the conductor
names no CLI, flag, or command — not in the skill, not in `.moa.yml`.

## One rule: token-lean, in two places

The skill loads into agentic harnesses (Claude Code, Codex, omp), so its tokens are the end user's
budget. Keep both small:

- **The skill's own text.** `SKILL.md` loads on *every* run — the most expensive real estate; add
  words there only when they change behavior. `references/*` and `templates/*` load on demand (a mode,
  an `init`) — lean too, just less hot. When improving the skill, **tighten existing lines before
  appending**; an edit that grows the prose has to earn it.
- **What the skill writes.** `.moa.yml` is re-read every run, so `init` writes only the models the
  roles use — registry = *union of per-role picks*, never the host's full ~50–70-model set. One
  primary per role + a trailing `auto`; prefer the latest in a line (Opus 4.8 > 4.7); reuse a model
  across roles before adding one.

## Docs: durable only

`docs/` is for durable documentation. One-off working docs — design specs, analyses, scratch —
go in `temp-docs/` (gitignored), never committed.

> Global context-mode routing rules inherited from the parent `CLAUDE.md` still apply.
