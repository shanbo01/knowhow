import { BootstrapService } from "../../../lib/server/bootstrap-service";
import { CommandService } from "../../../lib/server/command-service";
import { decodePayload, type WorkspaceMemberRecord } from "../../../lib/server/domain-records";
import {
  assertCookieMutationRequest,
  HttpError,
  jsonResponse,
  readJsonObject,
  toErrorResponse,
} from "../../../lib/server/http-security";
import { inputObject, inputText } from "../../../lib/server/input";
import { TABLES } from "../../../lib/server/appwrite-resources";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../lib/server/request-services";
import {
  requireRecentTotp,
  requireVerifiedSession,
  type AuthenticatedIdentity,
} from "../../../lib/server/session-identity";
import type { RecordStore } from "../../../lib/server/record-store";
import { consumeFixedWindows } from "../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REAUTHENTICATED_ACTIONS = new Set([
  "provisionOrganization",
  "createWorkspace",
  "acceptAppointment",
  "revokeAppointment",
  "updatePlatformSettings",
  "setWorkspaceStatus",
  "assignWorkspaceAdministrator",
  "appointOrganizationMember",
  "updateOrganizationMember",
  "updateOrganizationDomains",
  "updateAllowedDomains",
  "resolveSupportRequest",
  "revokeSupportAccess",
  "extendSubscription",
  "convertSubscription",
  "approveDeletionCase",
  "completeProvisioningRun",
]);

async function assertPrivilegedMfa(
  store: RecordStore,
  identity: AuthenticatedIdentity,
) {
  const [platformRoles, memberships, organizationMemberships] = await Promise.all([
    store.list(TABLES.platformRoles, {
      filters: [
        { field: "user_id", value: identity.userId },
        { field: "status", value: "active" },
      ],
      limit: 1,
    }),
    store.list(TABLES.workspaceMembers, {
      filters: [
        { field: "user_id", value: identity.userId },
        { field: "status", value: "active" },
      ],
    }),
    store.list(TABLES.organizationMemberships, {
      filters: [
        { field: "user_id", value: identity.userId },
        { field: "status", value: "active" },
      ],
      limit: 1,
    }),
  ]);
  const workspaceAdministrator = memberships.some((row) =>
    decodePayload<WorkspaceMemberRecord>(row, {
      name: identity.name,
      roles: [],
      capabilities: [],
      groupIds: [],
    }).roles.includes("administrator"),
  );
  if ((platformRoles.length > 0 || organizationMemberships.length > 0 || workspaceAdministrator) && !identity.mfaEnabled) {
    throw new HttpError(
      403,
      "MFA_ENROLLMENT_REQUIRED",
      "Set up an authenticator before using administrative access.",
    );
  }
}

function responseWithRequestId(body: unknown, requestId: string, init?: ResponseInit) {
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
    await assertPrivilegedMfa(store, identity);
    const workspaceId = new URL(request.url).searchParams.get("workspaceId")?.trim();
    if (workspaceId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(workspaceId)) {
      throw new HttpError(400, "WORKSPACE_FILTER_INVALID", "Workspace is invalid.");
    }
    const result = await new BootstrapService(store).bootstrap(identity, workspaceId);
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
    await assertPrivilegedMfa(store, identity);
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
      await requireRecentTotp(request);
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
