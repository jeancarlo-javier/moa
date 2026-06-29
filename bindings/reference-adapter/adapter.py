#!/usr/bin/env python3
"""
adapter.py — ARCHIVED REFERENCE IMPLEMENTATION of the enforced-spawn binding contract.

PARKED / NOT WIRED IN. moa's active binding model is the lightweight learned tool
profile (see moa-core/references/learn-tool.md), where the master drives a CLI with
its own shell and needs no adapter process. This file is kept verbatim as a *worked
example* of the heavier enforced contract — graded enforcement, least-privilege tool
policies, fail-closed routing — for whoever re-implements it later. See
../README.md and ../adapter-contract.md for the agnostic spec.

It targets one concrete CLI as its example runtime; the specific command names and
flags below are illustrative of that target, not normative for moa.

Contract implemented (see ../adapter-contract.md):

    serves() -> [ModelMeta]
    validate-policy <role> <toolPolicy.json> -> {enforcementGrade, reason}
    spawn <spawnRequest.json> -> SpawnResult.json
    parse-result <raw> -> {verdict?, resultText, changedFiles[], usage, cost}
    cancel <handle>
    cleanup <handle>

Invocation from the core is `python3 adapter.py <method> [args...]` with the
result printed to stdout as one JSON document on a single line. Errors are
written to stderr and exit non-zero; partial JSON is never printed on failure
(the core only reads stdout on exit 0).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from typing import Any

# ---------------------------------------------------------------------------
# Constants — the ONLY CLI knowledge lives here. Adjusting omp flags belongs
# in this file, not in the skill core.
# ---------------------------------------------------------------------------

OMP_BIN = os.environ.get("OMP_BIN", "omp")

# Canonical -> omp tool name. omp's tool surface is mostly the same as the
# canonical names; unknown names are silently dropped by omp, so we whitelist
# explicitly rather than passing through.
CANONICAL_TO_OMP_TOOL = {
    "read": "read",
    "edit": "edit",
    "write": "write",
    "bash": "bash",
    "find": "find",
    "search": "search",
    "lsp": "lsp",
    "ast_grep": "ast_grep",
    "ast_edit": "ast_edit",
    "todo": "todo",
    "web_search": "web_search",
    "browser": "browser",
    "notebook": "notebook",
    "inspect_image": "inspect_image",
    "python": "python",
}

# independenceGroup keys on MODEL FAMILY (lineage), NEVER on provider. The
# anti-self-certification check needs a verifier whose underlying model differs from
# the producer's; routing the SAME model through a different provider/aggregator
# (e.g. Claude via anthropic vs via google-antigravity) does NOT make it independent.
# Two models sharing a family share an independenceGroup -> not independent. Unknown
# families collapse to "other", which is conservative (treated as non-independent).

# Hard runtime guarantee: --no-skills and --no-extensions on every launch.
ALWAYS_PASSED = ["--no-skills", "--no-extensions", "--no-session"]


# ---------------------------------------------------------------------------
# serves
# ---------------------------------------------------------------------------

def _family_from_model(model_id: str) -> str:
    """Infer model family/lineage from the id. This is the AUTHORITATIVE basis for
    independenceGroup: two models that share a family are NOT independent of each
    other (a Claude verifying Claude shares blind spots), regardless of which
    provider serves them.
    """
    ml = model_id.lower().split("/")[-1]   # strip any provider/ prefix
    if ml.startswith("claude-"):
        return "claude"
    if ml.startswith("gpt-"):
        return "gpt"
    if ml.startswith("gemini-"):
        return "gemini"
    if ml.startswith("minimax"):
        return "minimax"
    if ml.startswith("qwen") or ml.startswith("gemma"):
        return "local-llm"
    return "other"


# Lineage names we trust as 'strong' even with no cost metadata — a short,
# conservative allowlist, not the primary signal. A diminutive variant of one of
# these (gpt-5.4-MINI) is deliberately NOT strong on name alone; metadata places it.
_STRONG_NAMES = ("opus", "fable", "mythos", "gpt-5.5", "gpt-5.4",
                 "gemini-3-pro", "gemini-3.1-pro", "o3", "o4")
# Tiny/triage lineages that are 'fast' tier by name when cost is unknown.
_FAST_NAMES = ("haiku", "qwen3:", "qwen3.5:", "gemma", "flash-lite", "highspeed")
# 'mini'/'nano'/'lite'/'small' as a standalone token. This must NOT fire on the
# 'mini' INSIDE 'MiniMax' — that coincidental substring is the bug we are fixing,
# so we require a word boundary on both sides.
_DIMINUTIVE = re.compile(r"(^|[-_ .:/])(mini|nano|micro|lite|small|tiny)([-_ .:/]|$)")


def _is_diminutive(model_lower: str) -> bool:
    return bool(_DIMINUTIVE.search(model_lower))


def _output_price(cost: Any) -> "float | None":
    """Pull an output-price signal out of omp's cost block. Shapes vary across
    providers, and the *unit* (per-token vs per-Mtok) is not guaranteed — which is
    why callers compare prices by RANK within the catalog, never against a
    hardcoded dollar threshold. Returns None when nothing usable is present.
    """
    if not isinstance(cost, dict):
        return None
    for k in ("output", "out", "completion", "per_output", "outputPerMtok"):
        v = cost.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    for k in ("total", "blended", "avg"):          # some catalogs only expose a blend
        v = cost.get(k)
        if isinstance(v, (int, float)):
            return float(v)
    return None


def _quantile(sorted_vals: list, q: float) -> float:
    """Nearest-rank quantile over a pre-sorted list (avoids a numpy dependency)."""
    if not sorted_vals:
        return 0.0
    idx = min(len(sorted_vals) - 1, max(0, int(round(q * (len(sorted_vals) - 1)))))
    return sorted_vals[idx]


def _tier_from_name(model_lower: str) -> str:
    """Last-resort tier when the catalog gives us no usable price."""
    if any(t in model_lower for t in _STRONG_NAMES) and not _is_diminutive(model_lower):
        return "strong"
    if _is_diminutive(model_lower) or any(t in model_lower for t in _FAST_NAMES):
        return "fast"
    return "cheap"


def _capability_tier(m: dict, model_id: str, hi: "float | None", lo: "float | None") -> str:
    """Heuristic capabilityTier: strong | cheap | fast.

    Tier is load-bearing — it drives `auto` routing and the 'delegate to the
    strongest model' rule — so we derive it from the metadata that actually
    predicts capability (price RANK within this catalog, plus reasoning support)
    rather than from coincidences in the model id. `init` then shows this map for
    the user to confirm, so a wrong guess is correctable, never silent.

    Price is ranked (hi/lo are catalog quartiles), not thresholded, so the same
    logic holds whether omp quotes per-token or per-Mtok. hi/lo are None when the
    catalog is too small to rank; we then fall back to lineage names.
    """
    ml = model_id.lower()
    reasoning = bool(m.get("reasoning")) or bool(m.get("thinkingLevels"))
    price = _output_price(m.get("cost"))

    # High-confidence lineage override — but a diminutive (…-mini) is never strong
    # on name alone; let its price decide.
    if any(t in ml for t in _STRONG_NAMES) and not _is_diminutive(ml):
        return "strong"

    if price is not None and hi is not None and lo is not None:
        # Top-of-catalog price + actual reasoning support is the clearest 'strong'
        # signal; a tiny model can be pricey per-token, so require reasoning too.
        if reasoning and price >= hi and not _is_diminutive(ml):
            return "strong"
        # Cheapest quartile, or an explicit small variant → triage/fast tier.
        if _is_diminutive(ml) or price <= lo:
            return "fast"
        # The middle band is the volume workhorse: capable coders (MiniMax-M3)
        # you fan high-volume edits out to.
        return "cheap"

    return _tier_from_name(ml)


def cmd_serves(_args: argparse.Namespace) -> int:
    """Return normalized model metadata for everything omp can host.

    Source of truth: `omp models --json` — a single command that returns the
    coalesced catalog across all configured providers. We never call a
    provider API directly; omp owns the auth.
    """
    proc = subprocess.run(
        [OMP_BIN, "models", "--json"],
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        print(f"omp models --json failed: {proc.stderr.strip()}", file=sys.stderr)
        return proc.returncode

    try:
        catalog = json.loads(proc.stdout)
    except json.JSONDecodeError as exc:
        print(f"omp models --json: invalid JSON: {exc}", file=sys.stderr)
        return 2

    models = catalog.get("models")
    if not isinstance(models, list):
        print("omp models --json: missing 'models' list", file=sys.stderr)
        return 2

    # Rank-based tiering needs the catalog's price spread up front. With too few
    # priced models a quartile is meaningless, so we leave hi/lo None and let the
    # tier fall back to lineage names.
    prices = sorted(p for p in (_output_price(m.get("cost")) for m in models) if p is not None)
    if len(prices) >= 4:
        hi, lo = _quantile(prices, 0.75), _quantile(prices, 0.25)
    else:
        hi = lo = None

    out = []
    for m in models:
        provider = m.get("provider", "")
        model_id = m.get("id", "")
        selector = m.get("selector") or f"{provider}/{model_id}"
        thinking = m.get("thinking") or []
        # Every (selector, thinking) combo is a usable modelId for routing.
        # The bare selector is what omp's catalog emits; the level-suffixed
        # form is what callers historically pass (e.g. ...:high, ...:xhigh).
        served = [selector] + [f"{selector}:{lvl}" for lvl in thinking]

        family = _family_from_model(model_id)
        out.append({
            "provider": provider,
            "modelFamily": family,
            "modelId": selector,                  # canonical, no thinking suffix
            "servedSelectors": served,            # every form the runtime accepts
            "modelName": m.get("name", model_id),
            "contextWindow": m.get("contextWindow"),
            "maxTokens": m.get("maxTokens"),
            "reasoning": bool(m.get("reasoning")),
            "thinkingLevels": thinking,
            "capabilityTier": _capability_tier(m, model_id, hi, lo),
            "independenceGroup": family,          # keyed on family/lineage, NOT provider
            "cost": m.get("cost", {}),
        })

    payload = {"ok": True, "models": out, "cachedAt": int(time.time())}
    sys.stdout.write(json.dumps(payload))
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# validate-policy
# ---------------------------------------------------------------------------

NETWORK_TOOLS = {"web_search", "browser"}     # `python` can shell out; treat as network-iffy
WRITE_TOOLS = {"edit", "write", "ast_edit", "notebook"}
SHELL_TOOL = "bash"
# We list `python` separately: it can network but isn't in the "explicitly
# network" set. Policies that say network=none are stricter than omp's
# `--tools` allowlist can enforce for python.
PYTHON_TOOL = "python"


def cmd_validate_policy(args: argparse.Namespace) -> int:
    role = args.role
    try:
        policy = json.loads(args.policy)
    except json.JSONDecodeError as exc:
        print(f"validate-policy: invalid policy JSON: {exc}", file=sys.stderr)
        return 2

    allow = list(policy.get("allow") or [])
    allow_set = set(allow)
    network = policy.get("network")
    filesystem = policy.get("filesystem")
    bash = policy.get("bash") or {}

    # Unknown canonical tool names -> we can't enforce them. Honest answer.
    unknown = [t for t in allow if t not in CANONICAL_TO_OMP_TOOL]
    if unknown:
        return _emit_validate("unsupported",
                              f"unknown canonical tools: {unknown}", role, policy)

    # Network policy.
    if network in ("none", "off_sandbox"):
        network_grant = allow_set & (NETWORK_TOOLS | {PYTHON_TOOL})
        if network_grant:
            return _emit_validate("unsupported",
                                  f"network={network} but allow includes {sorted(network_grant)}",
                                  role, policy)
    if network == "web_only":
        non_web = allow_set - NETWORK_TOOLS
        if non_web & (WRITE_TOOLS | {SHELL_TOOL}):
            return _emit_validate("unsupported",
                                  "network=web_only but policy has write/shell tools",
                                  role, policy)

    # Filesystem policy.
    if filesystem == "read_only":
        if allow_set & WRITE_TOOLS:
            return _emit_validate("unsupported",
                                  "filesystem=read_only but allow includes write tools",
                                  role, policy)

    # Decide grade.
    # Bash argv-allowlist cannot be enforced by omp (single coarse tool).
    if isinstance(bash, dict) and bash.get("mode") == "argv_allowlist":
        grade = "sandbox"
        reason = ("omp offers bash or no-bash only; per-argv allowlist "
                  "cannot be enforced by the runtime")
    # omp has no real filesystem isolation; worktree_copy is not enforceable.
    elif filesystem == "worktree_copy":
        grade = "sandbox"
        reason = "omp has no real filesystem isolation; worktree_copy not enforceable"
    else:
        grade = "strict"
        reason = "omp --tools enforces allowlist, --no-skills/--no-extensions on"

    return _emit_validate(grade, reason, role, policy)


def _emit_validate(grade: str, reason: str, role: str, policy: dict) -> int:
    sys.stdout.write(json.dumps({
        "ok": True,
        "enforcementGrade": grade,
        "reason": reason,
        "role": role,
        "policy": policy,
    }))
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# spawn
# ---------------------------------------------------------------------------

# Shared registry of live processes so cancel() can find them.
LIVE: dict[str, dict[str, Any]] = {}
LIVE_LOCK = threading.Lock()


def cmd_spawn(args: argparse.Namespace) -> int:
    try:
        req = json.loads(args.request)
    except json.JSONDecodeError as exc:
        print(f"spawn: invalid SpawnRequest JSON: {exc}", file=sys.stderr)
        return 2

    role = req.get("role", "unknown")
    model = req.get("model")
    if not model:
        print("spawn: SpawnRequest.model is required", file=sys.stderr)
        return 2

    policy = req.get("toolPolicy") or {}
    allow = [CANONICAL_TO_OMP_TOOL[t] for t in (policy.get("allow") or []) if t in CANONICAL_TO_OMP_TOOL]
    if not allow:
        print(f"spawn: policy for role={role} has no enforceable tools", file=sys.stderr)
        return 2

    prompt = req.get("prompt") or ""
    system_prompt = req.get("systemPrompt") or ""
    skills = req.get("skills") or []
    attachments = req.get("attachments") or []
    cwd = req.get("cwd") or os.getcwd()
    timeout = int(req.get("timeout") or 1800)
    max_cost = req.get("maxCost")

    if not os.path.isdir(cwd):
        print(f"spawn: cwd does not exist: {cwd}", file=sys.stderr)
        return 2

    # Re-validate so we never run with a policy we already know is unsatisfiable.
    grade, reason = _recheck_policy(policy, role)
    if grade == "unsupported":
        result = {
            "ok": True,
            "handle": "",
            "status": "policy_unsupported",
            "role": role,
            "resolvedModel": model,
            "provider": model.split("/", 1)[0] if "/" in model else "",
            "modelFamily": "",
            "enforcementGrade": grade,
            "verdict": None,
            "resultText": f"policy refused: {reason}",
            "changedFiles": [],
            "usage": {},
            "cost": 0.0,
            "exitCode": None,
            "durationMs": 0,
            "policy": policy,
            "stderrTail": "",
            "tmpDir": "",
            "reason": reason,
        }
        sys.stdout.write(json.dumps(result))
        sys.stdout.write("\n")
        return 0

    # Build argv. Prompt + system prompt go through temp files (NEVER shell-
    # interpolated). Attachments are passed as @path, which omp accepts as a
    # positional argument to be slurped into the message.

    tmpdir = tempfile.mkdtemp(prefix=f"dw-bind-omp-{role}-")
    prompt_path = os.path.join(tmpdir, "prompt.txt")
    with open(prompt_path, "w", encoding="utf-8") as f:
        f.write(prompt)
    sysprompt_path = None
    if system_prompt:
        sysprompt_path = os.path.join(tmpdir, "system.txt")
        with open(sysprompt_path, "w", encoding="utf-8") as f:
            f.write(system_prompt)

    argv = [
        OMP_BIN, "-p",
        "--cwd", cwd,
        "--model", model,
        "--tools", ",".join(allow),
        *ALWAYS_PASSED,
    ]
    if sysprompt_path:
        argv += ["--append-system-prompt", f"@{sysprompt_path}"]
    if max_cost is not None:
        argv += ["--max-time", str(int(max_cost))]
    argv += ["--max-time", str(timeout)]  # also a wall-clock cap
    for att in attachments:
        if os.path.exists(att):
            argv.append(f"@{att}")
        else:
            print(f"spawn: attachment missing, skipping: {att}", file=sys.stderr)
    argv.append(f"@{prompt_path}")

    handle = uuid.uuid4().hex[:12]
    with LIVE_LOCK:
        LIVE[handle] = {
            "pid": None, "tmpdir": tmpdir, "role": role, "model": model,
            "policy": policy, "argv": argv, "startedAt": time.time(),
        }

    started_file = req.get("startedFile")
    if started_file:
        # Write the handle + initial status as soon as we have one, so a
        # parent process can call cancel() before the result is ready.
        with open(started_file, "w", encoding="utf-8") as f:
            json.dump({"handle": handle, "pid": None, "role": role,
                       "model": model, "status": "starting"}, f)


    started = time.time()
    try:
        proc = subprocess.Popen(
            argv,

            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            cwd=cwd,
        )
    except FileNotFoundError:
        print(f"spawn: omp binary not found: {OMP_BIN}", file=sys.stderr)
        _cleanup_handle(handle)
        return 127
    with LIVE_LOCK:
        LIVE[handle]["pid"] = proc.pid

    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate()
        result = _make_result(
            handle=handle, role=role, model=model, policy=policy,
            grade=grade, status="timeout", raw_stdout=stdout or "",
            raw_stderr=stderr or "", started=started,
            tmpdir=tmpdir, extra={"reason": reason},
        )
        sys.stdout.write(json.dumps(result))
        sys.stdout.write("\n")
        return 0
    except Exception as exc:
        proc.kill()
        print(f"spawn: launch error: {exc}", file=sys.stderr)
        _cleanup_handle(handle)
        return 2

    status = "ok" if proc.returncode == 0 else "failed"
    if grade == "unsupported":
        status = "policy_unsupported"

    result = _make_result(
        handle=handle, role=role, model=model, policy=policy,
        grade=grade, status=status, raw_stdout=stdout or "",
        raw_stderr=stderr or "", started=started,
        tmpdir=tmpdir, exit_code=proc.returncode, extra={"reason": reason},
    )
    sys.stdout.write(json.dumps(result))
    sys.stdout.write("\n")
    return 0


def _recheck_policy(policy: dict, role: str) -> tuple[str, str]:
    """Re-run validatePolicy logic so we never call omp with a known-bad policy."""
    fake = argparse.Namespace(role=role, policy=json.dumps(policy))
    import io
    from contextlib import redirect_stdout
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = cmd_validate_policy(fake)
    if rc != 0:
        return ("unsupported", "validate-policy refused")
    try:
        out = json.loads(buf.getvalue())
    except json.JSONDecodeError:
        return ("unsupported", "validate-policy returned invalid JSON")
    return (out.get("enforcementGrade", "unsupported"),
            out.get("reason", ""))


def _make_result(*, handle, role, model, policy, grade, status,
                 raw_stdout, raw_stderr, started, tmpdir,
                 exit_code=None, extra=None) -> dict:
    parsed = parse_raw(raw_stdout, role=role)
    result = {
        "ok": True,
        "handle": handle,
        "status": status,
        "role": role,
        "resolvedModel": model,
        "provider": model.split("/", 1)[0] if "/" in model else "",
        "modelFamily": "",
        "enforcementGrade": grade,
        "verdict": parsed.get("verdict"),
        "resultText": parsed.get("resultText", ""),
        "changedFiles": parsed.get("changedFiles", []),
        "usage": parsed.get("usage", {}),
        "cost": parsed.get("cost", 0.0),
        "exitCode": exit_code,
        "durationMs": int((time.time() - started) * 1000),
        "policy": policy,
        "stderrTail": "\n".join((raw_stderr or "").splitlines()[-10:]),
        "tmpDir": tmpdir,
    }
    if extra:
        result.update(extra)
    return result


# ---------------------------------------------------------------------------
# parse-result (also called internally by spawn)
# ---------------------------------------------------------------------------

VERDICT_TOKENS = ("APPROVE", "REVISE", "BLOCKED", "ERROR")


def cmd_parse_result(args: argparse.Namespace) -> int:
    raw = args.raw
    if os.path.exists(raw):
        with open(raw, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
    else:
        data = raw
    out = parse_raw(data)
    sys.stdout.write(json.dumps({"ok": True, **out}))
    sys.stdout.write("\n")
    return 0


def parse_raw(text: str, *, role: str | None = None) -> dict:
    """Best-effort extract verdict/resultText/usage from omp output.

    omp can emit text or JSONL. With `--mode json` it emits one JSON object
    per line. We accept both: detect JSONL by trying to parse the first line.
    """
    verdict: str | None = None
    result_text_parts: list[str] = []
    changed: list[str] = []
    usage: dict = {}
    cost_total = 0.0
    text_lines: list[str] = []

    def _verdict_from(s: str) -> str | None:
        for line in (s or "").splitlines():
            head = line.strip().upper()
            if not head:
                continue
            for tok in VERDICT_TOKENS:
                if head == tok or head.startswith(tok + " ") or head.startswith(tok + ":"):
                    return tok
        return None

    # Try JSONL.
    jsonl_ok = True
    try:
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            obj = json.loads(line)
            t = obj.get("type")
            if t == "message_end":
                msg = obj.get("message") or {}
                for block in (msg.get("content") or []):
                    if block.get("type") == "text":
                        txt = block.get("text", "")
                        result_text_parts.append(txt)
                        if verdict is None:
                            verdict = _verdict_from(txt)
                u = msg.get("usage") or {}
                if u:
                    usage = u
                c = (u.get("cost") or {}).get("total")
                if isinstance(c, (int, float)):
                    cost_total += float(c)
            elif t == "tool_result":
                # omp doesn't expose changed paths here reliably; the core
                # should diff the worktree before vs after, not rely on this.
                pass
    except (json.JSONDecodeError, ValueError):
        jsonl_ok = False

    if not jsonl_ok:
        # Plain text mode.
        for line in text.splitlines():
            text_lines.append(line)
            if verdict is None:
                verdict = _verdict_from(line)

    # Last-chance verdict scan over text we already saw.
    if verdict is None:
        for blob in result_text_parts or text_lines or [text]:
            v = _verdict_from(blob)
            if v:
                verdict = v
                break

    result_text = "\n".join(result_text_parts).strip() or "\n".join(text_lines).strip()
    return {
        "verdict": verdict,
        "resultText": result_text,
        "changedFiles": changed,
        "usage": usage,
        "cost": cost_total,
    }


# ---------------------------------------------------------------------------
# cancel / cleanup
# ---------------------------------------------------------------------------

def cmd_cancel(args: argparse.Namespace) -> int:
    handle = args.handle
    with LIVE_LOCK:
        entry = LIVE.get(handle)
    if not entry:
        sys.stdout.write(json.dumps({"ok": True, "handle": handle, "status": "unknown"}))
        sys.stdout.write("\n")
        return 0
    pid = entry.get("pid")
    if pid:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except PermissionError:
            print(f"cancel: no permission to kill pid={pid}", file=sys.stderr)
    sys.stdout.write(json.dumps({"ok": True, "handle": handle, "status": "cancelled"}))
    sys.stdout.write("\n")
    return 0


def cmd_cleanup(args: argparse.Namespace) -> int:
    handle = args.handle
    with LIVE_LOCK:
        entry = LIVE.pop(handle, None)
    if not entry:
        sys.stdout.write(json.dumps({"ok": True, "handle": handle, "status": "unknown"}))
        sys.stdout.write("\n")
        return 0
    tmpdir = entry.get("tmpdir")
    if tmpdir and os.path.isdir(tmpdir):
        shutil.rmtree(tmpdir, ignore_errors=True)
    sys.stdout.write(json.dumps({"ok": True, "handle": handle, "status": "cleaned"}))
    sys.stdout.write("\n")
    return 0


# ---------------------------------------------------------------------------
# CLI dispatch
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="adapter.py", add_help=True)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("serves", help="list models this binding can host")

    p_vp = sub.add_parser("validate-policy", help="answer: can I enforce this?")
    p_vp.add_argument("--role", required=True)
    p_vp.add_argument("--policy", required=True,
                      help="JSON: the canonical toolPolicy from the core")

    p_sp = sub.add_parser("spawn", help="run one role x model subagent")
    p_sp.add_argument("--request", required=True,
                      help="JSON: the SpawnRequest from the core")

    p_pr = sub.add_parser("parse-result", help="extract verdict/usage from raw omp output")
    p_pr.add_argument("--raw", required=True,
                      help="path to raw output, or the raw text itself")

    p_cn = sub.add_parser("cancel", help="kill a live spawn by handle")
    p_cn.add_argument("--handle", required=True)

    p_cl = sub.add_parser("cleanup", help="remove temp dir for a handle")
    p_cl.add_argument("--handle", required=True)

    ns = p.parse_args(argv)
    table = {
        "serves": cmd_serves,
        "validate-policy": cmd_validate_policy,
        "spawn": cmd_spawn,
        "parse-result": cmd_parse_result,
        "cancel": cmd_cancel,
        "cleanup": cmd_cleanup,
    }
    return table[ns.cmd](ns)


if __name__ == "__main__":
    sys.exit(main())
