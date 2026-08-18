## Why

A project `.moa.yml` overlay silently discards every global role it does not name. `mergeConfigLayers`
(`moa-core/mcp/server.mjs:319-332`) iterates only the project's role keys, and deletes `roles` outright
when the overlay omits the section. Adding an overlay that only sets a pipeline — or only a
`runtime.workDir` — wipes the machine's entire staffing.

This is not just ergonomics. Because `zGlobalRole` carries `differentModelFrom`, declaring a subset can
break the anti-self-certification graph the global layer established. Verified against the current code:

```yaml
# ~/.moa/config.yml                         # .moa.yml
roles:                                       roles:
  coder:    { use: [m1] }                      verifier: {}
  verifier: { use: [m2], differentModelFrom: coder }
```
```
errors: ["…/.moa.yml: role 'verifier': differentModelFrom names unknown role 'coder'"]
roles:  []
```

The overlay inherits the *constraint* but not its *target*, so the author must hand-maintain the
transitive closure of `differentModelFrom` or the config refuses to load.

The behavior is also non-monotonic and inexpressible-by-intent:

| overlay | effective roles |
|---|---|
| no `.moa.yml` | all global roles |
| `.moa.yml` with `roles:` | only the declared keys |
| `.moa.yml` without `roles:` | **none** |

`zProjectOverlay` already rejects `roles: {}` ("must declare at least one role"), so "I want zero roles"
cannot be written. Absence therefore can only mean "no opinion" — but the code reads it as "zero".

## What Changes

- **BREAKING (semantics)**: `mergeConfigLayers` unions role keys instead of intersecting them.
  Effective roles become `{...global.roles}` overlaid with a per-key merge of the project's roles. This
  makes `roles` structurally identical to the `models` merge one line above it, and removes the
  `delete merged.roles` branch entirely.
- An overlay that omits `roles:` now inherits the global role palette unchanged, matching the
  no-overlay case.
- An overlay that declares a subset keeps every global role it did not name, so
  `differentModelFrom` targets survive.
- The existing test `load: project roles inherit global staffing without role union`
  (`moa-core/mcp/test.mjs:295`) encodes the old behavior and is rewritten; new cases cover the
  omitted-`roles` overlay and the `differentModelFrom` closure.
- Layering semantics get documented where authors actually look: `moa-core/schema/config.schema.json`
  currently says nothing about layers.

Non-goals:
- Extending `zGlobalRole` to accept `instructions` (see design.md — considered and deferred).
- A syntax for *narrowing* the palette (removing an inherited role). Nothing needs it yet.
- Changing the `models` merge, `/moa init` generation, or `crossCheck`'s error text. All five templates
  declare `roles:`, so `opInit` scope=project never emits an overlay that trips this; the defect is
  reachable only from a hand-written `.moa.yml`.

## Capabilities

### New Capabilities
- `config-layering`: how the global `~/.moa/config.yml` staffing layer and an optional project
  `.moa.yml` overlay combine into one effective config — key-level merge rules for `models` and
  `roles`, what absence means per layer, and which cross-layer invariants must survive the merge.

### Modified Capabilities
<!-- none: openspec/specs/ is empty, this is the first capability -->

## Impact

- `moa-core/mcp/server.mjs` — `mergeConfigLayers` (both call sites: `opLoad:1069`, `opInit:2321`).
- `moa-core/mcp/test.mjs` — one existing assertion inverted (`:327`), three cases added.
- `moa-core/schema/config.schema.json` — description text for `roles`.
- Downstream readers of the merged config are unaffected in shape, only in content:
  `opResolve:1161` (`roleGraph` over a larger map), `opRunStart:1671` (`roleInstructions`).
- Behavioral blast radius: any existing hand-written overlay that relied on narrowing the palette
  would now see a wider one. No such overlay exists in this repo's templates or fixtures.
