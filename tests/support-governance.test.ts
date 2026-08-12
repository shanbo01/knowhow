import assert from "node:assert/strict";
import test from "node:test";
import { AccessService } from "../lib/server/access-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import {
  decodePayload,
  rowData,
  type SupportGrantRecord,
} from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  identity,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

const options = (suffix: string, reauthenticated = true) => ({
  requestId: `request_support_${suffix}_0000000000`,
  idempotencyKey: `idempotency_support_${suffix}_0000000000`,
  reauthenticated,
});

async function seedPlatformRole(
  store: InMemoryRecordStore,
  userId: string,
  role: "owner" | "operations" | "support",
) {
  await store.create(
    TABLES.platformRoles,
    `platform_${role}_${userId}`,
    rowData(
      {
        user_id: userId,
        kind: role,
        status: "active",
        created_by: "seed",
      },
      { role },
    ),
  );
}

async function enableSupport(
  store: InMemoryRecordStore,
  organizationId: string,
  workspaceId: string,
) {
  await store.create(
    TABLES.entitlements,
    `support_${workspaceId}`,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "supportEnabled",
        status: "active",
      },
      { value: true },
    ),
  );
}

function supportGrant(
  approvedBy: string,
  expiresAt: string,
): SupportGrantRecord {
  return {
    requestId: "support_case_seed",
    role: "administrator",
    email: "support@knowhow.example",
    displayName: "Support Operator",
    approvedBy,
    grantedAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt,
    endedAt: null,
    revokedBy: null,
    reason: "Investigate a reproducible pilot configuration issue.",
  };
}

test("permanent membership takes precedence and expired grants grant nothing", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const operator = identity(
    "support-operator",
    "support@knowhow.example",
    "Support Operator",
  );
  const activeGrant = supportGrant(
    "workspace-admin",
    new Date(Date.now() + 60 * 60_000).toISOString(),
  );
  await store.create(
    TABLES.supportGrants,
    "grant_active",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: operator.userId,
        email: operator.email,
        status: "active",
        kind: "administrator",
        expires_at: activeGrant.expiresAt,
      },
      activeGrant,
    ),
  );
  const access = new AccessService(store);
  assert.equal(
    (await access.workspaceAccess(workspaceId, operator))?.supportGrant?.id,
    "grant_active",
  );

  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: operator.userId,
    email: operator.email,
    roles: ["viewer"],
  });
  const permanent = await access.workspaceAccess(workspaceId, operator);
  assert.deepEqual(permanent?.roles, ["viewer"]);
  assert.equal(permanent?.supportGrant, null);

  await store.update(
    TABLES.workspaceMembers,
    `member_${workspaceId}_${operator.userId}`,
    { status: "suspended" },
  );
  await store.update(
    TABLES.supportGrants,
    "grant_active",
    rowData(
      { status: "active", expires_at: "2020-01-01T00:00:00.000Z" },
      { ...activeGrant, expiresAt: "2020-01-01T00:00:00.000Z" },
    ),
  );
  const expired = await access.workspaceAccess(workspaceId, operator);
  assert.equal(expired?.membershipStatus, "suspended");
  assert.deepEqual(expired?.roles, []);
  assert.equal(expired?.supportGrant, null);
});

