import { TABLES } from "./appwrite-resources";
import { decodePayload, type PrivateMediaRecord, type WorkspaceMemberRecord } from "./domain-records";
import { HttpError } from "./http-security";
import type { RecordStore } from "./record-store";

type EntitlementValue = string | number | boolean;

const DEFAULTS: Record<string, EntitlementValue> = {
  maximumUsers: 100,
  maximumCreators: 25,
  storageBytes: 5_000_000_000,
  extensionEnabled: false,
  supportEnabled: false,
  removeBranding: false,
  publicSignup: false,
  payments: false,
  ssoScim: false,
};

export class EntitlementService {
  constructor(private readonly store: RecordStore, private readonly workspaceId: string) {}

  async value<T extends EntitlementValue>(kind: string, fallback?: T): Promise<T> {
    const rows = await this.store.list(TABLES.entitlements, {
      filters: [
        { field: "workspace_id", value: this.workspaceId },
        { field: "kind", value: kind },
        { field: "status", value: "active" },
      ],
      limit: 1,
    });
    const value = rows[0] ? decodePayload<{ value?: EntitlementValue }>(rows[0], {}).value : undefined;
    return (value ?? fallback ?? DEFAULTS[kind]) as T;
  }

  async requireFeature(kind: "extensionEnabled" | "supportEnabled" | "removeBranding") {
    if (!(await this.value<boolean>(kind, false))) {
      throw new HttpError(403, "ENTITLEMENT_REQUIRED", "This feature is not enabled for the workspace.");
    }
  }

  async assertMemberCapacity(additional = 1) {
    const maximum = await this.value<number>("maximumUsers", 100);
    const active = (await this.store.list(TABLES.workspaceMembers, {
      filters: [{ field: "workspace_id", value: this.workspaceId }, { field: "status", value: "active" }],
    })).length;
    if (active + additional > maximum) {
      throw new HttpError(409, "USER_ENTITLEMENT_EXCEEDED", "The workspace has reached its active-user entitlement.");
    }
  }

  async assertCreatorCapacity(userId?: string) {
    const maximum = await this.value<number>("maximumCreators", 25);
    const members = await this.store.list(TABLES.workspaceMembers, {
      filters: [{ field: "workspace_id", value: this.workspaceId }, { field: "status", value: "active" }],
    });
    const creatorIds = new Set(
      members
        .filter((row) => decodePayload<WorkspaceMemberRecord>(row, { name: "", roles: [], capabilities: [], groupIds: [] }).roles.some((role) => role === "creator" || role === "administrator"))
        .map((row) => String(row.user_id)),
    );
    if (userId) creatorIds.add(userId);
    if (creatorIds.size > maximum) {
      throw new HttpError(409, "CREATOR_ENTITLEMENT_EXCEEDED", "The workspace has reached its active-creator entitlement.");
    }
  }

  async assertStorageCapacity(additionalBytes: number, replacingMediaId?: string) {
    const maximum = await this.value<number>("storageBytes", 5_000_000_000);
    const media = await this.store.list(TABLES.privateMedia, {
      filters: [{ field: "workspace_id", value: this.workspaceId }],
      limit: 50_001,
    });
    let used = 0;
    for (const row of media) {
      if (row.$id === replacingMediaId || row.status === "deleted" || row.status === "quarantined") continue;
      used += decodePayload<PrivateMediaRecord>(row, null as never)?.byteSize ?? 0;
    }
    if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0 || used + additionalBytes > maximum) {
      throw new HttpError(413, "STORAGE_ENTITLEMENT_EXCEEDED", "The workspace storage entitlement would be exceeded.");
    }
    return { used, maximum };
  }
}
