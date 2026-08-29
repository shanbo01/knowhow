import { TABLES } from "./appwrite-resources";
import {
  effectiveCommercialPlan,
  entitlementsForPlan,
  WORKSPACES_PER_PLAN,
  type PlanEntitlements,
} from "./commercial-plan";
import {
  decodePayload,
  rowData,
  type PrivateMediaRecord,
  type SubscriptionRecord,
  type WorkspaceMemberRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { deterministicResourceId, resourceId } from "./ids";
import type { RecordStore } from "./record-store";

export class EntitlementDeniedError extends HttpError {
  readonly entitlementKind: string;

  constructor(
    status: number,
    code: string,
    message: string,
    entitlementKind: string,
  ) {
    super(status, code, message, { entitlement: entitlementKind });
    this.name = "EntitlementDeniedError";
    this.entitlementKind = entitlementKind;
  }
}

export async function recordEntitlementBlocked(
  store: RecordStore,
  workspaceId: string,
  entitlementKind: string,
) {
  try {
    const workspace = await store.get(TABLES.workspaces, workspaceId);
    await store.create(
      TABLES.usageEvents,
      resourceId("usage"),
      rowData(
        {
          organization_id: String(workspace?.organization_id ?? ""),
          workspace_id: workspaceId,
          kind: "entitlement.blocked",
          status: "recorded",
          occurred_at: new Date().toISOString(),
          created_by: "knowhow",
        },
        { entitlementKind },
      ),
    );
  } catch {
    // Never mask the entitlement denial if telemetry write fails.
  }
}

export type EntitlementValue = string | number | boolean;

export type EntitlementOverridePayload = {
  value: EntitlementValue;
  source?: "plan" | "override";
  reason?: string;
  expiresAt?: string | null;
  grantedBy?: string;
  grantedAt?: string;
};

const DEFAULTS: Record<string, EntitlementValue> = {
  maximumUsers: 3,
  maximumCreators: 1,
  maximumGuides: 15,
  storageBytes: 1_000_000_000,
  extensionEnabled: true,
  desktopCaptureEnabled: false,
  supportEnabled: false,
  removeBranding: false,
  privacyToolsEnabled: false,
  publicSignup: false,
  payments: false,
  ssoScim: false,
  fileExportsEnabled: false,
};

export const OVERRIDABLE_ENTITLEMENTS = [
  "maximumUsers",
  "maximumCreators",
  "maximumGuides",
  "storageBytes",
  "extensionEnabled",
  "desktopCaptureEnabled",
  "supportEnabled",
  "removeBranding",
  "privacyToolsEnabled",
  "fileExportsEnabled",
] as const;

export type OverridableEntitlement = (typeof OVERRIDABLE_ENTITLEMENTS)[number];

/**
 * How many workspaces an organization may hold. Organization-scoped rather than
 * workspace-scoped, so it lives on its own row (`workspace_id` null) instead of
 * in the per-workspace snapshot.
 */
export const ORGANIZATION_ENTITLEMENTS = ["maximumWorkspaces"] as const;

const ORGANIZATION_DEFAULTS: Record<string, EntitlementValue> = {
  maximumWorkspaces: 1,
};

export async function organizationEntitlement(
  store: RecordStore,
  organizationId: string,
  kind: (typeof ORGANIZATION_ENTITLEMENTS)[number],
  fallback?: number,
): Promise<number> {
  const rows = await store.list(TABLES.entitlements, {
    filters: [
      { field: "organization_id", value: organizationId },
      { field: "kind", value: kind },
    ],
    limit: 10,
  });
  const now = Date.now();
  for (const row of rows) {
    // Only the organization-scoped row counts; per-workspace rows share the
    // organization id but describe a single workspace.
    if (row.status !== "active" || row.workspace_id) continue;
    const payload = decodePayload<EntitlementOverridePayload>(row, {
      value: false,
    });
    if (payload.value === undefined || isExpiredOverride(payload, now)) continue;
    if (typeof payload.value === "number") return payload.value;
  }
  return fallback ?? (ORGANIZATION_DEFAULTS[kind] as number);
}

/**
 * How many workspaces the organization may hold: an explicit entitlement row
 * when one exists, otherwise derived from its best-funded workspace. Buying Pro
 * for one workspace is what unlocks adding more.
 */
export async function organizationWorkspaceLimit(
  store: RecordStore,
  organizationId: string,
) {
  const rows = await store.list(TABLES.subscriptions, {
    filters: [{ field: "organization_id", value: organizationId }],
    limit: 200,
  });
  let allowed = WORKSPACES_PER_PLAN.free;
  for (const row of rows) {
    if (row.status === "cancelled") continue;
    const subscription = decodePayload<SubscriptionRecord>(row, null as never);
    if (!subscription) continue;
    const plan = effectiveCommercialPlan(subscription);
    allowed = Math.max(allowed, WORKSPACES_PER_PLAN[plan]);
  }
  return organizationEntitlement(
    store,
    organizationId,
    "maximumWorkspaces",
    allowed,
  );
}

function isExpiredOverride(payload: EntitlementOverridePayload, now: number) {
  if (payload.source !== "override") return false;
  if (!payload.expiresAt) return false;
  const expiry = Date.parse(payload.expiresAt);
  return Number.isFinite(expiry) && expiry <= now;
}

export async function applyPlanEntitlements(
  store: RecordStore,
  input: {
    organizationId: string;
    workspaceId: string;
    actorUserId: string;
    entitlements: PlanEntitlements | Record<string, EntitlementValue>;
  },
) {
  const existing = await store.list(TABLES.entitlements, {
    filters: [{ field: "workspace_id", value: input.workspaceId }],
    limit: 100,
  });
  const byKind = new Map(
    existing.map((row) => [String(row.kind), row] as const),
  );
  for (const [kind, value] of Object.entries(input.entitlements)) {
    const fields = rowData(
      {
        organization_id: input.organizationId,
        workspace_id: input.workspaceId,
        kind,
        status: "active",
        updated_by: input.actorUserId,
      },
      { value, source: "plan" } satisfies EntitlementOverridePayload,
    );
    const row = byKind.get(kind);
    if (row) {
      await store.update(TABLES.entitlements, row.$id, fields);
    } else {
      const id = await deterministicResourceId(
        "entitle",
        `${input.workspaceId}:${kind}`,
      );
      await store.create(TABLES.entitlements, id, {
        ...fields,
        created_by: input.actorUserId,
      });
    }
  }
}

export class EntitlementService {
  constructor(private readonly store: RecordStore, private readonly workspaceId: string) {}

  private async subscription() {
    const rows = await this.store.list(TABLES.subscriptions, {
      filters: [{ field: "workspace_id", value: this.workspaceId }],
      order: "desc",
      limit: 10,
    });
    const row = rows.find((item) => item.status !== "cancelled") ?? rows[0];
    if (!row) return null;
    return decodePayload<SubscriptionRecord>(row, null as never);
  }

  async snapshot(): Promise<PlanEntitlements> {
    const subscription = await this.subscription();
    const plan = effectiveCommercialPlan(subscription);
    const catalog = entitlementsForPlan(plan);
    const rows = await this.store.list(TABLES.entitlements, {
      filters: [{ field: "workspace_id", value: this.workspaceId }],
      limit: 100,
    });
    const stored: Record<string, EntitlementValue> = {};
    const now = Date.now();
    for (const row of rows) {
      if (row.status !== "active" || typeof row.kind !== "string") continue;
      const payload = decodePayload<EntitlementOverridePayload>(row, {
        value: false,
      });
      if (payload.value === undefined) continue;
      if (isExpiredOverride(payload, now)) continue;
      stored[row.kind] = payload.value;
    }
    const merged = { ...DEFAULTS, ...catalog, ...stored } as PlanEntitlements;
    if (plan === "free") return { ...merged, ...catalog };
    return merged;
  }

  async value<T extends EntitlementValue>(kind: string, fallback?: T): Promise<T> {
    const snapshot = await this.snapshot();
    const fromPlan = snapshot[kind as keyof PlanEntitlements];
    return (fromPlan ?? fallback ?? DEFAULTS[kind]) as T;
  }

  private async deny(kind: string, status: number, code: string, message: string): Promise<never> {
    await recordEntitlementBlocked(this.store, this.workspaceId, kind);
    throw new EntitlementDeniedError(status, code, message, kind);
  }

  async requireFeature(
    kind:
      | "extensionEnabled"
      | "desktopCaptureEnabled"
      | "supportEnabled"
      | "removeBranding"
      | "privacyToolsEnabled"
      | "fileExportsEnabled",
  ) {
    if (!(await this.value<boolean>(kind, false))) {
      await this.deny(
        kind,
        403,
        "ENTITLEMENT_REQUIRED",
        "This feature is not enabled for the workspace.",
      );
    }
  }

  async assertMemberCapacity(additional = 1) {
    const maximum = await this.value<number>("maximumUsers", 100);
    const active = (await this.store.list(TABLES.workspaceMembers, {
      filters: [{ field: "workspace_id", value: this.workspaceId }, { field: "status", value: "active" }],
    })).length;
    if (active + additional > maximum) {
      await this.deny(
        "maximumUsers",
        409,
        "USER_ENTITLEMENT_EXCEEDED",
        "The workspace has reached its active-user entitlement.",
      );
    }
  }

  async assertCreatorCapacity(userId?: string) {
    const maximum = await this.value<number>("maximumCreators", 25);
    const members = await this.store.list(TABLES.workspaceMembers, {
      filters: [{ field: "workspace_id", value: this.workspaceId }, { field: "status", value: "active" }],
    });
    const creatorIds = new Set(
      members
        .filter((row) => decodePayload<WorkspaceMemberRecord>(row, { name: "", roles: [], groupIds: [] }).roles.some((role) => role === "creator" || role === "administrator"))
        .map((row) => String(row.user_id)),
    );
    if (userId) creatorIds.add(userId);
    if (creatorIds.size > maximum) {
      await this.deny(
        "maximumCreators",
        409,
        "CREATOR_ENTITLEMENT_EXCEEDED",
        "The workspace has reached its active-creator entitlement.",
      );
    }
  }

  /**
   * Live guides — archived and deleted ones are excluded, so archiving frees a
   * slot the same way deleting one does.
   */
  async guideUsage() {
    const maximum = await this.value<number>("maximumGuides", 15);
    const rows = await this.store.list(TABLES.guides, {
      filters: [{ field: "workspace_id", value: this.workspaceId }],
      limit: 10_001,
    });
    const used = rows.filter(
      (row) => row.status !== "deleted" && row.status !== "archived",
    ).length;
    return { used, maximum };
  }

  async assertGuideCapacity(additional = 1) {
    const { used, maximum } = await this.guideUsage();
    if (used + additional > maximum) {
      await this.deny(
        "maximumGuides",
        409,
        "GUIDE_ENTITLEMENT_EXCEEDED",
        `This workspace has reached its limit of ${maximum} guides.`,
      );
    }
    return { used, maximum };
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
      await this.deny(
        "storageBytes",
        413,
        "STORAGE_ENTITLEMENT_EXCEEDED",
        "The workspace storage entitlement would be exceeded.",
      );
    }
    return { used, maximum };
  }
}
