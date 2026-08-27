import "server-only";

import type {
  PlatformAccountRecord,
  PlatformAccountSummary,
  PlatformAuditSummary,
  PlatformDeletionCase,
  PlatformHome,
  PlatformHomeItem,
  PlatformLeadRecord,
  PlatformNotificationFailure,
  PlatformPage,
  PlatformPerson,
  PlatformQueueCounts,
  PlatformRevenue,
  PlatformRevenueMonth,
  PlatformSearchHit,
  PlatformSubscriptionSummary,
  PlatformTicketRecord,
  PlatformTicketSummary,
  WorkspaceRole,
} from "../knowhow-types";
import { AccessService } from "./access-service";
import { TABLES } from "./appwrite-resources";
import {
  effectiveCommercialPlan,
  entitlementsForPlan,
  inferredCommercialPlan,
  trialConsumed,
  type CommercialPlan,
} from "./commercial-plan";
import {
  decodePayload,
  type OrganizationRecord,
  type PrivateMediaRecord,
  type SubscriptionRecord,
  type SupportGrantRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { evaluateSubscription } from "./lifecycle-service";
import {
  customerHealth,
  daysUntil,
  emailDomain,
  intentScore,
  isConsumerEmailDomain,
  isVipAccount,
  nextBestAction,
  normalizeAccountTags,
  type WorkspaceSignals,
} from "./platform-intelligence";
import { PricingCatalogService } from "./pricing-catalog-service";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

const INDEX_LIMIT = 500;
const COUNT_CAP = 201;
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const DAY = 86_400_000;

function administrationReference(section: string, entityId?: string) {
  const params = new URLSearchParams({ section });
  if (entityId) params.set("entity", entityId);
  return `?${params.toString()}`;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function cappedCount(rows: unknown[]) {
  return Math.min(rows.length, COUNT_CAP - 1);
}

function pageLimit(value: string | null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return PAGE_DEFAULT;
  return Math.min(PAGE_MAX, Math.max(1, Math.floor(parsed)));
}

async function pageRows<T extends RecordData>(
  store: RecordStore,
  table: Parameters<RecordStore["list"]>[0],
  options: {
    filters?: Parameters<RecordStore["list"]>[1] extends infer O
      ? O extends { filters?: infer F }
        ? F
        : never
      : never;
    order?: "asc" | "desc";
    orderBy?: string;
    limit: number;
    cursor?: string;
  },
) {
  const rows = await store.list<T>(table, {
    filters: options.filters,
    order: options.order,
    orderBy: options.orderBy,
    limit: options.limit + 1,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  return {
    items,
    nextCursor: hasMore ? (items.at(-1)?.$id ?? null) : null,
  };
}

function leadFromRow(row: StoredRecord<RecordData>): PlatformLeadRecord {
  const details = decodePayload<{
    kind?: string;
    name?: string;
    organization?: string;
    role?: string;
    teamSize?: number;
    country?: string;
    workflow?: string;
    notes?: string;
    ownerLabel?: string;
    convertedRunId?: string;
  }>(row, {});
  return {
    id: row.$id,
    kind: stringValue(row.kind, details.kind),
    status: stringValue(row.status, "new"),
    organization: details.organization ?? "",
    contactName: details.name ?? "",
    email: stringValue(row.email),
    role: details.role ?? "",
    teamSize:
      typeof details.teamSize === "number" ? details.teamSize : null,
    country: details.country ?? "",
    workflow: details.workflow ?? "",
    notes: details.notes ?? "",
    ownerLabel: details.ownerLabel ?? "",
    convertedRunId: details.convertedRunId ?? null,
    occurredAt: stringValue(row.occurred_at, row.$createdAt),
  };
}

function ticketSummary(
  row: StoredRecord<RecordData>,
  workspaceName: string,
): PlatformTicketSummary {
  const details = decodePayload<{
    subject?: string;
    requesterName?: string;
    responseTargetAt?: string;
    updatedAt?: string;
  }>(row, {});
  return {
    id: row.$id,
    workspaceId: stringValue(row.workspace_id),
    workspaceName,
    subject: details.subject ?? "Support request",
    status: stringValue(row.status, "waiting_support"),
    requesterName: details.requesterName ?? "Workspace member",
    requesterUserId: stringValue(row.user_id),
    responseTargetAt: details.responseTargetAt ?? row.$createdAt,
    updatedAt: details.updatedAt ?? row.$updatedAt,
  };
}

function subscriptionSummary(
  row: StoredRecord<RecordData>,
): PlatformSubscriptionSummary {
  const value = decodePayload<SubscriptionRecord>(row, null as never);
  const evaluation = evaluateSubscription(value);
  const billedPlan = inferredCommercialPlan(
    value ?? { kind: "design_partner", manualContract: true },
  );
  return {
    id: row.$id,
    workspaceId: stringValue(row.workspace_id),
    kind: stringValue(row.kind, value?.kind ?? "design_partner"),
    plan: effectiveCommercialPlan(value),
    billedPlan,
    status: stringValue(row.status, value?.status ?? "active"),
    access: evaluation.access,
    startsAt: value?.startsAt ?? row.$createdAt,
    expiresAt: evaluation.expiresAt,
    graceEndsAt: evaluation.graceEndsAt,
    deletionEligibleAt: evaluation.deletionEligibleAt,
    trialConsumed: value ? trialConsumed(value) : false,
    complimentary: value?.complimentary === true,
    downgradedAt: value?.downgradedAt ?? null,
    manualReference:
      typeof (value as { manualReference?: unknown } | null)?.manualReference ===
      "string"
        ? String((value as { manualReference?: string }).manualReference)
        : null,
  };
}

function personFromMember(row: StoredRecord<RecordData>): PlatformPerson {
  const details = decodePayload<WorkspaceMemberRecord>(row, {
    name: stringValue(row.email),
    roles: [],
    groupIds: [],
  });
  return {
    userId: stringValue(row.user_id),
    name: details.name,
    email: stringValue(row.email),
    roles: details.roles,
  };
}

/* A subscription in grace is past its expiry but still has access and still
   owes, so it counts as held, not lost. */
const HOLDING_SUBSCRIPTION_STATUSES = new Set(["active", "grace"]);
const LOST_SUBSCRIPTION_STATUSES = new Set([
  "cancelled",
  "suspended",
  "deletion_pending",
  "deleting",
  "deleted",
]);

export class PlatformQueryService {
  private readonly access: AccessService;

  constructor(private readonly store: RecordStore) {
    this.access = new AccessService(store);
  }

  private async requireOperator(identity: AuthenticatedIdentity) {
    const roles = await this.access.platformRoles(identity.userId);
    if (!roles.length) {
      throw new HttpError(
        403,
        "PLATFORM_REQUIRED",
        "Platform access is required.",
      );
    }
    return roles;
  }

  private async workspaceNames() {
    const rows = await this.store.list(TABLES.workspaces, {
      order: "desc",
      limit: INDEX_LIMIT,
    });
    return new Map(
      rows.map((row) => {
        const workspace = decodePayload<WorkspaceRecord>(row, null as never);
        return [row.$id, workspace?.name ?? "Workspace"] as const;
      }),
    );
  }

  private async loadWorkspaceSignals(now = Date.now()) {
    const [
      workspaceRows,
      organizationRows,
      subscriptionRows,
      memberRows,
      entitlementRows,
      publishedActivation,
      captureEvents,
      publishEvents,
      paywallEvents,
      recentUsage,
      mediaRows,
      deviceRows,
    ] = await Promise.all([
      this.store.list(TABLES.workspaces, { order: "desc", limit: INDEX_LIMIT }),
      this.store.list(TABLES.organizations, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.subscriptions, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.workspaceMembers, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.entitlements, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.usageEvents, {
        filters: [{ field: "kind", value: "activation.first_guide_published" }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [{ field: "kind", value: "capture.completed" }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [{ field: "kind", value: "guide.published" }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [{ field: "kind", value: "entitlement.blocked" }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.usageEvents, {
        order: "desc",
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.privateMedia, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.extensionDevices, { limit: INDEX_LIMIT }),
    ]);
    const organizations = new Map(
      organizationRows.map((row) => {
        const organization = decodePayload<OrganizationRecord>(row, null as never);
        return [row.$id, organization] as const;
      }),
    );
    const subscriptions = new Map(
      subscriptionRows
        .filter((row) => row.status !== "cancelled")
        .map((row) => [stringValue(row.workspace_id), subscriptionSummary(row)] as const),
    );
    const membersByWorkspace = new Map<string, StoredRecord<RecordData>[]>();
    const domainUsers = new Map<string, Set<string>>();
    const domainWorkspaces = new Map<string, Set<string>>();
    for (const row of memberRows) {
      const workspaceId = stringValue(row.workspace_id);
      const list = membersByWorkspace.get(workspaceId) ?? [];
      list.push(row);
      membersByWorkspace.set(workspaceId, list);
      const domain = emailDomain(stringValue(row.email));
      if (!domain || isConsumerEmailDomain(domain)) continue;
      const users = domainUsers.get(domain) ?? new Set();
      users.add(stringValue(row.email).toLowerCase());
      domainUsers.set(domain, users);
      const workspaces = domainWorkspaces.get(domain) ?? new Set();
      workspaces.add(workspaceId);
      domainWorkspaces.set(domain, workspaces);
    }
    const numericEntitlement = (kind: string, workspaceId: string) => {
      const row = entitlementRows.find(
        (item) =>
          stringValue(item.workspace_id) === workspaceId &&
          stringValue(item.kind) === kind,
      );
      if (!row) return null;
      const value = decodePayload<{ value?: string | number | boolean }>(row, {}).value;
      const numeric = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : null;
    };
    const countByWorkspace = (rows: StoredRecord<RecordData>[]) => {
      const counts = new Map<string, number>();
      for (const row of rows) {
        const workspaceId = stringValue(row.workspace_id);
        counts.set(workspaceId, (counts.get(workspaceId) ?? 0) + 1);
      }
      return counts;
    };
    const published = new Set(publishedActivation.map((row) => stringValue(row.workspace_id)));
    const captures = countByWorkspace(captureEvents);
    const publishes = countByWorkspace(publishEvents);
    const paywallSince = now - 14 * DAY;
    const paywall = new Map<string, number>();
    for (const row of paywallEvents) {
      const at = Date.parse(stringValue(row.occurred_at, row.$createdAt));
      if (!Number.isFinite(at) || at < paywallSince) continue;
      const workspaceId = stringValue(row.workspace_id);
      paywall.set(workspaceId, (paywall.get(workspaceId) ?? 0) + 1);
    }
    const lastActivity = new Map<string, string>();
    for (const row of recentUsage) {
      const workspaceId = stringValue(row.workspace_id);
      if (lastActivity.has(workspaceId)) continue;
      lastActivity.set(workspaceId, stringValue(row.occurred_at, row.$createdAt));
    }
    const storage = new Map<string, number>();
    for (const row of mediaRows) {
      if (row.status === "deleted" || row.status === "quarantined") continue;
      const workspaceId = stringValue(row.workspace_id);
      const size = decodePayload<PrivateMediaRecord>(row, null as never)?.byteSize ?? 0;
      storage.set(workspaceId, (storage.get(workspaceId) ?? 0) + size);
    }
    const extension = new Map<string, string>();
    for (const row of deviceRows) {
      const workspaceId = stringValue(row.workspace_id);
      const lastUsed = decodePayload<{ lastUsedAt?: string }>(row, {}).lastUsedAt;
      const stamp = lastUsed || stringValue(row.$updatedAt);
      const current = extension.get(workspaceId);
      if (!current || stamp > current) extension.set(workspaceId, stamp);
    }

    const signals = new Map<string, WorkspaceSignals>();
    for (const row of workspaceRows) {
      const workspace = decodePayload<WorkspaceRecord>(row, null as never);
      const organization =
        organizations.get(workspace?.organizationId ?? stringValue(row.organization_id)) ??
        null;
      const subscription = subscriptions.get(row.$id) ?? null;
      const plan = (subscription?.plan ?? "free") as CommercialPlan;
      const billedPlan = (subscription?.billedPlan ?? plan) as CommercialPlan;
      const catalog = entitlementsForPlan(plan);
      const members = membersByWorkspace.get(row.$id) ?? [];
      const primaryEmail =
        organization?.primaryContactEmail ||
        stringValue(members[0]?.email);
      const domain = emailDomain(primaryEmail);
      const corporateDomain =
        domain && !isConsumerEmailDomain(domain) ? domain : null;
      const siblingCount = corporateDomain
        ? Math.max(0, (domainWorkspaces.get(corporateDomain)?.size ?? 1) - 1)
        : 0;
      const lastActivityAt = lastActivity.get(row.$id) ?? extension.get(row.$id) ?? null;
      const tags = normalizeAccountTags(organization?.accountTags);
      signals.set(row.$id, {
        workspaceId: row.$id,
        name: workspace?.name ?? "Workspace",
        organizationName: organization?.displayName ?? workspace?.name ?? "Workspace",
        plan,
        billedPlan,
        complimentary: subscription?.complimentary === true,
        tags,
        status: workspace?.status ?? stringValue(row.status, "active"),
        createdAt: workspace?.createdAt ?? row.$createdAt,
        expiresAt: subscription?.expiresAt ?? null,
        trialConsumed: subscription?.trialConsumed === true,
        downgradedAt: subscription?.downgradedAt ?? null,
        memberCount: members.length,
        seatLimit: numericEntitlement("maximumUsers", row.$id) ?? catalog.maximumUsers,
        storageBytes: storage.get(row.$id) ?? 0,
        storageLimit: numericEntitlement("storageBytes", row.$id) ?? catalog.storageBytes,
        published: published.has(row.$id),
        captureCount: captures.get(row.$id) ?? 0,
        publishCount: publishes.get(row.$id) ?? 0,
        lastActivityAt,
        lastExtensionAt: extension.get(row.$id) ?? null,
        paywallHits14d: paywall.get(row.$id) ?? 0,
        corporateDomain,
        siblingCount,
      });
    }
    return {
      workspaceRows,
      organizations,
      subscriptions,
      membersByWorkspace,
      domainWorkspaces,
      domainUsers,
      signals,
      published,
    };
  }

  private homeItem(signals: WorkspaceSignals, extra?: Partial<PlatformHomeItem>): PlatformHomeItem {
    const decision = nextBestAction(signals);
    const score = intentScore(signals);
    return {
      workspaceId: signals.workspaceId,
      name: signals.name,
      organizationName: signals.organizationName,
      plan: signals.plan,
      reason: extra?.reason ?? decision.reason,
      nextAction: extra?.nextAction ?? decision.action,
      href: administrationReference("clients", signals.workspaceId),
      daysRemaining: daysUntil(signals.expiresAt, Date.now()) ?? undefined,
      intentScore: score.score,
      ...extra,
    };
  }

  async home(identity: AuthenticatedIdentity): Promise<PlatformHome> {
    await this.requireOperator(identity);
    const now = Date.now();
    const [
      facts,
      newLeads,
      waitingSupport,
      waitingCustomer,
      failedNotifications,
      deletionRows,
      settingsRows,
    ] = await Promise.all([
      this.loadWorkspaceSignals(now),
      this.store.list(TABLES.leads, {
        filters: [{ field: "status", value: "new" }],
        order: "desc",
        limit: COUNT_CAP,
      }),
      this.store.list(TABLES.supportTickets, {
        filters: [{ field: "status", value: "waiting_support" }],
        order: "desc",
        limit: COUNT_CAP,
      }),
      this.store.list(TABLES.supportTickets, {
        filters: [{ field: "status", value: "waiting_customer" }],
        order: "desc",
        limit: COUNT_CAP,
      }),
      this.store.list(TABLES.notificationDeliveries, {
        filters: [{ field: "status", value: "failed" }],
        order: "desc",
        limit: COUNT_CAP,
      }),
      this.store.list(TABLES.lifecycleCases, {
        filters: [{ field: "status", value: "awaiting_approval" }],
        order: "desc",
        limit: COUNT_CAP,
      }),
      this.store.list(TABLES.catalogItems, {
        filters: [{ field: "slug", value: "platform_settings" }],
        limit: 1,
      }),
    ]);
    const activeSignals = [...facts.signals.values()].filter(
      (item) => item.status === "active" && !isVipAccount(item.tags, item.complimentary),
    );
    const overdue = waitingSupport.filter((row) => {
      const target = decodePayload<{ responseTargetAt?: string }>(row, {});
      return Date.parse(target.responseTargetAt ?? row.$createdAt) < now;
    });
    const names = new Map(
      facts.workspaceRows.map((row) => {
        const workspace = decodePayload<WorkspaceRecord>(row, null as never);
        return [row.$id, workspace?.name ?? "Workspace"] as const;
      }),
    );
    const trialEnding = activeSignals
      .filter((item) => {
        if (item.plan !== "pro_trial" || !item.expiresAt) return false;
        const remaining = daysUntil(item.expiresAt, now);
        return remaining !== null && remaining >= 0 && remaining <= 7;
      })
      .sort((left, right) => (left.expiresAt ?? "").localeCompare(right.expiresAt ?? ""))
      .slice(0, 8)
      .map((item) => this.homeItem(item));
    const highIntent = activeSignals
      .filter((item) => {
        const score = intentScore(item, now).score;
        const nearSeat = item.seatLimit > 0 && item.memberCount / item.seatLimit >= 0.8;
        const nearStorage =
          item.storageLimit > 0 && item.storageBytes / item.storageLimit >= 0.8;
        return score >= 40 || item.paywallHits14d >= 2 || nearSeat || nearStorage;
      })
      .sort((left, right) => intentScore(right, now).score - intentScore(left, now).score)
      .slice(0, 8)
      .map((item) => this.homeItem(item));
    const winBack = activeSignals
      .filter((item) => nextBestAction(item, now).action === "grant_trial")
      .slice(0, 8)
      .map((item) => this.homeItem(item));
    const enterprise = [...facts.domainWorkspaces.entries()]
      .filter(([domain, workspaces]) => {
        const users = facts.domainUsers.get(domain)?.size ?? 0;
        return !isConsumerEmailDomain(domain) && (users >= 3 || workspaces.size >= 2);
      })
      .slice(0, 8)
      .map(([domain, workspaces]) => {
        const firstId = [...workspaces][0]!;
        const signals = facts.signals.get(firstId);
        const users = facts.domainUsers.get(domain)?.size ?? 0;
        return {
          workspaceId: firstId,
          name: signals?.name ?? domain,
          organizationName: `@${domain}`,
          plan: signals?.plan ?? "free",
          reason: `${users} people across ${workspaces.size} workspaces.`,
          nextAction: "enterprise_lead" as const,
          href: administrationReference("clients", firstId),
        };
      });
    const atRisk = activeSignals
      .filter((item) => {
        const health = customerHealth(item, now);
        return health === "at_risk" || health === "churning";
      })
      .slice(0, 8)
      .map((item) => this.homeItem(item));
    const expansion = activeSignals
      .filter((item) => {
        const decision = nextBestAction(item, now);
        return decision.action === "offer_seats" || decision.action === "expansion";
      })
      .slice(0, 8)
      .map((item) => this.homeItem(item));
    const neverPublished = activeSignals
      .filter((item) => !item.published)
      .slice(0, 8)
      .map((item) =>
        this.homeItem(item, {
          reason: "No published guide yet.",
          nextAction: "none",
        }),
      );
    const settings = settingsRows[0]
      ? decodePayload<{ selfServiceWorkspaceLimit: number }>(settingsRows[0], {
          selfServiceWorkspaceLimit: 1,
        })
      : { selfServiceWorkspaceLimit: 1 };
    const counts: PlatformHome["counts"] = {
      newLeads: cappedCount(newLeads),
      openTickets: cappedCount([...waitingSupport, ...waitingCustomer]),
      overdueSupport: cappedCount(overdue),
      expiringSoon: trialEnding.length,
      neverActivated: neverPublished.length,
      deletionApprovals: cappedCount(deletionRows),
      failedNotifications: cappedCount(failedNotifications),
      customers: facts.workspaceRows.length,
      trials: activeSignals.filter((item) => item.plan === "pro_trial").length,
    };
    return {
      queues: [
        {
          id: "talk-today",
          title: "People worth talking to",
          description: "Trials, upgrade intent, and second-trial candidates.",
          items: [...trialEnding, ...highIntent, ...winBack].slice(0, 8),
        },
        {
          id: "trials",
          title: "Trials ending in 7 days",
          description: "Days left and whether they captured, published, or invited.",
          items: trialEnding,
        },
        {
          id: "intent",
          title: "High upgrade intent",
          description: "Near a limit, or repeatedly hitting a Pro wall.",
          items: highIntent,
        },
        {
          id: "winback",
          title: "Second trial / win-back",
          description: "Former trial or Pro tenants still using KnowHow.",
          items: winBack,
        },
        {
          id: "enterprise",
          title: "Enterprise candidates",
          description: "Several people or workspaces on the same company domain.",
          items: enterprise,
        },
        {
          id: "risk",
          title: "At risk",
          description: "Paid or trial workspaces whose usage is thinning.",
          items: atRisk,
        },
        {
          id: "expansion",
          title: "Expansion",
          description: "Seats or storage at 80% or more.",
          items: expansion,
        },
        {
          id: "never-published",
          title: "Never published",
          description: "Active workspaces that have not reached first publish.",
          items: neverPublished,
        },
        {
          id: "support",
          title: "Overdue support",
          description: "Tickets past their response target.",
          items: overdue.slice(0, 8).map((row) => {
            const ticket = ticketSummary(
              row,
              names.get(stringValue(row.workspace_id)) ?? "Workspace",
            );
            return {
              workspaceId: ticket.workspaceId,
              name: ticket.subject,
              organizationName: ticket.workspaceName,
              plan: facts.signals.get(ticket.workspaceId)?.plan ?? "free",
              reason: "Response target missed.",
              nextAction: "none" as const,
              href: administrationReference("support", ticket.id),
            };
          }),
        },
        {
          id: "deletions",
          title: "Deletion approvals",
          description: "Owner confirmation required before purge.",
          items: deletionRows.slice(0, 8).map((row) => ({
            workspaceId: stringValue(row.workspace_id),
            name: names.get(stringValue(row.workspace_id)) ?? "Workspace",
            organizationName: "Pending purge",
            plan: "enterprise",
            reason: "Retention ended. Confirm or restore.",
            nextAction: "none" as const,
            href: administrationReference("activity"),
          })),
        },
      ],
      funnel: [
        { id: "signed_up", label: "Workspaces", count: facts.workspaceRows.length },
        {
          id: "invited",
          label: "Invited a teammate",
          count: activeSignals.filter((item) => item.memberCount > 1).length,
        },
        {
          id: "captured",
          label: "First capture",
          count: activeSignals.filter((item) => item.captureCount > 0).length,
        },
        {
          id: "published",
          label: "Published a guide",
          count: activeSignals.filter((item) => item.published).length,
        },
        {
          id: "trialing",
          label: "Pro trial",
          count: activeSignals.filter((item) => item.plan === "pro_trial").length,
        },
      ],
      counts,
      settings,
    };
  }

  async queues(identity: AuthenticatedIdentity) {
    const home = await this.home(identity);
    const names = await this.workspaceNames();
    const recentAudits = await this.store.list(TABLES.auditSegments, {
      order: "desc",
      limit: 6,
    });
    const counts: PlatformQueueCounts = home.counts;
    return {
      counts,
      settings: home.settings,
      attention: {
        leads: [],
        tickets: [],
        expiring: home.queues.find((queue) => queue.id === "trials")?.items ?? [],
        neverActivated:
          home.queues.find((queue) => queue.id === "never-published")?.items ?? [],
        deletions: [],
      },
      recentAudits: recentAudits.slice(0, 5).map((row) => ({
        id: row.$id,
        workspaceId: stringValue(row.workspace_id),
        workspaceName: names.get(stringValue(row.workspace_id)) ?? "Workspace",
        action: stringValue(
          decodePayload<{ action?: string }>(row, {}).action,
          stringValue(row.kind),
        ),
        occurredAt: stringValue(row.occurred_at, row.$createdAt),
      })),
      home,
    };
  }

  private deletionFromRow(
    row: StoredRecord<RecordData>,
    workspaceName: string,
    includeConfirmation: boolean,
  ): PlatformDeletionCase {
    const details = decodePayload<{
      eligibleAt?: string;
      confirmationText?: string;
    }>(row, {});
    return {
      id: row.$id,
      organizationId: stringValue(row.organization_id),
      workspaceId: stringValue(row.workspace_id),
      workspaceName,
      status: stringValue(row.status),
      eligibleAt: details.eligibleAt ?? stringValue(row.scheduled_at),
      ...(includeConfirmation && details.confirmationText
        ? { confirmationText: details.confirmationText }
        : {}),
    };
  }

  async listAccounts(
    identity: AuthenticatedIdentity,
    input: { query?: string; status?: string; cursor?: string; limit?: string | null },
  ): Promise<PlatformPage<PlatformAccountSummary>> {
    await this.requireOperator(identity);
    const limit = pageLimit(input.limit ?? null);
    const facts = await this.loadWorkspaceSignals();
    const term = input.query?.trim().toLowerCase() ?? "";
    const status = input.status && input.status !== "all" ? input.status : "";
    let items = facts.workspaceRows.map((row) => {
      const workspace = decodePayload<WorkspaceRecord>(row, null as never);
      const signals = facts.signals.get(row.$id);
      const decision = signals ? nextBestAction(signals) : null;
      const score = signals ? intentScore(signals) : null;
      return {
        id: row.$id,
        organizationId: workspace?.organizationId ?? stringValue(row.organization_id),
        organizationName: signals?.organizationName ?? "",
        name: workspace?.name ?? "Workspace",
        slug: workspace?.slug ?? row.$id,
        status: workspace?.status ?? stringValue(row.status, "active"),
        createdAt: workspace?.createdAt ?? row.$createdAt,
        subscription: facts.subscriptions.get(row.$id) ?? null,
        seatLimit: signals?.seatLimit ?? null,
        memberCount: signals?.memberCount ?? 0,
        tags: signals?.tags ?? [],
        lastActivityAt: signals?.lastActivityAt ?? null,
        health: signals ? customerHealth(signals, Date.now()) : "free",
        intentScore: score?.score ?? 0,
        nextAction: decision?.action ?? "none",
        nextActionReason: decision?.reason ?? "",
        complimentary: signals?.complimentary === true,
      } satisfies PlatformAccountSummary;
    });
    if (status) {
      items = items.filter((item) => {
        if (status === "trial") return item.subscription?.plan === "pro_trial";
        if (status === "free") return item.subscription?.plan === "free" || !item.subscription;
        if (status === "pro") return item.subscription?.plan === "pro";
        if (status === "enterprise") return item.subscription?.plan === "enterprise";
        if (status === "at_risk") return item.health === "at_risk" || item.health === "churning";
        if (status === "win_back") return item.nextAction === "grant_trial";
        if (status === "high_intent") return (item.intentScore ?? 0) >= 40;
        return item.status === status;
      });
    }
    if (term) {
      items = items.filter((item) =>
        `${item.name} ${item.slug} ${item.organizationName} ${item.subscription?.plan ?? ""}`
          .toLowerCase()
          .includes(term),
      );
    }
    const start = input.cursor
      ? items.findIndex((item) => item.id === input.cursor) + 1
      : 0;
    const from = start > 0 ? start : input.cursor ? items.length : 0;
    const page = items.slice(from, from + limit);
    return {
      items: page,
      nextCursor: from + limit < items.length ? (page.at(-1)?.id ?? null) : null,
    };
  }

  async account(identity: AuthenticatedIdentity, workspaceId: string) {
    await this.requireOperator(identity);
    const row = await this.store.get(TABLES.workspaces, workspaceId);
    if (!row) {
      throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Client not found.");
    }
    const workspace = decodePayload<WorkspaceRecord>(row, null as never);
    const organizationId =
      workspace?.organizationId ?? stringValue(row.organization_id);
    const [
      organizationRow,
      memberRows,
      organizationMembers,
      subscriptionRows,
      entitlementRows,
      guideRows,
      ticketRows,
      auditRows,
      published,
      viewed,
      completed,
      supportCases,
      supportGrants,
      leadRows,
    ] = await Promise.all([
      organizationId ? this.store.get(TABLES.organizations, organizationId) : null,
      this.store.list(TABLES.workspaceMembers, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: INDEX_LIMIT,
      }),
      organizationId
        ? this.store.list(TABLES.organizationMemberships, {
            filters: [{ field: "organization_id", value: organizationId }],
            limit: 100,
          })
        : Promise.resolve([]),
      this.store.list(TABLES.subscriptions, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 10,
      }),
      this.store.list(TABLES.entitlements, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 50,
      }),
      this.store.list(TABLES.guides, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.supportTickets, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        order: "desc",
        limit: 20,
      }),
      this.store.list(TABLES.auditSegments, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        order: "desc",
        limit: 8,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "kind", value: "activation.first_guide_published" },
        ],
        limit: 1,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "kind", value: "activation.first_teammate_view" },
        ],
        limit: 1,
      }),
      this.store.list(TABLES.usageEvents, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "kind", value: "activation.first_teammate_completion" },
        ],
        limit: 1,
      }),
      this.store.list(TABLES.supportCases, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 5,
      }),
      this.store.list(TABLES.supportGrants, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 5,
      }),
      this.store.list(TABLES.leads, {
        filters: [{ field: "status", value: "converted" }],
        order: "desc",
        limit: 50,
      }),
    ]);
    const [usageRows, mediaRows, deviceRows, inviteRows, facts] = await Promise.all([
      this.store.list(TABLES.usageEvents, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        order: "desc",
        limit: 100,
      }),
      this.store.list(TABLES.privateMedia, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: INDEX_LIMIT,
      }),
      this.store.list(TABLES.extensionDevices, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 50,
      }),
      this.store.list(TABLES.invitations, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 50,
      }),
      this.loadWorkspaceSignals(),
    ]);
    const members = memberRows.map(personFromMember);
    const administrators = members.filter((member) =>
      member.roles.includes("administrator"),
    );
    const billingContacts = organizationMembers
      .filter((item) => item.status === "active")
      .map((item) => {
        const details = decodePayload<{ name?: string; roles?: string[] }>(
          item,
          {},
        );
        return {
          userId: stringValue(item.user_id),
          name: details.name ?? stringValue(item.email),
          email: stringValue(item.email),
          roles: details.roles ?? [],
        } satisfies PlatformPerson;
      })
      .filter((person) => person.roles.includes("billing") || person.roles.includes("owner"));
    const organization = organizationRow
      ? decodePayload<OrganizationRecord>(organizationRow, null as never)
      : null;
    const subscription =
      subscriptionRows
        .map(subscriptionSummary)
        .find((item) => item.status !== "cancelled") ?? null;
    const seatEntitlement = entitlementRows.find((item) =>
      ["maximumUsers", "member_limit"].includes(stringValue(item.kind)),
    );
    const seatValue = seatEntitlement
      ? decodePayload<{ value?: string | number | boolean }>(seatEntitlement, {})
          .value
      : null;
    const request = supportCases[0];
    const grant = supportGrants.find(
      (item) =>
        item.status === "active" &&
        Date.parse(stringValue(item.expires_at)) > Date.now(),
    );
    const requestDetails = request
      ? decodePayload<{
          requestedRole?: WorkspaceRole;
          requestedDurationHours?: number;
          reason?: string;
        }>(request, {})
      : null;
    const grantDetails = grant
      ? decodePayload<SupportGrantRecord>(grant, null as never)
      : null;
    const originatingLead =
      leadRows
        .map(leadFromRow)
        .find(
          (lead) =>
            lead.email &&
            (lead.email === organization?.primaryContactEmail ||
              administrators.some((admin) => admin.email === lead.email)),
        ) ?? null;
    const account: PlatformAccountRecord = {
      id: row.$id,
      organizationId,
      organizationName: organization?.displayName ?? "",
      name: workspace?.name ?? "Workspace",
      slug: workspace?.slug ?? row.$id,
      status: workspace?.status ?? stringValue(row.status, "active"),
      createdAt: workspace?.createdAt ?? row.$createdAt,
      subscription,
      seatLimit:
        typeof seatValue === "number"
          ? seatValue
          : Number.isFinite(Number(seatValue))
            ? Number(seatValue)
            : null,
      organization: organization
        ? {
            id: organizationRow!.$id,
            displayName: organization.displayName,
            legalName: organization.legalName,
            country: organization.country,
            status: organization.status,
            primaryContactName: organization.primaryContactName,
            primaryContactEmail: organization.primaryContactEmail,
            internalNotes: organization.internalNotes ?? "",
            ownerLabel: organization.ownerLabel ?? "",
            accountTags: normalizeAccountTags(organization.accountTags),
          }
        : null,
      administrators,
      billingContacts,
      memberCount: memberRows.length,
      publishedCount: guideRows.filter((guide) => guide.status === "published")
        .length,
      draftCount: guideRows.filter(
        (guide) => guide.status === "draft" || guide.status === "review",
      ).length,
      activation: {
        firstPublishedAt: published[0]
          ? stringValue(published[0].occurred_at)
          : null,
        firstTeammateViewAt: viewed[0]
          ? stringValue(viewed[0].occurred_at)
          : null,
        firstTeammateCompletionAt: completed[0]
          ? stringValue(completed[0].occurred_at)
          : null,
      },
      tickets: ticketRows
        .filter((item) => item.status !== "closed")
        .map((item) => ticketSummary(item, workspace?.name ?? "Workspace")),
      originatingLead: originatingLead
        ? {
            id: originatingLead.id,
            organization: originatingLead.organization,
            email: originatingLead.email,
          }
        : null,
      entitlements: entitlementRows.map((item) => {
        const payload = decodePayload<{
          value?: string | number | boolean;
          source?: string;
          reason?: string;
          expiresAt?: string | null;
        }>(item, {});
        return {
          id: item.$id,
          kind: stringValue(item.kind),
          value: payload.value ?? false,
          source: payload.source,
          reason: payload.reason ?? null,
          expiresAt: payload.expiresAt ?? null,
        };
      }),
      audits: auditRows.map((item) => ({
        id: item.$id,
        action: stringValue(
          decodePayload<{ action?: string }>(item, {}).action,
          stringValue(item.kind),
        ),
        occurredAt: stringValue(item.occurred_at, item.$createdAt),
      })),
      supportRequest:
        request && requestDetails
          ? {
              id: request.$id,
              status: stringValue(request.status, "pending") as
                | "pending"
                | "approved"
                | "denied"
                | "cancelled",
              requestedRole: requestDetails.requestedRole ?? "viewer",
              requestedDurationHours: numberValue(
                requestDetails.requestedDurationHours,
                1,
              ),
              reason: requestDetails.reason ?? "",
              createdAt: request.$createdAt,
            }
          : null,
      supportGrant:
        grant && grantDetails
          ? {
              id: grant.$id,
              role: grantDetails.role,
              grantedAt: grantDetails.grantedAt,
              expiresAt: grantDetails.expiresAt,
            }
          : null,
    };
    const usageKindCount = (kind: string) =>
      usageRows.filter((item) => stringValue(item.kind) === kind).length;
    const storageBytes = mediaRows.reduce((sum, item) => {
      if (item.status === "deleted" || item.status === "quarantined") return sum;
      return sum + (decodePayload<PrivateMediaRecord>(item, null as never)?.byteSize ?? 0);
    }, 0);
    const creatorCount = members.filter((member) =>
      member.roles.includes("creator") || member.roles.includes("administrator"),
    ).length;
    const catalog = entitlementsForPlan(
      (subscription?.plan as CommercialPlan) ?? "free",
    );
    const numericEntitlement = (kind: string, fallback: number) => {
      const row = entitlementRows.find((item) => stringValue(item.kind) === kind);
      const value = row
        ? decodePayload<{ value?: string | number | boolean }>(row, {}).value
        : null;
      const numeric = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numeric) ? numeric : fallback;
    };
    const deviceViews = deviceRows.map((item) =>
      decodePayload<{ extensionVersion?: string; lastUsedAt?: string }>(item, {}),
    );
    const lastExtensionAt = deviceViews
      .map((item) => item.lastUsedAt)
      .filter((item): item is string => Boolean(item))
      .sort()
      .at(-1) ?? null;
    const firstCapture = usageRows.find(
      (item) => stringValue(item.kind) === "capture.completed",
    );
    const signals = facts.signals.get(workspaceId);
    const tags = normalizeAccountTags(organization?.accountTags);
    const decision = signals
      ? nextBestAction(signals)
      : { action: "none" as const, reason: "" };
    const score = signals ? intentScore(signals) : { score: 0, reasons: [] };
    const timeline = [
      ...usageRows.map((item) => ({
        at: stringValue(item.occurred_at, item.$createdAt),
        kind: stringValue(item.kind),
        label: stringValue(item.kind).replaceAll(".", " "),
      })),
      ...auditRows.map((item) => ({
        at: stringValue(item.occurred_at, item.$createdAt),
        kind: stringValue(
          decodePayload<{ action?: string }>(item, {}).action,
          stringValue(item.kind),
        ),
        label: stringValue(
          decodePayload<{ summary?: string; action?: string }>(item, {}).summary,
          stringValue(item.kind),
        ),
      })),
      ...ticketRows.map((item) => ({
        at: stringValue(item.$createdAt),
        kind: "support.ticket",
        label: decodePayload<{ subject?: string }>(item, {}).subject ?? "Support ticket",
      })),
    ]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 30);
    const domain = emailDomain(
      organization?.primaryContactEmail || administrators[0]?.email || "",
    );
    const domainSiblings =
      domain && !isConsumerEmailDomain(domain)
        ? [...(facts.domainWorkspaces.get(domain) ?? [])]
            .filter((id) => id !== workspaceId)
            .slice(0, 8)
            .map((id) => ({
              workspaceId: id,
              name: facts.signals.get(id)?.name ?? "Workspace",
              domain,
            }))
        : [];
    account.organization = organization
      ? { ...account.organization!, accountTags: tags }
      : null;
    account.usage = {
      captures: usageKindCount("capture.completed"),
      publishes: usageKindCount("guide.published"),
      views: usageKindCount("guide.viewed"),
      exportRequests: usageKindCount("guide.export-requested"),
      paywallHits: usageKindCount("entitlement.blocked"),
      storageBytes,
      storageLimit: numericEntitlement("storageBytes", catalog.storageBytes),
      creatorCount,
      creatorLimit: numericEntitlement("maximumCreators", catalog.maximumCreators),
    };
    account.extension = deviceRows.length
      ? {
          version: deviceViews[0]?.extensionVersion ?? null,
          lastUsedAt: lastExtensionAt,
          deviceCount: deviceRows.length,
        }
      : null;
    account.lastActivityAt =
      usageRows[0]
        ? stringValue(usageRows[0].occurred_at, usageRows[0].$createdAt)
        : lastExtensionAt;
    account.activationChecklist = [
      {
        id: "published",
        label: "Published a guide",
        completed: Boolean(published[0]),
        completedAt: published[0] ? stringValue(published[0].occurred_at) : null,
      },
      {
        id: "capture",
        label: "First extension capture",
        completed: Boolean(firstCapture),
        completedAt: firstCapture
          ? stringValue(firstCapture.occurred_at, firstCapture.$createdAt)
          : null,
      },
      {
        id: "invite",
        label: "Invited a teammate",
        completed: memberRows.length > 1 || inviteRows.length > 0,
        completedAt: inviteRows[0]?.$createdAt ?? null,
      },
      {
        id: "teammate_view",
        label: "Teammate viewed a guide",
        completed: Boolean(viewed[0]),
        completedAt: viewed[0] ? stringValue(viewed[0].occurred_at) : null,
      },
      {
        id: "teammate_complete",
        label: "Teammate completed a guide",
        completed: Boolean(completed[0]),
        completedAt: completed[0] ? stringValue(completed[0].occurred_at) : null,
      },
    ];
    account.timeline = timeline;
    account.domainSiblings = domainSiblings;
    account.health = signals ? customerHealth(signals, Date.now()) : "free";
    account.intentScore = score.score;
    account.nextAction = decision.action;
    account.nextActionReason = decision.reason;
    account.complimentary = subscription?.complimentary === true;
    account.trialConsumed = subscription?.trialConsumed === true;
    account.tags = tags;
    account.memberCount = memberRows.length;
    return account;
  }

  async listLeads(
    identity: AuthenticatedIdentity,
    input: { query?: string; status?: string; cursor?: string; limit?: string | null },
  ): Promise<PlatformPage<PlatformLeadRecord>> {
    await this.requireOperator(identity);
    const limit = pageLimit(input.limit ?? null);
    const status = input.status && input.status !== "all" ? input.status : "";
    const searching = Boolean(input.query?.trim());
    const page = await pageRows(this.store, TABLES.leads, {
      ...(status ? { filters: [{ field: "status", value: status }] } : {}),
      order: "desc",
      limit: searching ? INDEX_LIMIT : limit,
      cursor: searching ? undefined : input.cursor,
    });
    let items = page.items.map(leadFromRow);
    const term = input.query?.trim().toLowerCase() ?? "";
    if (term) {
      items = items.filter((lead) =>
        `${lead.organization} ${lead.contactName} ${lead.email} ${lead.workflow} ${lead.role}`
          .toLowerCase()
          .includes(term),
      );
      const start = input.cursor
        ? items.findIndex((item) => item.id === input.cursor) + 1
        : 0;
      const from = start > 0 ? start : input.cursor ? items.length : 0;
      const sliced = items.slice(from, from + limit);
      return {
        items: sliced,
        nextCursor: from + limit < items.length ? (sliced.at(-1)?.id ?? null) : null,
      };
    }
    return { items, nextCursor: page.nextCursor };
  }

  async lead(identity: AuthenticatedIdentity, leadId: string) {
    await this.requireOperator(identity);
    const row = await this.store.get(TABLES.leads, leadId);
    if (!row) throw new HttpError(404, "LEAD_NOT_FOUND", "Lead not found.");
    return leadFromRow(row);
  }

  async listTickets(
    identity: AuthenticatedIdentity,
    input: {
      query?: string;
      status?: string;
      workspaceId?: string;
      cursor?: string;
      limit?: string | null;
    },
  ): Promise<PlatformPage<PlatformTicketSummary>> {
    await this.requireOperator(identity);
    const limit = pageLimit(input.limit ?? null);
    const names = await this.workspaceNames();
    const status = input.status && input.status !== "all" ? input.status : "open";
    const searching = Boolean(input.query?.trim());
    const workspaceId = input.workspaceId?.trim();

    if (status === "open") {
      const filters = workspaceId
        ? [{ field: "workspace_id" as const, value: workspaceId }]
        : undefined;
      const [waitingSupport, waitingCustomer] = await Promise.all([
        this.store.list(TABLES.supportTickets, {
          filters: [
            ...(filters ?? []),
            { field: "status", value: "waiting_support" },
          ],
          order: "desc",
          limit: INDEX_LIMIT,
        }),
        this.store.list(TABLES.supportTickets, {
          filters: [
            ...(filters ?? []),
            { field: "status", value: "waiting_customer" },
          ],
          order: "desc",
          limit: INDEX_LIMIT,
        }),
      ]);
      let items = [...waitingSupport, ...waitingCustomer]
        .map((row) =>
          ticketSummary(row, names.get(stringValue(row.workspace_id)) ?? "Workspace"),
        )
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
      const term = input.query?.trim().toLowerCase() ?? "";
      if (term) {
        items = items.filter((ticket) =>
          `${ticket.workspaceName} ${ticket.subject} ${ticket.requesterName}`
            .toLowerCase()
            .includes(term),
        );
      }
      const start = input.cursor
        ? items.findIndex((item) => item.id === input.cursor) + 1
        : 0;
      const from = start > 0 ? start : input.cursor ? items.length : 0;
      const page = items.slice(from, from + limit);
      return {
        items: page,
        nextCursor: from + limit < items.length ? (page.at(-1)?.id ?? null) : null,
      };
    }

    const page = await pageRows(this.store, TABLES.supportTickets, {
      filters: [
        ...(workspaceId ? [{ field: "workspace_id", value: workspaceId }] : []),
        ...(status && status !== "all" ? [{ field: "status", value: status }] : []),
      ],
      order: "desc",
      limit: searching ? INDEX_LIMIT : limit,
      cursor: searching ? undefined : input.cursor,
    });
    let items = page.items.map((row) =>
      ticketSummary(row, names.get(stringValue(row.workspace_id)) ?? "Workspace"),
    );
    const term = input.query?.trim().toLowerCase() ?? "";
    if (term) {
      items = items.filter((ticket) =>
        `${ticket.workspaceName} ${ticket.subject} ${ticket.requesterName}`
          .toLowerCase()
          .includes(term),
      );
      const start = input.cursor
        ? items.findIndex((item) => item.id === input.cursor) + 1
        : 0;
      const from = start > 0 ? start : input.cursor ? items.length : 0;
      const sliced = items.slice(from, from + limit);
      return {
        items: sliced,
        nextCursor: from + limit < items.length ? (sliced.at(-1)?.id ?? null) : null,
      };
    }
    return { items, nextCursor: page.nextCursor };
  }

  async ticket(identity: AuthenticatedIdentity, ticketId: string) {
    await this.requireOperator(identity);
    const row = await this.store.get(TABLES.supportTickets, ticketId);
    if (!row) {
      throw new HttpError(404, "SUPPORT_TICKET_NOT_FOUND", "Support ticket not found.");
    }
    const names = await this.workspaceNames();
    const details = decodePayload<Partial<PlatformTicketRecord>>(row, {});
    const messages = await this.store.list(TABLES.supportMessages, {
      filters: [{ field: "subject_id", value: ticketId }],
      orderBy: "sequence",
      order: "asc",
      limit: 200,
    });
    const ticket: PlatformTicketRecord = {
      id: row.$id,
      workspaceId: stringValue(row.workspace_id),
      workspaceName: names.get(stringValue(row.workspace_id)) ?? "Workspace",
      subject: details.subject ?? "Support request",
      status: stringValue(row.status, "waiting_support") as PlatformTicketRecord["status"],
      requesterUserId: stringValue(row.user_id),
      requesterName: details.requesterName ?? "Workspace member",
      requesterEmail: stringValue(row.email),
      createdAt: details.createdAt ?? row.$createdAt,
      updatedAt: details.updatedAt ?? row.$updatedAt,
      responseTargetAt: details.responseTargetAt ?? row.$createdAt,
      resolvedAt: details.resolvedAt ?? null,
      closedAt: details.closedAt ?? null,
      closureConfirmedAt: details.closureConfirmedAt ?? null,
      messages: messages.map((message) => {
        const content = decodePayload<{
          authorName?: string;
          authorKind?: "customer" | "support";
          body?: string;
        }>(message, {});
        return {
          id: message.$id,
          sequence: numberValue(message.sequence, 1),
          authorUserId: stringValue(message.user_id),
          authorName: content.authorName ?? "Member",
          authorKind: content.authorKind === "support" ? "support" : "customer",
          body: content.body ?? "",
          createdAt: stringValue(message.occurred_at, message.$createdAt),
        };
      }),
    };
    return ticket;
  }

  async listBilling(
    identity: AuthenticatedIdentity,
    input: { query?: string; status?: string; cursor?: string; limit?: string | null },
  ) {
    await this.requireOperator(identity);
    const limit = pageLimit(input.limit ?? null);
    const [subscriptionRows, names, catalogs] = await Promise.all([
      this.store.list(TABLES.subscriptions, { order: "desc", limit: INDEX_LIMIT }),
      this.workspaceNames(),
      new PricingCatalogService(this.store).list(),
    ]);
    let items = subscriptionRows
      .map(subscriptionSummary)
      .map((subscription) => ({
        ...subscription,
        workspaceName: names.get(subscription.workspaceId) ?? "Workspace",
      }))
      .sort((left, right) => {
        if (!left.expiresAt && !right.expiresAt) return 0;
        if (!left.expiresAt) return 1;
        if (!right.expiresAt) return -1;
        return left.expiresAt.localeCompare(right.expiresAt);
      });
    const status = input.status && input.status !== "all" ? input.status : "";
    const term = input.query?.trim().toLowerCase() ?? "";
    if (status) items = items.filter((item) => item.status === status);
    if (term) {
      items = items.filter((item) =>
        `${item.workspaceName} ${item.kind} ${item.status} ${item.access}`
          .toLowerCase()
          .includes(term),
      );
    }
    const start = input.cursor
      ? items.findIndex((item) => item.id === input.cursor) + 1
      : 0;
    const from = start > 0 ? start : input.cursor ? items.length : 0;
    const page = items.slice(from, from + limit);
    return {
      items: page,
      nextCursor: from + limit < items.length ? (page.at(-1)?.id ?? null) : null,
      catalogs,
    };
  }

  /* Revenue is derived, never stored. The pricing catalog carries amountMinor
     per workspace_month and per usage unit, and in private beta those are null.
     When they are null this reports the plan mix and says the catalog is
     unpriced rather than inventing a number, because a wrong MRR is worse than
     an absent one.

     Movement comes from the subscription lifecycle dates that already exist
     (startsAt, convertedAt, downgradedAt, expiresAt). usage_rollups is declared
     but never written, so there is no other time series to read. */
  async revenue(identity: AuthenticatedIdentity): Promise<PlatformRevenue> {
    await this.requireOperator(identity);
    const now = Date.now();
    const [subscriptionRows, invoiceRows, catalogs] = await Promise.all([
      this.store.list(TABLES.subscriptions, { limit: INDEX_LIMIT }),
      this.store.list(TABLES.manualInvoices, { order: "desc", limit: INDEX_LIMIT }),
      new PricingCatalogService(this.store).list(),
    ]);

    const effective = catalogs
      .filter((catalog) => catalog.status === "active")
      .sort((left, right) =>
        (right.effectiveFrom ?? "").localeCompare(left.effectiveFrom ?? ""),
      )[0];
    const currency = effective?.currency ?? "USD";
    const baseMinor = effective?.baseWorkspace?.amountMinor ?? null;

    const subscriptions = subscriptionRows.flatMap((row) => {
      const record = decodePayload<SubscriptionRecord | null>(row, null);
      return record ? [{ id: row.$id, record }] : [];
    });

    const paying = subscriptions.filter(
      ({ record }) =>
        HOLDING_SUBSCRIPTION_STATUSES.has(record.status) &&
        (record.plan === "pro" || record.plan === "enterprise") &&
        !record.complimentary,
    );
    const planMix = { free: 0, pro_trial: 0, pro: 0, enterprise: 0 };
    for (const { record } of subscriptions) {
      if (!HOLDING_SUBSCRIPTION_STATUSES.has(record.status)) continue;
      const plan = record.plan ?? "free";
      if (plan in planMix) planMix[plan as keyof typeof planMix] += 1;
    }

    const mrrMinor = baseMinor === null ? null : paying.length * baseMinor;

    /* Manual contracts are the only revenue actually agreed today. They carry a
       reference, not an amount, so this counts them rather than summing them. */
    const contracted = invoiceRows.filter((row) => {
      const details = decodePayload<{ complimentary?: boolean }>(row, {});
      return row.status === "recorded" && !details.complimentary;
    }).length;

    const months: PlatformRevenueMonth[] = [];
    const cursor = new Date(now);
    cursor.setUTCDate(1);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCMonth(cursor.getUTCMonth() - 11);
    for (let index = 0; index < 12; index += 1) {
      const from = cursor.getTime();
      const next = new Date(cursor);
      next.setUTCMonth(next.getUTCMonth() + 1);
      const to = next.getTime();
      const within = (value?: string | null) => {
        if (!value) return false;
        const at = Date.parse(value);
        return Number.isFinite(at) && at >= from && at < to;
      };
      let started = 0;
      let converted = 0;
      let churned = 0;
      for (const { record } of subscriptions) {
        if (within(record.startsAt)) started += 1;
        if (within(record.convertedAt)) converted += 1;
        /* downgradedAt and convertedAt are last-transition stamps on a mutable
           subscription row, not an event log. A workspace that downgraded and
           later came back still carries the downgrade stamp, so counting the
           stamp alone reports a live paying customer as churned, in the same
           month it converted, and keeps doing so forever.

           Churn therefore requires the subscription to be lost now. Anything
           still active or in grace has not churned, whatever it did on the way
           here. The cost is that a genuine churn-and-return nets to zero
           instead of showing both moves; recording lifecycle transitions as
           events is what would make both visible. */
        if (!LOST_SUBSCRIPTION_STATUSES.has(record.status)) continue;
        if (within(record.downgradedAt) || within(record.expiresAt)) {
          churned += 1;
        }
      }
      months.push({
        month: new Date(from).toISOString().slice(0, 7),
        started,
        converted,
        churned,
      });
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    const trialsStarted = subscriptions.filter(
      ({ record }) => record.plan === "pro_trial" || record.trialConsumed,
    ).length;
    const trialsConverted = subscriptions.filter(({ record }) => record.convertedAt).length;

    return {
      currency,
      catalogPriced: baseMinor !== null,
      catalogName: effective?.name ?? null,
      baseAmountMinor: baseMinor,
      mrrMinor,
      arrMinor: mrrMinor === null ? null : mrrMinor * 12,
      payingWorkspaces: paying.length,
      contractedAgreements: contracted,
      planMix,
      months,
      trialsStarted,
      trialsConverted,
    };
  }

  async listActivity(
    identity: AuthenticatedIdentity,
    input: { cursor?: string; limit?: string | null },
  ) {
    const roles = await this.requireOperator(identity);
    const limit = pageLimit(input.limit ?? null);
    const names = await this.workspaceNames();
    const [auditPage, failedPage, deletionRows, appointmentRows] = await Promise.all([
      pageRows(this.store, TABLES.auditSegments, {
        order: "desc",
        limit,
        cursor: input.cursor,
      }),
      this.store.list(TABLES.notificationDeliveries, {
        filters: [{ field: "status", value: "failed" }],
        order: "desc",
        limit: 20,
      }),
      this.store.list(TABLES.lifecycleCases, {
        filters: [{ field: "status", value: "awaiting_approval" }],
        order: "desc",
        limit: 50,
      }),
      this.store.list(TABLES.initialAdminAppointments, {
        filters: [{ field: "status", value: "active" }],
        limit: 50,
      }),
    ]);
    const includeConfirmation = roles.includes("owner");
    return {
      audits: {
        items: auditPage.items.map((row) => ({
          id: row.$id,
          workspaceId: stringValue(row.workspace_id),
          workspaceName: names.get(stringValue(row.workspace_id)) ?? "Workspace",
          action: stringValue(
            decodePayload<{ action?: string }>(row, {}).action,
            stringValue(row.kind),
          ),
          occurredAt: stringValue(row.occurred_at, row.$createdAt),
        })) satisfies PlatformAuditSummary[],
        nextCursor: auditPage.nextCursor,
      },
      notificationFailures: failedPage.map((row) => {
        const details = decodePayload<{ attempts?: number; lastFailedAt?: string }>(
          row,
          {},
        );
        return {
          id: row.$id,
          workspaceId: stringValue(row.workspace_id),
          workspaceName: names.get(stringValue(row.workspace_id)) ?? "Workspace",
          kind: stringValue(row.kind),
          attempts: numberValue(details.attempts),
          lastFailedAt: details.lastFailedAt ?? row.$updatedAt,
        } satisfies PlatformNotificationFailure;
      }),
      deletionCases: deletionRows.map((row) =>
        this.deletionFromRow(
          row,
          names.get(stringValue(row.workspace_id)) ?? "Workspace",
          includeConfirmation,
        ),
      ),
      appointments: appointmentRows.map((row) => ({
        id: row.$id,
        workspaceId: stringValue(row.workspace_id),
        email: stringValue(row.email),
        status: "active" as const,
        expiresAt: stringValue(row.expires_at),
        createdAt: row.$createdAt,
      })),
    };
  }

  async search(identity: AuthenticatedIdentity, query: string) {
    await this.requireOperator(identity);
    const phrase = query.trim().toLowerCase();
    const sections: PlatformSearchHit[] = (
      [
        ["overview", "Home"],
        ["customers", "Customers"],
        ["leads", "Leads"],
        ["support", "Support"],
        ["tools", "Tools"],
      ] as const
    )
      .filter(
        ([section, label]) =>
          !phrase ||
          label.toLowerCase().includes(phrase) ||
          section.includes(phrase),
      )
      .map(([section, label]) => ({
        kind: "section" as const,
        id: section,
        label,
        description:
          section === "overview" ? "Founder home" : `Open ${label.toLowerCase()}`,
        href: administrationReference(section),
      }));
    if (!phrase) return { results: sections.slice(0, 8) };

    const [accounts, leads, tickets, people] = await Promise.all([
      this.listAccounts(identity, { query: phrase, limit: "8" }),
      this.listLeads(identity, { query: phrase, limit: "5" }),
      this.listTickets(identity, { query: phrase, status: "open", limit: "5" }),
      this.store.list(TABLES.workspaceMembers, {
        filters: [{ field: "email", value: phrase }],
        limit: 10,
      }),
    ]);
    const names = await this.workspaceNames();
    const hits: PlatformSearchHit[] = [
      ...accounts.items.map((account) => ({
        kind: "account" as const,
        id: account.id,
        label: account.organizationName
          ? `${account.organizationName} · ${account.name}`
          : account.name,
        description: `${account.slug} · ${account.status}`,
        href: administrationReference("clients", account.id),
      })),
      ...leads.items.map((lead) => ({
        kind: "lead" as const,
        id: lead.id,
        label: lead.organization || lead.contactName || lead.email,
        description: `${lead.email} · ${lead.status}`,
        href: administrationReference("leads", lead.id),
      })),
      ...tickets.items.map((ticket) => ({
        kind: "ticket" as const,
        id: ticket.id,
        label: ticket.subject,
        description: `${ticket.workspaceName} · ${ticket.requesterName}`,
        href: administrationReference("support", ticket.id),
      })),
      ...people.map((row) => ({
        kind: "person" as const,
        id: row.$id,
        label: personFromMember(row).name || stringValue(row.email),
        description: `${stringValue(row.email)} · ${names.get(stringValue(row.workspace_id)) ?? "Workspace"}`,
        href: administrationReference("clients", stringValue(row.workspace_id)),
      })),
      ...sections,
    ];
    return { results: hits.slice(0, 10) };
  }
}
