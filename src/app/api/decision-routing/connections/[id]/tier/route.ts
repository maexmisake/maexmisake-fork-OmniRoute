import {
  decisionSettingsApi,
  saveDecisionConnectionTier,
} from "@/lib/decisionPolicy/dashboardSettings";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  return decisionSettingsApi(
    request,
    (body) => saveDecisionConnectionTier(id, body, request.signal),
    true
  );
}
