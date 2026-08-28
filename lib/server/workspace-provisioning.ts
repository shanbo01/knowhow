import { TABLES } from "./appwrite-resources";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  rowData,
  type SubscriptionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import type { EntitlementValue } from "./entitlement-service";
import { deterministicResourceId } from "./ids";
import type { RecordStore } from "./record-store";

export type WorkspaceProvisionIds = {
  workspaceId: string;
  settingsId: string;
  memberId: string;
  subscriptionId: string;
  onboardingProgressId: string;
};

export type WorkspaceProvisionInput = {
  ids: WorkspaceProvisionIds;
  organizationId: string;
  name: string;
  slug: string;
  createdAt: string;
  actor: { userId: string; email: string; name: string };
  accentColor: string;
  logoMediaId?: string | null;
  /** Full subscription payload — callers differ on trial dates and catalog ids. */
  subscription: SubscriptionRecord & Record<string, unknown>;
  subscriptionKind: string;
  entitlements: Record<string, EntitlementValue>;
  entitlementSource: string;
  requestId?: string;
};

/**
 * Writes the six workspace-scoped records every new workspace needs. Shared by
 * self-service signup and admin-created workspaces so the two cannot drift;
 * organization, membership, branding, and idempotency records stay with the
 * callers, which handle them differently.
 */
export async function provisionWorkspaceRecords(
  store: RecordStore,
  input: WorkspaceProvisionInput,
) {
  const { ids, organizationId, actor, createdAt, requestId } = input;
  const scope = {
    organization_id: organizationId,
    workspace_id: ids.workspaceId,
    status: "active",
    created_by: actor.userId,
  };

  const workspace: WorkspaceRecord = {
    organizationId,
    name: input.name,
    slug: input.slug,
    status: "active",
    createdAt,
    auditSequence: 0,
    auditHash: "0".repeat(64),
  };
  await store.create(
    TABLES.workspaces,
    ids.workspaceId,
    rowData(
      {
        organization_id: organizationId,
        slug: input.slug,
        status: "active",
        created_by: actor.userId,
        ...(requestId ? { request_id: requestId } : {}),
      },
      workspace,
    ),
  );

  await store.create(
    TABLES.workspaceSettings,
    ids.settingsId,
    rowData(
      scope,
      {
        ...DEFAULT_WORKSPACE_SETTINGS,
        accentColor: input.accentColor,
        ...(input.logoMediaId ? { logoUrl: input.logoMediaId } : {}),
      },
    ),
  );

  const member: WorkspaceMemberRecord = {
    name: actor.name,
    roles: ["administrator"],
    groupIds: [],
    joinedAt: createdAt,
  };
  await store.create(
    TABLES.workspaceMembers,
    ids.memberId,
    rowData({ ...scope, user_id: actor.userId, email: actor.email }, member),
  );

  await store.create(
    TABLES.subscriptions,
    ids.subscriptionId,
    rowData({ ...scope, kind: input.subscriptionKind }, input.subscription),
  );

  for (const [kind, value] of Object.entries(input.entitlements)) {
    const entitlementId = await deterministicResourceId(
      "entitle",
      `${ids.workspaceId}:${kind}`,
    );
    await store.create(
      TABLES.entitlements,
      entitlementId,
      rowData({ ...scope, kind }, { value, source: input.entitlementSource }),
    );
  }

  await store.create(
    TABLES.onboardingProgress,
    ids.onboardingProgressId,
    rowData(
      { ...scope, user_id: actor.userId, occurred_at: createdAt },
      {
        startedAt: createdAt,
        completedAt: null,
        currentStep: "workspace_readiness",
        skippedSteps: [],
      },
    ),
  );
}
