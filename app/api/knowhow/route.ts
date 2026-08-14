import { BootstrapService } from "../../../lib/server/bootstrap-service";
import { CommandService } from "../../../lib/server/command-service";
import {
  assertCookieMutationRequest,
  HttpError,
  jsonResponse,
  readJsonObject,
  toErrorResponse,
} from "../../../lib/server/http-security";
import { inputObject, inputText } from "../../../lib/server/input";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../lib/server/request-services";
import {
  requireRecentTotp,
  requireVerifiedSession,
} from "../../../lib/server/session-identity";
import { consumeFixedWindows } from "../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REAUTHENTICATED_ACTIONS = new Set([
  "provisionOrganization",
  "createWorkspace",
  "acceptAppointment",
  "revokeAppointment",
  "createBetaAccessGrant",
  "revokeBetaAccessGrant",
  "completeSelfServiceSetup",
  "updatePlatformSettings",
  "setWorkspaceStatus",
  "assignWorkspaceAdministrator",
  "appointOrganizationMember",
  "updateOrganizationMember",
  "resolveSupportRequest",
  "revokeSupportAccess",
  "extendSubscription",
  "convertSubscription",
  "createPricingCatalog",
  "updatePricingCatalog",
  "retirePricingCatalog",
  "createLifecycleSimulationTenant",
  "simulateLifecycleState",
  "approveDeletionCase",
  "completeProvisioningRun",
]);

function responseWithRequestId(
  body: unknown,
  requestId: string,
  init?: ResponseInit,
) {
  return withRequestId(jsonResponse(body, init), requestId);
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.bootstrap",
        subject: identity.userId,
        limit: 180,
        windowSeconds: 60,
      },
    ]);
    const workspaceId = new URL(request.url).searchParams
      .get("workspaceId")
      ?.trim();
    if (workspaceId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(workspaceId)) {
      throw new HttpError(
        400,
        "WORKSPACE_FILTER_INVALID",
        "Workspace is invalid.",
      );
    }
    const result = await new BootstrapService(store).bootstrap(
      identity,
      workspaceId,
    );
    return responseWithRequestId({ ...result, requestId }, requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    assertCookieMutationRequest(request, allowedRequestOrigins());
    const identity = await requireVerifiedSession(request);
    const { store, objects } = createRequestServices();
    const body = await readJsonObject(request, 1_500_000);
    const action = inputText(body.action, "Action", { min: 2, max: 100 });
    const payload = inputObject(body.payload ?? {}, "Payload");
    const idempotencyKey = inputText(
      request.headers.get("x-idempotency-key"),
      "Idempotency key",
      { min: 16, max: 128 },
    );
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.command",
        subject: identity.userId,
        limit: 180,
        windowSeconds: 60,
      },
      {
        scope: `knowhow.action.${action.toLowerCase().slice(0, 50)}`,
        subject: identity.userId,
        limit: REAUTHENTICATED_ACTIONS.has(action) ? 30 : 90,
        windowSeconds: REAUTHENTICATED_ACTIONS.has(action) ? 600 : 60,
      },
    ]);
    let reauthenticated = false;
    if (REAUTHENTICATED_ACTIONS.has(action)) {
      if (identity.mfaEnabled) await requireRecentTotp(request);
      reauthenticated = true;
    }
    const result = await new CommandService(store, objects).execute(
      identity,
      action,
      payload,
      { idempotencyKey, requestId, reauthenticated },
    );
    const responseBody =
      typeof result === "object" && result !== null && !Array.isArray(result)
        ? { ...result, requestId }
        : { data: result, requestId };
    return responseWithRequestId(responseBody, requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
