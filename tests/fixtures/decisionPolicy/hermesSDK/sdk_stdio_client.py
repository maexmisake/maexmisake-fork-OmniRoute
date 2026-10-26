"""Actual locked SDK over a bounded, socket-free test-only stdio transport."""
import base64
import importlib.metadata
import importlib.util
import json
from pathlib import Path
import socket
import sys

ROOT = Path(__file__).resolve().parent
MAX_LINE = 1_500_000


def denied(*_args, **_kwargs):
    raise RuntimeError("SDK fixture forbids network sockets")




def read_line():
    raw = sys.stdin.buffer.readline(MAX_LINE + 1)
    if not raw or len(raw) > MAX_LINE or not raw.endswith(b"\n"):
        raise RuntimeError("SDK fixture input boundary")
    return json.loads(raw)


def emit(value):
    raw = json.dumps(value, separators=(",", ":"), allow_nan=False)
    if len(raw) > MAX_LINE:
        raise RuntimeError("SDK fixture output boundary")
    print(raw, flush=True)


def check_versions():
    selected = json.loads((ROOT / "selected-wheels.json").read_text())
    for package in selected["packages"]:
        if importlib.metadata.version(package["name"]) != package["version"]:
            raise RuntimeError("SDK fixture requires exact installed lock")
    if sys.version_info[:2] != (3, 12):
        raise RuntimeError("SDK fixture lock is for standalone Python 3.12")


