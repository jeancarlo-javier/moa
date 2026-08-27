## Purpose

Defines how a producing phase's reasoning effort escalates when gates return REVISE, so that each
retry is materially stronger than the attempt that just failed rather than a repeat of it.

## ADDED Requirements

### Requirement: Rework SHALL escalate a producing phase's effort, cumulatively across gates

Each time a gate returns REVISE and sends work back to a producing phase, the next description of
that phase SHALL report a higher effort rung than the previous description of it, until the role's
highest declared rung is reached. Escalation SHALL count every rework round driven into the phase,
regardless of which gate drove it.

#### Scenario: One gate rejects the same producer twice

- **WHEN** a gate returns REVISE twice against a producing phase whose role declares three rungs
- **THEN** the returned next step reports the second rung after the first REVISE and the third rung
  after the second

#### Scenario: Two different gates each reject the same producer once

- **WHEN** one gate returns REVISE against a producing phase, that gate then approves, and a
  second gate afterwards returns REVISE against the same producing phase
- **THEN** the returned next step reports the third rung, because the phase has been reworked twice

#### Scenario: Producer declares a single rung

- **WHEN** a gate returns REVISE against a producing phase whose role declares one effort rung
- **THEN** that phase reports that rung on every round and the run proceeds normally

#### Scenario: Escalation stops at the highest declared rung

- **WHEN** rework rounds exceed the number of rungs the role declares
- **THEN** the phase reports the highest declared rung and the run proceeds normally

### Requirement: A producing phase's effort rung SHALL NOT decrease within a run

Once a producing phase has been described at a rung, no later description of that phase within the
same run SHALL report a lower one.

#### Scenario: A second gate loops back to an already-escalated producer

- **WHEN** a producing phase has escalated through repeated REVISE from one gate, and a different
  gate then returns REVISE against it for the first time
- **THEN** the reported rung is at least the rung already reached

### Requirement: A phase that declares an effort source SHALL inherit that source's rework pressure

Any phase may declare another phase as its effort source. Rework rounds driven into the work that
source stands for SHALL raise the declaring phase's rung as though they had been driven into it
directly. Where the declared source is itself a gate, the source SHALL resolve to the phase that
gate guards, so that a declared source never names something no rework is ever credited to.

#### Scenario: Replanning raises the executing phase

- **WHEN** an executing phase declares a planning phase as its effort source, and a gate returns
  REVISE against that planning phase
- **THEN** the executing phase, when next described, reports a rung raised by that rework round

#### Scenario: A phase names itself as its effort source

- **WHEN** a producing phase declares itself as its own effort source, which the configuration
  accepts, and a gate returns REVISE against it
- **THEN** the reported rung rises by exactly one rung for that rework round, not two

#### Scenario: The declared effort source is a gate

- **WHEN** a phase declares a gate as its effort source, which the configuration accepts, and that
  gate returns REVISE against the work it guards
- **THEN** the declaring phase escalates on the next round, rather than staying at its lowest rung

#### Scenario: The declared effort source cannot receive rework

- **WHEN** a phase's declared effort source is one no rework can be credited to — absent from the
  run because it was skipped as provided, or a phase that produces nothing of its own
- **THEN** that phase still escalates on every rework round driven into it directly, and inherits
  nothing from that source

### Requirement: A gate phase's own effort SHALL escalate with the rework it has driven

A gate phase SHALL itself escalate as the work it guards is reworked, so a verifier examines a
repeatedly-rejected artifact at least as hard as it examined the first attempt. This SHALL hold
whether the gate declares its loop-back target or leaves it to be inferred.

#### Scenario: A gate rejects, then examines the rework

- **WHEN** a gate whose role declares more than one rung returns REVISE, and the run later returns
  to that gate
- **THEN** the gate is described at a higher rung than on its first round

#### Scenario: A gate that declares no loop-back target

- **WHEN** a gate declares no loop-back target, so its return phase is inferred, and it returns
  REVISE
- **THEN** it escalates on the next round exactly as a gate that declared its target would

### Requirement: Every accepted REVISE SHALL raise exactly one phase's rework

Whenever a gate's REVISE is accepted and the run returns to an earlier phase, that round SHALL
raise the rework of exactly one phase. No accepted round SHALL be credited to nothing, whatever
shape the loop-back chain takes.

#### Scenario: The loop-back chain ends somewhere no rework can be credited

- **WHEN** a gate's loop-back chain leads to a phase that produces nothing, to a cycle among gates,
  or to a phase skipped as provided, and that gate's REVISE is accepted
- **THEN** the round still raises a phase's rework, and the gate escalates on the next round rather
  than staying at its lowest rung

#### Scenario: The gate's own loop-back edge is one no REVISE can be accepted on

- **WHEN** a gate declares a loop-back target that is not among the run's surviving steps, so no
  REVISE at that gate can be accepted at all
- **THEN** nothing is credited, because no round occurred

### Requirement: Gate budget accounting SHALL be independent of effort escalation

The count that decides whether a gate has exhausted `maxGateLoops` SHALL be unaffected by effort
escalation, and SHALL remain a per-gate count.

#### Scenario: Two gates loop back to one producer without exhausting either

- **WHEN** two different gates each return REVISE once against the same producing phase, under a
  `maxGateLoops` of 2
- **THEN** neither gate is exhausted and the run continues, even though the producer has escalated
  two rungs
