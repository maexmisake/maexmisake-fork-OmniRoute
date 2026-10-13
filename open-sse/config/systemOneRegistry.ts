/**
 * System One (typed decision) backend registry.
 *
 * System One models answer typed questions — `noul` (yes/no), `choice` and
 * `score` — with calibrated probabilities instead of text, so they are not chat
 * models and are never dispatched by a chat executor. This module is the single
 * place that knows which OmniRoute providers can serve them, where their
 * decision and catalog endpoints live, and how a client-supplied model id maps
 * onto a concrete `(provider, model)` target.
 *
 * Adding a backend is a data change: register it in `SYSTEMONE_BACKENDS` (with
 * the hosts an operator may point a connection at) and, if it should answer a
 * bare user-facing alias, add its model id to that alias in
 * `SYSTEMONE_MODEL_ALIASES`. Nothing else in the integration is per-provider.
 *
 * Wire contracts are taken from each vendor's published documentation and are
 * marked `contractVerified: false` — no live call has confirmed them from this
 * checkout, and an operator can override the endpoint per connection within the
 * provider's allowlisted hosts.
 */

import { hasUnsafeModelIdSyntax } from "../utils/modelIdSafety.ts";

/** Thrown for a caller-supplied target that cannot be resolved. Carries no request state. */
export class SystemOneTargetError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "SystemOneTargetError";
    this.status = status;
  }
}

export type SystemOneTier = "free" | "paid";

/**
 * Request-shape limits enforced before a credential is spent.
 *
 * The candidate/question counts are the Jev model family's own documented
 * limits (choice accepts at most 255 options, Score at most 10 levels), so all
 * three backends share them while staying overridable per backend. `maxBodyBytes`
 * is OmniRoute's own guard, not a vendor-published figure.
 */
export type SystemOneLimits = {
  maxQuestions: number;
  minCriteria: number;
  maxChoiceCriteria: number;
  maxScoreLevels: number;
  maxBodyBytes: number;
};

export const JEV_SYSTEMONE_LIMITS: SystemOneLimits = {
  maxQuestions: 64,
  minCriteria: 1,
  maxChoiceCriteria: 255,
  maxScoreLevels: 10,
  maxBodyBytes: 1_048_576,
};

export type SystemOneBackend = {
  /** OmniRoute provider id — credentials stay in the normal provider connection store. */
  provider: string;
  label: string;
  /** Documented POST endpoint for typed decisions. */
  decisionUrl: string;
  /** Documented decision-model catalog, or null when the backend publishes none. */
  modelsUrl: string | null;
  /** Hosts an operator may point a per-connection endpoint override at. */
  allowedHosts: readonly string[];
  requiresKey: boolean;
  timeoutMs: number;
  /** Request-shape limits for this backend. */
  limits: SystemOneLimits;
  /**
   * Fallback filter for a catalog that lists chat and decision models together
   * (OpenCode Zen's `/zen/v1/models`) or carries no modality metadata. A row
   * whose own metadata already declares a decision capability is kept
   * regardless; this only decides the rows that declare nothing.
   */
  decisionModelPattern: RegExp;
  /**
   * Whether the wire contract has been confirmed against the live upstream from
   * this repository. Documentation-derived endpoints stay `false`.
   */
  contractVerified: boolean;
};

/**
 * OpenCode Zen documents `POST /inference/v1/systemone` while the rest of its
 * API (and this repo's chat registry entry) lives under `/zen/v1`; the model
 * catalog is `/zen/v1/models`. Both paths are on the same allowlisted host, so
 * an operator can re-point either per connection if the docs move.
 */
