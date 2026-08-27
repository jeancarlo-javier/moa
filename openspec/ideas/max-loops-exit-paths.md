# Exit Paths from `max_loops_exceeded`

`idea` · 2026-08-27

## Problem

When a gate exceeds `maxGateLoops` the run becomes terminal (`server.mjs:1940-1942`) and every
later report or spawn is refused (`server.mjs:1768, 2097`). No operation anywhere returns a run to
`running`.

The terminal payload offers three doors: *change the plan · relax the criteria · take over*
(`server.mjs:1946`). It never names the fourth, which already exists: start a focused run that
gates only the remaining work, via ad-hoc `steps` or `provided`
(`server.mjs:1646-1648, 2544`; shipped 2026-08-24 as `skip-steps-when-provided`).

In run `run-20260827-152217-4e77` the master took the third door, fixed three blockers by hand and
finished them unverified — while the cheap fourth door was available and unmentioned. Note the
limit: `plan` is the only `skippable: true` step in all three shipped templates, so `provided` is
a real recovery path in adaptive mode and a narrow one in workflow mode.

## Idea

Two candidates, smallest first:

1. **Signpost.** Add the focused-rerun path to `nextHumanAction`. A string change plus, possibly,
   declaring more steps `skippable` in the templates.
2. **Bounded resume grant** (gpt-5.6-sol's ranked-first recommendation, 2026-08-27): pause instead
   of dying; persist `resumeTo`, an additional-loop allowance, the granting actor, and the reason.
   Resume at the producing phase, not the gate — the cap branch returns before assigning
   `current = ti` (`server.mjs:1949-1953`). Takeover must still require an independent gate.

## Open questions

- Is (1) sufficient? The adversarial review's own stated failure mode for (2) is human ratcheting:
  "pause becomes 'one more round' indefinitely, recreating unbounded spend."
- The round counter is a **budget** signal, not a convergence metric. Any resume grant must stay a
  bound, not become a negotiation.
- Manual edits made while paused blur authorship. A resumed run needs a fresh mutation snapshot.
- Does the master taking over need to be recorded as such? Related: [[gate-findings-ledger]].
