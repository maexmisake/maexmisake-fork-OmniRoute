/**
 * System One transport: endpoint resolution and request headers.
 *
 * A decision call must only ever leave for the provider's own allowlisted
 * host(s). The endpoint is configurable per connection so an operator can
 * follow a vendor's path change without a release, but a host outside the
 * allowlist, a plaintext scheme, embedded credentials or a cloud-metadata
 * address are all rejected before any credential is attached.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SystemOneEndpointError,
  systemOneHeaders,
  systemOneUrl,
} from "../../open-sse/handlers/systemOneTransport.ts";

function captureError(fn: () => unknown): SystemOneEndpointError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof SystemOneEndpointError, `unexpected error: ${String(error)}`);
    return error as SystemOneEndpointError;
  }
  throw new Error("expected the call to throw");
}

test("each backend resolves its documented decision endpoint by default", () => {
  assert.equal(systemOneUrl("opencode", {}), "https://opencode.ai/inference/v1/systemone");
  assert.equal(
    systemOneUrl("vercel-ai-gateway", {}),
    "https://ai-gateway.vercel.sh/typesafe/v1/systemone"
  );
  assert.equal(systemOneUrl("openrouter", {}), "https://openrouter.ai/api/v1/systemone");
});

test("each backend resolves its documented catalog endpoint by default", () => {
  assert.equal(systemOneUrl("opencode", {}, "models"), "https://opencode.ai/zen/v1/models");
  assert.equal(
    systemOneUrl("vercel-ai-gateway", {}, "models"),
    "https://ai-gateway.vercel.sh/typesafe/v1/models"
  );
  assert.equal(
    systemOneUrl("openrouter", {}, "models"),
    "https://openrouter.ai/api/v1/models?output_modalities=decisions"
  );
});

test("a per-connection endpoint override on an allowlisted host is honored", () => {
  assert.equal(
    systemOneUrl("opencode", {
      providerSpecificData: { systemOneUrl: "https://opencode.ai/zen/v1/systemone" },
    }),
    "https://opencode.ai/zen/v1/systemone"
  );
  // A subdomain of the allowlisted host is accepted; vendors move APIs there.
  assert.equal(
    systemOneUrl("openrouter", {
      providerSpecificData: { systemOneUrl: "https://api.openrouter.ai/api/v2/systemone" },
    }),
    "https://api.openrouter.ai/api/v2/systemone"
  );
  assert.equal(
    systemOneUrl(
      "opencode",
      { providerSpecificData: { systemOneModelsUrl: "https://opencode.ai/zen/v2/models" } },
      "models"
    ),
    "https://opencode.ai/zen/v2/models"
  );
});

test("the decision override does not leak into the catalog read, or the reverse", () => {
  const connection = {
    providerSpecificData: { systemOneUrl: "https://opencode.ai/zen/v1/systemone" },
  };
  assert.equal(systemOneUrl("opencode", connection, "models"), "https://opencode.ai/zen/v1/models");
  const catalogOnly = {
    providerSpecificData: { systemOneModelsUrl: "https://opencode.ai/zen/v2/models" },
  };
  assert.equal(systemOneUrl("opencode", catalogOnly), "https://opencode.ai/inference/v1/systemone");
});

test("an override outside the provider's allowlisted hosts is rejected", () => {
  for (const url of [
    "https://evil.example.com/inference/v1/systemone",
    // Suffix-confusion: `notopencode.ai` is not a subdomain of `opencode.ai`.
    "https://notopencode.ai/inference/v1/systemone",
    "https://opencode.ai.evil.example/inference/v1/systemone",
    // Another registered backend's host is still not this provider's host.
    "https://openrouter.ai/api/v1/systemone",
  ]) {
    const error = captureError(() =>
      systemOneUrl("opencode", { providerSpecificData: { systemOneUrl: url } })
    );
    assert.equal(error.status, 400);
    assert.match(error.message, /allowlist/i);
  }
});

test("a plaintext, credentialed or malformed override is rejected", () => {
  for (const url of [
    "http://opencode.ai/inference/v1/systemone",
    "https://user:secret@opencode.ai/inference/v1/systemone",
    "ftp://opencode.ai/systemone",
    "not a url",
  ]) {
    const error = captureError(() =>
      systemOneUrl("opencode", { providerSpecificData: { systemOneUrl: url } })
    );
    assert.equal(error.status, 400);
    // The rejection must not quote the credential it just refused.
    assert.doesNotMatch(error.message, /secret/);
  }
});

test("a blank override is treated as unset, not as an error", () => {
  for (const blank of ["", "   "]) {
    assert.equal(
      systemOneUrl("opencode", { providerSpecificData: { systemOneUrl: blank } }),
      "https://opencode.ai/inference/v1/systemone"
    );
  }
});

test("a cloud-metadata or private address override is rejected even if spelled as the host", () => {
  for (const url of ["https://169.254.169.254/systemone", "http://127.0.0.1/systemone"]) {
    const error = captureError(() =>
      systemOneUrl("openrouter", { providerSpecificData: { systemOneUrl: url } })
    );
    assert.equal(error.status, 400);
  }
});

test("an unregistered provider cannot produce a URL", () => {
  assert.throws(() => systemOneUrl("anthropic", {}));
});

test("headers carry the connection bearer token and JSON content types", () => {
  const headers = systemOneHeaders("openrouter", { apiKey: "sk-test-key" });
  assert.equal(headers.Authorization, "Bearer sk-test-key");
  assert.equal(headers["Content-Type"], "application/json");
  assert.equal(headers.Accept, "application/json");
});

test("an OAuth access token is used when no API key is stored", () => {
  assert.equal(
    systemOneHeaders("openrouter", { accessToken: "oauth-token" }).Authorization,
    "Bearer oauth-token"
  );
});

test("a keyless free-tier connection sends no Authorization header", () => {
  const headers = systemOneHeaders("opencode", { apiKey: null, accessToken: null });
  assert.equal("Authorization" in headers, false);
  assert.equal(headers.Accept, "application/json");
});

test("client-supplied headers cannot be injected through providerSpecificData", () => {
  const headers = systemOneHeaders("openrouter", {
    apiKey: "sk-test-key",
    providerSpecificData: { headers: { Authorization: "Bearer attacker", "X-Evil": "1" } },
  });
  assert.equal(headers.Authorization, "Bearer sk-test-key");
  assert.equal("X-Evil" in headers, false);
});
