import { createErrorResponse } from "@/lib/api/errorResponse";
import { requireOperatorCredential } from "@/lib/api/operatorCredential";
import { readNativeAttemptInspectionRows } from "@/lib/db/decisionAttemptInspection";
import {
  parseNativeAttemptInspectionQuery,
  projectNativeAttemptPage,
} from "@/lib/decisionPolicy/attemptInspection";

function privateResponse(response: Response) {
  response.headers.set("cache-control", "private, no-store");
  return response;
}
/** Operator-only, SELECT-only journal observation; never retries or reconciles a stage. */
export async function GET(request: Request) {
  if (!(request instanceof Request))
    return privateResponse(
      createErrorResponse({ status: 401, message: "Authentication required" })
    );
  try {
    const auth = await requireOperatorCredential(request, {
      alwaysRequireAuth: true,
      forbiddenMessage:
        "Native attempt inspection requires a signed-in dashboard session or the local CLI.",
    });
    if (auth.ok === false) return privateResponse(auth.response);
    request.signal.throwIfAborted();
    const query = parseNativeAttemptInspectionQuery(new URL(request.url).searchParams);
    if (!query)
      return privateResponse(
        createErrorResponse({ status: 400, message: "Invalid native attempt filters" })
      );
    const rows = readNativeAttemptInspectionRows(query);
    request.signal.throwIfAborted();
    return privateResponse(Response.json(projectNativeAttemptPage(rows, query.limit)));
  } catch {
    return privateResponse(
      createErrorResponse({
        status: request.signal.aborted ? 499 : 503,
        message: request.signal.aborted
          ? "Native attempt inspection cancelled"
          : "Native attempt inspection unavailable",
      })
    );
  }
}
