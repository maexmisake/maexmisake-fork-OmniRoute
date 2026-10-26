import "../_setup/isolateDataDir.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { prepareClaudeRequest } from "../../open-sse/translator/helpers/claudeHelper.ts";
import {
  withApplicationAttempt,
  type ApplicationAttempt,
} from "../../open-sse/services/decisionPolicy/applicationContext.ts";
function conversation() {
  return {
    model: "claude-sonnet-5-5",
    thinking: { type: "adaptive" },
    messages: [
      { role: "user", content: [{ type: "text", text: "Synthetic task" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Synthetic first", signature: "synthetic-first-signature" },
          { type: "tool_use", id: "call_repeated", name: "proxy_lookup", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_repeated", content: "Synthetic first result" },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: "Synthetic second",
            signature: "synthetic-second-signature",
          },
          { type: "tool_use", id: "call_repeated", name: "proxy_lookup", input: { x: 1 } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_repeated", content: "Synthetic second result" },
        ],
      },
    ],
  };
}
test("trusted bounded occurrence guard preserves both signed blocks in an active multi-group cycle", () => {
  const seen: number[] = [];
  // Formatter-only fixture. This deliberately cannot authorize/reserve a provider request.
  const context = {
    tools: {
      preserveWireThinking(message: unknown, messages: unknown[], index: number) {
        assert.equal(messages[index], message);
        seen.push(index);
        return true;
      },
    },
  } as unknown as ApplicationAttempt;
  const result = withApplicationAttempt(context, () =>
    prepareClaudeRequest(conversation(), "claude", false, "claude-sonnet-5-5")
  );
  const messages = result.messages!;
  assert.deepEqual(messages[1].content[0], {
    type: "thinking",
    thinking: "Synthetic first",
    signature: "synthetic-first-signature",
  });
  assert.deepEqual(messages[3].content[0], {
    type: "thinking",
    thinking: "Synthetic second",
    signature: "synthetic-second-signature",
  });
  assert.deepEqual(seen, [3, 1]);
});

test("ordinary untrusted repeated-ID history retains the existing global repair behavior", async () => {
  const { openaiToClaudeRequest } =
    await import("../../open-sse/translator/request/openai-to-claude.ts");
  const group = (text: string) => [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "repeated_call", type: "function", function: { name: "lookup", arguments: "{}" } },
      ],
    },
    { role: "tool", tool_call_id: "repeated_call", content: text },
  ];
  const result = openaiToClaudeRequest(
    "claude-sonnet-5-5",
    {
      messages: [{ role: "user", content: "Synthetic" }, ...group("first"), ...group("second")],
      reasoning_effort: "high",
      max_tokens: 64,
    },
    true,
    { _provider: "claude" }
  );
  const text = JSON.stringify(result.messages);
  assert.match(text, /Unpaired tool result repeated_call/);
  assert.match(text, /second/);
});
