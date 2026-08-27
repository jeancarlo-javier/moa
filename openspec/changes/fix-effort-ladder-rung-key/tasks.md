## 0. Test fixture

- [ ] 0.1 Build on the existing multi-rung fixture (`test.mjs:4406-4409`), but give the producing
      and reviewing roles **three** rungs. A two-rung ladder's clamp hides the downgrade — measured
      `low | high | high | high` where a three-rung ladder shows `c0 c1 c2 → c1`. Confirm no
      existing test asserts that fixture's ladder length before widening it; add a variant if one
      does.
- [ ] 0.2 Note that this fixture's `execute` carries `loopBackTo: plan`; tests 1.3 and 1.5 need a
      topology without it (this repo's `.moa.yml:98, 109, 120` shape).

## 1. Regression tests — must FAIL against unmodified `server.mjs`

- [ ] 1.1 Cross-gate accumulation: `review-work` REVISEs once against `execute`, approves, then
      `validate` REVISEs once. Assert `execute` two rungs above its start. Today: never more than
      one rung, and zero on the aliased topology.
- [ ] 1.2 No downgrade, three-rung ladder, no-`loopBackTo` topology: `review-work` REVISEs twice,
      approves, then `validate` REVISEs once. Today `c0 c1 c2 → c1`.
- [ ] 1.3 Aliased critical-gate freeze: reference pipeline, no `provided`, approve `plan`,
      `review-plan`, `review-work`, then `REVISE` from `validate`. Assert `next.phase === "execute"`
      and an escalated rung. Today `execute` stays at rung 0 with `loops = {validate: 1,
      execute: 1}`.
- [ ] 1.4 Gate-to-gate budget collision: a gate whose `loopBackTo` names another gate. Assert the
      target gate's budget count is never lowered. Today `{review-work: 2, execute: 2}` →
      `{review-work: 1, execute: 2, validate: 1}`, resetting it below its accrued total and
      indefinitely deferring `max_loops_exceeded`.
- [ ] 1.5 Legacy manifest rebuild: a pre-fix manifest with recorded REVISE verdicts for
      `review-work ×2` and `validate ×1`. After load, assert `execute` at the rung for three rework
      rounds. Fails today by construction — no `rework` map exists.
- [ ] 1.5a Legacy replay must not credit non-gate REVISE records: a pre-fix manifest where a
      non-gate phase carries `verdict: "REVISE"`. Assert the rebuild credits it nothing.
- [ ] 1.6 Legacy gate-to-gate manifest: the topology where a gate is another gate's declared
      target, so `loops` holds a clobbered counter. Assert the replayed rebuild matches the true
      cumulative count and never lowers a rung across the upgrade. Summing the gate counters
      measurably fails this both ways (`c2 → c1` in one case, `c1 → c3` in another).
- [ ] 1.7 Record the observed wrong value for each of 1.1-1.6 before writing the fix. A test that
      passes beforehand is not a regression test.

## 2. Guards — pass today and must keep passing

- [ ] 2.1 Self-source: a step naming itself as its effort source is schema-valid
      (`server.mjs:305-307`). One REVISE raises it exactly one rung.
- [ ] 2.2 Gate escalation, declared target: `review-plan` rises a rung after its own REVISE. No
      existing test asserts any gate's effort — all assertions sit on `plan`/`execute`
      (`test.mjs:1383, 1389, 1399, 1404, 4724, 4731, 4738, 4744`) — so the suite would stay green
      while this regressed.
- [ ] 2.3 Gate escalation, inferred target: a gate declaring **no** `loopBackTo` escalates on its
      second round. The `research-synth.yml:48` shape — the only shipped gate of that kind, and it
      is `critical`.
- [ ] 2.4 Gate-valued source, producer side: a producer whose declared `loopBackTo` names a gate
      keeps escalating. Today it reads the gate's aliased counter and reaches rung 2; a rule that
      keys on the gate's own phase freezes it at 0 forever.
- [ ] 2.5 Gate-valued source, gate side: a `critical` gate whose declared `loopBackTo` names
      another gate is described at the rung the reworked artifact has earned, not at 0.
- [ ] 2.6 Declared-but-skipped source: a step whose declared source was skipped as `provided`
      inherits nothing and escalates only on its own rework — the reader must not credit rework
      through an edge the REVISE handler refuses (`server.mjs:1936` errors on that edge).
- [ ] 2.7 Gate looping back to a **master** phase — loadable, and `frame` is a master step in every
      shipped template. Today `c0 → c1 → c2`; assert it still climbs.
- [ ] 2.8 Mutual gate cycle (`g1 → g2`, `g2 → g1`) — loadable. Today both climb; assert they still
      do, and that resolution terminates.
- [ ] 2.9 Gate-to-gate chain whose end was skipped as `provided`. Today both gates climb; assert
      they still do.
- [ ] 2.10 Producer whose declared source is a gate that loops back to a master phase. Today it
      escalates; assert it still does.
- [ ] 2.11 Producer whose declared source survives but is a **master** phase: today frozen at rung
      0, and it should escalate on its own rework only. Record which behavior the fix produces and
      confirm it matches `spec.md`'s "cannot receive rework" scenario.

## 3. Fix

- [ ] 3.1 Add `manifest.rework` (phase → integer) at run creation (`server.mjs:1737-1744`).
- [ ] 3.2 Add one shared `effortSource(manifest, step)` satisfying the post-condition: it returns a
      surviving, non-gate, non-master step, or nothing. Declared source, followed through any gate
      to the phase that gate guards, cycle-guarded by a seen-set over gate phases; the handler's
      backward-scan inference when a gate declares none.
- [ ] 3.2a Distinguish the two dead ends. Return nothing **only** when a step's source is declared
      directly and does not survive — the one edge the handler itself refuses
      (`server.mjs:1936` errors, so no round can occur). When the handler would ACCEPT the REVISE
      but the followed chain dead-ends — at a master phase, at a cycle, or at a phase skipped as
      `provided` — fall back to the handler's backward-scan inference instead of returning nothing.
      The invariant: every REVISE the handler accepts is credited to exactly one phase. Measured
      today, a gate looping back to `frame` climbs `c0 → c1 → c2`; a reader-only rule leaves it at
      `c0` forever.
- [ ] 3.3 In the REVISE handler (`server.mjs:1932-1956`), keep `loops[gatePhase]++`, its
      `maxGateLoops` check, and the control-flow target **unchanged**, and replace the target write
      to `loops` with `rework[effortSource(gateStep)]++`.
- [ ] 3.4 Derive the rung in `describeStep` (`server.mjs:1603-1604`) as the sum of `rework` over
      the distinct keys `{step.phase, effortSource(step)}`, clamped by the existing
      `Math.min(..., effort.length - 1)`, for every roled step including gates.
- [ ] 3.5 Rebuild in `loadRun` (`server.mjs:1550-1554`) when `rework` is absent: replay
      `manifest.phases ?? []`, crediting one round to `effortSource` of each phase recorded with
      verdict `REVISE` **on a gate step**. The gate filter is required, not cosmetic —
      `opStepReport` constrains `verdict` only on gates (`server.mjs:1773-1774`), so an unfiltered
      replay credits a non-gate phase carrying a `REVISE` verdict as real rework (measured
      `plan p0 → p1` where the truth is `p0`). Compute without writing — `loadRun` runs on
      read-only paths; the next accepted report persists it through `saveRun`.
- [ ] 3.6 Update the comments at `server.mjs:1599-1602` and `1691` to describe the separated
      counters and the single resolution function.
- [ ] 3.7 Update the `loopBackTo` prose at `config.schema.json:138` — it says the field "only
      selects whose **loop counter** drives this step's effort rung", and after this change no loop
      counter feeds effort. The JSON contract itself does not change.

## 4. Verify

- [ ] 4.1 Run the full `moa-core/mcp/test.mjs` suite. The 193 checks that pass today must still
      pass, plus the new ones. Report both counts.
- [ ] 4.2 Re-run the topology enumeration used in review — step kind × `loopBackTo` shape × gates
      per phase × ladder length — and confirm every row is PRESERVED or a documented
      INTENTIONALLY-CHANGED, with no REGRESSION.
- [ ] 4.3 Compare the serialized manifest key set before and after; the only addition must be
      `rework`. Do not use `git diff --stat` — `server.mjs` serializes the manifest, so a diff
      there proves nothing.
- [ ] 4.4 Confirm a read-only path over a legacy manifest performs no write.
- [ ] 4.5 Confirm rollback: a manifest carrying `rework` still loads and round-trips under the
      pre-fix code (`server.mjs:1550-1561`).
- [ ] 4.6 Note in the completion summary that retries after a gate REVISE now cost more, and that
      this is the declared ladder working rather than a regression.

## 5. Independent gate

- [ ] 5.1 Send the diff plus `specs/effort-escalation/spec.md` to a reviewer whose model family
      differs from whoever authored the fix. Do not self-certify.
