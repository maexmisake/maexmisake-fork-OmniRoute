import {
  decisionSettingsApi,
  getDecisionRoutingOptions,
} from "@/lib/decisionPolicy/dashboardSettings";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return decisionSettingsApi(request, () => getDecisionRoutingOptions());
}
