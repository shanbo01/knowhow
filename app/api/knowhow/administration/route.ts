import { Query } from "node-appwrite";
import { AccessService, type PlatformRole } from "../../../../lib/server/access-service";
import { TABLES } from "../../../../lib/server/appwrite-resources";
import { decodePayload, rowData } from "../../../../lib/server/domain-records";
import {
  assertCookieMutationRequest,
  HttpError,
  jsonResponse,
  readJsonObject,
  toErrorResponse,
} from "../../../../lib/server/http-security";
import { deterministicResourceId } from "../../../../lib/server/ids";
import { inputEmail, inputText } from "../../../../lib/server/input";
import { PlatformQueryService } from "../../../../lib/server/platform-query-service";
import { consumeFixedWindows } from "../../../../lib/server/rate-limit-service";
import {
  allowedRequestOrigins,
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import {
  requireRecentTotp,
  requireVerifiedSession,
} from "../../../../lib/server/session-identity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PLATFORM_ROLES: readonly PlatformRole[] = [
  "owner",
  "operations",
  "support",
  "billing",
  "auditor",
];

type AccessHistory = {
  email?: string;
  name?: string;
  changes?: Array<{
    status: "active" | "revoked";
    at: string;
    by: string;
  }>;
};

async function requireAdministrationOwner(
  access: AccessService,
  userId: string,
) {
  const roles = await access.platformRoles(userId);
  if (!roles.includes("owner")) {
    throw new HttpError(
      403,
      "ADMINISTRATION_OWNER_REQUIRED",
      "KnowHow Administration owner access is required.",
    );
  }
  return roles;
}

function validatedRoles(value: unknown) {
  if (!Array.isArray(value) || value.length > PLATFORM_ROLES.length) {
    throw new HttpError(400, "ADMINISTRATION_ROLES_INVALID", "Roles are invalid.");
  }
  const roles = [...new Set(value)];
  if (
    roles.some(
      (role): role is unknown =>
        typeof role !== "string" ||
        !PLATFORM_ROLES.includes(role as PlatformRole),
    )
  ) {
    throw new HttpError(400, "ADMINISTRATION_ROLES_INVALID", "Roles are invalid.");
  }
  return roles as PlatformRole[];
}

