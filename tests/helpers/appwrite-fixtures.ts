import type { AuthenticatedIdentity } from "../../lib/server/session-identity";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  rowData,
  type OrganizationRecord,
  type SubscriptionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "../../lib/server/domain-records";
import { TABLES } from "../../lib/server/appwrite-resources";
import type { RecordStore } from "../../lib/server/record-store";

export const identity = (
  userId: string,
  email = `${userId}@example.com`,
  name = userId,
): AuthenticatedIdentity => ({
  userId,
  email,
  name,
  emailVerified: true,
  mfaEnabled: true,
});

export async function seedWorkspace(
  store: RecordStore,
  options: {
    organizationId?: string;
    workspaceId?: string;
    workspaceName?: string;
    workspaceStatus?: "active" | "suspended" | "archived";
    subscription?: Partial<SubscriptionRecord>;
  } = {},
) {
  const organizationId = options.organizationId ?? "org_acme";
  const workspaceId = options.workspaceId ?? "workspace_acme";
  const workspaceName = options.workspaceName ?? "Acme Operations";
  const createdAt = "2026-01-01T00:00:00.000Z";
  const organization: OrganizationRecord = {
    legalName: "Acme LLC",
    displayName: "Acme",
    primaryContactName: "Acme Owner",
    primaryContactEmail: "owner@acme.example",
    country: "QA",
    status: "active",
    createdAt,
  };
  const workspace: WorkspaceRecord = {
    organizationId,
    name: workspaceName,
    slug: workspaceId,
    status: options.workspaceStatus ?? "active",
    createdAt,
    auditSequence: 0,
    auditHash: "0".repeat(64),
    suspensionReason: null,
  };
  const subscription: SubscriptionRecord = {
    kind: "paid",
    startsAt: createdAt,
    expiresAt: null,
    graceDays: 7,
    retentionDays: 90,
    publicTrial: false,
    manualContract: true,
    status: "active",
    ...options.subscription,
  };
  if (!(await store.get(TABLES.organizations, organizationId))) {
    await store.create(
      TABLES.organizations,
      organizationId,
      rowData(
        { slug: organizationId, status: "active", created_by: "seed" },
        organization,
      ),
    );
  }
  await store.create(
    TABLES.workspaces,
    workspaceId,
    rowData(
      {
        organization_id: organizationId,
        slug: workspace.slug,
        status: workspace.status,
        created_by: "seed",
      },
      workspace,
    ),
  );
  await store.create(
    TABLES.workspaceSettings,
    `settings_${workspaceId}`,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        status: "active",
        created_by: "seed",
      },
      DEFAULT_WORKSPACE_SETTINGS,
    ),
  );
  await store.create(
    TABLES.subscriptions,
    `subscription_${workspaceId}`,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        status: subscription.status,
        kind: subscription.kind,
        created_by: "seed",
      },
      subscription,
    ),
  );
  return { organizationId, workspaceId, workspace, subscription };
}

export async function seedWorkspaceMember(
  store: RecordStore,
  input: {
    organizationId?: string;
    workspaceId?: string;
    userId: string;
    email?: string;
    roles: WorkspaceMemberRecord["roles"];
    status?: "active" | "suspended";
    capabilities?: WorkspaceMemberRecord["capabilities"];
  },
) {
  const organizationId = input.organizationId ?? "org_acme";
  const workspaceId = input.workspaceId ?? "workspace_acme";
  const email = input.email ?? `${input.userId}@example.com`;
  const member: WorkspaceMemberRecord = {
    name: input.userId,
    roles: input.roles,
    capabilities: input.capabilities ?? [],
    groupIds: [],
  };
  await store.create(
    TABLES.workspaceMembers,
    `member_${workspaceId}_${input.userId}`,
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: input.userId,
        email,
        status: input.status ?? "active",
        created_by: "seed",
      },
      member,
    ),
  );
  return member;
}

export async function seedOrganizationMember(
  store: RecordStore,
  input: {
    organizationId?: string;
    userId: string;
    email?: string;
    roles: Array<"owner" | "administrator" | "billing" | "security_auditor">;
    status?: "active" | "revoked";
  },
) {
  const organizationId = input.organizationId ?? "org_acme";
  const email = input.email ?? `${input.userId}@example.com`;
  const id = `org_member_${organizationId}_${input.userId}`;
  await store.create(
    TABLES.organizationMemberships,
    id,
    rowData(
      {
        organization_id: organizationId,
        user_id: input.userId,
        email,
        status: input.status ?? "active",
        created_by: "seed",
      },
      { name: input.userId, roles: input.roles },
    ),
  );
  return id;
}
