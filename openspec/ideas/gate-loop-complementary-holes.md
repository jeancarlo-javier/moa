# Gate Loops Produce Complementary-Hole Cycles

`idea` · 2026-08-27

## Problem

Observed while gating `fix-effort-ladder-rung-key` through six rounds. Every round returned
exactly one BLOCKER, and each was the **mirror of the previous round's fix**:

```
r1  per-gate max()              -> does not accumulate across gates
r2  shared counter key          -> backfill loses the cross-gate history
r3  sum over distinct keys      -> non-gate steps only; freezes every verifier
r4  + gates that declare a target -> freezes gates that declare none
r5  one effortSource + post-condition -> constrains the reader, not the writer
r6  + credit invariant          -> (applied, unverified)
```

Rounds 1-4 each added a branch keyed on **who is asking** (is this a gate?) when the defect was a
property of **the answer**. A verdict of REVISE with a list of findings drives the producer to
patch the named branch, and the next round finds the complementary one. The loop is doing
depth-first symptom repair and neither the gate nor the producer can see that from inside it.

Two things broke the cycle, and neither is more rounds:

1. **Changing the question.** Round 5 asked for an *enumeration* — step kind × `loopBackTo` shape ×
   gates per phase × ladder length, every row marked PRESERVED / INTENTIONALLY-CHANGED /
   REGRESSION — instead of "find defects". It returned the shape of the cycle and a falsifiable
   termination criterion, not another instance.
2. **Changing the reviewer.** A finding one reviewer marked RESOLVED on the producer's assertion
   was found still open by a different reviewer that went and read the evidence.

## Idea

A gate whose rounds keep producing all-new findings in the same area is a signal the loop is
symptom-scoped. Rather than counting rounds toward `maxGateLoops`, moa could name that pattern and
change what it asks for: a coverage/enumeration pass over the space the findings live in, or a
verifier from a different model, or both.

## Open questions

- What detects the pattern? "All-new findings, N rounds running, same phase" needs findings to have
  identity — see [[gate-findings-ledger]].
- Is this a new phase kind (an enumeration gate), a different prompt for the same gate, or purely
  guidance in the skill? A new mechanism from one incident is the objection a prior review already
  raised against escalation proposals.
- Related: [[max-loops-exit-paths]] — the cap fires on exactly this pattern, and its exits are the
  ones that hand the work back unverified.
- Counter-evidence to hold: n=1. The design gate in run `run-20260827-152217-4e77` converged in
  three rounds without any of this.
