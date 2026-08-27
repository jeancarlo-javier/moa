## Context

See `proposal.md` — Why. Two conflations produced every defect in this area.

`manifest.loops[phase]` serves two unrelated jobs: the per-gate budget count checked against
`maxGateLoops` (`server.mjs:1940`) and the effort rung index (`server.mjs:1604`).

And one edge is resolved by three different callers under three different rules. The REVISE
handler resolves `loopBackTo` to pick where control returns (`server.mjs:1934-1935`, declared, else
a backward scan for gates, else an error). `describeStep` resolves the same field to pick an effort
key (`server.mjs:1603`, declared-and-surviving, else the step's own phase). Reconstruction would
need a third. Wherever two of those disagree, a rung is wrong.

## Goals / Non-Goals

**Goals.** Separate budget accounting from effort escalation. Make escalation cumulative across
gates and monotonic. Resolve the effort edge through exactly one function, with a post-condition
strong enough that no topology falls through it.

**Non-Goals.** Changing `maxGateLoops` semantics, or where control returns on REVISE. Making
`max_loops_exceeded` recoverable (`openspec/ideas/max-loops-exit-paths.md`). Recording findings
(`openspec/ideas/gate-findings-ledger.md`).

## Decisions

**D1 — a separate per-phase rework counter.** Add `manifest.rework`, a phase → integer map,
incremented by one on every accepted REVISE, credited to the phase that gate's rework belongs to
(D2). `describeStep` derives the rung from `rework`, never from `loops`. `loops` keeps its single
remaining job: the per-gate budget check, untouched.

*Alternative — keep one counter, write it under the key the reader uses, and make the write
`max(existing, count)`.* Killed in review: each gate keeps its own count from zero, so a per-gate
maximum does not accumulate — `review-work` REVISE then `validate` REVISE leaves the producer at
rung 1 after two rejections.

*Alternative — narrow the contract to "the largest single gate's REVISE count".* Rejected: two
independent rejections would escalate no further than one, which is the under-escalation this
change exists to remove.

**D2 — one resolution function with a post-condition, used by every caller.**

    effortSource(manifest, step) MUST return a phase the REVISE handler can credit rework to —
    a surviving, non-gate, non-master step — or nothing.

Resolution: take `step.loopBackTo` when declared; while that names a gate, replace it with the
phase that gate guards, cycle-guarded by a seen-set over gate phases. When nothing is declared and
the step is a gate, take the phase the handler infers — the nearest preceding surviving non-gate,
non-master step.

Two outcomes look alike and must not be treated alike. **The handler also refuses** — a step
declares a source directly and that phase does not survive — and there `effortSource` returns
nothing, because no REVISE can be accepted on that edge at all (`server.mjs:1936` errors). **The
handler accepts but the chain dead-ends** — the followed chain ends at a master phase, at a cycle,
or at a phase skipped as `provided` — and there the handler still returns control and still counts
the round, so returning nothing would credit an accepted rework round to no one. In that case fall
back to the handler's own backward-scan inference.

The invariant behind both: **every REVISE the handler accepts is credited to exactly one phase.**
The post-condition constrains what that phase may be; this clause makes sure one always exists.

The rung is the sum of `rework` over the distinct keys `{step.phase, effortSource(step)}`, clamped
to the role's highest rung. The REVISE handler credits `rework[effortSource(gateStep)]`. Legacy
reconstruction resolves through the same function. Three callers, one answer.

*Why a post-condition and not another branch.* Four review rounds each found one defect that was
the mirror of the previous fix: the aliased case then the unaliased, non-gate steps then gates,
gates with a declared target then gates without. Each fix added a branch keyed on **who is asking**
— is this a gate? — when the defect is a property of **the answer**: any step whose effort key is a
phase nothing increments reads rung 0 forever. `rework` is only ever credited to producers, so a
key that is a gate phase, a master phase, or a skipped phase is dead. The post-condition rejects
all three at once.

A fifth round then showed the post-condition alone is still only half the rule: it bounds what the
*reader* may resolve to, while the *writer* accepts a strictly larger set of REVISE rounds. A gate
looping back to `frame` — a master phase in every shipped template — loads fine, is accepted by the
handler, and under a reader-only rule credits nothing, reading rung 0 forever where the old aliased
write delivered rung 2. Pairing the post-condition with the credit invariant closes it: an
enumeration over step kind × `loopBackTo` shape × gate count × ladder length, including
gate-to-master, gate-to-gate chains, mutual gate cycles, and skipped chain ends, has no row left
where an accepted round goes uncredited.

*Deduplication is load-bearing.* A step naming itself as its effort source is schema-valid — the
check is existence only (`server.mjs:305-307`) — and without distinct keys it counts one rework
round twice.

*Control flow is not credit.* Where control returns on REVISE is unchanged, including a gate that
loops back to another gate: the run really does re-enter that gate. Only the rework credit follows
the chain through to the producer. Separating them is the last of the three conflations.

*Gates escalate, and one behavior is genuinely new.* `describeStep` already applies a rung to every
roled step, gates included (`server.mjs:1598-1607`), and a gate reaches its count through whichever
phase the handler wrote. Under D2 it reads `rework[gate.phase] + rework[effortSource(gate)]`, which
is equal in the one-gate case. Where two gates loop back to one phase, a gate now escalates on
rework it did not itself drive; that is intended — the artifact in front of that verifier has been
reworked that many times — and is called out because it is a change, not a preservation. Exposure
is wide: **no** role in any shipped template or in this repo's `.moa.yml` declares `effort`, so
ladders come from the resolved model's list (`server.mjs:1253`). The two-rung reviewer used
throughout this change comes from the test fixture's model registry (`test.mjs:150`, consumed by
the effort-less `reviewer` at `test.mjs:155`), not from the templates.

