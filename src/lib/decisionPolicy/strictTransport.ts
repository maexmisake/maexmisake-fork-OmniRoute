import { MockAgent, fetch as undiciFetch } from "undici";
import {
  hasAmbientProxyContext,
  isDirectFetchContext,
  isTlsFingerprintActive,
  resolveProxyForRequest,
} from "../../../open-sse/utils/proxyFetch.ts";

export const STRICT_CHAT_URL = "https://api.openai.com/v1/chat/completions";
export function assertStrictDirectEgress(): void {
  if (
    hasAmbientProxyContext() ||
    isDirectFetchContext() ||
    process.env.ENABLE_TLS_FINGERPRINT === "true" ||
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ||
    isTlsFingerprintActive("openai", false) ||
    resolveProxyForRequest(STRICT_CHAT_URL).source !== "direct"
  )
    throw new Error("policy_egress_unsupported");
}
/** Synthetic integration transport only. A real transport requires a prepared
 * application authorization/redaction/egress/accounting capability not yet implemented. */
export function strictTransport(mode: { fixtureAgent: MockAgent } | { fixtureAgent?: undefined }) {
  if (!mode.fixtureAgent) throw new Error("production_transport_unvalidated");
  assertStrictDirectEgress();
  if (
    mode.fixtureAgent.constructor !== MockAgent ||
    Object.getPrototypeOf(mode.fixtureAgent) !== MockAgent.prototype
  )
    throw new Error("policy_fixture_unsupported");
  const agent = mode.fixtureAgent;
  agent.activate();
  agent.disableNetConnect();
  return {
    synthetic: true,
    async send(url: string, init: RequestInit): Promise<Response> {
      assertStrictDirectEgress();
      init.signal?.throwIfAborted();
      if (url !== STRICT_CHAT_URL || init.method !== "POST")
        throw new Error("policy_endpoint_mismatch");
      return (await undiciFetch(url, {
        ...init,
        redirect: "error",
        dispatcher: agent,
      } as Parameters<typeof undiciFetch>[1])) as unknown as Response;
    },
    // The fixture owner closes its supplied agent after assertions. No real socket/agent exists here.
    close: async () => {},
  };
}
