import { TABLES } from "./appwrite-resources";
import { isRetainLifecycle } from "./commercial-plan";
import {
  decodePayload,
  type LifecycleAccess,
  type SubscriptionRecord,
} from "./domain-records";
import type { RecordStore } from "./record-store";

const DAY = 86_400_000;

function validDate(value: string | null | undefined) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export type LifecycleEvaluation = {
  access: LifecycleAccess;
  expiresAt: string | null;
  graceEndsAt: string | null;
  deletionEligibleAt: string | null;
};

export function evaluateSubscription(
  subscription: SubscriptionRecord | null,
  now = new Date(),
): LifecycleEvaluation {
  if (!subscription) {
    return {
      access: "active",
      expiresAt: null,
      graceEndsAt: null,
      deletionEligibleAt: null,
    };
  }
  const expiry = validDate(subscription.expiresAt);
  const graceDays = Math.max(0, Math.min(30, subscription.graceDays));
  const retentionDays = Math.max(
    graceDays,
    Math.min(365, subscription.retentionDays),
  );
  const graceEnd = expiry === null ? null : expiry + graceDays * DAY;
  const deletionEligible =
    expiry === null ? null : expiry + retentionDays * DAY;
  const base = {
    expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
    graceEndsAt: graceEnd === null ? null : new Date(graceEnd).toISOString(),
    deletionEligibleAt:
      deletionEligible === null
        ? null
        : new Date(deletionEligible).toISOString(),
  };

  if (subscription.status === "deleted") return { access: "deleted", ...base };
  if (subscription.status === "deleting")
    return { access: "deleting", ...base };
  if (subscription.status === "deletion_pending")
    return { access: "deletion_pending", ...base };
  if (!isRetainLifecycle(subscription)) {
    return { access: "active", ...base, deletionEligibleAt: null };
  }
  if (subscription.status === "cancelled")
    return { access: "suspended", ...base };
  if (subscription.kind === "paid" && expiry === null)
    return { access: "active", ...base };
  if (expiry === null || now.getTime() < expiry)
    return { access: "active", ...base };
  if (graceEnd !== null && now.getTime() < graceEnd)
    return { access: "read_only", ...base };
  if (deletionEligible !== null && now.getTime() >= deletionEligible) {
    return { access: "deletion_pending", ...base };
  }
  return { access: "suspended", ...base };
}

export async function subscriptionForWorkspace(
  store: RecordStore,
  workspaceId: string,
) {
  const rows = await store.list(TABLES.subscriptions, {
    filters: [{ field: "workspace_id", value: workspaceId }],
    order: "desc",
    limit: 10,
  });
  const row = rows.find((item) => item.status !== "cancelled") ?? rows[0];
  if (!row) return null;
  const decoded = decodePayload<Partial<SubscriptionRecord>>(row, {});
  const value: SubscriptionRecord = {
    kind: (decoded.kind ??
      row.kind ??
      "design_partner") as SubscriptionRecord["kind"],
    startsAt: decoded.startsAt ?? row.$createdAt,
    expiresAt: decoded.expiresAt ?? null,
    graceDays: decoded.graceDays ?? 7,
    retentionDays: decoded.retentionDays ?? 90,
    publicTrial: false,
    manualContract: decoded.manualContract ?? true,
    status: (decoded.status ??
      row.status ??
      "active") as SubscriptionRecord["status"],
    ...decoded,
  };
  return { row, value };
}