**D3 — monotonicity is a property, not a guard.** `rework` only increments, `manifest.steps` is
never mutated after run start, so the distinct-key set is constant and a sum of increment-only
counters cannot fall. No `max()` is needed; the downgrade defect disappears with the conflation
that caused it.

**D4 — legacy manifests are rebuilt by replaying the recorded REVISE verdicts.** A manifest written
before this change has no `rework` map, and `loops` cannot supply one: it mixes per-gate counters
with a target alias that every REVISE overwrites, so after `review-work` REVISEs twice and
`validate` once it holds `loops["review-work"]=2`, `loops.validate=1`, `loops.execute=1` — the
target entry records the last gate to touch it, not the total.

Summing each gate's own counter into its `effortSource` was the first attempt and measurement
rejected it: exact for every gate whose counter was never aliased, but a gate that is itself
another gate's declared target has its counter clobbered, and reconstruction then under- or
over-counts — in one measured case *lowering* a rung across the upgrade, the exact failure D4
exists to prevent.

Replay instead. `manifest.phases` records every accepted report with its `verdict`
(`server.mjs:1844-1849`), so for each phase recorded `REVISE` **on a gate step** credit one round to
that gate's `effortSource`. The gate filter is load-bearing: `opStepReport` constrains `verdict`
only on gates (`server.mjs:1773-1774`) and records whatever it is given, so a non-gate phase
carrying a `REVISE` verdict — which the old code credited nowhere — would otherwise be replayed as
real rework. Gate-filtered replay is exact on every topology measured, including the gate-to-gate
case where the summed-counter approach under- and over-counted.

Compute it on load without writing. `loadRun` is called on read-only paths, and a migration that
writes on every status check is a surprise; the next accepted report persists it through the normal
`saveRun`.

## Risks / Trade-offs

- **Retries get slower and more expensive.** → The declared ladder finally working. Say so in the
  completion note so it is not read as a regression.
- **A new manifest field.** → Additive and rebuilt on load (D4); a pre-fix manifest still loads.
- **Additive inheritance can reach the top rung quickly** when a plan is reworked and then the
  executing phase is too. → Intended: both are real rework pressure on the same work. The clamp
  bounds it, and the clamp is also why a two-rung ladder hides several of these defects — tests
  need three rungs to see them.
- **Most runs see no change.** Unresolved effort defaults to `["auto"]` (`server.mjs:1253`), a
  single rung, where the defect is behaviorally inert.

## Migration Plan

Automatic, on manifest load, computed not written (D4). No schema or config contract changes,
though `config.schema.json:138`'s prose describing `loopBackTo` as selecting "whose **loop
counter** drives this step's effort rung" becomes false and is updated. Rollback is reverting the
commit: `loadRun`/`saveRun` round-trip the whole manifest (`server.mjs:1550-1561`), so a manifest
carrying `rework` still loads under the old code, which ignores it.
