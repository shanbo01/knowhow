import { appendAudit } from "./audit-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  rowData,
  type OrganizationRecord,
  type SubscriptionRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import {
  entitlementsForPlan,
  FREE_ENTITLEMENTS,
  isCommercialPlan,
  PRO_TRIAL_DAYS,
  type CommercialPlan,
} from "./commercial-plan";
import { HttpError } from "./http-security";
import { deterministicResourceId } from "./ids";
import { inputEmail, inputText, slugify } from "./input";
import { TABLES } from "./appwrite-resources";
import { resolveSelfServiceTrialPlan } from "./pricing-catalog-service";
import type { RecordStore } from "./record-store";
import { registrationMode } from "./registration-mode";
import type { AuthenticatedIdentity } from "./session-identity";

const DAY = 86_400_000;

export type BetaAdmissionSummary = {
  grantId: string;
  admittedAt?: string;
};

export type BetaAdmissionVerifier = {
  getConsumedGrantForUser(
    userId: string,
    email: string,
  ): Promise<BetaAdmissionSummary | null>;
};

export type SelfServiceSetupDraft = {
  organizationName?: string;
  legalName?: string;
  country?: string;
  workspaceName?: string;
  accentColor?: string;
  inviteEmail?: string;
};

export type SelfServiceSetupInput = {
  organizationName?: unknown;
  legalName?: unknown;
  country?: unknown;
  workspaceName?: unknown;
  accentColor?: unknown;
  inviteEmail?: unknown;
  plan?: unknown;
};

export type SelfServiceSetupResult = {
  organizationId: string;
  workspaceId: string;
  workspaceSlug: string;
  subscriptionId: string;
  onboardingProgressId: string;
  trial: {
    startsAt: string;
    expiresAt: string | null;
    graceEndsAt: string | null;
    deletionEligibleAt: string | null;
    plan: CommercialPlan;
  };
  invite?: {
    id: string;
    inviteUrl?: string;
    expiresAt: string;
  };
};

export type SelfServiceSetupRun = {
  runId: string;
  status: "draft" | "completed";
  draft: SelfServiceSetupDraft;
  result?: SelfServiceSetupResult;
};

export type SelfServiceSetupOptions = {
  requestId: string;
  reauthenticated?: boolean;
  now?: Date;
  createInvite?: (input: {
    organizationId: string;
    workspaceId: string;
    email: string;
  }) => Promise<SelfServiceSetupResult["invite"]>;
};

type TrialPlan = {
  catalogItemId: string;
  trialDays: number;
  graceDays: number;
  retentionDays: number;
  entitlements: Record<string, string | number | boolean>;
};

function normalizeAccent(value: unknown) {
  const accent = inputText(
    value ?? DEFAULT_WORKSPACE_SETTINGS.accentColor,
    "Accent color",
    { min: 7, max: 7 },
  ).toLowerCase();
  if (!/^#[0-9a-f]{6}$/.test(accent)) {
    throw new HttpError(
      400,
      "BRANDING_INVALID",
      "Use a six-digit hexadecimal accent color.",
    );
  }
  return accent;
}

function normalizedDraft(
  input: SelfServiceSetupInput,
  options: { partial: boolean },
): SelfServiceSetupDraft {
  const output: SelfServiceSetupDraft = {};
  if (input.organizationName !== undefined || !options.partial) {
    output.organizationName = inputText(
      input.organizationName,
      "Organization name",
      { min: 2, max: 128 },
    );
  }
  if (input.legalName !== undefined) {
    output.legalName = inputText(input.legalName, "Legal name", {
      min: 2,
      max: 200,
    });
  }
  if (input.country !== undefined) {
    output.country = inputText(input.country, "Country", {
      min: 2,
      max: 2,
    }).toUpperCase();
  }
  if (input.workspaceName !== undefined || !options.partial) {
    output.workspaceName = inputText(input.workspaceName, "Workspace name", {
      min: 2,
      max: 128,
    });
  }
  if (input.accentColor !== undefined) {
    output.accentColor = normalizeAccent(input.accentColor);
  }
  if (input.inviteEmail !== undefined) {
    output.inviteEmail = inputEmail(input.inviteEmail, "Teammate email");
  }
  return output;
}

