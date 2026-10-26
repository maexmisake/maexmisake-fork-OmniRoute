"""Pinned main-loop/default resolution with an optional, uninstalled client patch.

Original byte-verified fragments are reused from hermesPinned. The default
resolver is explicitly a previously retrieved web-rendered fragment, not a
fabricated raw blob. No CLI initialization, credentials, discovery or sockets.
"""

import __future__
import ast
import dataclasses
import hashlib
import json
import runpy
import sys
from pathlib import Path
from types import MethodType, ModuleType, SimpleNamespace
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
PACKAGE = REPO / "scripts/ad-hoc/hermes-effort-delegation"
MODEL = "synthetic-hermes-pinned"
BASE = "https://hermes.fixture.invalid/v1"
PROVIDER = "omniroute-delegated"
PIN = "749cb638ff43f9ce5333c186a1e4f67d473aa4f2"

OLD = runpy.run_path(str(ROOT.parent / "hermesPinned/build_request.py"))
ClosedBoundaryError = OLD["ClosedBoundaryError"]


def checked_fragment(fragment):
    source = fragment["source"]
    if hashlib.sha256(source.encode()).hexdigest() != fragment["sha256"]:
        raise ClosedBoundaryError("fragment mismatch")
    return source


def source_fragments():
    raw = (ROOT / "upstream-fragments.json").read_bytes()
    provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
    if hashlib.sha256(raw).hexdigest() != provenance["fragmentFileSHA256"]:
        raise ClosedBoundaryError("fragment aggregate mismatch")
    data = json.loads(raw)
    if data["commit"] != PIN:
        raise ClosedBoundaryError("wrong source pin")
    for row in data["fragments"]:
        checked_fragment(row)
    return {row["qualifiedName"]: row for row in data["fragments"]}


def compile_function(source, env, path):
    tree = ast.parse(source)
    if len(tree.body) != 1 or not isinstance(tree.body[0], ast.FunctionDef):
        raise ClosedBoundaryError("unexpected function AST")
    exec(compile(tree, "pinned/" + path, "exec", flags=__future__.annotations.compiler_flag), env)
    return env[tree.body[0].name]


def patched_function(name, source, patch_pin):
    declared = patch_pin["functions"][name]
    if hashlib.sha256(source.encode()).hexdigest() != declared["originalSHA256"]:
        raise ClosedBoundaryError("guard original function mismatch")
    guard = next(row for row in patch_pin["guards"] if row["function"] == name)
    anchor, addition = guard["anchor"], guard["addition"]
    if source.count(anchor) != 1:
        raise ClosedBoundaryError("guard anchor mismatch")
    replacement = anchor + addition if guard["after"] else addition + anchor
    result = source.replace(anchor, replacement, 1)
    if hashlib.sha256(result.encode()).hexdigest() != declared["patchedSHA256"]:
        raise ClosedBoundaryError("guard patched function mismatch")
    return result


def base_class(fragment, methods):
    module = ModuleType("_closed_hermes_provider_base")
    module.__dict__.update(dataclass=dataclasses.dataclass, Any=object)
    sys.modules[module.__name__] = module
    exec(compile(checked_fragment(fragment), "pinned/providers/base.py", "exec",
                 flags=__future__.annotations.compiler_flag), module.__dict__)
    cls = module.ProviderProfile
    for name in ("prepare_messages", "get_max_tokens", "build_extra_body"):
        setattr(cls, name, methods["ProviderProfile." + name])
    return cls


def relay_profile(base, env, binding):
    # Own pure profile imports only these actual interface names. No profile
    # loader/credential/config I/O is executed by this capture fixture.
    provider = ModuleType("providers")
    provider.__path__ = []
    provider_base = ModuleType("providers.base")
    provider_base.ProviderProfile = base
    agent = ModuleType("agent")
    agent.__path__ = []
    effort = ModuleType("agent.reasoning_effort")
    effort.OPENAI_COMPAT_WIRE_EFFORTS = env["OPENAI_COMPAT_WIRE_EFFORTS"]
    effort.clamp_effort = env["clamp_effort"]
    for module in (provider, provider_base, agent, effort):
        sys.modules[module.__name__] = module
    own = runpy.run_path(str(PACKAGE / "profile.py"))
    return own["DelegatingRelayProfile"](binding)


CASES = {
    "ordinary-custom-unset", "ordinary-custom-medium", "ordinary-custom-high", "ordinary-custom-off",
    "delegated-unset", "explicit-medium", "explicit-high", "explicit-off", "explicit-none",
    "recovery-off", "recovery-effort-rejected", "recovery-disable-rejected",
    "missing-profile", "wrong-profile", "profile-lookup-error",
    "wrong-destination", "lookalike-destination", "wrong-combo", "disabled",
    "unsupported-api-mode", "unpatched-missing-profile", "override-medium",
    "explicit-xhigh", "explicit-max", "ordinary-custom-xhigh", "ordinary-custom-max",
}


