## Why

One integer serves two unrelated jobs. `manifest.loops[phase]` is both the per-gate budget count
checked against `maxGateLoops` (`server.mjs:1940`) and the effort rung index (`server.mjs:1604`).
Compounding it, `loopBackTo` means the REVISE return edge on a gate step and the effort-inheritance
source on a non-gate step (`config.schema.json:138`, `server.mjs:1691`), and the REVISE handler
writes the counter under one key while `describeStep` reads it under the other.

Three defects follow, all reproduced against the shipped templates:

1. **Frozen at the lowest rung.** `validate` (critical) REVISEs → the handler writes
   `loops.execute` (`server.mjs:1938-1939`), but `describeStep(execute)` reads
   `loops[execute.loopBackTo="plan"]`, absent after a first-pass plan approval
   (`server.mjs:1603-1604`). Reproduced `low → low` on `engineering` and `quick`
   (`full-engineering.yml:66-72, 76-80`). `review-work` takes the same path.
2. **Downgrade.** The write is an assignment, not an accumulation, so two gates targeting one
   producer can *lower* an already-climbed rung: `review-work` REVISEs twice
   (`loops.execute=2`), approves, then `validate` REVISEs once and assigns `loops.execute=1`.
   Reproduced `high → medium`. Live in this repo's `.moa.yml:99-100, 110-111, 121-122`, which
   carries no alias defect.
3. **No accumulation across gates.** Each gate counts its own REVISEs from zero, so a producer
   rejected once by two different gates escalates only one rung — it has been reworked twice and
   retries barely harder than the attempt that just failed.

The effort ladder is the mechanism that makes a retry stronger than the attempt that failed. It is
inert or wrong on every path where more than one gate guards a producer.

All 193 existing checks pass: the ladder tests target `plan`, which carries no alias
(`test.mjs:1380-1404`); the surviving-target test only exercises `review-plan → plan`
(`test.mjs:4734-4744`); the main fixture's coder declares no ladder (`test.mjs:153-163`).

## What Changes

- Add `manifest.rework`, a phase → integer map incremented on every accepted REVISE that sends
  work back to that phase. Effort rungs derive from it; `loops` keeps only the per-gate budget
  check, unchanged.
- Resolve the effort edge through one function with a post-condition: `effortSource` returns a
  phase the REVISE handler can credit rework to — a surviving, non-gate, non-master step — or
  nothing. A declared source that names a gate resolves through to the phase that gate guards; a
  declared source that does not survive resolves to nothing; a gate with nothing declared uses the
  handler's own inference. Where the handler ACCEPTS a REVISE but the chain dead-ends — at a master
  phase, a cycle, or a skipped phase — fall back to that inference rather than crediting nothing,
  so that every accepted round raises exactly one phase's rework. The rung is the sum of `rework`
  over the distinct keys
  `{step.phase, effortSource(step)}`, clamped to the role's highest rung, for **every** roled step
  including gates. The REVISE handler credits through the same function. Every defect here came
  from callers resolving one edge under different rules; the post-condition is what makes the
  topology space close. Monotonicity follows from increment-only counters; no guard is needed.
- Leave control flow alone: where a REVISE returns is unchanged, including a gate that loops back
  to another gate. Only the rework credit follows the chain to the producer.
- Replace the REVISE handler's target-phase write to `loops` with the `rework` increment. Only
  `loops[gatePhase]` and its `maxGateLoops` check remain, so a gate that loops back to another
  gate can no longer overwrite that gate's budget count.
- Rebuild `rework` on load for manifests written before this change by replaying the recorded
  REVISE verdicts on gate steps in `manifest.phases` — exact by construction, and unlike summing the gate
  counters it needs no special case for a gate that is another gate's target, where the counter has
  been clobbered and reconstruction measurably lowers a rung. Compute it without writing, so a
  read-only call does not trigger a migration write.
- Update the `loopBackTo` prose in `config.schema.json:138`, which says the field "only
  selects whose **loop counter** drives this step's effort rung". After this change no loop counter
  feeds effort at all. The JSON contract is unchanged; its prose is not.
- Five regression tests that fail today: cross-gate accumulation, no-downgrade (on the
  no-`loopBackTo` topology), the aliased critical-gate freeze, a gate-to-gate budget collision, and
  a legacy two-gate manifest reconstructed to its true cumulative rung. Plus three guards that pass
  today and must keep passing: a self-source step counted once, and a gate's own effort escalating
  as it drives rework — with a declared target and with an inferred one. Ladders in these tests
  need three rungs; a two-rung ladder's clamp hides the downgrade.

**Not in scope.** This does not explain the non-convergence observed in run
`run-20260827-152217-4e77`. That run's reworked phases were `design-options` (role
`design-consult`) and `author-change` (role `planner`); every role in it resolves a **single-rung**
ladder, so `Math.min(count, effort.length - 1)` is pinned at rung 0 regardless of this defect —
the inert case named below. Effort is also not the
only way a retry can differ — the caller authors each spawn prompt (`server.mjs:2094-2114`). Nor
does every critical gate carry the alias defect: `research-synth.yml:48` declares no `loopBackTo`,
so its fallback already reads the counter the handler writes — that step is unaffected by the
defect and must stay unaffected by the fix, which is why `effortSource` mirrors the handler's
inference rather than keying on the gate's own phase. `maxGateLoops`
semantics, the terminal `max_loops_exceeded` state, and the absence of a structured findings
record are untouched and captured as ideas.

## Capabilities

### New Capabilities
- `effort-escalation`: how a producing phase's effort rung is derived from rework rounds — that it
  accumulates across gates, never decreases, inherits through a declared effort source, and is
  independent of gate budget accounting.

### Modified Capabilities
<!-- none -->

## Impact

- `moa-core/mcp/server.mjs` — new `rework` map, rung derivation at ~1603, increment replacing the
  target write at ~1939, rebuild in `loadRun` (~1550), and one shared
  `effortSource` used by all three.
- `moa-core/mcp/test.mjs` — five regression tests and three guards, reusing the existing multi-rung fixture at
  `test.mjs:4406-4409`.
- **Behavioral:** producers with multi-rung ladders now escalate on every rework round, from any
  gate. Gate phases keep escalating as they do today — including `research-synth.yml:48`, the one
  shipped gate with no declared target — and additionally escalate when another gate has reworked
  the same phase, which is new behavior rather than preserved behavior.
- Exposure is wide: no role in any shipped template or in this repo's `.moa.yml` declares `effort`,
  so ladders come from the resolved model's list (`server.mjs:1253`). Retries get slower and more expensive — the declared ladder finally working, not a
  regression.
- **Manifest:** one additive field, backfilled on load. A pre-fix manifest loads unchanged;
  `loadRun`/`saveRun` round-trip the whole object (`server.mjs:1550-1561`), so a manifest carrying
  the new key also survives a rollback to the old code.
- Roles with a single rung, or unresolved effort defaulting to `["auto"]` (`server.mjs:1253`), are
  unaffected.
- Related open idea: `openspec/ideas/dynamic-role-effort.md` (per-candidate ladders) builds on this
  mechanism and should land after it.
