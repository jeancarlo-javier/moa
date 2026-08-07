# Anti-self-certification protocol

The master is the conductor, **deliberately not the strongest model**. Therefore it may
route and synthesize verdicts, but it may **never be the final word on the correctness of
hard work**. This is the skill's top safety invariant (`master.selfCertification: forbidden`).

## The rule

- Every phase result carries a `verdict`, and names the model that produced it
  (`producerModel`) — when it does not, moa reads the phase as the model it routed that role
  to. Naming it matters: it is what a gate's independence is judged against.
- The master MAY accept low-stakes, non-mutating results on its own judgment.
- Any phase with `gate: standard` or `gate: critical` REQUIRES an independent verification
  before it can pass. The master may **reject** a gate result, but it may **never replace a
  required gate with its own "looks good."**

## "Independent" is enforced, not hoped

Discovery returns normalized metadata per model: `{ provider, modelFamily, modelId,
capabilityTier, independenceGroup }`. **`independenceGroup` identifies the underlying MODEL,
collapsing provider aliases** — two routes to one model cannot pose as independent verification.
It collapses the `provider/` prefix and any `:effort` suffix, which covers the canonical
`vendor/model` ids moa asks for. It does **not** decode vendor-decorated ids: a deployment
string like `bedrock/us.anthropic.claude-sonnet-4-6-v1:0` will not collapse onto
`anthropic/claude-sonnet-4-6`, and the two would grade as independent though they are one model.
Correct collapsing needs an explicit alias table, not a prefix-stripping guess that could fuse
genuinely different models — until there is one, **give aliases of the same model the same
canonical id in `models:`** rather than trusting the grader to see through them.
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

Coverage also requires the gate to be **real**, and it is judged **per write, against the model
that wrote it** — not against the phase the gate nominally reviews, and not against the run as a
whole. A gate clears only the writes whose author it differs from: two writers therefore cannot
cover for each other (a gate independent of the *last* writer still cannot certify what it wrote
itself earlier), a loop-back whose rework names a different model does not launder the original
author's own APPROVE, and the master is never an independent verifier whatever model it runs.
Outside `strict` (which halts at `verification_unavailable`) the run still completes — `auto`
degrades rather than blocks — but it finishes `done_unverified`, labeled with the reason.

## What the floor rests on

moa enforces these rules over a mix of what it **observes** and what the master **reports**, and
the split is deliberate. **File mutations are observed**: when the project is a git repository,
the server photographs the working tree by content identity at phase entry and again at report
time, and the floor rests on the paths that actually changed rather than on the `changedFiles` a
phase declares. A phase can no longer claim an earlier phase's writes, nor omit its own. **The
producing model is declared.** Naming a `spawnId` on the report lets the server confirm which
route returned that phase's result, and a declaration contradicted by that route is recorded and
labeled — but a completed spawn proves a route answered, not that it authored the artifact, so
this **detects a false declaration without preventing one** and never changes a grade, a pass, or
a strict halt.

What remains outside the guarantee, named rather than implied: writes outside the repository,
writes to git-ignored paths and to paths marked `assume-unchanged` or `skip-worktree`, writes
outside the project directory in a monorepo, **any observation at all in a workspace moa cannot
or will not photograph — either because there is nothing to photograph (not a git repository, no
git binary, or a git command that fails or times out, all of which yield no snapshot at all), or
because moa took the photograph and refuses to stand behind it (a project directory that will not
resolve, a repository identity that cannot be read, a project directory retargeted
mid-observation, a project or git directory replaced at the same path mid-observation, more than
2000 dirty paths, a dirty path that cannot be identified — unreadable, or a dirty submodule — a
HEAD that cannot be read and cannot be confirmed unborn, a failed diff after HEAD moved, or a
project that resolves to a different repository between step entry and report). Those two
categories are complete over every refusal in the code, and all of them degrade to the declared
list by design**; and — a **third** category, the only one that neither refuses nor degrades —
**a write the photograph is taken over and still cannot see: an *ABA* swap — the project or git
directory replaced at the same path *after* the frame is pinned and put back *before* it is
re-validated. Both
endpoints then stat the same inode, the frame holds, and the phase is reported as an observed
`files: []`.** That case is deliberately **not guarded**: catching it needs every read bound to a
directory *handle* instead of re-resolved from a pathname (`openat` semantics), which Node does
not expose, and a guard built on pathnames strong enough to catch it also refuses on ordinary
operation — the same reason the `assume-unchanged` / `skip-worktree` case above, whose mechanism
is an in-place `$GIT_DIR/index` replacement, is named here rather than defended: pinning the index
inode would refuse on ordinary `git status`, which rewrites the index through an `index.lock`
rename. Both need an actor manipulating the filesystem *during* the observation. **So the
observation is evidence about a filesystem no one is racing; it is not proof against concurrent
filesystem manipulation, and a phase that reports zero mutations is only as trustworthy as the
directory it was photographed through.** Also outside the guarantee:
attribution of a write to one worker among several sharing a
directory, and the verdict itself: moa never checks whether the work is *good*, only that the
gate looked at reality instead of at the producer's summary. The master is still instructed never
to author its own gate.

## On disagreement

If the verifier and a reviewer disagree, an independent **arbiter** (a third model —
`independenceGroup` differing from both, a third family preferred, strong-tagged) breaks the tie. If no arbiter is available, the run
halts at `blocked_verifier_disagreement` with both positions and the deciding evidence
recorded in the run store. The master never casts the deciding vote itself.