export const SYSTEMONE_BACKENDS = {
  opencode: {
    provider: "opencode",
    label: "OpenCode Zen",
    decisionUrl: "https://opencode.ai/inference/v1/systemone",
    modelsUrl: "https://opencode.ai/zen/v1/models",
    allowedHosts: ["opencode.ai"],
    // The documented System One endpoint requires an OpenCode Zen API key for
    // both paid Jev and the limited-time free model.
    requiresKey: true,
    timeoutMs: 30_000,
    limits: JEV_SYSTEMONE_LIMITS,
    // Documented Zen decision ids: `jev-1.13`, `jev-1.13-free`.
    decisionModelPattern: /^jev(?:[-.]|$)/i,
    contractVerified: false,
  },
  "vercel-ai-gateway": {
    provider: "vercel-ai-gateway",
    label: "Vercel AI Gateway",
    decisionUrl: "https://ai-gateway.vercel.sh/typesafe/v1/systemone",
    modelsUrl: "https://ai-gateway.vercel.sh/typesafe/v1/models",
    allowedHosts: ["ai-gateway.vercel.sh"],
    requiresKey: true,
    timeoutMs: 30_000,
    limits: JEV_SYSTEMONE_LIMITS,
    // The gateway's own id for the model is `typesafe-ai/jev`.
    decisionModelPattern: /(?:^|\/)jev(?:[-.]|$)/i,
    contractVerified: false,
  },
  openrouter: {
    provider: "openrouter",
    label: "OpenRouter",
    decisionUrl: "https://openrouter.ai/api/v1/systemone",
    // OpenRouter tags decision models with `output_modalities=decisions`.
    modelsUrl: "https://openrouter.ai/api/v1/models?output_modalities=decisions",
    allowedHosts: ["openrouter.ai"],
    requiresKey: true,
    timeoutMs: 30_000,
    limits: JEV_SYSTEMONE_LIMITS,
    // OpenRouter tags decision models in `architecture.output_modalities`, so
    // the pattern is only a fallback for a row that carries none.
    decisionModelPattern: /(?:^|\/)jev(?:[-.]|$)/i,
    contractVerified: false,
  },
} as const satisfies Record<string, SystemOneBackend>;

export type SystemOneProviderId = keyof typeof SYSTEMONE_BACKENDS;

/** A bare alias may fan out at most this far, one candidate per backend. */
export const SYSTEMONE_MAX_FALLBACK_CANDIDATES = 3;

/**
 * Bare, user-facing aliases and the concrete upstream model id each backend
 * serves them with. Order is the fan-out order for a bare alias: cheapest
 * documented first, then unknown-price gateways in registry order. A free alias
 * lists only free-tier model ids, so it can never resolve onto a paid model.
 */
const SYSTEMONE_MODEL_ALIASES: Readonly<
  Record<string, ReadonlyArray<{ provider: SystemOneProviderId; model: string }>>
