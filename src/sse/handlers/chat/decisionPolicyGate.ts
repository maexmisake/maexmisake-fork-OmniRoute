import {
  decisionPolicyOptedIn,
  unavailableDecisionPolicy,
} from "@omniroute/open-sse/services/decisionPolicy/applicationGate.ts";
import { normalizeComboStep } from "@/lib/combos/steps";
import { getCombos } from "@/lib/db/combos";
import { resolveComboForModel } from "@/lib/db/modelComboMappings";
import { resolveModelAliasWithSeedFallback } from "@/lib/modelAliasResolver";
import { resolveCcDiscoveryAliasStrip } from "@/lib/ccDiscoveryAliasResolve";
import { enforceApiKeyPolicy } from "@/shared/utils/apiKeyPolicy";
import { errorResponse } from "@omniroute/open-sse/utils/error.ts";
import { resolvePolicyApiKey } from "@/shared/utils/apiKeyPolicy";
import { getApiKeyMetadata } from "@/lib/db/apiKeys";
import { getModelAliases } from "@/lib/db/models/aliases";
import { resolveRoutingModel } from "../resolveRoutingModel";

type Combo = Record<string, unknown>;
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function byIdentity(name: string, combos: Combo[]): Combo | undefined {
  const exact = combos.find((combo) => combo.name === name || combo.id === name);
  if (exact) return exact;
  const stripped = name.startsWith("combo/") ? name.slice(6) : name;
  return combos.find(
    (combo) => typeof combo.name === "string" && combo.name.toLowerCase() === stripped.toLowerCase()
  );
}
async function resolveStoredCombo(name: string, combos: Combo[]): Promise<Combo | null> {
  const raw = byIdentity(name, combos);
  if (raw) return raw;
  const { getCombo, stripContextWindowSuffix } = await import("@/sse/services/model");
  const base = stripContextWindowSuffix(name) || name;
  const resolved =
    (await getCombo(name)) ??
    (base !== name ? (byIdentity(base, combos) ?? (await getCombo(base))) : null) ??
    (await resolveComboForModel(base));
  if (resolved || !name.startsWith("auto/")) return resolved;
  return byIdentity(`auto/best-${name.slice(5)}`, combos) ?? null;
}
async function referencedCombos(
  combo: Combo,
  combos: Combo[],
  shapes: Array<{ name: string; models: unknown[] }>
): Promise<Combo[]> {
  const result: Combo[] = [];
  const models = Array.isArray(combo.models) ? combo.models : [];
  for (const [index, value] of models.entries()) {
    const step = normalizeComboStep(value, {
      comboName: String(combo.name ?? ""),
      index,
      allCombos: shapes,
    });
    const target =
      step?.kind === "combo-ref" ? step.comboName : step?.kind === "model" ? step.model : null;
    if (!target) continue;
    const child = await resolveStoredCombo(target, combos);
    if (child) result.push(child);
  }
  return result;
}
/** Follow actual combo steps, never descriptions/prompts/arbitrary metadata strings. */
async function includesDecisionPolicy(root: Combo, combos: Combo[]): Promise<boolean> {
  const pending: Combo[] = [root],
    seen = new Set<string>();
  const shapes = combos.map((combo) => ({
    ...combo,
    name: String(combo.name ?? ""),
    models: Array.isArray(combo.models) ? combo.models : [],
  }));
  let visited = 0;
  while (pending.length) {
    if (++visited > 4096) return true;
    const combo = pending.pop()!;
    const name = String(combo.name ?? combo.id ?? "");
    if (seen.has(name)) continue;
    seen.add(name);
    if (decisionPolicyOptedIn(combo)) return true;
    pending.push(...(await referencedCombos(combo, combos, shapes)));
  }
  return false;
}
function aliasTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  if (record(value) && typeof value.provider === "string" && typeof value.model === "string")
    return `${value.provider}/${value.model}`;
  return null;
}
function resolveFreshAliases(
  model: string,
  aliases: Record<string, unknown>,
  combos: Combo[]
): string {
  const seen = new Set<string>();
  let current = model;
  for (let i = 0; i < 16; i++) {
    if (combos.some((combo) => combo.name === current)) return current;
    if (seen.has(current)) throw new Error("Ambiguous alias cycle");
    seen.add(current);
    const next = aliasTarget(aliases[current]);
    if (!next) return current;
    current = next;
  }
  throw new Error("Alias chain exceeds policy inspection bound");
}
export async function decisionPolicyModelRejection(model: unknown): Promise<Response | null> {
  if (typeof model !== "string" || !model) return null;
  try {
    const combos = await getCombos();
    if (!combos.some(decisionPolicyOptedIn)) return null;
    const plain = model.startsWith("no-think/") ? model.slice(9) : model;
    const aliases = await getModelAliases();
    const fresh = resolveFreshAliases(plain, aliases, combos);
    const alias = fresh !== plain ? fresh : await resolveModelAliasWithSeedFallback(plain);
    const cc = await resolveCcDiscoveryAliasStrip(typeof alias === "string" ? alias : plain, {
      recordUsage: false,
    });
    const name = cc.model;
    // Raw records preserve enabled empty/malformed combos, unlike getCombo().
    const combo = await resolveStoredCombo(name, combos);
    return combo && (await includesDecisionPolicy(combo, combos))
      ? unavailableDecisionPolicy()
      : null;
  } catch {
    // A metadata outage must never convert an unsupported opt-in into legacy routing.
    return errorResponse(503, "Decision combo policy metadata unavailable", {
      code: "decision_policy_metadata_unavailable",
    });
  }
}
/** Route admission escape fence, before self-hosted diversion and media guardrails.
 * Key policy runs exactly once here only when returning the terminal opt-in rejection. */
export async function decisionPolicyRouteRejection(
  request: Request,
  body: Record<string, unknown>
): Promise<Response | null> {
  try {
    if (!(await getCombos()).some(decisionPolicyOptedIn)) return null;
    const key = await resolvePolicyApiKey(request);
    const metadata = key ? await getApiKeyMetadata(key) : null;
    const model = resolveRoutingModel(
      request,
      { model: typeof body.model === "string" ? body.model : null },
      metadata?.forcedModel
    );
    const rejection = await decisionPolicyModelRejection(model);
    if (!rejection) return null;
    const policy = await enforceApiKeyPolicy(request, model ?? null);
    return policy.rejection ?? rejection;
  } catch {
    return errorResponse(503, "Decision combo policy metadata unavailable", {
      code: "decision_policy_metadata_unavailable",
    });
  }
}
