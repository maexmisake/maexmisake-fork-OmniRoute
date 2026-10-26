"""Closed pinned-AST preparation; never import original agent/provider modules or run tools."""
import __future__
import ast
import builtins
import contextlib
import copy
import hashlib
import json
import re
import socket
import sys
import textwrap
from collections.abc import Mapping
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent
PIN = "749cb638ff43f9ce5333c186a1e4f67d473aa4f2"
TOOL_NAME = "synthetic_lookup"
SUBSTITUTIONS = [
    "Synthetic SDK-like SimpleNamespace messages/calls, no OpenAI SDK normalization/serialization",
    "Synthetic agent: no reasoning, callbacks or thinking pad; no initialization/config/dotenv",
    "Agent split/derive ID collaborators accept only supplied fixture IDs; missing-ID generation denied",
    "Fixed wall_time1700000000.0 for original timestamp helper",
    "Runner deep-copies rows before selected original API cleanup statements",
    "Runner supplies result values and order; no tool execution, persistence, guardrails or dispatcher scheduling",
    "Only executor messages.append(tool_message) statement executes; full commit/flush pipeline excluded",
    "Original sanitizer called with explicit generic-custom no-reasoning/no-Gemini/no-Mistral fixture flags",
    "Redaction/model_dump/threat-scanner and every unreviewed import/side effect fail closed",
]

class ClosedBoundaryError(BaseException):
    pass

def denied(*_args, **_kwargs):
    raise ClosedBoundaryError("Unreviewed fixture boundary")

socket.socket = denied
socket.create_connection = denied
socket.getaddrinfo = denied

def load_fragments(fragments):
    safe_names = ("all", "any", "bool", "callable", "dict", "enumerate", "Exception", "float", "frozenset",
                  "getattr", "hasattr", "int", "isinstance", "len", "list", "map", "next", "object", "range",
                  "set", "str", "tuple", "TypeError", "ValueError")
    env = {"__builtins__": {k: getattr(builtins, k) for k in safe_names}, "Mapping": Mapping,
           "re": re, "contextlib": contextlib, "wall_time": lambda: 1700000000.0,
           "logging": SimpleNamespace(debug=denied), "logger": SimpleNamespace(debug=denied),
           "_model_dump_safe": denied, "scan_for_threats": denied}
    imports = []
    def closed_import(name, _globals=None, _locals=None, fromlist=(), level=0):
        if name != "agent.reasoning_carriers" or level or any(k not in ("field", "carrier_record") for k in fromlist):
            raise ClosedBoundaryError("Unreviewed import")
        imports.append({"module": name, "attributes": list(fromlist)})
        return SimpleNamespace(field=env["field"], carrier_record=env["carrier_record"])
    env["__builtins__"]["__import__"] = closed_import
    statements = {}
    for fragment in fragments:
        raw = fragment["source"]
        if hashlib.sha256(raw.encode()).hexdigest() != fragment["sha256"]:
            raise ClosedBoundaryError("Fragment integrity mismatch")
        tree = ast.parse(textwrap.dedent(raw))
        name = fragment["name"]
        code = compile(tree, "pinned:" + fragment["path"] + ":" + name, "exec",
                       flags=__future__.annotations.compiler_flag)
        if ":" in name:
            statements[name] = code
        else:
            if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.FunctionDef, ast.Assign)):
                raise ClosedBoundaryError("Unreviewed fragment shape")
            exec(code, env)
    return env, statements, imports, closed_import