async function setupIds(userId: string) {
  return {
    runId: await deterministicResourceId("selfsetup", userId),
    organizationId: await deterministicResourceId(
      "org",
      `self-service:${userId}`,
    ),
    organizationMembershipId: await deterministicResourceId(
      "orgmember",
      `self-service:${userId}`,
    ),
    brandingId: await deterministicResourceId(
      "branding",
      `self-service:${userId}`,
    ),
    workspaceId: await deterministicResourceId(
      "workspace",
      `self-service:${userId}`,
    ),
    settingsId: await deterministicResourceId(
      "settings",
      `self-service:${userId}`,
    ),
    memberId: await deterministicResourceId("member", `self-service:${userId}`),
    subscriptionId: await deterministicResourceId(
      "subscription",
      `self-service:${userId}`,
    ),
    onboardingProgressId: await deterministicResourceId(
      "onboard",
      `self-service:${userId}`,
    ),
  };
}

function completeResult(value: unknown): SelfServiceSetupResult | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<SelfServiceSetupResult>;
  return typeof candidate.organizationId === "string" &&
    typeof candidate.workspaceId === "string" &&
    typeof candidate.workspaceSlug === "string" &&
    typeof candidate.subscriptionId === "string" &&
    typeof candidate.onboardingProgressId === "string" &&
    candidate.trial !== undefined
    ? (candidate as SelfServiceSetupResult)
    : undefined;
}

export class SelfServiceProvisioningService {
  constructor(
    private readonly store: RecordStore,
    private readonly admissions: BetaAdmissionVerifier,
  ) {}

  async save(
    identity: AuthenticatedIdentity,
    input: SelfServiceSetupInput,
    options: Pick<SelfServiceSetupOptions, "requestId">,
  ): Promise<SelfServiceSetupRun> {
    this.requireVerified(identity);
    await this.authorizeSelfService(identity);
    const ids = await setupIds(identity.userId);
    const row = await this.store.get(TABLES.provisioningRuns, ids.runId);
    const current = row
      ? decodePayload<{
          draft?: SelfServiceSetupDraft;
          result?: SelfServiceSetupResult;
        }>(row, {})
      : {};
    if (
      row &&
      (row.user_id !== identity.userId || row.kind !== "self_service")
    ) {
      throw new HttpError(
        409,
        "SELF_SERVICE_SETUP_CONFLICT",
        "The saved setup record is unavailable.",
      );
    }
    if (row && row.status !== "draft" && row.status !== "completed") {
      throw new HttpError(
        409,
        "SELF_SERVICE_SETUP_CONFLICT",
        "The saved setup record is unavailable.",
      );
    }
    if (row?.status === "completed") {
      const result = completeResult(current.result);
      if (!result) {
        throw new HttpError(
          500,
          "SELF_SERVICE_SETUP_CORRUPT",
          "The completed setup record is unavailable.",
          { expose: false },
        );
      }
      return {
        runId: ids.runId,
        status: "completed",
        draft: current.draft ?? {},
        result,
      };
    }
    const draft = {
      ...(current.draft ?? {}),
      ...normalizedDraft(input, { partial: true }),
    };
    const now = new Date().toISOString();
    const data = rowData(
      {
        user_id: identity.userId,
        email: identity.email,
        status: "draft",
        kind: "self_service",
        request_id: options.requestId,
        updated_by: identity.userId,
        ...(row ? {} : { created_by: identity.userId }),
      },
      {
        draft,
        createdAt: row?.$createdAt ?? now,
        updatedAt: now,
      },
    );
    if (row) await this.store.update(TABLES.provisioningRuns, ids.runId, data);
    else await this.store.create(TABLES.provisioningRuns, ids.runId, data);
    return { runId: ids.runId, status: "draft", draft };
  }

