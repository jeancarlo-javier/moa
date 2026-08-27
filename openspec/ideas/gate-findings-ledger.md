# Structured Gate Findings Ledger

`idea` · 2026-08-27

## Problem

A gate's findings survive only as free text: `moa_step_report` accepts `summary`, a "1-3 line
result summary" (`server.mjs:2563`), and the phase record stores exactly that (`server.mjs:1844`).
No findings/issues/blockers structure exists anywhere on a phase or run record.

Three consequences:

- `max_loops_exceeded` tells the human to "review the recorded findings in the run manifest"
  (`server.mjs:1946`), but the manifest holds prose, not findings.
- A scope decision — "these open findings belong to a different change; none block this one" — has
  nowhere to live. In run `run-20260827-152217-4e77` the master made exactly that call at the
  design gate and it existed only in its own reasoning.
- Nothing can reconcile round N's findings against round N-1's: the server cannot tell a repeat
  from a fresh defect, and neither can the next verifier (`describeStep` carries no history,
  `server.mjs:1587-1639`; the verifier prompt is caller-authored, `server.mjs:2500`).

## Idea

Immutable per-round finding records with server-assigned IDs, each carrying severity, claim,
locus, and disposition (open / resolved / deferred). A deferral records actor, reason, and target.

## Open questions

- Adversarial review (gpt-5.6-sol, 2026-08-27) ranked this **second**, after making
  `max_loops_exceeded` recoverable — see [[max-loops-exit-paths]]. Is that ordering right?
- The same review's guardrail: a master-authored deferral MUST NOT bypass a required gate. What
  enforces that?
- Prior-round findings must reach the producing **role**, not just the master, or the ledger only
  informs the conductor. What is the server-provided channel?
- Feed prior findings to the next *verifier* only for reconciliation, never for relative severity
  grading — a BLOCKER must stay absolute rather than weaken because an earlier defect was larger.
- Scope drag: `run-store.md:19` documents the phase record as
  `{phase, status, attempt, inputHash, producedArtifacts, changedFiles, lockOwner, retryPolicy}`
  while `server.mjs:1844` writes
  `{phase, role, verdict, summary, changedFiles, producerModel, producerFamily, observed,
  routeObservation, ts}`. Two fields overlap. Any change to this record must reconcile the doc.
