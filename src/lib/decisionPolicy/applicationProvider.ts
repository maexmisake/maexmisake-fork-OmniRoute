import { getProviderValidationGuard } from "@/shared/network/outboundUrlGuardPolicy";
import {
  hasAmbientProxyContext,
  isTlsFingerprintActive,
  resolveProxyForRequest,
} from "../../../open-sse/utils/proxyFetch.ts";
import type { Candidate } from "../../../open-sse/services/decisionPolicy/contract.ts";
import type { ProviderCredentials } from "../../../open-sse/executors/base/validationDispatch.ts";
import { parseTokenExpiryMs } from "../tokenHealthCheckExpiry";

export type ApplicationProvider = {
  claude: boolean;
  endpoint: string;
  credentials: ProviderCredentials;
};
export function isBoundedClaudePair(model: string, effort: string): boolean {
  return (
    (model === "claude-opus-5-5" && ["medium", "high", "xhigh", "max"].includes(effort)) ||
    (model === "claude-sonnet-5-5" && ["medium", "high", "xhigh", "max"].includes(effort)) ||
    (model === "claude-haiku-5-5" && ["medium", "high", "xhigh", "max"].includes(effort))
  );
}
export function assertReadyClaudeOAuth(credentials: ProviderCredentials): void {
  if (
    !credentials.accessToken ||
    credentials.apiKey ||
    parseTokenExpiryMs(credentials.expiresAt) < Date.now() + 60_000
  )
    throw new Error("decision_oauth_unsupported");
}
export function resolveApplicationProvider(
  candidate: Candidate,
  connection: Record<string, unknown>
): ApplicationProvider {
  const data = (connection.providerSpecificData ?? {}) as Record<string, unknown>;
  if (data.extraApiKeys || data.cliproxyapiMode || data.darioMode)
    throw new Error("decision_connection_unsupported");
  if (candidate.provider === "claude") {
    if (
      connection.authType !== "oauth" ||
      !isBoundedClaudePair(candidate.model, candidate.effort.value ?? "")
    )
      throw new Error("decision_connection_unsupported");
    // OAuth tokens stay on the canonical existing native Messages transport.
    if (Object.keys(data).length !== 0) throw new Error("decision_connection_unsupported");
    const credentials: ProviderCredentials = {
      accessToken: typeof connection.accessToken === "string" ? connection.accessToken : undefined,
      refreshToken:
        typeof connection.refreshToken === "string" ? connection.refreshToken : undefined,
      expiresAt: String(connection.tokenExpiresAt || connection.expiresAt || ""),
      ...(connection.apiKey ? { apiKey: String(connection.apiKey) } : {}),
      connectionId: String(connection.id),
    };
    assertReadyClaudeOAuth(credentials);
    return {
      claude: true,
      credentials,
      endpoint: "https://api.anthropic.com/v1/messages?beta=true",
    };
  }
  if (candidate.provider !== "openai" || connection.authType !== "apikey")
    throw new Error("decision_connection_unsupported");
  const base =
    typeof data.baseUrl === "string" ? data.baseUrl : "https://api.openai.com/v1/chat/completions";
  return {
    claude: false,
    credentials: { apiKey: String(connection.apiKey), connectionId: String(connection.id) },
    endpoint: new URL(
      base.endsWith("/chat/completions") ? base : base.replace(/\/$/, "") + "/chat/completions"
    ).href,
  };
}
function textBlocks(value: unknown): boolean {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        block &&
        block.type === "text" &&
        typeof block.text === "string" &&
        Object.keys(block).every((key) => ["type", "text", "cache_control"].includes(key))
    )
  );
}
export function claudeWireFacts(
  wire: Record<string, unknown>,
  effort: string,
  outputLimit: number,
  stream = false
) {
  const thinking = wire.thinking as Record<string, unknown> | undefined;
  const output = wire.output_config as Record<string, unknown> | undefined;
  const messages = wire.messages as Array<Record<string, unknown>> | undefined;
  const allowed = [
    "model",
    "messages",
    "stream",
    "max_tokens",
    "system",
    "metadata",
    "thinking",
    "output_config",
    "context_management",
  ];
  if (
    Object.keys(wire).some((key) => !allowed.includes(key)) ||
    wire.stream !== stream ||
    wire.max_tokens !== outputLimit
  )
    throw new Error("decision_final_request_unsupported");
  if (
    thinking?.type !== "adaptive" ||
    output?.effort !== effort ||
    Object.keys(output).some((key) => key !== "effort")
  )
    throw new Error("decision_identity_changed");
  if (
    Object.keys(thinking).some((key) => !["type", "display"].includes(key)) ||
    (thinking.display !== undefined &&
      !["omitted", "summarized"].includes(String(thinking.display)))
  )
    throw new Error("decision_final_request_unsupported");
  if (
    wire.context_management !== undefined &&
    JSON.stringify(wire.context_management) !==
      JSON.stringify({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] })
  )
    throw new Error("decision_final_request_unsupported");
  if (
    !Array.isArray(messages) ||
    !messages.every(
      (message) =>
        ["user", "assistant"].includes(String(message.role)) &&
        textBlocks(message.content) &&
        Object.keys(message).every((key) => ["role", "content"].includes(key))
    )
  )
    throw new Error("decision_final_request_unsupported");
  if (wire.system !== undefined && !textBlocks(wire.system))
    throw new Error("decision_final_request_unsupported");
  // Used only to recheck bounded request facts; the actual Messages body is untouched.
  return messages.map((message) => ({ role: message.role, content: message.content }));
}
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
export function claudeReportedUsage(usage: Record<string, unknown>) {
  const input = count(usage.input_tokens),
    cacheRead = count(usage.cache_read_input_tokens),
    cacheCreation = count(usage.cache_creation_input_tokens);
  const total =
    input === null || cacheRead === null || cacheCreation === null
      ? null
      : input + cacheRead + cacheCreation;
  return {
    input: total !== null && Number.isSafeInteger(total) ? total : null,
    output: count(usage.output_tokens),
    cacheRead,
    cacheCreation,
    reasoning: null,
    uncachedInput: input,
  };
}

export function assertApplicationEgress(provider: string, url: string): void {
  if (
    getProviderValidationGuard() === "none" ||
    hasAmbientProxyContext() ||
    isTlsFingerprintActive(provider, false) ||
    process.env.ENABLE_TLS_FINGERPRINT === "true" ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    process.env.PROXY_FAIL_OPEN === "true" ||
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"].some(
      (key) => !!process.env[key]
    ) ||
    resolveProxyForRequest(url).source !== "direct"
  )
    throw new Error("decision_egress_unsupported");
}