  async complete(
    identity: AuthenticatedIdentity,
    input: SelfServiceSetupInput,
    options: SelfServiceSetupOptions,
  ): Promise<SelfServiceSetupResult> {
    this.requireVerified(identity);
    const admission = await this.authorizeSelfService(identity);
    const ids = await setupIds(identity.userId);
    const run = await this.store.get(TABLES.provisioningRuns, ids.runId);
    if (
      run &&
      (run.user_id !== identity.userId || run.kind !== "self_service")
    ) {
      throw new HttpError(
        409,
        "SELF_SERVICE_SETUP_CONFLICT",
        "The saved setup record is unavailable.",
      );
    }
    if (run && run.status !== "draft" && run.status !== "completed") {
      throw new HttpError(
        409,
        "SELF_SERVICE_SETUP_CONFLICT",
        "The saved setup record is unavailable.",
      );
    }
    const runState = run
      ? decodePayload<{
          draft?: SelfServiceSetupDraft;
          result?: SelfServiceSetupResult;
        }>(run, {})
      : {};
    if (run?.status === "completed") {
      const result = completeResult(runState.result);
      if (!result) {
        throw new HttpError(
          500,
          "SELF_SERVICE_SETUP_CORRUPT",
          "The completed setup record is unavailable.",
          { expose: false },
        );
      }
      await this.assertBoundResult(identity, result);
      return result;
    }
    const draft = {
      ...(runState.draft ?? {}),
      ...normalizedDraft(input, { partial: true }),
    };
    const required = normalizedDraft(draft, { partial: false });
    if (required.inviteEmail === identity.email) {
      throw new HttpError(
        400,
        "SELF_INVITATION_INVALID",
        "Invite a teammate using a different email address.",
      );
    }
    const createdWorkspaceCount = await this.createdWorkspaceCount(
      identity.userId,
    );
    const limit = await this.workspaceLimit();
    if (createdWorkspaceCount >= limit) {
      throw new HttpError(
        409,
        "SELF_SERVICE_WORKSPACE_LIMIT",
        "This account has reached its self-service workspace limit.",
      );
    }

    const catalogPlan = await this.trialPlan();
    const requestedPlan =
      input.plan === "free" || input.plan === "pro_trial"
        ? input.plan
        : isCommercialPlan(input.plan)
          ? "pro_trial"
          : "pro_trial";
    const commercialPlan: CommercialPlan =
      requestedPlan === "free" ? "free" : "pro_trial";
    const now = options.now ? new Date(options.now) : new Date();
    if (!Number.isFinite(now.getTime())) throw new Error("Invalid setup time.");
    const startsAt = now.toISOString();
    const trialDays =
      commercialPlan === "pro_trial"
        ? catalogPlan.trialDays || PRO_TRIAL_DAYS
        : 0;
    const expiresAt =
      commercialPlan === "pro_trial"
        ? new Date(now.getTime() + trialDays * DAY).toISOString()
        : null;
    const graceEndsAt =
      commercialPlan === "pro_trial"
        ? new Date(
            now.getTime() + (trialDays + catalogPlan.graceDays) * DAY,
          ).toISOString()
        : null;
    const deletionEligibleAt =
      commercialPlan === "pro_trial"
        ? new Date(
            now.getTime() + (trialDays + catalogPlan.retentionDays) * DAY,
          ).toISOString()
        : null;
    const workspaceSlug = `${slugify(required.workspaceName!)}-${ids.workspaceId.slice(-5)}`;
    const organizationSlug = `${slugify(required.organizationName!)}-${ids.organizationId.slice(-5)}`;

    const result: SelfServiceSetupResult = {
      organizationId: ids.organizationId,
      workspaceId: ids.workspaceId,
      workspaceSlug,
      subscriptionId: ids.subscriptionId,
      onboardingProgressId: ids.onboardingProgressId,
      trial: {
        startsAt,
        expiresAt,
        graceEndsAt,
        deletionEligibleAt,
        plan: commercialPlan,
      },
    };

    const organization: OrganizationRecord = {
      legalName: required.legalName ?? required.organizationName!,
      displayName: required.organizationName!,
      primaryContactName: identity.name,
      primaryContactEmail: identity.email,
      country: required.country ?? "QA",
      status: "active",
      createdAt: startsAt,
    };
    const workspace: WorkspaceRecord = {
      organizationId: ids.organizationId,
      name: required.workspaceName!,
      slug: workspaceSlug,
      status: "active",
      createdAt: startsAt,
      auditSequence: 0,
      auditHash: "0".repeat(64),
    };
    const subscription: SubscriptionRecord = {
      kind: "trial",
      plan: commercialPlan,
      startsAt,
      expiresAt,
      graceDays: commercialPlan === "pro_trial" ? catalogPlan.graceDays : 0,
      retentionDays:
        commercialPlan === "pro_trial" ? catalogPlan.retentionDays : 90,
      publicTrial: false,
      manualContract: false,
      status: "active",
      trialConsumed: commercialPlan === "pro_trial",
    };
    const planEntitlements =
      commercialPlan === "free"
        ? FREE_ENTITLEMENTS
        : {
            ...entitlementsForPlan("pro_trial"),
            ...catalogPlan.entitlements,
            extensionEnabled: true,
            supportEnabled: true,
            removeBranding: true,
            privacyToolsEnabled: true,
            customSubdomainEnabled: true,
            fileExportsEnabled: true,
          };
    const accentColor = normalizeAccent(required.accentColor);

    await this.store.create(
      TABLES.organizations,
      ids.organizationId,
      rowData(
        {
          slug: organizationSlug,
          status: "active",
          created_by: identity.userId,
          request_id: options.requestId,
        },
        organization,
      ),
    );
    await this.store.create(
      TABLES.organizationMemberships,
      ids.organizationMembershipId,
      rowData(
        {
          organization_id: ids.organizationId,
          user_id: identity.userId,
          email: identity.email,
          status: "active",
          created_by: identity.userId,
          request_id: options.requestId,
        },
        { roles: ["owner"], name: identity.name, joinedAt: startsAt },
      ),
    );
    await this.store.create(
      TABLES.organizationBranding,
      ids.brandingId,
      rowData(
        {
          organization_id: ids.organizationId,
          status: "active",
          created_by: identity.userId,
        },
        { logoMediaId: null, accentColor, updatedAt: startsAt },
      ),
    );
    await this.store.create(
      TABLES.workspaces,
      ids.workspaceId,
      rowData(
        {
          organization_id: ids.organizationId,
          slug: workspaceSlug,
          status: "active",
          created_by: identity.userId,
          request_id: options.requestId,
        },
        workspace,
      ),
    );
    await this.store.create(
      TABLES.workspaceSettings,
      ids.settingsId,
      rowData(
        {
          organization_id: ids.organizationId,
          workspace_id: ids.workspaceId,
          status: "active",
          created_by: identity.userId,
        },
        { ...DEFAULT_WORKSPACE_SETTINGS, accentColor },
      ),
    );
    const member: WorkspaceMemberRecord = {
      name: identity.name,
      roles: ["administrator"],
      capabilities: [],
      groupIds: [],
      joinedAt: startsAt,
    };
    await this.store.create(
      TABLES.workspaceMembers,
      ids.memberId,
      rowData(
        {
          organization_id: ids.organizationId,
          workspace_id: ids.workspaceId,
          user_id: identity.userId,
          email: identity.email,
          status: "active",
          created_by: identity.userId,
        },
        member,
      ),
    );
    await this.store.create(
      TABLES.subscriptions,
      ids.subscriptionId,
      rowData(
        {
          organization_id: ids.organizationId,
          workspace_id: ids.workspaceId,
          status: "active",
          kind: "trial",
          created_by: identity.userId,
        },
        {
          ...subscription,
          catalogItemId:
            commercialPlan === "pro_trial"
              ? catalogPlan.catalogItemId
              : "built_in_free_default",
          originalExpiresAt: expiresAt,
          deletionEligibleAt,
        },
      ),
    );
    for (const [kind, value] of Object.entries(planEntitlements)) {
      const entitlementId = await deterministicResourceId(
        "entitle",
        `${ids.workspaceId}:${kind}`,
      );
      await this.store.create(
        TABLES.entitlements,
        entitlementId,
        rowData(
          {
            organization_id: ids.organizationId,
            workspace_id: ids.workspaceId,
            kind,
            status: "active",
            created_by: identity.userId,
          },
          {
            value,
            source:
              commercialPlan === "pro_trial"
                ? catalogPlan.catalogItemId
                : "built_in_free_default",
          },
        ),
      );
    }
    await this.store.create(
      TABLES.onboardingProgress,
      ids.onboardingProgressId,
      rowData(
        {
          organization_id: ids.organizationId,
          workspace_id: ids.workspaceId,
          user_id: identity.userId,
          status: "active",
          occurred_at: startsAt,
          created_by: identity.userId,
        },
        {
          startedAt: startsAt,
          completedAt: null,
          currentStep: "workspace_readiness",
          skippedSteps: [],
        },
      ),
    );
    const milestoneKinds = [
      "registration.completed",
      "organization.created",
      "workspace.created",
    ];
    for (const kind of milestoneKinds) {
      const milestoneRequestId = await deterministicResourceId(
        "request",
        `${options.requestId}:${kind}`,
      );
      await this.store.create(
        TABLES.usageEvents,
        await deterministicResourceId("usage", `${ids.workspaceId}:${kind}`),
        rowData(
          {
            organization_id: ids.organizationId,
            workspace_id: ids.workspaceId,
            user_id: identity.userId,
            subject_id:
              kind === "organization.created"
                ? ids.organizationId
                : kind === "workspace.created"
                  ? ids.workspaceId
                  : identity.userId,
            kind,
            status: "recorded",
            occurred_at: startsAt,
            // usage_events.request_id is uniquely indexed. Each atomic setup
            // milestone therefore needs its own stable correlation key.
            request_id: milestoneRequestId,
            created_by: identity.userId,
          },
          { contentIncluded: false, source: "self_service" },
        ),
      );
    }

    if (required.inviteEmail && options.createInvite) {
      result.invite = await options.createInvite({
        organizationId: ids.organizationId,
        workspaceId: ids.workspaceId,
        email: required.inviteEmail,
      });
    }

    const completedAt = new Date().toISOString();
    const persistedResult: SelfServiceSetupResult = {
      ...result,
      ...(result.invite
        ? {
            invite: {
              id: result.invite.id,
              expiresAt: result.invite.expiresAt,
            },
          }
        : {}),
    };
    const runData = rowData(
      {
        user_id: identity.userId,
        email: identity.email,
        organization_id: ids.organizationId,
        workspace_id: ids.workspaceId,
        status: "completed",
        kind: "self_service",
        sequence: 1,
        request_id: options.requestId,
        updated_by: identity.userId,
        ...(run ? {} : { created_by: identity.userId }),
      },
      {
        draft: required,
        ...(admission?.grantId ? { admissionGrantId: admission.grantId } : {}),
        createdAt: run?.$createdAt ?? startsAt,
        updatedAt: completedAt,
        completedAt,
        result: persistedResult,
      },
    );
    if (run)
      await this.store.update(TABLES.provisioningRuns, ids.runId, runData);
    else await this.store.create(TABLES.provisioningRuns, ids.runId, runData);

    await appendAudit(this.store, identity, ids.workspaceId, {
      action: "self_service.created",
      targetType: "workspace",
      targetId: ids.workspaceId,
      targetLabel: workspace.name,
      summary: "Organization and trial workspace created through self-service",
      metadata: {
        ...(admission?.grantId ? { admissionGrantId: admission.grantId } : {}),
        trialDays,
      },
    });
    return result;
  }