def pinned_id_helpers():
    """Execute only the two hashed, original pure ID bodies; never import the adapter."""
    raw = (ROOT / "tool-id-fragments.json").read_bytes()
    provenance = json.loads((ROOT / "tool-id-provenance.json").read_text())
    if hashlib.sha256(raw).hexdigest() != provenance["fragmentFileSHA256"]:
        raise ClosedBoundaryError("Pinned ID fragment integrity")
    payload = json.loads(raw)
    if payload.get("commit") != PIN:
        raise ClosedBoundaryError("Pinned ID source revision")
    names = {"_split_responses_tool_id", "_derive_responses_function_call_id"}
    fragments = payload.get("fragments", [])
    if len(fragments) != 2 or {row["name"] for row in fragments} != names:
        raise ClosedBoundaryError("Pinned ID fragment names")
    env = {"__builtins__": {name: getattr(builtins, name) for name in ("str", "isinstance", "len")},
           "re": re, "hashlib": hashlib, "uuid": SimpleNamespace(uuid4=denied)}
    for row in fragments:
        if hashlib.sha256(row["source"].encode()).hexdigest() != row["sha256"]:
            raise ClosedBoundaryError("Pinned ID function integrity")
        tree = ast.parse(row["source"])
        if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef) or tree.body[0].name != row["name"]:
            raise ClosedBoundaryError("Pinned ID AST boundary")
        code = compile(tree, "pinned:agent/codex_responses_adapter.py:" + row["name"], "exec",
                       flags=__future__.annotations.compiler_flag)
        exec(code, env)
    return env["_split_responses_tool_id"], env["_derive_responses_function_call_id"]

def agent_fixture(pinned_ids=False):
    def split_id(raw):
        if not isinstance(raw, str) or not raw.startswith("fixture-call-"):
            raise ClosedBoundaryError("Unreviewed agent ID")
        left, _, right = raw.partition("|")
        return left, right or None
    def derive_id(call_id, item_id):
        if not call_id.startswith("fixture-call-"):
            raise ClosedBoundaryError("Unreviewed agent ID derivation")
        return item_id or "fixture-item-" + call_id
    if pinned_ids:
        split_id, derive_id = pinned_id_helpers()
    return SimpleNamespace(_split_responses_tool_id=split_id,
        _derive_responses_function_call_id=derive_id, _deterministic_call_id=denied,
        _extract_reasoning=lambda _message: None, _needs_thinking_reasoning_pad=lambda: False,
        _strip_think_blocks=denied, verbose_logging=False, reasoning_callback=None,
        stream_delta_callback=None, _stream_callback=None)

def tool_call(call_id, name=None, arguments='{"item":"synthetic lamp"}'):
    name = TOOL_NAME if name is None else name
    return SimpleNamespace(id=call_id, call_id=None, response_item_id=None, type="function",
                           function=SimpleNamespace(name=name, arguments=arguments))

def construct(env, statements, calls, *, result_order=None, preface=None):
    original_sdk = repr(calls)
    assistant = env["build_assistant_message"](agent_fixture(),
        SimpleNamespace(content=preface, tool_calls=calls), "tool_calls")
    assert repr(calls) == original_sdk
    messages = [{"role": "user", "content": "Explain a synthetic lamp."}, assistant]
    ordered = list(range(len(calls))) if result_order is None else result_order
    for index in ordered:
        call = assistant["tool_calls"][index]
        result = env["make_tool_result_message"](call["function"]["name"], "Synthetic result", call["id"])
        env.update(messages=messages, tool_message=result)
        exec(statements["_commit_tool_result:append_statement_only"], env)
    preserved = copy.deepcopy(messages)
    projected = []
    for row in messages:
        env["api_msg"] = copy.deepcopy(row)
        for name in ("api_content_pop", "persistence_pop", "finish_reason_pop"):
            exec(statements["build_api_messages:" + name + "_statement_only"], env)
        wire = env["api_msg"]
        clean = env["_sanitize_message"](wire, True,
            frozenset({"reasoning", "reasoning_content", "reasoning_details"}), None,
            mistral_tool_ids=False)
        projected.append(wire if clean is None else clean)
    assert messages == preserved, "Selected API projection must not rewrite storage rows"
    for row in projected:
        assert set(row) <= {"role", "content", "tool_calls", "tool_call_id"}
        for call in row.get("tool_calls", []):
            assert set(call) == {"id", "type", "function"}
            assert set(call["function"]) == {"name", "arguments"}
    return {"storageMessages": messages, "projectedMessages": projected}

