import type { OrganizationRole, WorkspaceRole, WorkspaceStatus } from "../knowhow-types";
import { decodePayload, type LifecycleAccess, type SupportGrantRecord, type WorkspaceMemberRecord, type WorkspaceRecord } from "./domain-records";
import { HttpError } from "./http-security";
import { TABLES } from "./appwrite-resources";
import type { AuthorizationContext } from "./policy";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";
import { evaluateSubscription, subscriptionForWorkspace, type LifecycleEvaluation } from "./lifecycle-service";

export type PlatformRole = "owner" | "operations" | "support" | "billing" | "auditor";
export type { OrganizationRole } from "../knowhow-types";

export type WorkspaceAccess = {
  workspaceRow: StoredRecord<RecordData>;
  workspace: WorkspaceRecord;
  membershipRow: StoredRecord<RecordData> | null;
  roles: WorkspaceRole[];
  capabilities: Array<"vault">;
  membershipStatus: "active" | "suspended";
  supportGrant: (SupportGrantRecord & { id: string }) | null;
  lifecycleAccess: LifecycleAccess;
  lifecycle: LifecycleEvaluation;
};

function activeExpiry(value: unknown) {
  return typeof value === "string" && Date.parse(value) > Date.now();
}

export class AccessService {
  constructor(private readonly store: RecordStore) {}

  async platformRoles(userId: string): Promise<PlatformRole[]> {
    const rows = await this.store.list(TABLES.platformRoles, {
      filters: [
        { field: "user_id", value: userId },
        { field: "status", value: "active" },
      ],
    });
    return rows
      .map((row) => row.kind)
      .filter((role): role is PlatformRole =>
        typeof role === "string" && ["owner", "operations", "support", "billing", "auditor"].includes(role),
      );
  }

  async organizationRoles(organizationId: string, userId: string): Promise<OrganizationRole[]> {
    const rows = await this.store.list(TABLES.organizationMemberships, {
      filters: [
        { field: "organization_id", value: organizationId },
        { field: "user_id", value: userId },
        { field: "status", value: "active" },
      ],
      limit: 1,
    });
    const value = rows[0] ? decodePayload<{ roles?: string[] }>(rows[0], {}) : {};
    return (value.roles ?? []).filter((role): role is OrganizationRole =>
      ["owner", "administrator", "billing", "security_auditor"].includes(role),
    );
  }

  async workspaceAccess(workspaceId: string, identity: AuthenticatedIdentity): Promise<WorkspaceAccess | null> {
    const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
    if (!workspaceRow) return null;
    const workspace = decodePayload<WorkspaceRecord>(workspaceRow, null as never);
    if (!workspace?.name || workspace.organizationId !== workspaceRow.organization_id) return null;

    const [memberships, subscription] = await Promise.all([
      this.store.list(TABLES.workspaceMembers, {
      filters: [
        { field: "workspace_id", value: workspaceId },
        { field: "user_id", value: identity.userId },
      ],
      limit: 1,
      }),
      subscriptionForWorkspace(this.store, workspaceId),
    ]);
    const lifecycle = evaluateSubscription(subscription?.value ?? null);
    const lifecycleAccess = lifecycle.access;
    const membershipRow = memberships[0] ?? null;
    if (membershipRow && membershipRow.status !== "suspended") {
      const member = decodePayload<WorkspaceMemberRecord>(membershipRow, {
        name: identity.name,
        roles: [],
        capabilities: [],
        groupIds: [],
      });
      return {
        workspaceRow,
        workspace,
        membershipRow,
        roles: member.roles,
        capabilities: member.capabilities,
        membershipStatus: "active",
        supportGrant: null,
        lifecycleAccess,
        lifecycle,
      };
    }

    const grants = await this.store.list(TABLES.supportGrants, {
      filters: [
        { field: "workspace_id", value: workspaceId },
        { field: "user_id", value: identity.userId },
        { field: "status", value: "active" },
      ],
      order: "desc",
      limit: 1,
    });
    const grantRow = grants[0];
    if (grantRow && activeExpiry(grantRow.expires_at)) {
      const grant = decodePayload<SupportGrantRecord>(grantRow, null as never);
      if (grant?.role) {
        return {
          workspaceRow,
          workspace,
          membershipRow: null,
          roles: [grant.role],
          capabilities: [],
          membershipStatus: "active",
          supportGrant: { ...grant, id: grantRow.$id },
          lifecycleAccess,
          lifecycle,
        };
      }
    }
    if (membershipRow) {
      return {
        workspaceRow,
        workspace,
        membershipRow,
        roles: [],
        capabilities: [],
        membershipStatus: "suspended",
        supportGrant: null,
        lifecycleAccess,
        lifecycle,
      };
    }
    return null;
  }

  async requireWorkspace(workspaceId: string, identity: AuthenticatedIdentity) {
    const access = await this.workspaceAccess(workspaceId, identity);
    if (!access) throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
    return access;
  }

  context(access: WorkspaceAccess, isPlatformAdministrator = false): AuthorizationContext {
    return {
      isVerifiedIdentity: true,
      isPlatformAdministrator,
      membershipStatus: access.membershipStatus,
      workspaceStatus: access.workspace.status as WorkspaceStatus,
      lifecycleAccess: access.lifecycleAccess,
      roles: access.roles,
      capabilities: access.capabilities,
      ...(access.supportGrant
        ? {
            supportGrant: {
              role: access.supportGrant.role,
              expiresAt: access.supportGrant.expiresAt,
            },
          }
        : {}),
    };
  }
}
