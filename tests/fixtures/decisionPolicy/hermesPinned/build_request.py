"""Execute allowlisted, pinned Hermes AST bodies with closed synthetic collaborators.

This is kwargs assembly, not the full Hermes client or OpenAI SDK serialization.
The complete upstream MIT notice is in LICENSE beside this file.
"""

import __future__
import ast
import builtins
import contextlib
import hashlib
import json
import socket
import sys
import textwrap
from pathlib import Path
from types import MethodType, SimpleNamespace
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
MODEL = "synthetic-hermes-pinned"
BASE = "https://hermes.fixture.invalid/v1"
SUBSTITUTIONS = [
    "closed in-memory provider/auxiliary/carrier/Gemini/Codex import facades",
    "synthetic agent and profile scalar state; no initialization/config discovery",
    "already-sanitized text messages; identity convert_messages and carrier shaping",
    "empty data-use/provider preferences; no ephemeral cap; no fixed temperature",
    "non-Moonshot fixture; developer-role constant fails if consulted",
    "custom URL predicates false; no real credential or endpoint resolution",
    "capture-only create callable; no OpenAI SDK or HTTP serialization",
    "explicit driver stream/stream_options flags added after original kwargs builder",
]


class ClosedBoundaryError(BaseException):
    # Pinned compatibility catches/suppress(Exception) must not swallow fixture policy.
    pass


def denied(*_args, **_kwargs):
    raise ClosedBoundaryError("unreviewed fixture boundary")


# Python itself may import socket solely to install this independent guard.
# No downloaded Hermes source receives the real import function or socket module.
socket.socket = denied
socket.create_connection = denied
socket.getaddrinfo = denied


def fixture_host_matches(base, domain):
    if base != BASE:
        raise ClosedBoundaryError("unreviewed URL")
    return False


def only_custom(provider, profile):
    if provider != "custom":
        raise ClosedBoundaryError("unreviewed provider")
    return profile


def checked_identity(value, **_kwargs):
    return value


class UnavailableDeveloperModels:
    def __iter__(self):
        raise ClosedBoundaryError("unreviewed developer-role predicate")


def load_functions(profile):
    raw = (ROOT / "upstream-fragments.json").read_bytes()
    provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
    if hashlib.sha256(raw).hexdigest() != provenance["fragmentFileSHA256"]:
        raise ClosedBoundaryError("fragment aggregate mismatch")
    fragments = json.loads(raw)
    if fragments["commit"] != "749cb638ff43f9ce5333c186a1e4f67d473aa4f2":
        raise ClosedBoundaryError("unreviewed source pin")
    sentinel = object()
    facades = {
        "providers.base": SimpleNamespace(OMIT_TEMPERATURE=sentinel),
        "providers": SimpleNamespace(get_provider_profile=lambda name: only_custom(name, profile)),
        "agent.auxiliary_client": SimpleNamespace(
            _fixed_temperature_for_model=lambda *_args: None,
            OMIT_TEMPERATURE=sentinel,
        ),
        "agent.reasoning_carriers": SimpleNamespace(shape_wire_carriers=checked_identity),
        "agent.gemini_native_adapter": SimpleNamespace(
            gemini_uses_thinking_level=lambda _model: False,
            is_native_gemini_base_url=lambda _base: False,
        ),
        "agent.transports.codex": SimpleNamespace(
            _bound_prompt_cache_key_field=denied,
            _cache_scope_from_session_id=denied,
            _content_cache_key=denied,
        ),
    }
    imports = []

    def closed_import(name, _globals=None, _locals=None, fromlist=(), level=0):
        if level or name not in facades:
            raise ClosedBoundaryError("unreviewed import")
        result = facades[name]
        if any(not hasattr(result, attr) for attr in fromlist):
            raise ClosedBoundaryError("unreviewed import attribute")
        imports.append({"module": name, "attributes": list(fromlist)})
        return result

    safe_names = (
        "any", "bool", "dict", "Exception", "float", "frozenset", "getattr",
        "hasattr", "int", "isinstance", "len", "list", "max", "min", "object",
        "str", "tuple", "TypeError", "ValueError",
    )
    env = {"__builtins__": {name: getattr(builtins, name) for name in safe_names}}
    env["__builtins__"]["__import__"] = closed_import
    env.update({
        "contextlib": contextlib,
        "urlparse": urlparse,
        "uuid": SimpleNamespace(uuid4=denied),
        "base_url_host_matches": fixture_host_matches,
        "DEVELOPER_ROLE_MODELS": UnavailableDeveloperModels(),
        "is_moonshot_model": lambda _model: False,
        "sanitize_moonshot_tools": denied,
        "data_use_requirement": lambda _messages: frozenset(),
        "_alias_tool_search_bridge_for_xai": lambda _agent, _transport, tools: tools,
        "_provider_preferences_for_agent": lambda _agent: {},
        "_consume_ephemeral_max_output": lambda _agent: None,
    })
    methods = {}
    for fragment in fragments["fragments"]:
        source = fragment["source"]
        if hashlib.sha256(source.encode()).hexdigest() != fragment["sha256"]:
            raise ClosedBoundaryError("fragment content mismatch")
        tree = ast.parse(textwrap.dedent(source))
        if len(tree.body) != 1 or not isinstance(tree.body[0], (ast.FunctionDef, ast.AnnAssign)):
            raise ClosedBoundaryError("unreviewed AST statement")
        ast.increment_lineno(tree, fragment["startLine"] - 1)
        code = compile(tree, "pinned/" + fragment["path"], "exec",
                       flags=__future__.annotations.compiler_flag)
        # Deliberate execution of only checked original function/constant AST nodes.
        exec(code, env)
        if isinstance(tree.body[0], ast.FunctionDef):
            methods[fragment["qualifiedName"]] = env[tree.body[0].name]
    return env, methods, closed_import, imports