async function accessMembers() {
  const { store, users } = createRequestServices();
  const rows = await store.list(TABLES.platformRoles, {
    limit: 500,
  });
  const grouped = new Map<string, PlatformRole[]>();
  for (const row of rows) {
    const userId = typeof row.user_id === "string" ? row.user_id : "";
    const role = typeof row.kind === "string" ? row.kind : "";
    if (
      row.status !== "active" ||
      !userId ||
      !PLATFORM_ROLES.includes(role as PlatformRole)
    ) continue;
    const current = grouped.get(userId) ?? [];
    if (!current.includes(role as PlatformRole)) current.push(role as PlatformRole);
    grouped.set(userId, current);
  }

  const members = await Promise.all(
    [...grouped.entries()].map(async ([userId, roles]) => {
      try {
        const user = await users.get({ userId });
        return {
          userId,
          name: user.name || user.email,
          email: user.email,
          roles,
          enabled: user.status,
          emailVerified: user.emailVerification,
          lastActiveAt: user.accessedAt || null,
        };
      } catch {
        const fallback = rows.find((row) => row.user_id === userId);
        return {
          userId,
          name: "Unavailable account",
          email: typeof fallback?.email === "string" ? fallback.email : "",
          roles,
          enabled: false,
          emailVerified: false,
          lastActiveAt: null,
        };
      }
    }),
  );

  return members.sort((left, right) => {
    const ownerDelta = Number(right.roles.includes("owner")) - Number(left.roles.includes("owner"));
    return ownerDelta || left.email.localeCompare(right.email);
  });
}

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const identity = await requireVerifiedSession(request);
    const { store } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.administration.query",
        subject: identity.userId,
        limit: 120,
        windowSeconds: 60,
      },
    ]);

    const access = new AccessService(store);
    const roles = await access.platformRoles(identity.userId);
    if (!roles.length) {
      throw new HttpError(
        403,
        "ADMINISTRATION_REQUIRED",
        "KnowHow Administration access is required.",
      );
    }

    const url = new URL(request.url);
    const resource = url.searchParams.get("resource")?.trim() || "dashboard";
    const canManage = roles.some((role) => role === "owner" || role === "operations");
    const canSupport = canManage || roles.includes("support");
    if (
      ["dashboard", "clients", "client"].includes(resource) &&
      !canManage
    ) {
      throw new HttpError(
        403,
        "ADMINISTRATION_OPERATIONS_REQUIRED",
        "KnowHow Administration access is required for workspace and commercial data.",
      );
    }
    if (["support", "ticket"].includes(resource) && !canSupport) {
      throw new HttpError(
        403,
        "ADMINISTRATION_SUPPORT_REQUIRED",
        "KnowHow Administration support access is required.",
      );
    }
    const service = new PlatformQueryService(store);
    const query = url.searchParams.get("q")?.trim() ?? "";
    const status = url.searchParams.get("status")?.trim() ?? "";
    const cursor = url.searchParams.get("cursor")?.trim() || undefined;
    const limit = url.searchParams.get("limit");
    const workspaceId = url.searchParams.get("workspaceId")?.trim() ?? "";
    const ticketId = url.searchParams.get("ticketId")?.trim() ?? "";

    let body: object;
    if (resource === "dashboard") {
      body = await service.home(identity);
    } else if (resource === "clients") {
      body = await service.listAccounts(identity, { query, status, cursor, limit });
    } else if (resource === "client") {
      if (!workspaceId) {
        throw new HttpError(400, "CLIENT_REQUIRED", "Client is required.");
      }
      body = { client: await service.account(identity, workspaceId) };
    } else if (resource === "support") {
      body = await service.listTickets(identity, {
        query,
        status,
        workspaceId: workspaceId || undefined,
        cursor,
        limit,
      });
    } else if (resource === "ticket") {
      if (!ticketId) {
        throw new HttpError(
          400,
          "SUPPORT_TICKET_REQUIRED",
          "Support ticket is required.",
        );
      }
      body = {
        ticket: await service.ticket(
          identity,
          inputText(ticketId, "Support ticket", { min: 1, max: 36 }),
        ),
      };
    } else if (resource === "access") {
      await requireAdministrationOwner(access, identity.userId);
      body = { members: await accessMembers() };
    } else {
      throw new HttpError(
        400,
        "ADMINISTRATION_QUERY_INVALID",
        "Unknown administration query.",
      );
    }

    return withRequestId(jsonResponse({ ...body, requestId }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    assertCookieMutationRequest(request, allowedRequestOrigins());
    const identity = await requireVerifiedSession(request);
    const { store, users } = createRequestServices();
    await consumeFixedWindows(store, [
      {
        scope: "knowhow.administration.access",
        subject: identity.userId,
        limit: 20,
        windowSeconds: 600,
      },
    ]);
    const access = new AccessService(store);
    await requireAdministrationOwner(access, identity.userId);
    if (!identity.mfaEnabled) {
      throw new HttpError(
        403,
        "MFA_ENROLLMENT_REQUIRED",
        "Enable two-step verification before changing KnowHow Administration access.",
      );
    }
    await requireRecentTotp(request);

    const body = await readJsonObject(request, 32_000);
    const idempotencyKey = inputText(
      request.headers.get("x-idempotency-key"),
      "Idempotency key",
      { min: 16, max: 128 },
    );
    const action = inputText(body.action, "Action", { min: 3, max: 40 });
    if (action !== "set_access") {
      throw new HttpError(
        400,
        "ADMINISTRATION_ACTION_INVALID",
        "Unknown administration action.",
      );
    }
    const email = inputEmail(body.email);
    const nextRoles = validatedRoles(body.roles);
    const matches = await users.list({
      queries: [Query.equal("email", [email]), Query.limit(2)],
      total: false,
    });
    if (matches.users.length !== 1) {
      throw new HttpError(
        404,
        "ADMINISTRATION_ACCOUNT_NOT_FOUND",
        "Use the email of an existing KnowHow account.",
      );
    }
    const target = matches.users[0];
    if (!target.status || !target.emailVerification) {
      throw new HttpError(
        409,
        "ADMINISTRATION_ACCOUNT_NOT_READY",
        "The account must be enabled and email-verified before access is granted.",
      );
    }
    const targetMemberships = await store.list(TABLES.workspaceMembers, {
      filters: [
        { field: "user_id", value: target.$id },
        { field: "status", value: "active" },
      ],
      limit: 1,
    });
    if (!targetMemberships.length) {
      throw new HttpError(
        409,
        "ADMINISTRATION_WORKSPACE_ACCESS_REQUIRED",
        "Add this account to a KnowHow workspace before granting Administration access.",
      );
    }

    const existingRows = await store.list(TABLES.platformRoles, {
      filters: [{ field: "user_id", value: target.$id }],
      limit: PLATFORM_ROLES.length,
    });
    const targetIsOwner = existingRows.some(
      (row) => row.kind === "owner" && row.status === "active",
    );
    if (targetIsOwner && !nextRoles.includes("owner")) {
      throw new HttpError(
        409,
        "ADMINISTRATION_OWNER_PROTECTED",
        "Owner access cannot be removed from this screen.",
      );
    }

    const now = new Date().toISOString();
    await store.transaction(async (transaction) => {
      for (const role of PLATFORM_ROLES) {
        const shouldBeActive = nextRoles.includes(role);
        const existing = existingRows.find((row) => row.kind === role);
        if (!existing && !shouldBeActive) continue;
        const previous = existing
          ? decodePayload<AccessHistory>(existing, {})
          : {};
        const previousStatus = existing?.status === "active" ? "active" : "revoked";
        const nextStatus = shouldBeActive ? "active" : "revoked";
        const history = previous.changes ?? [];
        const changes =
          !existing || previousStatus !== nextStatus
            ? [...history, { status: nextStatus, at: now, by: identity.userId }].slice(-100)
            : history;
        const id =
          existing?.$id ??
          (await deterministicResourceId("platrole", `${target.$id}:${role}`));
        await transaction.upsert(
          TABLES.platformRoles,
          id,
          rowData(
            {
              user_id: target.$id,
              email: target.email,
              kind: role,
              status: nextStatus,
              idempotency_key: idempotencyKey,
              created_by: existing?.created_by ?? identity.userId,
              updated_by: identity.userId,
              request_id: requestId,
            },
            {
              email: target.email,
              name: target.name || target.email,
              changes,
            },
          ),
        );
      }
    });

    return withRequestId(
      jsonResponse({
        userId: target.$id,
        email: target.email,
        roles: nextRoles,
        requestId,
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
