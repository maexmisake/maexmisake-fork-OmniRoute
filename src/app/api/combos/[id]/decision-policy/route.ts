import {
  decisionSettingsApi,
  getDecisionPolicySettings,
  saveDecisionPolicySettings,
} from "@/lib/decisionPolicy/dashboardSettings";
type Context = { params: Promise<{ id: string }> };
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: Context) {
  const { id } = await context.params;
  return decisionSettingsApi(request, () => getDecisionPolicySettings(id));
}
export async function PUT(request: Request, context: Context) {
  const { id } = await context.params;
  return decisionSettingsApi(
    request,
    (body) => saveDecisionPolicySettings(id, body, request.signal),
    true
  );
}