def run(incoming):
    if not isinstance(incoming, dict) or set(incoming) - {"case", "messages", "tools"}:
        raise ClosedBoundaryError("invalid input keys")
    case = incoming.get("case")
    if case not in CASES:
        raise ClosedBoundaryError("unknown case")
    if "tools" in incoming and not isinstance(incoming["tools"], bool):
        raise ClosedBoundaryError("invalid tool option")
    messages = incoming.get("messages", [{"role": "user", "content": "Explain a synthetic lamp."}])
    if not isinstance(messages, list) or len(messages) > 256:
        raise ClosedBoundaryError("invalid supplied message history")
    if len(json.dumps(messages).encode()) > 65536:
        raise ClosedBoundaryError("supplied message history too large")

    placeholder = SimpleNamespace(name="custom", fixed_temperature=None, default_max_tokens=None,
                                  supports_prompt_cache_key=False)
    env, methods, original_import, imports = OLD["load_functions"](placeholder)
    fragments = source_fragments()
    base = base_class(fragments["ProviderProfile.fixtureFieldSubset"], methods)
    profile = relay_profile(base, env, {"enabled": case != "disabled", "base_url": BASE, "combo": MODEL})
    custom = base(name="custom")
    for name in ("default_reasoning_config", "build_api_kwargs_extras"):
        setattr(custom, name, MethodType(methods["CustomProfile." + name], custom))

    def lookup(name):
        if name == "custom":
            return custom
        if name != PROVIDER:
            raise ClosedBoundaryError("unknown provider identity")
        if case == "profile-lookup-error":
            raise ValueError("synthetic profile lookup failure")
        if case in ("missing-profile", "unpatched-missing-profile"):
            return None
        return custom if case == "wrong-profile" else profile

    def capabilities(provider, model, *, allow_network):
        if allow_network is not False:
            raise ClosedBoundaryError("unexpected capability network request")
        return None  # Honest unknown, never spoofed non-reasoning capability.

    def closed_import(name, globals=None, locals=None, fromlist=(), level=0):
        facades = {
            "providers": SimpleNamespace(get_provider_profile=lookup),
            "agent.reasoning_params": SimpleNamespace(unset_reasoning_default=env.get("unset_reasoning_default")),
            "agent.models_dev": SimpleNamespace(get_model_capabilities=capabilities),
            "agent.opencode_affinity": SimpleNamespace(merge_session_affinity_headers=lambda value, *_: value),
        }
        if not level and name in facades:
            result = facades[name]
            if any(not hasattr(result, key) for key in fromlist):
                raise ClosedBoundaryError("unknown facade member")
            imports.append({"module": name, "attributes": list(fromlist)})
            return result
        return original_import(name, globals, locals, fromlist, level)

    env["__builtins__"]["__import__"] = closed_import
    allowed_urls = {BASE, BASE + "/other", "https://hermes.fixture.invalid.attacker.invalid/v1"}

    def host_matches(url, domain):
        if url not in allowed_urls:
            raise ClosedBoundaryError("unknown fixture endpoint")
        host = (urlparse(url).hostname or "").lower()
        return host == domain or host.endswith("." + domain)

    env.update(base_url_host_matches=host_matches,
               effective_request_overrides=lambda agent: dict(agent.request_overrides),
               _prompt_cache_scope_for_agent=lambda _agent: None)
    patch_pin = json.loads((PACKAGE / "PATCH-PIN.json").read_text(encoding="utf-8"))
    if hashlib.sha256((PACKAGE / "hermes-749cb638.patch").read_bytes()).hexdigest() != patch_pin["patchSHA256"]:
        raise ClosedBoundaryError("patch artifact mismatch")
    for name, row in fragments.items():
        if name == "ProviderProfile.fixtureFieldSubset":
            continue
        source = row["source"]
        if name == "_build_api_kwargs_for_mode" and case != "unpatched-missing-profile":
            source = patched_function(name, source, patch_pin)
        compile_function(source, env, row["path"])
    old_rows = json.loads((ROOT.parent / "hermesPinned/upstream-fragments.json").read_text(encoding="utf-8"))["fragments"]
    original_builder = next(row["source"] for row in old_rows if row["qualifiedName"] == "_build_chat_completions_kwargs")
    patched = original_builder if case == "unpatched-missing-profile" else patched_function(
        "_build_chat_completions_kwargs", original_builder, patch_pin)
    compile_function(patched, env, "agent/chat_completion_helpers.py")

    transport = SimpleNamespace(convert_messages=OLD["checked_identity"])
    for name in ("build_kwargs", "_build_kwargs_from_profile"):
        setattr(transport, name, MethodType(methods["ChatCompletionsTransport." + name], transport))
    reasoning = None
    if case in ("explicit-medium", "ordinary-custom-medium"):
        reasoning = {"enabled": True, "effort": "medium"}
    if case in ("explicit-high", "ordinary-custom-high", "missing-profile", "wrong-profile", "profile-lookup-error", "unpatched-missing-profile", "recovery-effort-rejected"):
        reasoning = {"enabled": True, "effort": "high"}
    if case in ("explicit-xhigh", "ordinary-custom-xhigh", "explicit-max", "ordinary-custom-max"):
        reasoning = {"enabled": True, "effort": case.rsplit("-", 1)[1]}
    if case in ("explicit-off", "ordinary-custom-off", "recovery-disable-rejected"):
        reasoning = {"enabled": False, "effort": "none"}
    if case == "explicit-none":
        reasoning = {"enabled": True, "effort": "none"}
    tools = [{"type": "function", "function": {"name": "synthetic_tool", "parameters": {
        "type": "object", "properties": {"item": {"type": "string"}}, "required": ["item"],
    }}}] if incoming.get("tools", True) else []
    agent = SimpleNamespace(
        provider="custom" if case.startswith("ordinary-custom") else PROVIDER,
        model="synthetic-other-combo" if case == "wrong-combo" else MODEL,
        base_url=BASE + "/other" if case == "wrong-destination" else (
            "https://hermes.fixture.invalid.attacker.invalid/v1" if case == "lookalike-destination" else BASE),
        api_mode="codex_responses" if case == "unsupported-api-mode" else "chat_completions",
        reasoning_config=reasoning, tools=tools, max_tokens=64, _ollama_num_ctx=None,
        _ephemeral_reasoning_off=case == "recovery-off",
        _reasoning_effort_rejected=case == "recovery-effort-rejected",
        _reasoning_disable_rejected=case == "recovery-disable-rejected",
        _reasoning_floor_required=False,
        session_id="synthetic-effort-session", openrouter_min_coding_score=None,
        _get_transport=lambda: transport, _is_qwen_portal=lambda: False,
        _is_openrouter_url=lambda: False, _supports_reasoning_extra_body=lambda: False,
        _is_direct_openai_url=lambda: False, _is_azure_openai_url=lambda: False,
        _is_github_copilot_url=lambda: False,
        _resolved_api_call_timeout=lambda: 5,
        _prepare_messages_for_non_vision_model=OLD["checked_identity"],
        request_overrides={"reasoning_effort": "medium"} if case == "override-medium" else {},
    )
    agent._base_url_lower = agent.base_url
    agent._max_tokens_param = MethodType(methods["AIAgent._max_tokens_param"], agent)
    env["_consume_ephemeral_max_output"] = lambda _agent: None
    captured = {}
    executed = set()

    def trace(frame, event, _arg):
        if event == "call" and frame.f_code.co_filename.startswith("pinned/"):
            executed.add(frame.f_code.co_filename + ":" + frame.f_code.co_name)

    sys.setprofile(trace)
    try:
        kwargs = env["build_api_kwargs"](agent, messages, tools)
        captured.update(kwargs)
    except ValueError as error:
        code = str(error)
        if not code.startswith("omniroute_delegation_"):
            raise ClosedBoundaryError("unexpected builder error") from None
        return {"ok": False, "case": case, "error": code, "captureCreateCalls": 0,
                "sdkWireCaptured": False, "fullHermesExecuted": False, "pin": PIN,
                "executedSourceFunctions": sorted(executed)}
    finally:
        sys.setprofile(None)
    driver = {"stream": True, "stream_options": {"include_usage": True}}
    return {
        "ok": True, "case": case, "pin": PIN,
        "capturedKwargs": captured, "driverFlags": driver,
        "body": OLD["project"](captured, driver), "clientBaseURL": agent.base_url,
        "wireReasoningConfig": getattr(agent, "_wire_reasoning_config", None),
        "ephemeralOffRemaining": agent._ephemeral_reasoning_off,
        "captureCreateCalls": 1, "sdkWireCaptured": False, "fullHermesExecuted": False,
        "proofKind": "pinned-main-loop-builder-with-explicit-optional-profile-and-source-patch",
        "defaultResolverSourceKind": "previously-retrieved-official-web-rendered-fragment",
        "importFacadesUsed": imports,
        "executedSourceFunctions": sorted(executed),
    }


if __name__ == "__main__":
    try:
        incoming = json.loads(sys.stdin.buffer.read(131073).decode("utf-8"))
        print(json.dumps(run(incoming), sort_keys=True))
    except ClosedBoundaryError:
        print(json.dumps({"ok": False, "error": "closed-fixture-boundary"}))
        sys.exit(2)