  private requireVerified(identity: AuthenticatedIdentity) {
    if (!identity.emailVerified) {
      throw new HttpError(
        403,
        "EMAIL_NOT_VERIFIED",
        "Verify your email before creating an organization.",
      );
    }
  }

  private async authorizeSelfService(identity: AuthenticatedIdentity) {
    const mode = registrationMode();
    if (mode === "disabled") {
      throw new HttpError(
        403,
        "SELF_SERVICE_DISABLED",
        "Organization setup is invitation-only for this deployment.",
      );
    }
    const admission = await this.admissions.getConsumedGrantForUser(
      identity.userId,
      identity.email,
    );
    if (mode === "private_beta" && !admission) {
      throw new HttpError(
        403,
        "BETA_ADMISSION_REQUIRED",
        "A consumed private-beta admission is required.",
      );
    }
    return admission;
  }

  private async createdWorkspaceCount(userId: string) {
    const memberships = await this.store.list(TABLES.workspaceMembers, {
      filters: [
        { field: "user_id", value: userId },
        { field: "status", value: "active" },
      ],
      limit: 5_001,
    });
    let count = 0;
    for (const membership of memberships) {
      const details = decodePayload<WorkspaceMemberRecord>(membership, {
        name: "",
        roles: [],
        capabilities: [],
        groupIds: [],
      });
      if (!details.roles.includes("administrator")) continue;
      const workspaceId = String(membership.workspace_id ?? "");
      const workspace = workspaceId
        ? await this.store.get(TABLES.workspaces, workspaceId)
        : null;
      if (workspace?.created_by === userId) count += 1;
    }
    return count;
  }

