## Purpose

Defines how the machine-level staffing config and an optional project overlay combine into the one
effective config that role resolution and pipeline execution read, so an author can predict what a
given pair of files produces without reading the merge implementation.

## ADDED Requirements

### Requirement: Overlay absence means inheritance, not erasure

A project overlay SHALL only alter the sections it declares. Omitting a section MUST leave the global
layer's value for that section intact. Because the overlay schema rejects an empty `roles` map, an
absent `roles` section carries no intent to remove and MUST NOT be read as one.

#### Scenario: Overlay declares no roles

- **WHEN** the global config declares roles and the project overlay omits the `roles` section entirely
- **THEN** the effective config exposes every global role unchanged
- **AND** the effective role set is identical to the one produced when no project overlay exists at all

#### Scenario: Overlay declares only unrelated sections

- **WHEN** a project overlay declares only `runtime` or `template` keys and no `roles`
- **THEN** loading the config succeeds and global staffing is preserved

#### Scenario: Overlay pipeline references a global role it did not redeclare

- **WHEN** a project overlay declares a pipeline whose step names a role defined only in the global config
- **THEN** the config loads without error and that step resolves against the inherited global role

### Requirement: Role keys union across layers

Effective roles SHALL be the union of the global layer's role keys and the project overlay's role keys.
A role named by both layers MUST be merged field-by-field with the overlay's fields taking precedence.
A role named only by the global layer MUST survive into the effective config. This mirrors the merge
rule already applied to the model registry, so both named collections behave identically.

#### Scenario: Overlay declares a subset of global roles

- **WHEN** the global config declares roles `a`, `b`, and `c` and the overlay declares only `b`
- **THEN** the effective config contains `a`, `b`, and `c`
- **AND** `b` carries the overlay's field values wherever it sets them, and the global values elsewhere

#### Scenario: Overlay introduces a role the global layer does not define

- **WHEN** the overlay declares a role name absent from the global config
- **THEN** the effective config contains that role exactly as the overlay declared it

#### Scenario: Overlay refines a role without restating its staffing

- **WHEN** the overlay declares a role with `instructions` but no `use`
- **THEN** the effective role carries the overlay's `instructions` and the global layer's `use`

### Requirement: Cross-role invariants survive layering

Merging MUST NOT invalidate a constraint one layer expressed between two roles. Where a role declares
independence from another role, the referenced target MUST remain present in the effective config
whenever both were present in the layer that declared the constraint. An author MUST NOT be required to
restate a role solely to keep another role's reference resolvable.

#### Scenario: Inherited independence constraint keeps its target

- **WHEN** the global config declares a role whose model must differ from another global role, and the
  overlay redeclares only the dependent role
- **THEN** the config loads without error
- **AND** the independence constraint is still enforced during role resolution

#### Scenario: Overlay cannot silently collapse an inherited independence constraint

- **WHEN** an inherited independence constraint cannot be satisfied by the available models
- **THEN** resolution reports the dependent role as blocked rather than resolving it unconstrained

### Requirement: Layering semantics are documented at the authoring surface

The published config schema SHALL state, for each named collection an overlay may declare, how that
collection combines with the global layer and what omitting it means. An author writing a project
overlay against the schema alone MUST be able to predict the effective config without consulting the
implementation or its tests.

#### Scenario: Author reads the schema before writing an overlay

- **WHEN** an author inspects the schema description for `roles` or `models`
- **THEN** the description states that project keys merge over global keys, that global-only keys are
  retained, and that omitting the section inherits the global layer