> = {
  jev: [
    { provider: "opencode", model: "jev-1.13" },
    { provider: "openrouter", model: "typesafe/jev-1.13" },
    { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" },
  ],
  "jev-1.13": [
    { provider: "opencode", model: "jev-1.13" },
    { provider: "openrouter", model: "typesafe/jev-1.13" },
    { provider: "vercel-ai-gateway", model: "typesafe-ai/jev" },
  ],
  // OpenCode Zen's Jev Free is a limited-time free model and the only free-tier
  // System One model documented on any backend. It must never be served by a
  // paid account, so the alias resolves to that one candidate.
  "jev-free": [{ provider: "opencode", model: "jev-1.13-free" }],
  "jev-1.13-free": [{ provider: "opencode", model: "jev-1.13-free" }],
};

/**
 * Published per-token rates (USD per 1M tokens) for decision models, by
 * provider. Empty on purpose: none of the three backends publishes a per-token
 * System One rate that has been verified from this checkout, so cost comes from
 * the upstream's reported `usage.cost`, an operator pricing row, or is reported
 * as unknown — never silently as free.
 */
const PUBLISHED_PRICING: Readonly<
  Record<string, ReadonlyArray<{ match: RegExp; input: number; output: number }>>
> = {};

export function isSystemOneProvider(value: string): value is SystemOneProviderId {
  return Object.prototype.hasOwnProperty.call(SYSTEMONE_BACKENDS, value);
}

export function listSystemOneProviders(): SystemOneProviderId[] {
  return Object.keys(SYSTEMONE_BACKENDS) as SystemOneProviderId[];
}

export function systemOneBackend(provider: string): SystemOneBackend {
  if (!isSystemOneProvider(provider)) {
    throw new SystemOneTargetError(`Provider ${provider} does not support System One`);
  }
  return SYSTEMONE_BACKENDS[provider];
}

/**
 * Free-tier detection is explicit per provider spelling: OpenCode Zen suffixes
 * its free models with `-free`, OpenRouter with the `:free` variant suffix.
 * Anything else is treated as paid, so an unknown id is never billed as free.
 */
export function systemOneModelTier(provider: string, model: string): SystemOneTier {
  const id = model.trim().toLowerCase();
  if (provider === "openrouter") return id.endsWith(":free") ? "free" : "paid";
  return id.endsWith("-free") || id.endsWith(":free") ? "free" : "paid";
}

export function nativeSystemOnePricing(
  provider: string,
  model: string
): { input: number; output: number } | null {
  const rates = PUBLISHED_PRICING[provider];
  const match = rates?.find((rate) => rate.match.test(model));
  return match ? { input: match.input, output: match.output } : null;
}

export type SystemOneCandidate = {
  provider: SystemOneProviderId;
  /** Model id sent upstream, exactly as that backend spells it. */
  model: string;
  /** `<provider>/<model>` — what API-key policy, usage and cooldown record. */
  canonicalModel: string;
  tier: SystemOneTier;
  /** True when the caller named the provider, which disables cross-provider fallback. */
  pinned: boolean;
};

export type ResolveSystemOneOptions = {
  /** Restrict a bare alias fan-out to backends that actually have a connection. */
  availableProviders?: readonly string[] | null;
};

function assertSafeId(raw: string): string {
  const id = raw?.trim?.() ?? "";
  if (!id || hasUnsafeModelIdSyntax(id)) {
    throw new SystemOneTargetError("Invalid System One model ID");
  }
  return id;
}

function candidate(
  provider: SystemOneProviderId,
  model: string,
  pinned: boolean
): SystemOneCandidate {
  return {
    provider,
    model,
    canonicalModel: `${provider}/${model}`,
    tier: systemOneModelTier(provider, model),
    pinned,
  };
}

/**
 * Resolve a client-supplied System One model id into an ordered candidate list.
 *
 * `<provider>/<model>` pins that backend: exactly one candidate, and an
 * unsupported provider prefix is an error rather than a fallback. A bare alias
 * from `SYSTEMONE_MODEL_ALIASES` fans out across its backends (bounded by
 * `SYSTEMONE_MAX_FALLBACK_CANDIDATES`) without ever crossing the free/paid
 * tier. An unknown bare id is rejected — the gateway never guesses a backend
 * that would spend an operator's credential.
 */
export function resolveSystemOneCandidates(
  rawModel: string,
  options: ResolveSystemOneOptions = {}
): SystemOneCandidate[] {
  const id = assertSafeId(rawModel);
  const available = options.availableProviders ?? null;
  const isAvailable = (provider: SystemOneProviderId) => !available || available.includes(provider);

  const separator = id.indexOf("/");
  if (separator > 0) {
    const prefix = id.slice(0, separator);
    const model = id.slice(separator + 1).trim();
    if (isSystemOneProvider(prefix)) {
      if (!model) {
        throw new SystemOneTargetError("System One model is required after the provider prefix");
      }
      return [candidate(prefix, model, true)];
    }
    // A known-looking prefix that is not a System One backend fails closed: it
    // is never reinterpreted as a model id on some other backend.
    throw new SystemOneTargetError(
      `Provider ${prefix} does not support System One. Use one of: ${listSystemOneProviders().join(", ")}`
    );
  }

  const alias = SYSTEMONE_MODEL_ALIASES[id.toLowerCase()];
  if (!alias) {
    throw new SystemOneTargetError(
      `Unknown System One model "${id}". Use a provider-qualified id such as openrouter/typesafe/jev-1.13`
    );
  }

  const candidates = alias
    .filter((entry) => isAvailable(entry.provider))
    .slice(0, SYSTEMONE_MAX_FALLBACK_CANDIDATES)
    .map((entry) => candidate(entry.provider, entry.model, false));

  if (!candidates.length) {
    throw new SystemOneTargetError(
      `No configured System One backend serves "${id}". Configure one of: ${alias
        .map((entry) => entry.provider)
        .join(", ")}`
    );
  }
  return candidates;
}

type ConnectionTierFields = {
  apiKey?: string | null;
  accessToken?: string | null;
  providerSpecificData?: Record<string, unknown> | null;
};

/**
 * Whether a provider connection may serve a model of this tier.
 *
 * A free-tier model is dispatchable only on an account that is itself the free
 * tier: a keyless connection, or one the operator explicitly tagged
 * `systemOneTier: "free"`. A paid model, conversely, always needs the backend's
 * normal credential when `requiresKey` is true. A free-tier model may still need
 * a credential; the tier tag prevents paid fallback, it does not bypass auth.
 */
export function isConnectionEligibleForTier(
  tier: SystemOneTier,
  connection: ConnectionTierFields,
  provider?: string
): boolean {
  const declared = connection.providerSpecificData?.systemOneTier;
  const hasCredential = Boolean(connection.apiKey || connection.accessToken);
  const requiresKey =
    provider && isSystemOneProvider(provider) ? !!systemOneBackend(provider).requiresKey : false;
  if (tier === "free") {
    if (declared !== "free") return false;
    return requiresKey ? hasCredential : true;
  }
  if (declared === "free") return false;
  return requiresKey ? hasCredential : true;
}