test("support requests require separation of duties and never stack", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  await enableSupport(store, organizationId, workspaceId);
  const operator = identity(
    "support-operator",
    "support@knowhow.example",
    "Support Operator",
  );
  const administrator = identity(
    "workspace-admin",
    "admin@acme.example",
    "Workspace Admin",
  );
  await seedPlatformRole(store, operator.userId, "support");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: administrator.userId,
    email: administrator.email,
    roles: ["administrator"],
  });
  const service = new CommandService(store);
  const request = (await service.execute(
    operator,
    "requestSupportAccess",
    {
      workspaceId,
      requestedRole: "administrator",
      requestedDurationHours: 2,
      reason: "Investigate a reproducible configuration issue.",
    },
    options("request"),
  )) as { requestId: string };
  assert.ok(request.requestId);

  await assert.rejects(
    service.execute(
      operator,
      "requestSupportAccess",
      {
        workspaceId,
        requestedRole: "viewer",
        requestedDurationHours: 1,
        reason: "Attempt to create a duplicate support request.",
      },
      options("duplicate"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SUPPORT_REQUEST_PENDING",
  );
  await assert.rejects(
    service.execute(
      administrator,
      "resolveSupportRequest",
      {
        workspaceId,
        requestId: request.requestId,
        approve: true,
        grantedRole: "administrator",
        grantedDurationHours: 2,
      },
      options("missing-explicit"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SUPPORT_ADMIN_CONFIRM_REQUIRED",
  );
  const decision = (await service.execute(
    administrator,
    "resolveSupportRequest",
    {
      workspaceId,
      requestId: request.requestId,
      approve: true,
      grantedRole: "administrator",
      grantedDurationHours: 2,
      explicitAdministrator: true,
    },
    options("approve"),
  )) as { grantId: string };
  const granted = await new AccessService(store).workspaceAccess(
    workspaceId,
    operator,
  );
  assert.equal(granted?.supportGrant?.id, decision.grantId);
  assert.deepEqual(granted?.roles, ["administrator"]);

  await assert.rejects(
    service.execute(
      operator,
      "createInvite",
      {
        workspaceId,
        email: "person@acme.example",
        role: "viewer",
      },
      options("support-governance"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SUPPORT_GRANT_RESTRICTED",
  );
  await service.execute(
    operator,
    "revokeSupportAccess",
    { workspaceId, grantId: decision.grantId },
    options("self-revoke", false),
  );
  assert.equal((await store.get(TABLES.supportGrants, decision.grantId))?.status, "revoked");
  assert.equal(
    await new AccessService(store).workspaceAccess(workspaceId, operator),
    null,
  );
});

test("support operators cannot request through permanent membership or self-approve", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  await enableSupport(store, organizationId, workspaceId);
  const operator = identity(
    "support-admin",
    "support-admin@knowhow.example",
    "Support Admin",
  );
  await seedPlatformRole(store, operator.userId, "support");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: operator.userId,
    email: operator.email,
    roles: ["administrator"],
  });
  const service = new CommandService(store);
  await assert.rejects(
    service.execute(
      operator,
      "requestSupportAccess",
      {
        workspaceId,
        requestedRole: "viewer",
        requestedDurationHours: 1,
        reason: "Attempt exceptional access while permanently assigned.",
      },
      options("membership-conflict"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SUPPORT_MEMBERSHIP_CONFLICT",
  );

  const caseId = "support_self_approval";
  await store.create(
    TABLES.supportCases,
    caseId,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: operator.userId,
        email: operator.email,
        status: "pending",
        kind: "exceptional_access",
      },
      {
        requesterEmail: operator.email,
        requesterName: operator.name,
        requestedRole: "viewer",
        requestedDurationHours: 1,
        reason: "A manually seeded separation-of-duties test case.",
      },
    ),
  );
  await assert.rejects(
    service.execute(
      operator,
      "resolveSupportRequest",
      {
        workspaceId,
        requestId: caseId,
        approve: true,
        grantedRole: "viewer",
        grantedDurationHours: 1,
      },
      options("self-approval"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SUPPORT_SELF_APPROVAL",
  );
  assert.equal((await store.get(TABLES.supportCases, caseId))?.status, "pending");
});

test("operations sweep expires old support grants", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const operator = identity("ops", "ops@knowhow.example", "Operations");
  await seedPlatformRole(store, operator.userId, "operations");
  const grant = supportGrant("workspace-admin", "2020-01-01T00:00:00.000Z");
  await store.create(
    TABLES.supportGrants,
    "grant_expired",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: "support-operator",
        email: grant.email,
        status: "active",
        kind: grant.role,
        expires_at: grant.expiresAt,
      },
      grant,
    ),
  );
  const result = (await new CommandService(store).execute(
    operator,
    "sweepExpiredSupportAccess",
    {},
    options("expiry-sweep"),
  )) as { expired: number };
  assert.equal(result.expired, 1);
  const row = await store.get(TABLES.supportGrants, "grant_expired");
  assert.equal(row?.status, "expired");
  assert.ok(decodePayload<SupportGrantRecord>(row, grant).endedAt);
});
