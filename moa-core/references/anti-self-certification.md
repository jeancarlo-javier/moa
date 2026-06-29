# Anti-self-certification protocol

The master is the conductor, **deliberately not the strongest model**. Therefore it may
route and synthesize verdicts, but it may **never be the final word on the correctness of
hard work**. This is the skill's top safety invariant (`master.selfCertification: forbidden`).

## The rule

- Every phase result carries `verdict` + `verifiedBy` + `confidence`.
- The master MAY accept low-stakes, non-mutating results on its own judgment.
- Any phase with `gate: standard` or `gate: critical` REQUIRES an independent verification
  before it can pass. The master may **reject** a gate result, but it may **never replace a
  required gate with its own "looks good."**

## "Independent" is enforced, not hoped

Discovery returns normalized metadata per model: `{ provider, modelFamily, modelId,
capabilityTier, independenceGroup }`. A verifier of a producer's work must have a
**different `independenceGroup`** than that producer — two aliases of the same underlying
model cannot pose as independent verification. A `gate: critical` verifier must **also** carry
every tag in `master.hardVerificationTags` (default `[strong]`); `gate: standard` needs only a
different family.

**The producer is derived, never guessed: the nearest preceding `gate: none`, non-`master`
phase** — the phase whose artifact the gate reviews (under `fanout`, all workers of that phase's
role, one family). Independence holds when the verifier's family differs from the producer's. A
role's `differentModelFrom` is an **explicit cross-check** of this target: the loader **warns
(errors under `strict`)** when it names a role whose family disagrees with the inferred producer.
Inference is primary; a disagreeing `differentModelFrom` is a config bug to surface.

Under `master.mode: auto` the master may right-size that producing phase and author the mutation
itself; then **the master is the actual producer**, independence is measured against the
*master's* family, and it must hand the check to a separate verifier — grading its own output is
self-certification wearing a verifier's hat.

## The grade ladder — degrade, but never silently

When the target (cross-family) verifier isn't reachable, independence **degrades by grade**, and
moa always names the grade reached:

> **cross-family** (verifier family ≠ producer — the target) → **same-family** (a fresh-context
> native subagent, no producer bias; labeled *"same-family — not cross-family independent"*) →
> **self-check** (no spawn; labeled *"unverified — single-agent"*).

A fresh-context subagent is never the producer, so **same-family native verification is not
self-certification** — it is a weaker but honest independent grade. Only the bottom rung — the
producer grading its own work — is self-certification.

The spawn source is set by **`runtime.subagents`** (`auto` | `native` | `external` | `blocked`,
default `auto`); `blocked` empties the spawn set, forcing self-check. **`master.mode` sets how far
the grade may fall:** `auto` (and adaptive mode) degrades gracefully — same-family native, labeled,
never blocking while a subagent is spawnable; **`strict`** holds the hard floor — a `gate:
critical` phase with **no cross-family** verifier halts at **`verification_unavailable`**
("unverifiable here — pin a remote strong model, connect a tool, or override"). moa uses the best
rung the policy and host allow, and offers to connect a tool to climb. See
`references/adaptive.md`.

## Match the verifier to the failure mode

`strong` is the default verifier tag because most gates check **correctness**, where capability
helps. But a gate checking **constraint/format adherence** — strict output shape, length or schema
limits, a required template — wants a *literal, instruction-following* verifier, and there a smaller
cheaper model often **beats** a strong one (strong models add reasoning and verbosity that itself
breaks strict formats). So a critical **correctness** gate keeps `strong` + cross-family; a
**constraint-adherence** gate prefers the strictest-following independent model over the most
capable — different-family independence still holds either way.

## The mutation gate floor

Right-sizing lets trivial, **non-mutating** tasks answer inline. But **any repo mutation**
must pass a **`gate: critical`** verification, at the best grade the ladder allows. The only
exception: `runtime.defaults.allowInlineWithoutGates: true` AND a non-critical task — and even
then the output is labeled **"unverified inline mode"** so no one mistakes it for verified work.

## On disagreement

If the verifier and a reviewer disagree, an independent **arbiter** (another model with a
third `independenceGroup`, strong-tagged) breaks the tie. If no arbiter is available, the run
halts at `blocked_verifier_disagreement` with both positions and the deciding evidence
recorded in the run store. The master never casts the deciding vote itself.