def run():
    raw = (ROOT / "tool-protocol-fragments.json").read_bytes()
    provenance = json.loads((ROOT / "fragment-provenance.json").read_text())
    if hashlib.sha256(raw).hexdigest() != provenance["fragmentFileSHA256"]:
        raise ClosedBoundaryError("Aggregate integrity mismatch")
    bundle = json.loads(raw)
    if bundle["commit"] != PIN: raise ClosedBoundaryError("Unexpected pin")
    env, statements, imports, closed_import = load_fragments(bundle["fragments"])
    executed = set()
    def profile(frame, event, _arg):
        if event == "call" and frame.f_code.co_filename.startswith("pinned:"):
            executed.add(frame.f_code.co_filename + ":" + frame.f_code.co_name)
    sys.setprofile(profile)
    checks = []
    captures = {}
    try:
        captures["single"] = construct(env, statements, [tool_call("fixture-call-one")])
        checks.append("original assistant/result construction and selected API projection")
        captures["two-results-reversed"] = construct(env, statements,
            [tool_call("fixture-call-one"), tool_call("fixture-call-two")], result_order=[1, 0])
        rows = captures["two-results-reversed"]["projectedMessages"]
        assert [r["tool_call_id"] for r in rows if r["role"] == "tool"] == ["fixture-call-two", "fixture-call-one"]
        checks.append("two provided calls retain identity under runner-supplied reversed result order")
        captures["composite-id"] = construct(env, statements, [tool_call("fixture-call-one|fixture-item-one")])
        rows = captures["composite-id"]["projectedMessages"]
        assert rows[1]["tool_calls"][0]["id"] == rows[2]["tool_call_id"] == "fixture-call-one"
        checks.append("composite result ID uses original normalizer plus disclosed agent ID facade")
        first = construct(env, statements, [tool_call("fixture-call-repeat")])
        second = construct(env, statements, [tool_call("fixture-call-repeat", arguments='{"item":"different synthetic lamp"}')])
        assert first["projectedMessages"][1]["tool_calls"][0]["id"] == second["projectedMessages"][1]["tool_calls"][0]["id"]
        captures["repeated-provider-id-across-turns"] = [first, second]
        checks.append("separate original constructions may retain the same supplied provider ID")
        message = env["make_tool_result_message"]("synthetic_lookup", "Synthetic result", "fixture-call-one|fixture-item-one")
        assert message["tool_call_id"] == "fixture-call-one"
        checks.append("original result constructor strips composite ID suffix")
        for label, probe in [
            ("unknown-import", lambda: closed_import("os")),
            ("socket", lambda: socket.socket()),
            ("missing-ID-generator", lambda: construct(env, statements, [tool_call("")])),
            ("unreviewed-preface-redaction", lambda: construct(env, statements, [tool_call("fixture-call-one")], preface="Synthetic preface")),
            ("unreviewed-threat-scanner", lambda: env["make_tool_result_message"]("mcp_synthetic", "A sufficiently long synthetic result for scanner boundary", "fixture-call-one")),
        ]:
            try: probe()
            except ClosedBoundaryError: checks.append(label + " denied before external activity")
            else: raise AssertionError(label + " must fail closed")
        changed = copy.deepcopy(bundle["fragments"])
        changed[0]["source"] += "\n"
        try: load_fragments(changed)
        except ClosedBoundaryError: checks.append("changed pinned fragment rejected before execution")
        else: raise AssertionError("integrity failure expected")
    finally:
        sys.setprofile(None)
    return dict(pin=PIN, synthetic=True, checks=checks, checkCount=len(checks), captures=captures,
                executedOriginalFragments=sorted(executed), admittedImports=imports,
                substitutions=SUBSTITUTIONS, fullHermesImported=False, actualToolsRun=False,
                executorCommitPipelineRun=False, completeBuildAPIMessagesRun=False,
                openAISDKWireCaptured=False, providerRequests=0)

if __name__ == "__main__":
    supplied = sys.stdin.read(4096)
    config = json.loads(supplied) if supplied.strip() else {}
    if set(config) - {"tool_name"}: raise ClosedBoundaryError("Unexpected runner input")
    if "tool_name" in config:
        name = config["tool_name"]
        if not isinstance(name, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_-]{0,57}", name):
            raise ClosedBoundaryError("Unexpected runner input")
        TOOL_NAME = name
        SUBSTITUTIONS.append("Runner supplies a synthetic tool name to unchanged original constructors")
    print(json.dumps(run(), indent=2))
