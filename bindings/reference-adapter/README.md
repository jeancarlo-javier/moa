# reference-adapter — archived worked example

**Status: PARKED / not wired in.** This package is a frozen, end-to-end example of the
*enforced-spawn binding contract* described in [`../adapter-contract.md`](../adapter-contract.md).
It exists so that whoever re-implements graded enforcement later has a complete, working
reference to read — not because moa calls it today.

moa's **active** binding model is the lightweight *learned tool profile*
(`moa-core/references/learn-tool.md`): the master probes a CLI, learns how to drive it, and
runs it with its own shell. No adapter process, no language runtime required. See
[`../README.md`](../README.md) for why the enforced model was parked.

## What's here

| File | Role in the example |
|------|---------------------|
| `binding.json` | Manifest: declares the contract methods and the (illustrative) served providers. |
| `adapter.py` | The six-method contract implemented against **one concrete CLI**, chosen only as a worked example. Its command names and flags are specific to that target and are *illustrative, not normative*. |
| `conformance_test.sh` | The proof-of-enforcement suite: tool restriction actually applied, prompt never shell-interpolated, honest `policy_unsupported`, cancel works. This is the part most worth preserving for re-implementation. |

## If you re-implement enforcement

Don't copy the Python. Copy the **contract** and the **conformance tests**. The lesson of
this archive is the shape of the guarantees (graded `enforcementGrade`, fail-closed routing,
least-privilege tool policies proven by tests), not this one runtime's flags. The natural
re-entry point is to grow a `toolRestriction` section on the learned tool profile and have
the master enforce + grade it — see `../README.md` → *Re-implementing on top of profiles*.
