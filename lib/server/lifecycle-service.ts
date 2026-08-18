import { TABLES } from "./appwrite-resources";
import {
  effectiveCommercialPlan,
  entitlementsForPlan,
  inferredCommercialPlan,
  isRetainLifecycle,
  subscriptionKindForPlan,
} from "./commercial-plan";
import {
  decodePayload,
  rowData,
  type LifecycleAccess,
  type LifecycleCaseRecord,
  type OrganizationRecord,
  type SubscriptionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { applyPlanEntitlements } from "./entitlement-service";
import type { RecordStore, StoredRecord, RecordData } from "./record-store";

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

async function stableId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}_${hex.slice(0, 35 - prefix.length)}`;
}

type Notice = { kind: string; at: number };

function notices(subscription: SubscriptionRecord): Notice[] {
  const start = validDate(subscription.startsAt);
  const expiry = validDate(subscription.expiresAt);
  if (start === null || expiry === null) return [];
  const stored = inferredCommercialPlan(subscription);
  const prefix =
    stored === "pro_trial" || subscription.kind === "trial"
      ? "trial"
      : stored === "enterprise" || subscription.kind === "design_partner"
        ? "pilot"
        : "subscription";
  const graceEnd = expiry + subscription.graceDays * DAY;
  const eligible = expiry + subscription.retentionDays * DAY;
  const retain = isRetainLifecycle(subscription);
  return [
    { kind: `${prefix}.welcome`, at: start },
    ...(stored === "pro_trial" || subscription.kind === "trial"
      ? [{ kind: "trial.activation_help", at: start + 7 * DAY }]
      : []),
    { kind: `${prefix}.expiry_4d`, at: expiry - 4 * DAY },
    { kind: `${prefix}.expiry_1d`, at: expiry - DAY },
    { kind: `${prefix}.expired`, at: expiry },
    ...(retain
      ? [
          {
            kind: `${prefix}.grace_midpoint`,
            at: expiry + Math.floor(subscription.graceDays / 2) * DAY,
          },
          { kind: `${prefix}.grace_1d`, at: graceEnd - DAY },
          { kind: `${prefix}.suspended`, at: graceEnd },
          { kind: "retention.30d_after_expiry", at: expiry + 30 * DAY },
          { kind: "retention.eligibility_7d", at: eligible - 7 * DAY },
          { kind: "retention.eligibility_1d", at: eligible - DAY },
        ]
      : [
          {
            kind: `${prefix}.grace_1d`,
            at: graceEnd - DAY,
          },
        ]),
  ];
}

function desiredStatus(access: LifecycleAccess): SubscriptionRecord["status"] {
  if (access === "read_only") return "grace";
  if (access === "suspended") return "suspended";
  if (access === "deletion_pending") return "deletion_pending";
  if (access === "deleting") return "deleting";
  if (access === "deleted") return "deleted";
  return "active";
}

export class LifecycleService {
  constructor(private readonly store: RecordStore) {}

  async sweep(now = new Date()) {
    const subscriptions = await this.store.list(TABLES.subscriptions, {
      limit: 50_001,
    });
    const results: Array<{
      workspaceId: string;
      access: LifecycleAccess;
      notifications: number;
      caseCreated: boolean;
    }> = [];
    for (const row of subscriptions) {
      if (!row.workspace_id) continue;
      results.push(await this.sweepSubscription(row, now));
    }
    return results;
  }

  /**
   * Apply the same lifecycle transition used by the operations sweep to one
   * workspace while a command transaction is already open. This is used only
   * by the guarded non-production simulator; it deliberately does not provide
   * an alternate state-transition implementation.
   */
  async sweepWorkspaceInTransaction(workspaceId: string, now = new Date()) {
    const rows = await this.store.list(TABLES.subscriptions, {
      filters: [{ field: "workspace_id", value: workspaceId }],
      order: "desc",
      limit: 10,
    });
    const row = rows.find((item) => item.status !== "cancelled") ?? rows[0];
    if (!row) {
      throw new Error(`Subscription for ${workspaceId} does not exist.`);
    }
    return this.sweepSubscription(row, now, true);
  }

  private async sweepSubscription(
    row: StoredRecord<RecordData>,
    now: Date,
    transactionAlreadyOpen = false,
  ) {
    const subscription = decodePayload<SubscriptionRecord>(row, null as never);
    const workspaceId = String(row.workspace_id);
    const evaluation = evaluateSubscription(subscription, now);
    let notificationCount = 0;
    let caseCreated = false;

    const apply = async (transaction: RecordStore) => {
      const workspaceRow = await transaction.get(
        TABLES.workspaces,
        workspaceId,
      );
      if (!workspaceRow) return;
      const workspace = decodePayload<WorkspaceRecord>(
        workspaceRow,
        null as never,
      );
      const organizationRow = await transaction.get(
        TABLES.organizations,
        workspace.organizationId,
      );
      const organization = organizationRow
        ? decodePayload<OrganizationRecord>(organizationRow, null as never)
        : null;

      const retain = isRetainLifecycle(subscription);
      const storedPlan = inferredCommercialPlan(subscription);
      const effectivePlan = effectiveCommercialPlan(subscription, now);
      let nextSubscription = subscription;
      if (!retain && effectivePlan === "free" && storedPlan !== "free") {
        nextSubscription = {
          ...subscription,
          plan: "free",
          kind: subscriptionKindForPlan("free"),
          status: "active",
          expiresAt: null,
          graceDays: 0,
          publicTrial: false,
          manualContract: false,
          trialConsumed: true,
          downgradedAt: now.toISOString(),
          lastEvaluatedAt: now.toISOString(),
        };
        await applyPlanEntitlements(transaction, {
          organizationId: workspace.organizationId,
          workspaceId,
          actorUserId: "knowhow_ops",
          entitlements: entitlementsForPlan("free"),
        });
      } else if (
        !retain &&
        storedPlan === "pro" &&
        effectivePlan === "pro" &&
        evaluation.expiresAt &&
        now.getTime() >= Date.parse(evaluation.expiresAt)
      ) {
        nextSubscription = {
          ...subscription,
          plan: "pro",
          status: "grace",
          lastEvaluatedAt: now.toISOString(),
        };
      }

      const status = retain
        ? desiredStatus(evaluation.access)
        : nextSubscription.status;
      if (
        subscription.status !== status ||
        subscription.plan !== nextSubscription.plan ||
        subscription.expiresAt !== nextSubscription.expiresAt ||
        subscription.lastEvaluatedAt !== now.toISOString()
      ) {
        await transaction.update(
          TABLES.subscriptions,
          row.$id,
          rowData(
            {
              organization_id: row.organization_id,
              workspace_id: workspaceId,
              status,
              kind: nextSubscription.kind,
              updated_by: "knowhow_ops",
            },
            { ...nextSubscription, status, lastEvaluatedAt: now.toISOString() },
          ),
        );
      }

      const shouldSuspend =
        retain &&
        [
          "suspended",
          "deletion_pending",
          "deleting",
          "deleted",
        ].includes(evaluation.access);
      if (
        shouldSuspend &&
        (workspace.status !== "suspended" ||
          workspace.suspensionReason !== "lifecycle")
      ) {
        await transaction.update(
          TABLES.workspaces,
          workspaceId,
          rowData(
            {
              organization_id: workspace.organizationId,
              slug: workspace.slug,
              status: "suspended",
              updated_by: "knowhow_ops",
            },
            {
              ...workspace,
              status: "suspended",
              suspensionReason: "lifecycle",
            },
          ),
        );
      } else if (
        !shouldSuspend &&
        workspace.status === "suspended" &&
        workspace.suspensionReason === "lifecycle"
      ) {
        await transaction.update(
          TABLES.workspaces,
          workspaceId,
          rowData(
            {
              organization_id: workspace.organizationId,
              slug: workspace.slug,
              status: "active",
              updated_by: "knowhow_ops",
            },
            { ...workspace, status: "active", suspensionReason: null },
          ),
        );
      }

      const administrators = (
        await transaction.list(TABLES.workspaceMembers, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "status", value: "active" },
          ],
        })
      ).filter((member) =>
        decodePayload<WorkspaceMemberRecord>(member, {
          name: "",
          roles: [],
          capabilities: [],
          groupIds: [],
        }).roles.includes("administrator"),
      );
      for (const notice of notices(subscription)) {
        if (notice.at > now.getTime()) continue;
        for (const administrator of administrators) {
          const email =
            typeof administrator.email === "string"
              ? administrator.email
              : null;
          if (!email) continue;
          const idempotencyKey = `${row.$id}:${notice.kind}:${administrator.user_id}`;
          const id = await stableId("notice", idempotencyKey);
          if (await transaction.get(TABLES.notificationDeliveries, id))
            continue;
          await transaction.create(
            TABLES.notificationDeliveries,
            id,
            rowData(
              {
                organization_id: workspace.organizationId,
                workspace_id: workspaceId,
                user_id: administrator.user_id,
                email,
                kind: notice.kind,
                subject_id: row.$id,
                status: "queued",
                scheduled_at: now.toISOString(),
                idempotency_key: idempotencyKey,
                created_by: "knowhow_ops",
              },
              {
                workspaceName: workspace.name,
                expiresAt: evaluation.expiresAt,
                graceEndsAt: evaluation.graceEndsAt,
                deletionEligibleAt: evaluation.deletionEligibleAt,
                retainLifecycle: retain,
              },
            ),
          );
          notificationCount += 1;
        }
      }

      if (
        retain &&
        evaluation.access === "deletion_pending" &&
        evaluation.deletionEligibleAt
      ) {
        const caseId = await stableId("delete", `${row.$id}:tenant-deletion`);
        const existing = await transaction.get(TABLES.lifecycleCases, caseId);
        if (!existing) {
          const confirmationText = `DELETE ${organization?.displayName ?? workspace.name}`;
          const record: LifecycleCaseRecord = {
            kind: "tenant_deletion_approval",
            subscriptionId: row.$id,
            status: "awaiting_approval",
            eligibleAt: evaluation.deletionEligibleAt,
            confirmationText,
            createdAt: now.toISOString(),
          };
          await transaction.create(
            TABLES.lifecycleCases,
            caseId,
            rowData(
              {
                organization_id: workspace.organizationId,
                workspace_id: workspaceId,
                subject_id: row.$id,
                kind: record.kind,
                status: record.status,
                scheduled_at: now.toISOString(),
                created_by: "knowhow_ops",
              },
              record,
            ),
          );
          caseCreated = true;
        }

        const day = now.toISOString().slice(0, 10);
        for (const ownerEmail of (
          process.env.KNOWHOW_PLATFORM_OWNER_EMAILS ?? ""
        )
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean)) {
          const idempotencyKey = `${caseId}:critical:${day}:${ownerEmail}`;
          const noticeId = await stableId("notice", idempotencyKey);
          if (await transaction.get(TABLES.notificationDeliveries, noticeId))
            continue;
          await transaction.create(
            TABLES.notificationDeliveries,
            noticeId,
            rowData(
              {
                organization_id: workspace.organizationId,
                workspace_id: workspaceId,
                email: ownerEmail,
                kind: "deletion.approval_overdue",
                subject_id: caseId,
                status: "queued",
                scheduled_at: now.toISOString(),
                idempotency_key: idempotencyKey,
                created_by: "knowhow_ops",
              },
              {
                workspaceName: workspace.name,
                organizationName: organization?.displayName ?? workspace.name,
                eligibleAt: evaluation.deletionEligibleAt,
              },
            ),
          );
          notificationCount += 1;
        }
      }
    };
    if (transactionAlreadyOpen) await apply(this.store);
    else await this.store.transaction(apply);
    return {
      workspaceId,
      access: evaluation.access,
      notifications: notificationCount,
      caseCreated,
    };
  }
}
