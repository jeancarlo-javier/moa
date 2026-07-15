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
capabilityTier, independenceGroup }`. **`independenceGroup` identifies the underlying MODEL,
collapsing provider aliases** — two routes to one model cannot pose as independent verification.
Independence keys on the **model, never the family**: a verifier must have a **different
`independenceGroup`** than the producer — Opus checking Sonnet's work is independent; Sonnet
checking Sonnet's (any provider, any fresh context) is not. Family is a **preference, not the
test**: same-family models share training lineage and blind spots, so `auto` picks a cross-family
verifier whenever one exists and the grade names what it got. A `gate: critical` verifier must
**also** carry every tag in `master.hardVerificationTags` (default `[strong]`).

**The producer is derived, never guessed: the nearest preceding `gate: none`, non-`master`
phase** — the phase whose artifact the gate reviews (under `fanout`, all workers of that phase's
role, one model). Independence holds when the verifier's model differs from the producer's. A
role's `differentModelFrom` is an **explicit cross-check** of this target: the loader **warns
(errors under `strict`)** when it names a role whose model matches the inferred producer.
Inference is primary; a disagreeing `differentModelFrom` is a config bug to surface.

Under `master.mode: auto` the master may right-size that producing phase and author the mutation
itself; then **the master is the actual producer**, independence is measured against the
*master's* model, and it must hand the check to a separate verifier — grading its own output is
self-certification wearing a verifier's hat.

## The grade ladder — degrade, but never silently

When the target (cross-family) verifier isn't reachable, independence **degrades by grade**, and
moa always names the grade reached:

> **cross-family** (different model, different family — the target) → **cross-model** (different
> model, same family; labeled *"cross-model — same family"*) → **self-check** (no different model
> spawnable; best effort — a fresh-context same-model pass helps but stays this rung — labeled
> *"unverified — no independent model"*).

The top two rungs are both real independent verification — the model differs. Only the bottom
rung fails the test: the producer's own model grading the producer's work — fresh context or not,
any provider alias — is self-certification, and it never passes a gate.

The spawn source is set by **`runtime.subagents`** (`auto` | `native` | `external` | `blocked`,
default `auto`); `blocked` empties the spawn set, forcing self-check. **`master.mode` sets how far
the grade may fall:** `auto` (and adaptive mode) degrades gracefully — labeled, never blocking
while a different-model subagent is spawnable; **`strict`** holds the hard floor — a `gate:
critical` phase with **no different-model** verifier halts at **`verification_unavailable`**
("unverifiable here — pin a remote strong model, connect a tool, or override"). moa uses the best
rung the policy and host allow, and offers to connect a tool to climb. See
`references/adaptive.md`.

## Match the verifier to the failure mode

`strong` is the default verifier tag because most gates check **correctness**, where capability
helps. But a gate checking **constraint/format adherence** — strict output shape, length or schema
limits, a required template — wants a *literal, instruction-following* verifier, and there a smaller
cheaper model often **beats** a strong one (strong models add reasoning and verbosity that itself
breaks strict formats). So a critical **correctness** gate keeps `strong` (cross-family
preferred); a **constraint-adherence** gate prefers the strictest-following independent model over
the most capable — different-model independence still holds either way.

## The mutation gate floor

Right-sizing lets trivial, **non-mutating** tasks answer inline. But **any repo mutation**
must pass a **`gate: critical`** verification, at the best grade the ladder allows. There is no
opt-out: a run whose mutations are not covered by a passed critical gate finishes as
`done_unverified`, labeled **"unverified — the repo was mutated with no passed critical gate
covering the last change"** so no one mistakes it for verified work.

Coverage is **ordered**: a gate vouches only for what existed when it ran, so the gate must
follow the last write. A pipeline that writes *after* its critical gate is not verified — that
write passed no gate — and finishes `done_unverified` no matter how many gates ran earlier.

## On disagreement

If the verifier and a reviewer disagree, an independent **arbiter** (a third model —
`independenceGroup` differing from both, a third family preferred, strong-tagged) breaks the tie. If no arbiter is available, the run
halts at `blocked_verifier_disagreement` with both positions and the deciding evidence
recorded in the run store. The master never casts the deciding vote itself.