def project(captured, driver):
    allowed = {"model", "messages", "tools", "max_tokens", "max_completion_tokens",
               "reasoning_effort", "temperature", "top_p", "parallel_tool_calls", "timeout", "extra_body"}
    # The unchanged pinned profile merge already forwards top_p request_overrides.
    # Recognizing it in this fixture projection does not admit sampling at the router.
    if set(captured) - allowed:
        raise ClosedBoundaryError("unknown SDK kwarg")
    body = dict(captured)
    timeout = body.pop("timeout", None)
    if timeout is not None and timeout != 5:
        raise ClosedBoundaryError("unexpected SDK-only timeout")
    extra = body.pop("extra_body", {})
    if not isinstance(extra, dict) or set(extra) & (set(body) | set(driver) | {"timeout"}):
        raise ClosedBoundaryError("extra_body collision")
    if set(extra) - {"reasoning"}:
        raise ClosedBoundaryError("unreviewed extra_body key")
    body.update(extra)
    if set(body) & set(driver):
        raise ClosedBoundaryError("driver collision")
    body.update(driver)
    return body


def run(case):
    configured_reasoning = {"configured-reasoning-high", "configured-reasoning-conflict"}
    configured_controls = {"configured-temperature", "configured-top-p",
                           "configured-strict-absent", "configured-strict-false",
                           "configured-strict-true"}
    omitted_tool_cases = {"omitted-cap-tools", "omitted-cap-tools-medium", "omitted-cap-tools-xhigh", "omitted-cap-tools-max", "omitted-cap-tools-parallel", "omitted-cap-tools-no-parallel"}
    allowed = {"explicit-medium", "explicit-high", "default-medium", "omitted-cap",
               "stream-tools", "omitted-cap-tools", "default-stream", "nonstream-tools", "tool-continuation",
               "unknown-provider", "unknown-import", "socket-canary",
               "extra-body-collision"} | configured_controls | configured_reasoning | omitted_tool_cases
    if case not in allowed:
        raise ClosedBoundaryError("unknown fixture case")
    profile = SimpleNamespace(name="custom", fixed_temperature=None, default_max_tokens=None,
                              supports_prompt_cache_key=False)
    env, methods, import_facade, imports = load_functions(profile)
    if case == "unknown-import":
        # Match pinned source's compatibility catch: policy denial must escape it.
        with contextlib.suppress(Exception):
            import_facade("socket")
    if case == "socket-canary":
        socket.socket()
    if case == "unknown-provider":
        only_custom("unknown", profile)
    for method in ("prepare_messages", "get_max_tokens", "build_extra_body"):
        setattr(profile, method, MethodType(methods["ProviderProfile." + method], profile))
    for method in ("build_api_kwargs_extras", "default_reasoning_config"):
        setattr(profile, method, MethodType(methods["CustomProfile." + method], profile))
    transport = SimpleNamespace(convert_messages=checked_identity)
    for method in ("build_kwargs", "_build_kwargs_from_profile"):
        setattr(transport, method, MethodType(methods["ChatCompletionsTransport." + method], transport))
    agent = SimpleNamespace(
        provider="custom", model=MODEL, base_url=BASE, _base_url_lower=BASE,
        max_tokens=None if case == "omitted-cap" or case in omitted_tool_cases else 64, _ollama_num_ctx=None,
        session_id="synthetic-session", openrouter_min_coding_score=None,
        _get_transport=lambda: transport, _is_qwen_portal=lambda: False,
        _is_openrouter_url=lambda: False, _is_direct_openai_url=lambda: False,
        _is_azure_openai_url=lambda: False, _is_github_copilot_url=lambda: False,
        _supports_reasoning_extra_body=lambda: False,
        _resolved_api_call_timeout=lambda: 5,
        _prepare_messages_for_non_vision_model=checked_identity,
    )
    agent._max_tokens_param = MethodType(methods["AIAgent._max_tokens_param"], agent)
    executed = set()

    def trace(frame, event, _arg):
        if event == "call" and frame.f_code.co_filename.startswith("pinned/"):
            executed.add(frame.f_code.co_filename + ":" + frame.f_code.co_name)

    sys.setprofile(trace)
    try:
        reasoning = profile.default_reasoning_config(MODEL) if case == "default-medium" else {
            "enabled": True, "effort": "medium" if case == "explicit-medium" else (case.removeprefix("omitted-cap-tools-") if case in {"omitted-cap-tools-medium", "omitted-cap-tools-xhigh", "omitted-cap-tools-max"} else "high"),
        }
        tools = [{"type": "function", "function": {"name": "synthetic_tool", "parameters": {
            "type": "object", "properties": {},
        }}}] if case in {"stream-tools", "nonstream-tools"} | omitted_tool_cases else []
        if case in configured_controls:
            # Supplied synthetic configuration, not registry discovery or a default.
            tools = [{"type": "function", "function": {"name": "synthetic_tool", "parameters": {
                "type": "object", "properties": {"item": {"type": "string"}},
                "required": ["item"], "additionalProperties": False,
            }}}]
            if case in {"configured-strict-false", "configured-strict-true"}:
                tools[0]["function"]["strict"] = case == "configured-strict-true"
        overrides = {"extra_body": {"model": "unintended"}} if case == "extra-body-collision" else {}
        if case in {"omitted-cap-tools-parallel", "omitted-cap-tools-no-parallel"}:
            overrides = {"parallel_tool_calls": case == "omitted-cap-tools-parallel"}
        if case == "configured-temperature":
            overrides = {"temperature": 0.7}
        if case == "configured-top-p":
            overrides = {"top_p": 0.9}
        if case in configured_reasoning:
            # Explicit synthetic request_overrides, merged by the original profile.
            # The original CustomProfile independently emits top-level High.
            overrides = {"extra_body": {"reasoning": {
                "enabled": True,
                "effort": "medium" if case == "configured-reasoning-conflict" else "high",
            }}}
        messages = [{"role": "user", "content": "Explain a synthetic lamp."}]
        if case == "tool-continuation":
            messages.extend([
                {"role": "assistant", "content": None, "tool_calls": [{
                    "id": "synthetic-call", "type": "function", "function": {
                        "name": "synthetic_tool", "arguments": "{}",
                    },
                }]},
                {"role": "tool", "tool_call_id": "synthetic-call", "content": "Synthetic result"},
            ])
        kwargs = methods["_build_chat_completions_kwargs"](
            agent, messages, tools, reasoning, overrides, None,
        )
    finally:
        sys.setprofile(None)
    captured = {}

    def capture_create(**value):
        captured.update(value)

    capture_create(**kwargs)
    driver = {"stream": True, "stream_options": {"include_usage": True}} if case in {"stream-tools", "default-stream"} | omitted_tool_cases | configured_controls | configured_reasoning else {"stream": False}
    return {
        "case": case, "pin": "749cb638ff43f9ce5333c186a1e4f67d473aa4f2",
        "proofKind": "original-source-kwargs-plus-declared-fixture-JSON-projection",
        "capturedKwargs": captured, "body": project(captured, driver),
        "driverFlags": driver, "sdkOnlyOmitted": ["timeout"] if "timeout" in captured else [],
        "executedSourceFunctions": sorted(executed), "importFacadesUsed": imports,
        "substitutions": SUBSTITUTIONS, "sdkWireCaptured": False, "fullHermesExecuted": False,
    }


if __name__ == "__main__":
    try:
        incoming = json.loads(sys.stdin.buffer.read(4096).decode("utf-8"))
        if set(incoming) != {"case"} or not isinstance(incoming["case"], str):
            raise ClosedBoundaryError("invalid fixture input")
        print(json.dumps(run(incoming["case"]), sort_keys=True))
    except ClosedBoundaryError:
        print(json.dumps({"ok": False, "error": "closed-fixture-boundary"}))
        sys.exit(2)