  private async trialPlan(): Promise<TrialPlan> {
    return resolveSelfServiceTrialPlan(this.store);
  }

  private async workspaceLimit() {
    const settings = await this.store.get(
      TABLES.catalogItems,
      "platform_settings",
    );
    const configured = settings
      ? decodePayload<{ selfServiceWorkspaceLimit?: number }>(settings, {})
          .selfServiceWorkspaceLimit
      : undefined;
    const envValue = Number.parseInt(
      process.env.KNOWHOW_SELF_SERVICE_WORKSPACE_LIMIT ?? "",
      10,
    );
    const value = configured ?? (Number.isSafeInteger(envValue) ? envValue : 1);
    return Number.isSafeInteger(value) && value >= 1 && value <= 100
      ? value
      : 1;
  }

  private async assertBoundResult(
    identity: AuthenticatedIdentity,
    result: SelfServiceSetupResult,
  ) {
    const [
      organization,
      workspace,
      organizationMembership,
      workspaceMembership,
    ] = await Promise.all([
      this.store.get(TABLES.organizations, result.organizationId),
      this.store.get(TABLES.workspaces, result.workspaceId),
      this.store.list(TABLES.organizationMemberships, {
        filters: [
          { field: "organization_id", value: result.organizationId },
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
        ],
        limit: 1,
      }),
      this.store.list(TABLES.workspaceMembers, {
        filters: [
          { field: "workspace_id", value: result.workspaceId },
          { field: "user_id", value: identity.userId },
          { field: "status", value: "active" },
        ],
        limit: 1,
      }),
    ]);
    if (
      !organization ||
      !workspace ||
      workspace.organization_id !== result.organizationId ||
      organizationMembership.length !== 1 ||
      workspaceMembership.length !== 1
    ) {
      throw new HttpError(
        409,
        "SELF_SERVICE_SETUP_CONFLICT",
        "The completed setup does not match this account.",
      );
    }
  }
}