def load_tool_helpers():
    path = ROOT.parent / "hermesTools" / "tool_protocol_fixture.py"
    spec = importlib.util.spec_from_file_location("pinned_tool_helpers", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    raw = (path.parent / "tool-protocol-fragments.json").read_bytes()
    import hashlib
    provenance = json.loads((path.parent / "fragment-provenance.json").read_text())
    if hashlib.sha256(raw).hexdigest() != provenance["fragmentFileSHA256"]:
        raise RuntimeError("SDK fixture fragment integrity")
    env, statements, _imports, _closed_import = module.load_fragments(json.loads(raw)["fragments"])
    return module, env, statements


def original_results(message, initial_messages):
    # Actual SDK-assembled message/call objects enter unchanged original constructors.
    helpers, env, statements = load_tool_helpers()
    assistant = env["build_assistant_message"](helpers.agent_fixture(), message, "tool_calls")
    messages = [*initial_messages, assistant]
    for call in reversed(assistant["tool_calls"]):
        result = env["make_tool_result_message"](call["function"]["name"], "Synthetic result", call["id"])
        env.update(messages=messages, tool_message=result)
        exec(statements["_commit_tool_result:append_statement_only"], env)
    projected = []
    for row in messages:
        import copy
        env["api_msg"] = copy.deepcopy(row)
        for name in ("api_content_pop", "persistence_pop", "finish_reason_pop"):
            exec(statements["build_api_messages:" + name + "_statement_only"], env)
        wire = env["api_msg"]
        clean = env["_sanitize_message"](wire, True,
            frozenset({"reasoning", "reasoning_content", "reasoning_details"}), None,
            mistral_tool_ids=False)
        projected.append(wire if clean is None else clean)
    return projected


def main():
    check_versions()
    import httpx
    import openai
    from openai.lib.streaming.chat import ChatCompletionStreamState
    socket.socket = denied
    socket.create_connection = denied
    socket.getaddrinfo = denied
    config = read_line()
    if set(config) != {"key", "kwargs", "driverFlags", "mode"}:
        raise RuntimeError("SDK fixture configuration boundary")
    requests = 0
    metrics = []

    class BridgeStream(httpx.SyncByteStream):
        def __init__(self, request_id):
            self.id = request_id
            self.done = False
            self.closed = False
            self.bytes = 0
            self.metric = {"id": request_id, "pulls": 0, "eofRead": False, "closedBeforeEOF": False}
            metrics.append(self.metric)

        def __iter__(self):
            while not self.done:
                emit({"kind": "pull", "id": self.id})
                self.metric["pulls"] += 1
                row = read_line()
                if row.get("id") != self.id:
                    raise RuntimeError("SDK fixture response identity")
                if row.get("kind") == "end":
                    self.done = True
                    self.metric["eofRead"] = True
                    return
                if row.get("kind") == "stream_error":
                    self.done = True
                    raise httpx.ReadError("Synthetic handler stream rejected")
                if row.get("kind") != "chunk":
                    raise RuntimeError("SDK fixture chunk boundary")
                chunk = base64.b64decode(row["data"], validate=True)
                self.bytes += len(chunk)
                if len(chunk) > 65536 or self.bytes > 1048576:
                    raise RuntimeError("SDK fixture response size")
                yield chunk

        def close(self):
            if self.closed:
                return
            self.closed = True
            if not self.done:
                self.metric["closedBeforeEOF"] = True
                emit({"kind": "close", "id": self.id})
                row = read_line()
                if row != {"kind": "closed", "id": self.id}:
                    raise RuntimeError("SDK fixture close boundary")

    def dispatch(request):
        nonlocal requests
        requests += 1
        if requests > 2 or request.method != "POST" or str(request.url) != "https://hermes.fixture.invalid/v1/chat/completions":
            raise RuntimeError("SDK fixture request boundary")
        body = request.content
        if len(body) > 262144:
            raise RuntimeError("SDK fixture request size")
        emit({"kind": "request", "id": requests, "method": request.method,
              "url": str(request.url), "headers": dict(request.headers),
              "body": base64.b64encode(body).decode()})
        row = read_line()
        if row.get("kind") != "headers" or row.get("id") != requests:
            raise RuntimeError("SDK fixture header boundary")
        return httpx.Response(row["status"], headers=row["headers"], stream=BridgeStream(requests), request=request)

    transport = httpx.MockTransport(dispatch)
    summaries = []
    with httpx.Client(transport=transport, trust_env=False) as http:
        client = openai.OpenAI(api_key=config["key"], base_url="https://hermes.fixture.invalid/v1", max_retries=0, http_client=http)
        kwargs = {**config["kwargs"], **config["driverFlags"]}
        for stage in range(2 if config["mode"] == "tool-loop" else 1):
            if kwargs.get("stream"):
                state = ChatCompletionStreamState(input_tools=kwargs.get("tools", []))
                with client.chat.completions.create(**kwargs) as stream:
                    for chunk in stream:
                        state.handle_chunk(chunk)
                        if config["mode"] == "cancel":
                            break
                if config["mode"] == "cancel":
                    summaries.append({"cancelled": True})
                    break
                completion = state.get_final_completion()
            else:
                completion = client.chat.completions.create(**kwargs)
            choice = completion.choices[0]
            calls = choice.message.tool_calls or []
            summaries.append({"model": completion.model, "finishReason": choice.finish_reason,
                              "callCount": len(calls), "content": choice.message.content,
                              "usage": completion.usage.model_dump() if completion.usage else None,
                              "calls": [{"id": c.id, "name": c.function.name, "arguments": c.function.arguments} for c in calls]})
            if config["mode"] == "tool-loop" and stage == 0:
                if not calls:
                    raise RuntimeError("SDK fixture expected complete tools")
                kwargs["messages"] = original_results(choice.message, kwargs["messages"])
        client.close()
    emit({"kind": "result", "ok": True, "sdk": openai.__version__, "python": ".".join(map(str, sys.version_info[:3])),
          "requests": requests, "metrics": metrics, "summaries": summaries,
          "sdkWireCaptured": True, "sdkParserExecuted": True, "fullHermesExecuted": False, "actualToolsRun": False})


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"kind": "result", "ok": False, "errorClass": type(error).__name__,
              "status": getattr(error, "status_code", None), "fullHermesExecuted": False, "actualToolsRun": False})
        sys.exit(2)
