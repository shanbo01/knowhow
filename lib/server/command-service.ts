import type {
  OrganizationRole,
  SupportAccessRequest,
  WorkspaceRole,
  WorkspaceSettings,
} from "../knowhow-types";
import { AccessService, type PlatformRole } from "./access-service";
import { BetaAccessService } from "./beta-access-service";
import { DesktopAuthService } from "./desktop-auth-service";
import { appendAudit } from "./audit-service";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  type GuideRecord,
  rowData,
  type OrganizationRecord,
  type LifecycleCaseRecord,
  type SubscriptionRecord,
  type SupportGrantRecord,
  type WorkspaceGroupRecord,
  type WorkspaceMemberRecord,
  type WorkspaceRecord,
} from "./domain-records";
import {
  entitlementsForPlan,
  inferredCommercialPlan,
  isCommercialPlan,
  PRO_TRIAL_DAYS,
  subscriptionKindForPlan,
  trialConsumed,
  type CommercialPlan,
} from "./commercial-plan";
import {
  isAccountTag,
} from "./platform-intelligence";
import { HttpError } from "./http-security";
import { GuideCommandService } from "./guide-command-service";
import {
  evaluateSubscription,
  subscriptionForWorkspace,
} from "./lifecycle-service";
import {
  applyPlanEntitlements,
  EntitlementDeniedError,
  EntitlementService,
  OVERRIDABLE_ENTITLEMENTS,
  recordEntitlementBlocked,
  type EntitlementOverridePayload,
  type EntitlementValue,
  type OverridableEntitlement,
} from "./entitlement-service";
import { PricingCatalogService } from "./pricing-catalog-service";
import { GuideAccessService } from "./guide-access-service";
import { resourceId, deterministicResourceId } from "./ids";
import {
  inputBoolean,
  inputEmail,
  inputInteger,
  inputObject,
  inputStringList,
  inputText,
  slugify,
} from "./input";
import { TABLES } from "./appwrite-resources";
import { requireAuthorized } from "./policy";
import { RecordConflictError, type RecordStore } from "./record-store";
import type { PrivateObjectStore } from "./private-object-store";
import type { AuthenticatedIdentity } from "./session-identity";
import {
  SelfServiceProvisioningService,
  type SelfServiceSetupInput,
} from "./self-service-provisioning-service";
import { encryptNotificationCredential } from "./notification-secrets";
import {
  constantTimeEqual,
  hashToken,
  signAppointmentToken,
  signInviteToken,
  verifyAppointmentToken,
  verifyInviteToken,
} from "./tokens";

const WORKSPACE_ROLES = new Set<WorkspaceRole>([
  "administrator",
  "creator",
  "reviewer",
  "publisher",
  "viewer",
]);
const INVITABLE_ROLES = new Set<WorkspaceRole>([
  "creator",
  "reviewer",
  "publisher",
  "viewer",
]);

type CommandOptions = {
  idempotencyKey: string;
  requestId: string;
  reauthenticated?: boolean;
};

function nowIso() {
  return new Date().toISOString();
}

function nextBusinessDay(from = new Date()) {
  const target = new Date(from.getTime() + 24 * 60 * 60 * 1_000);
  // Qatar business days are Sunday through Thursday.
  while (target.getUTCDay() === 5 || target.getUTCDay() === 6) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  return target.toISOString();
}

function supportText(
  value: unknown,
  label: string,
  options: { min: number; max: number },
) {
  const text = inputText(value, label, options);
  if (
    /(?:password|passcode|secret|api[_ -]?key|access[_ -]?token|bearer)\s*[:=]\s*\S+/i.test(
      text,
    ) ||
    /(?:\d[ -]*?){13,19}/.test(text)
  ) {
    throw new HttpError(
      400,
      "SENSITIVE_SUPPORT_CONTENT",
      "Remove credentials, secrets, payment numbers, and other sensitive data from the support message.",
    );
  }
  return text;
}

function provisioningStep(step: number, raw: Record<string, unknown>) {
  if (step === 1) {
    const identity = {
      legalName: inputText(raw.legalName, "Legal name", { min: 2, max: 200 }),
      displayName: inputText(raw.displayName, "Display name", {
        min: 2,
        max: 128,
      }),
      primaryContactName: inputText(raw.primaryContactName, "Primary contact", {
        min: 2,
        max: 128,
      }),
      primaryContactEmail: inputEmail(
        raw.primaryContactEmail,
        "Primary contact email",
      ),
      country: inputText(raw.country ?? "QA", "Country", {
        min: 2,
        max: 2,
      }).toUpperCase(),
    };
    if (!/\.[a-z]{2,}$/i.test(identity.primaryContactEmail.split("@")[1] ?? "")) {
      throw new HttpError(
        400,
        "EMAIL_INVALID",
        "Primary contact email is invalid.",
      );
    }
    return identity;
  }
  if (step === 2) {
    const accentColor = inputText(
      raw.accentColor ?? "#2f6fed",
      "Accent color",
      { min: 7, max: 7 },
    );
    if (!/^#[0-9a-f]{6}$/i.test(accentColor))
      throw new HttpError(
        400,
        "BRANDING_INVALID",
        "Use a six-digit hexadecimal accent color.",
      );
    return {
      accentColor: accentColor.toLowerCase(),
      logoMediaId: inputText(raw.logoMediaId, "Organization logo", {
        min: 1,
        max: 36,
      }),
    };
  }
  if (step === 3) {
    if (
      !Array.isArray(raw.workspaces) ||
      raw.workspaces.length < 1 ||
      raw.workspaces.length > 10
    ) {
      throw new HttpError(
        400,
        "WORKSPACES_INVALID",
        "Provision between one and ten workspaces.",
      );
    }
    return {
      workspaces: raw.workspaces.map((candidate) => {
        const workspace = inputObject(candidate, "Workspace");
        return {
          name: inputText(workspace.name, "Workspace name", {
            min: 2,
            max: 128,
          }),
          administratorEmails: inputStringList(
            workspace.administratorEmails ?? [],
            "Workspace administrators",
            10,
            320,
          ).map((value) => inputEmail(value)),
          accentColor: workspace.accentColor
            ? inputText(workspace.accentColor, "Workspace accent", {
                min: 7,
                max: 7,
              })
            : null,
        };
      }),
    };
  }
  if (step === 4) {
    const pilotStart = new Date(
      inputText(raw.pilotStart, "Pilot start", { min: 10, max: 40 }),
    );
    const pilotEnd = new Date(
      inputText(raw.pilotEnd, "Pilot end", { min: 10, max: 40 }),
    );
    if (
      !Number.isFinite(pilotStart.getTime()) ||
      !Number.isFinite(pilotEnd.getTime()) ||
      pilotEnd <= pilotStart
    ) {
      throw new HttpError(
        400,
        "PILOT_DATES_INVALID",
        "Pilot dates are invalid.",
      );
    }
    return {
      pilotStart: pilotStart.toISOString(),
      pilotEnd: pilotEnd.toISOString(),
      entitlements: {
        maximumUsers: inputInteger(
          raw.maximumUsers ?? 100,
          "Maximum users",
          1,
          100,
        ),
        maximumCreators: inputInteger(
          raw.maximumCreators ?? 25,
          "Maximum creators",
          1,
          100,
        ),
        storageBytes: inputInteger(
          raw.storageBytes ?? 5_000_000_000,
          "Storage limit",
          1_000_000,
          Number.MAX_SAFE_INTEGER,
        ),
      },
    };
  }
  if (step === 5) {
    const initialOwnerEmails = inputStringList(
      raw.initialOwnerEmails,
      "Initial owners",
      10,
      320,
    ).map((value) => inputEmail(value));
    if (initialOwnerEmails.length < 2)
      throw new HttpError(
        400,
        "INITIAL_OWNERS_REQUIRED",
        "Provision at least two initial organization owners.",
      );
    return { initialOwnerEmails };
  }
  if (step === 6) {
    if (
      !Array.isArray(raw.teamInvitations) ||
      raw.teamInvitations.length > 100
    ) {
      throw new HttpError(
        400,
        "TEAM_INVITATIONS_INVALID",
        "Provide no more than 100 initial team invitations.",
      );
    }
    return {
      teamInvitations: raw.teamInvitations.map((candidate) => {
        const invitation = inputObject(candidate, "Team invitation");
        return {
          email: inputEmail(invitation.email),
          workspaceIndex: inputInteger(
            invitation.workspaceIndex ?? 0,
            "Workspace selection",
            0,
            9,
          ),
          role: role(invitation.role ?? "viewer", true),
        };
      }),
    };
  }
  throw new HttpError(
    400,
    "PROVISIONING_STEP_INVALID",
    "Provisioning step is invalid.",
  );
}

function role(value: unknown, invitational = false): WorkspaceRole {
  const candidate = inputText(value, "Role", {
    min: 4,
    max: 32,
  }) as WorkspaceRole;
  if (!(invitational ? INVITABLE_ROLES : WORKSPACE_ROLES).has(candidate)) {
    throw new HttpError(400, "ROLE_INVALID", "The selected role is invalid.");
  }
  return candidate;
}

function roles(value: unknown): WorkspaceRole[] {
  const output = inputStringList(value, "Roles", 5, 32) as WorkspaceRole[];
  if (!output.length || output.some((item) => !WORKSPACE_ROLES.has(item))) {
    throw new HttpError(400, "ROLE_INVALID", "Select at least one valid role.");
  }
  return output;
}

function organizationRoles(value: unknown): OrganizationRole[] {
  const output = inputStringList(
    value,
    "Organization roles",
    4,
    32,
  ) as OrganizationRole[];
  if (
    !output.length ||
    output.some(
      (item) =>
        !["owner", "administrator", "billing", "security_auditor"].includes(
          item,
        ),
    )
  ) {
    throw new HttpError(
      400,
      "ORGANIZATION_ROLE_INVALID",
      "Select at least one valid organization role.",
    );
  }
  return [...new Set(output)];
}

function platformMayManage(value: PlatformRole[]) {
  return value.includes("owner") || value.includes("operations");
}

function platformMaySupport(value: PlatformRole[]) {
  return platformMayManage(value) || value.includes("support");
}

async function deterministicId(prefix: string, value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${prefix}_${hex.slice(0, 35 - prefix.length)}`;
}

function requireReauthentication(value: boolean | undefined) {
  if (!value) {
    throw new HttpError(
      403,
      "TOTP_REAUTH_REQUIRED",
      "Confirm a current authenticator code to continue.",
    );
  }
}

function storedCommandResult(action: string, result: unknown) {
  if (
    action === "createBetaAccessGrant" &&
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result)
  ) {
    const safe = { ...(result as Record<string, unknown>) };
    delete safe.code;
    return { ...safe, code: null, replayed: true };
  }
  if (
    action === "completeSelfServiceSetup" &&
    typeof result === "object" &&
    result !== null &&
    !Array.isArray(result)
  ) {
    const value = result as Record<string, unknown>;
    const invite =
      typeof value.invite === "object" &&
      value.invite !== null &&
      !Array.isArray(value.invite)
        ? (value.invite as Record<string, unknown>)
        : null;
    return {
      ...value,
      ...(invite
        ? {
            invite: {
              id: invite.id,
              expiresAt: invite.expiresAt,
            },
          }
        : {}),
    };
  }
  return result;
}

function pairingCode(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

async function queueNotification(
  store: RecordStore,
  input: {
    organizationId?: string;
    workspaceId?: string;
    userId?: string;
    email?: string;
    kind: string;
    subjectId: string;
    payload?: Record<string, unknown>;
    idempotencyKey: string;
  },
) {
  const id = await deterministicId("notice", input.idempotencyKey);
  const storedIdempotencyKey =
    input.idempotencyKey.length <= 128
      ? input.idempotencyKey
      : await deterministicId("notice-key", input.idempotencyKey);
  const notificationPayload = { ...(input.payload ?? {}) };
  if (typeof notificationPayload.credential === "string") {
    notificationPayload.credentialEnvelope =
      await encryptNotificationCredential(notificationPayload.credential, {
        kind: input.kind,
        subjectId: input.subjectId,
        email: input.email,
      });
    delete notificationPayload.credential;
  }
  await store.upsert(
    TABLES.notificationDeliveries,
    id,
    rowData(
      {
        organization_id: input.organizationId ?? null,
        workspace_id: input.workspaceId ?? null,
        user_id: input.userId ?? null,
        email: input.email ?? null,
        kind: input.kind,
        subject_id: input.subjectId,
        status: "queued",
        scheduled_at: nowIso(),
        idempotency_key: storedIdempotencyKey,
      },
      notificationPayload,
    ),
  );
}

export class CommandService {
  private readonly access: AccessService;

  constructor(
    private readonly store: RecordStore,
    private readonly objects?: PrivateObjectStore,
  ) {
    this.access = new AccessService(store);
  }

  async execute(
    identity: AuthenticatedIdentity,
    action: string,
    payload: Record<string, unknown>,
    options: CommandOptions,
  ): Promise<unknown> {
    const idempotencyKey = inputText(
      options.idempotencyKey,
      "Idempotency key",
      {
        min: 16,
        max: 128,
      },
    );
    const scope =
      typeof payload.workspaceId === "string"
        ? payload.workspaceId
        : typeof payload.targetWorkspaceId === "string"
          ? payload.targetWorkspaceId
          : identity.userId;
    const idempotencyId = await deterministicId(
      "idem",
      `${scope}:${identity.userId}:${action}:${idempotencyKey}`,
    );
    const conflictAttempts = new Set([
      "completeProvisioningRun",
      "completeSelfServiceSetup",
    ]).has(action)
      ? 3
      : 1;
    for (let attempt = 0; attempt < conflictAttempts; attempt += 1) {
      try {
        return await this.store.transaction(async (transaction) => {
          const existing = await transaction.get(
            TABLES.idempotencyKeys,
            idempotencyId,
          );
          if (existing) {
            const replay = decodePayload<{ result?: unknown }>(existing, {});
            return replay.result;
          }
          const scoped = new CommandService(transaction, this.objects);
          const result = await scoped.handle(
            identity,
            action,
            payload,
            options,
          );
          const resultRecord =
            typeof result === "object" &&
            result !== null &&
            !Array.isArray(result)
              ? (result as Record<string, unknown>)
              : null;
          let storedWorkspaceId =
            typeof payload.workspaceId === "string"
              ? payload.workspaceId
              : typeof payload.targetWorkspaceId === "string"
                ? payload.targetWorkspaceId
                : typeof resultRecord?.workspaceId === "string"
                  ? resultRecord.workspaceId
                  : null;
          let storedOrganizationId =
            typeof resultRecord?.organizationId === "string"
              ? resultRecord.organizationId
              : null;
          // Deletion approval results intentionally expose only the case ID.
          // Bind their idempotency record to the tenant using the still-live
          // case row so the later approved purge removes the replay record too.
          if (
            action === "approveDeletionCase" &&
            typeof payload.caseId === "string"
          ) {
            const lifecycleCase = await transaction.get(
              TABLES.lifecycleCases,
              payload.caseId,
            );
            if (typeof lifecycleCase?.workspace_id === "string") {
              storedWorkspaceId = lifecycleCase.workspace_id;
            }
            if (typeof lifecycleCase?.organization_id === "string") {
              storedOrganizationId = lifecycleCase.organization_id;
            }
          }
          if (storedWorkspaceId && !storedOrganizationId) {
            const workspace = await transaction.get(
              TABLES.workspaces,
              storedWorkspaceId,
            );
            if (typeof workspace?.organization_id === "string") {
              storedOrganizationId = workspace.organization_id;
            }
          }
          await transaction.create(
            TABLES.idempotencyKeys,
            idempotencyId,
            rowData(
              {
                organization_id: storedOrganizationId,
                workspace_id: storedWorkspaceId,
                user_id: identity.userId,
                status: "completed",
                kind: action,
                idempotency_key: idempotencyKey,
                request_id: options.requestId,
                expires_at: new Date(
                  Date.now() + 24 * 60 * 60 * 1_000,
                ).toISOString(),
                created_by: identity.userId,
              },
              { result: storedCommandResult(action, result) },
            ),
          );
          return result;
        });
      } catch (error) {
        if (error instanceof EntitlementDeniedError) {
          const blockedWorkspaceId =
            typeof payload.workspaceId === "string"
              ? payload.workspaceId
              : typeof payload.targetWorkspaceId === "string"
                ? payload.targetWorkspaceId
                : null;
          if (blockedWorkspaceId) {
            await recordEntitlementBlocked(
              this.store,
              blockedWorkspaceId,
              error.entitlementKind,
            );
          }
        }
        if (!(error instanceof RecordConflictError)) throw error;
        const committed = await this.store.get(
          TABLES.idempotencyKeys,
          idempotencyId,
        );
        if (committed?.status === "completed") {
          const replay = decodePayload<{ result?: unknown }>(committed, {});
          return replay.result;
        }
        if (attempt === conflictAttempts - 1) throw error;
        // Appwrite transactions use optimistic concurrency. A provisioning
        // completion can begin immediately after the preceding draft save, so
        // allow the prior commit to settle before rebuilding the atomic write.
        await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
      }
    }
    throw new Error("Provisioning command retry loop exhausted.");
  }

  private async platformRoles(identity: AuthenticatedIdentity) {
    return this.access.platformRoles(identity.userId);
  }

  private async createAppointment(
    identity: AuthenticatedIdentity,
    workspace: WorkspaceRecord,
    workspaceId: string,
    email: string,
    options: CommandOptions,
    appointmentAccess: {
      organizationRoles?: OrganizationRole[];
      workspaceAdministrator?: boolean;
    } = { workspaceAdministrator: true },
  ) {
    const appointmentId = resourceId("appoint");
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 14 * 24 * 60 * 60;
    const token = await signAppointmentToken({
      jti: appointmentId,
      workspaceId,
      email,
      expiresAt: expiresAtSeconds,
    });
    const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
    await this.store.create(
      TABLES.initialAdminAppointments,
      appointmentId,
      rowData(
        {
          organization_id: workspace.organizationId,
          workspace_id: workspaceId,
          email,
          subject_id: await hashToken(token),
          status: "active",
          expires_at: expiresAt,
          created_by: identity.userId,
          request_id: options.requestId,
        },
        {
          email,
          createdAt: nowIso(),
          organizationRoles: appointmentAccess.organizationRoles ?? [],
          workspaceAdministrator:
            appointmentAccess.workspaceAdministrator ?? true,
        },
      ),
    );
    const organizationRow = await this.store.get(
      TABLES.organizations,
      workspace.organizationId,
    );
    const organizationName = organizationRow
      ? decodePayload<OrganizationRecord>(organizationRow, null as never)
          .displayName
      : workspace.name;
    await queueNotification(this.store, {
      organizationId: workspace.organizationId,
      workspaceId,
      email,
      kind: "administrator.appointed",
      subjectId: appointmentId,
      idempotencyKey: `${options.idempotencyKey}:appointment:${workspaceId}:${email}:${appointmentId}`,
      payload: {
        expiresAt,
        credential: token,
        organizationRoles: appointmentAccess.organizationRoles ?? [],
        workspaceAdministrator:
          appointmentAccess.workspaceAdministrator ?? true,
        organizationName,
        workspaceName: workspace.name,
      },
    });
    return { appointmentId, token, expiresAt };
  }

  private async createSelfServiceInvite(
    identity: AuthenticatedIdentity,
    input: { organizationId: string; workspaceId: string; email: string },
    options: CommandOptions,
  ) {
    const invitationId = resourceId("invite");
    const expiresAtSeconds = Math.floor(Date.now() / 1_000) + 14 * 24 * 60 * 60;
    const token = await signInviteToken({
      jti: invitationId,
      workspaceId: input.workspaceId,
      role: "viewer",
      email: input.email,
      expiresAt: expiresAtSeconds,
    });
    const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
    await this.store.create(
      TABLES.invitations,
      invitationId,
      rowData(
        {
          organization_id: input.organizationId,
          workspace_id: input.workspaceId,
          email: input.email,
          subject_id: await hashToken(token),
          status: "active",
          kind: "viewer",
          expires_at: expiresAt,
          created_by: identity.userId,
          request_id: options.requestId,
        },
        {
          label: `Invite ${input.email}`,
          role: "viewer",
          maxUses: 1,
          useCount: 0,
          createdAt: nowIso(),
          source: "self_service_setup",
        },
      ),
    );
    const workspaceRow = await this.store.get(
      TABLES.workspaces,
      input.workspaceId,
    );
    const workspaceName = workspaceRow
      ? decodePayload<WorkspaceRecord>(workspaceRow, null as never).name
      : "your KnowHow workspace";
    await queueNotification(this.store, {
      organizationId: input.organizationId,
      workspaceId: input.workspaceId,
      email: input.email,
      kind: "invitation.created",
      subjectId: invitationId,
      idempotencyKey: `${options.idempotencyKey}:self-service-invitation`,
      payload: { expiresAt, credential: token, workspaceName },
    });
    return {
      id: invitationId,
      inviteUrl: `/app?invite=${encodeURIComponent(token)}`,
      expiresAt,
    };
  }

  private async handle(
    identity: AuthenticatedIdentity,
    action: string,
    payload: Record<string, unknown>,
    options: CommandOptions,
  ): Promise<unknown> {
    if (action === "updateTheme") {
      const theme = inputText(payload.theme, "Theme", { min: 4, max: 6 });
      if (!new Set(["light", "dark", "system"]).has(theme)) {
        throw new HttpError(
          400,
          "THEME_INVALID",
          "Theme must be light, dark, or system.",
        );
      }
      await this.store.upsert(
        TABLES.userPreferences,
        identity.userId,
        rowData(
          {
            user_id: identity.userId,
            status: "active",
            updated_by: identity.userId,
          },
          { theme },
        ),
      );
      return { theme };
    }

    if (action === "createBetaAccessGrant") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const label =
        payload.label === undefined
          ? undefined
          : inputText(payload.label, "Grant label", { max: 128 });
      const exactEmail =
        payload.email === undefined ? undefined : inputEmail(payload.email);
      const expiresAt = inputText(payload.expiresAt, "Grant expiry", {
        min: 20,
        max: 40,
      });
      const maxUses = inputInteger(payload.maxUses, "Maximum uses", 1, 10_000);
      return new BetaAccessService(this.store).createGrant({
        actorUserId: identity.userId,
        label,
        exactEmail,
        expiresAt,
        maxUses,
        requestId: options.requestId,
      });
    }

    if (action === "revokeBetaAccessGrant") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const grantId = inputText(payload.grantId, "Beta access grant", {
        min: 1,
        max: 36,
      });
      const grant = await new BetaAccessService(this.store).revokeGrant({
        grantId,
        actorUserId: identity.userId,
        requestId: options.requestId,
      });
      return { grant };
    }

    if (action === "updateLead" || action === "convertLead") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      const leadId = inputText(payload.leadId, "Lead", { min: 1, max: 36 });
      const row = await this.store.get(TABLES.leads, leadId);
      if (!row) throw new HttpError(404, "LEAD_NOT_FOUND", "Lead not found.");
      const details = decodePayload<{
        kind?: string;
        name?: string;
        email?: string;
        organization?: string;
        role?: string;
        teamSize?: number;
        country?: string;
        workflow?: string;
        ordinaryDataOnly?: boolean;
        occurredAt?: string;
        notes?: string;
        ownerLabel?: string;
        convertedRunId?: string;
      }>(row, {});
      if (action === "convertLead") {
        if (details.convertedRunId) {
          return { runId: details.convertedRunId, converted: true };
        }
        const country =
          typeof details.country === "string" && details.country.trim().length === 2
            ? details.country.trim().toUpperCase()
            : "QA";
        const runId = resourceId("provision");
        const createdAt = nowIso();
        const stepOne = {
          legalName: inputText(
            details.organization || details.name || "New organization",
            "Legal name",
            { min: 2, max: 200 },
          ),
          displayName: inputText(
            details.organization || details.name || "New organization",
            "Display name",
            { min: 2, max: 128 },
          ),
          primaryContactName: inputText(
            details.name || "Primary contact",
            "Primary contact",
            { min: 2, max: 128 },
          ),
          primaryContactEmail: inputEmail(details.email || row.email),
          country,
        };
        await this.store.create(
          TABLES.provisioningRuns,
          runId,
          rowData(
            {
              user_id: identity.userId,
              status: "draft",
              kind: "organization",
              sequence: 1,
              request_id: options.requestId,
              created_by: identity.userId,
            },
            {
              steps: { "1": stepOne },
              completedSteps: [],
              currentStep: 1,
              createdAt,
              updatedAt: createdAt,
              sourceLeadId: leadId,
            },
          ),
        );
        await this.store.update(
          TABLES.leads,
          leadId,
          rowData(
            {
              status: "converted",
              updated_by: identity.userId,
            },
            {
              ...details,
              notes: details.notes ?? "",
              convertedRunId: runId,
            },
          ),
        );
        return { runId, converted: true };
      }
      const statuses = new Set([
        "new",
        "qualified",
        "waiting",
        "converted",
        "rejected",
        "closed",
      ]);
      const status = payload.status
        ? inputText(payload.status, "Lead status", { min: 3, max: 16 })
        : stringValue(row.status, "new");
      if (!statuses.has(status)) {
        throw new HttpError(400, "LEAD_STATUS_INVALID", "Lead status is invalid.");
      }
      const notes =
        payload.notes === undefined
          ? (details.notes ?? "")
          : inputText(payload.notes, "Notes", { max: 4_000, optional: true });
      const ownerLabel =
        payload.ownerLabel === undefined
          ? (details.ownerLabel ?? "")
          : inputText(payload.ownerLabel, "Owner", { max: 128, optional: true });
      await this.store.update(
        TABLES.leads,
        leadId,
        rowData(
          { status, updated_by: identity.userId },
          { ...details, notes, ownerLabel },
        ),
      );
      return { leadId, status, notes, ownerLabel };
    }

    if (action === "updateOrganizationRecord") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      const organizationId = inputText(payload.organizationId, "Organization", {
        min: 1,
        max: 36,
      });
      const row = await this.store.get(TABLES.organizations, organizationId);
      if (!row) {
        throw new HttpError(404, "ORGANIZATION_NOT_FOUND", "Organization not found.");
      }
      const current = decodePayload<OrganizationRecord>(row, null as never);
      const next: OrganizationRecord = {
        ...current,
        legalName: payload.legalName
          ? inputText(payload.legalName, "Legal name", { min: 2, max: 200 })
          : current.legalName,
        displayName: payload.displayName
          ? inputText(payload.displayName, "Display name", { min: 2, max: 128 })
          : current.displayName,
        primaryContactName: payload.primaryContactName
          ? inputText(payload.primaryContactName, "Primary contact", {
              min: 2,
              max: 128,
            })
          : current.primaryContactName,
        primaryContactEmail: payload.primaryContactEmail
          ? inputEmail(payload.primaryContactEmail)
          : current.primaryContactEmail,
        country: payload.country
          ? inputText(payload.country, "Country", { min: 2, max: 2 }).toUpperCase()
          : current.country,
        internalNotes:
          payload.internalNotes === undefined
            ? current.internalNotes
            : inputText(payload.internalNotes, "Notes", {
                max: 4_000,
                optional: true,
              }),
        ownerLabel:
          payload.ownerLabel === undefined
            ? current.ownerLabel
            : inputText(payload.ownerLabel, "Owner", {
                max: 128,
                optional: true,
              }),
        accountTags:
          payload.accountTags === undefined
            ? current.accountTags
            : inputStringList(payload.accountTags, "Account tags", 8, 32).map(
                (tag) => {
                  if (!isAccountTag(tag)) {
                    throw new HttpError(
                      400,
                      "ACCOUNT_TAG_INVALID",
                      "Account tag is invalid.",
                    );
                  }
                  return tag;
                },
              ),
      };
      await this.store.update(
        TABLES.organizations,
        organizationId,
        rowData(
          {
            status: row.status ?? current.status,
            updated_by: identity.userId,
          },
          next,
        ),
      );
      return { organizationId };
    }

    if (action === "saveSelfServiceSetup") {
      const service = new SelfServiceProvisioningService(
        this.store,
        new BetaAccessService(this.store),
      );
      return service.save(identity, payload as SelfServiceSetupInput, {
        requestId: options.requestId,
      });
    }

    if (action === "completeSelfServiceSetup") {
      const service = new SelfServiceProvisioningService(
        this.store,
        new BetaAccessService(this.store),
      );
      return service.complete(identity, payload as SelfServiceSetupInput, {
        requestId: options.requestId,
        reauthenticated: options.reauthenticated,
        createInvite: (input) =>
          this.createSelfServiceInvite(identity, input, options),
      });
    }

    if (action === "saveProvisioningRun") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      const step = inputInteger(payload.step, "Provisioning step", 1, 6);
      const data = provisioningStep(
        step,
        inputObject(payload.data, "Provisioning data"),
      );
      const requestedId = payload.runId
        ? inputText(payload.runId, "Provisioning run", { min: 1, max: 36 })
        : null;
      const runId = requestedId ?? resourceId("provision");
      const existing = requestedId
        ? await this.store.get(TABLES.provisioningRuns, runId)
        : null;
      if (
        requestedId &&
        (!existing ||
          existing.created_by !== identity.userId ||
          existing.status !== "draft")
      ) {
        throw new HttpError(
          404,
          "PROVISIONING_RUN_NOT_FOUND",
          "Provisioning draft not found.",
        );
      }
      const current = existing
        ? decodePayload<{
            steps?: Record<string, unknown>;
            completedSteps?: number[];
            createdAt?: string;
          }>(existing, {})
        : {};
      const completedSteps = [
        ...new Set([...(current.completedSteps ?? []), step]),
      ].sort((left, right) => left - right);
      const next = {
        steps: { ...(current.steps ?? {}), [String(step)]: data },
        completedSteps,
        currentStep: Math.min(6, step + 1),
        createdAt: current.createdAt ?? nowIso(),
        updatedAt: nowIso(),
      };
      if (existing) {
        await this.store.update(
          TABLES.provisioningRuns,
          runId,
          rowData(
            {
              status: "draft",
              sequence: next.currentStep,
              request_id: options.requestId,
              updated_by: identity.userId,
            },
            next,
          ),
        );
      } else {
        await this.store.create(
          TABLES.provisioningRuns,
          runId,
          rowData(
            {
              user_id: identity.userId,
              status: "draft",
              kind: "organization",
              sequence: next.currentStep,
              request_id: options.requestId,
              created_by: identity.userId,
            },
            next,
          ),
        );
      }
      return { runId, currentStep: next.currentStep, completedSteps };
    }

    if (action === "completeProvisioningRun") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const runId = inputText(payload.runId, "Provisioning run", {
        min: 1,
        max: 36,
      });
      const run = await this.store.get(TABLES.provisioningRuns, runId);
      const storedDraft = run
        ? decodePayload<{
            steps?: Record<string, Record<string, unknown>>;
            completedSteps?: number[];
          }>(run, {})
        : null;
      if (
        !run ||
        run.created_by !== identity.userId ||
        run.status !== "draft" ||
        !storedDraft?.steps
      ) {
        throw new HttpError(
          404,
          "PROVISIONING_RUN_NOT_FOUND",
          "Provisioning draft not found.",
        );
      }
      const finalStepData = payload.finalStepData
        ? provisioningStep(
            6,
            inputObject(payload.finalStepData, "Final provisioning step"),
          )
        : null;
      const storedSteps = storedDraft.steps;
      const draft: {
        steps: Record<string, Record<string, unknown>>;
        completedSteps: number[];
      } = {
        steps: finalStepData
          ? {
              ...storedSteps,
              "6": finalStepData as Record<string, unknown>,
            }
          : storedSteps,
        completedSteps: finalStepData
          ? [...new Set([...(storedDraft.completedSteps ?? []), 6])].sort(
              (left, right) => left - right,
            )
          : (storedDraft.completedSteps ?? []),
      };
      if (
        ![1, 2, 3, 4, 5, 6].every((step) =>
          draft.completedSteps?.includes(step),
        )
      ) {
        throw new HttpError(
          409,
          "PROVISIONING_INCOMPLETE",
          "Complete all six provisioning steps first.",
        );
      }
      const identityStep = draft.steps["1"];
      const brandingStep = draft.steps["2"];
      const workspaceStep = draft.steps["3"];
      const commercialStep = draft.steps["4"];
      const ownerStep = draft.steps["5"];
      const invitationStep = draft.steps["6"];
      const result = (await this.handle(
        identity,
        "provisionOrganization",
        {
          ...identityStep,
          ...commercialStep,
          ...ownerStep,
          ...invitationStep,
          branding: brandingStep,
          workspaces: workspaceStep.workspaces,
          provisioningRunId: runId,
        },
        options,
      )) as {
        organizationId: string;
        workspaceId: string;
        workspaces: unknown[];
      };
      await this.store.update(
        TABLES.provisioningRuns,
        runId,
        rowData(
          {
            organization_id: result.organizationId,
            workspace_id: result.workspaceId,
            status: "completed",
            sequence: 6,
            updated_by: identity.userId,
          },
          {
            ...draft,
            completedAt: nowIso(),
            result: {
              organizationId: result.organizationId,
              workspaceId: result.workspaceId,
            },
          },
        ),
      );
      return { ...result, runId };
    }

    if (action === "createWorkspace" || action === "provisionOrganization") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const name = inputText(
        payload.name ??
          payload.organizationName ??
          payload.displayName ??
          payload.legalName,
        "Organization name",
        { min: 2, max: 128 },
      );
      const displayName = inputText(
        payload.displayName ?? name,
        "Display name",
        { min: 2, max: 128 },
      );
      const administratorEmails = payload.initialOwnerEmails
        ? inputStringList(
            payload.initialOwnerEmails,
            "Initial owners",
            10,
            320,
          ).map((value) => inputEmail(value))
        : payload.administratorEmail
          ? [inputEmail(payload.administratorEmail)]
          : [];
      if (administratorEmails.length < 2) {
        throw new HttpError(
          400,
          "INITIAL_OWNERS_REQUIRED",
          "Provision at least two initial organization owners before pilot access.",
        );
      }
      const organizationId = resourceId("org");
      const organizationSlug = `${slugify(displayName)}-${organizationId.slice(-5)}`;
      const createdAt = nowIso();
      const organization: OrganizationRecord = {
        legalName: inputText(payload.legalName ?? name, "Legal name", {
          min: 2,
          max: 200,
        }),
        displayName,
        primaryContactName: inputText(
          payload.primaryContactName ?? displayName,
          "Primary contact",
          { min: 2, max: 128 },
        ),
        primaryContactEmail: inputEmail(
          payload.primaryContactEmail ?? administratorEmails[0],
        ),
        country: inputText(payload.country ?? "QA", "Country", {
          min: 2,
          max: 2,
        }).toUpperCase(),
        status: "active",
        createdAt,
      };
      await this.store.create(
        TABLES.organizations,
        organizationId,
        rowData(
          {
            slug: organizationSlug,
            status: "active",
            created_by: identity.userId,
          },
          organization,
        ),
      );
      const brandingInput = inputObject(payload.branding ?? {}, "Branding");
      const organizationAccent = inputText(
        brandingInput.accentColor ?? DEFAULT_WORKSPACE_SETTINGS.accentColor,
        "Organization accent",
        { min: 7, max: 7 },
      );
      if (!/^#[0-9a-f]{6}$/i.test(organizationAccent))
        throw new HttpError(
          400,
          "BRANDING_INVALID",
          "Organization branding is invalid.",
        );
      const logoMediaId = inputText(
        brandingInput.logoMediaId,
        "Organization logo",
        { min: 1, max: 36 },
      );
      const logoRow = await this.store.get(TABLES.privateMedia, logoMediaId);
      const provisioningRunId = inputText(
        payload.provisioningRunId,
        "Provisioning run",
        { min: 1, max: 36 },
      );
      if (
        !logoRow ||
        logoRow.workspace_id !== provisioningRunId ||
        logoRow.kind !== "provisioning-logo" ||
        logoRow.created_by !== identity.userId
      ) {
        throw new HttpError(
          409,
          "PROVISIONING_LOGO_INVALID",
          "Upload the organization logo in the provisioning wizard.",
        );
      }
      await this.store.update(
        TABLES.privateMedia,
        logoMediaId,
        rowData(
          {
            organization_id: organizationId,
            workspace_id: null,
            subject_id: organizationId,
            status: "ready",
            kind: "organization-logo",
            updated_by: identity.userId,
          },
          {
            ...decodePayload(logoRow, {}),
            organizationId,
            provisioningRunId: null,
          },
        ),
      );
      await this.store.create(
        TABLES.organizationBranding,
        resourceId("branding"),
        rowData(
          {
            organization_id: organizationId,
            status: "active",
            created_by: identity.userId,
          },
          {
            logoMediaId,
            accentColor: organizationAccent.toLowerCase(),
            updatedAt: createdAt,
          },
        ),
      );
      const workspaceInputs = Array.isArray(payload.workspaces)
        ? payload.workspaces.map((value) => inputObject(value, "Workspace"))
        : [
            {
              name: inputText(payload.workspaceName ?? name, "Workspace name", {
                min: 2,
                max: 128,
              }),
            },
          ];
      if (!workspaceInputs.length || workspaceInputs.length > 10) {
        throw new HttpError(
          400,
          "WORKSPACES_INVALID",
          "Provision between one and ten workspaces.",
        );
      }
      const created: Array<{
        workspaceId: string;
        appointments: Array<{ email: string; token: string }>;
      }> = [];
      for (const [
        workspaceIndex,
        workspaceInput,
      ] of workspaceInputs.entries()) {
        const workspaceName = inputText(workspaceInput.name, "Workspace name", {
          min: 2,
          max: 128,
        });
        const workspaceId = resourceId("workspace");
        const workspace: WorkspaceRecord = {
          organizationId,
          name: workspaceName,
          slug: `${slugify(workspaceName)}-${workspaceId.slice(-5)}`,
          status: "active",
          createdAt,
          auditSequence: 0,
          auditHash: "0".repeat(64),
        };
        await this.store.create(
          TABLES.workspaces,
          workspaceId,
          rowData(
            {
              organization_id: organizationId,
              slug: workspace.slug,
              status: "active",
              created_by: identity.userId,
            },
            workspace,
          ),
        );
        await this.store.create(
          TABLES.workspaceSettings,
          resourceId("settings"),
          rowData(
            {
              organization_id: organizationId,
              workspace_id: workspaceId,
              status: "active",
              created_by: identity.userId,
            },
            {
              ...DEFAULT_WORKSPACE_SETTINGS,
              logoUrl: logoMediaId,
              accentColor: workspaceInput.accentColor
                ? inputText(workspaceInput.accentColor, "Workspace accent", {
                    min: 7,
                    max: 7,
                  })
                : organizationAccent.toLowerCase(),
            },
          ),
        );
        const pilotStart =
          typeof payload.pilotStart === "string"
            ? new Date(payload.pilotStart)
            : new Date();
        const pilotEnd =
          typeof payload.pilotEnd === "string"
            ? new Date(payload.pilotEnd)
            : new Date(pilotStart.getTime() + 30 * 24 * 60 * 60 * 1_000);
        if (
          !Number.isFinite(pilotStart.getTime()) ||
          !Number.isFinite(pilotEnd.getTime()) ||
          pilotEnd <= pilotStart
        ) {
          throw new HttpError(
            400,
            "PILOT_DATES_INVALID",
            "Pilot dates are invalid.",
          );
        }
        await this.store.create(
          TABLES.subscriptions,
          resourceId("subscription"),
          rowData(
            {
              organization_id: organizationId,
              workspace_id: workspaceId,
              status: "active",
              kind: "design_partner",
              created_by: identity.userId,
            },
            {
              kind: "design_partner",
              plan: "enterprise",
              status: "active",
              startsAt: pilotStart.toISOString(),
              expiresAt: pilotEnd.toISOString(),
              graceDays: 7,
              retentionDays: 90,
              publicTrial: false,
              manualContract: true,
            },
          ),
        );
        const configuredEntitlements = inputObject(
          payload.entitlements ?? {},
          "Entitlements",
        );
        const entitlements = {
          maximumUsers: inputInteger(
            configuredEntitlements.maximumUsers ?? 100,
            "Maximum users",
            1,
            100,
          ),
          maximumCreators: inputInteger(
            configuredEntitlements.maximumCreators ?? 25,
            "Maximum creators",
            1,
            100,
          ),
          storageBytes: inputInteger(
            configuredEntitlements.storageBytes ?? 5_000_000_000,
            "Storage limit",
            1_000_000,
            Number.MAX_SAFE_INTEGER,
          ),
          extensionEnabled: true,
          desktopCaptureEnabled: true,
          supportEnabled: true,
          removeBranding: false,
          privacyToolsEnabled: true,
          customSubdomainEnabled: true,
          fileExportsEnabled: true,
          publicSignup: false,
          payments: false,
          ssoScim: false,
        };
        for (const [kind, value] of Object.entries(entitlements)) {
          await this.store.create(
            TABLES.entitlements,
            resourceId("entitle"),
            rowData(
              {
                organization_id: organizationId,
                workspace_id: workspaceId,
                kind,
                status: "active",
                created_by: identity.userId,
              },
              { value },
            ),
          );
        }
        const appointments: Array<{ email: string; token: string }> = [];
        const selectedAdministrators = inputStringList(
          workspaceInput.administratorEmails ?? [],
          "Workspace administrators",
          10,
          320,
        ).map((value) => inputEmail(value));
        const appointmentEmails = [
          ...new Set([
            ...selectedAdministrators,
            ...(workspaceIndex === 0 ? administratorEmails : []),
          ]),
        ];
        if (!selectedAdministrators.length) {
          throw new HttpError(
            400,
            "WORKSPACE_ADMINISTRATOR_REQUIRED",
            "Select at least one administrator for each workspace.",
          );
        }
        for (const email of appointmentEmails) {
          const organizationOwner =
            workspaceIndex === 0 && administratorEmails.includes(email);
          const appointment = await this.createAppointment(
            identity,
            workspace,
            workspaceId,
            email,
            options,
            {
              organizationRoles: organizationOwner ? ["owner"] : [],
              workspaceAdministrator: selectedAdministrators.includes(email),
            },
          );
          appointments.push({ email, token: appointment.token });
        }
        await appendAudit(this.store, identity, workspaceId, {
          action: "workspace.provisioned",
          targetType: "workspace",
          targetId: workspaceId,
          targetLabel: workspaceName,
          summary: `${workspaceName} provisioned for a controlled pilot`,
          metadata: {
            initialOwnerCount: administratorEmails.length,
            pilotDays: Math.ceil(
              (pilotEnd.getTime() - pilotStart.getTime()) /
                (24 * 60 * 60 * 1_000),
            ),
          },
        });
        created.push({ workspaceId, appointments });
      }
      const invitationResults: Array<{
        email: string;
        workspaceId: string;
        token: string;
        role: WorkspaceRole;
      }> = [];
      const teamInvitations = Array.isArray(payload.teamInvitations)
        ? payload.teamInvitations
        : [];
      for (const rawInvitation of teamInvitations) {
        const invitation = inputObject(rawInvitation, "Team invitation");
        const email = inputEmail(invitation.email);
        const workspaceIndex = inputInteger(
          invitation.workspaceIndex ?? 0,
          "Workspace selection",
          0,
          created.length - 1,
        );
        const inviteRole = role(invitation.role ?? "viewer", true);
        const workspaceId = created[workspaceIndex].workspaceId;
        const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
        const workspaceName = workspaceRow
          ? decodePayload<WorkspaceRecord>(workspaceRow, null as never).name
          : "KnowHow workspace";
        const invitationId = resourceId("invite");
        const expiresAtSeconds =
          Math.floor(Date.now() / 1_000) + 14 * 24 * 60 * 60;
        const token = await signInviteToken({
          jti: invitationId,
          workspaceId,
          role: inviteRole as Exclude<WorkspaceRole, "administrator">,
          email,
          expiresAt: expiresAtSeconds,
        });
        const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
        await this.store.create(
          TABLES.invitations,
          invitationId,
          rowData(
            {
              organization_id: organizationId,
              workspace_id: workspaceId,
              email,
              subject_id: await hashToken(token),
              status: "active",
              kind: inviteRole,
              expires_at: expiresAt,
              created_by: identity.userId,
            },
            {
              label: `Initial team invitation for ${email}`,
              role: inviteRole,
              maxUses: 1,
              useCount: 0,
              createdAt,
            },
          ),
        );
        await queueNotification(this.store, {
          organizationId,
          workspaceId,
          email,
          kind: "invitation.created",
          subjectId: invitationId,
          idempotencyKey: `${options.idempotencyKey}:team:${workspaceIndex}:${email}`,
          payload: { expiresAt, credential: token, workspaceName },
        });
        invitationResults.push({ email, workspaceId, token, role: inviteRole });
      }
      return {
        organizationId,
        workspaceId: created[0].workspaceId,
        workspaces: created,
        invitations: invitationResults,
      };
    }

    if (action === "requestSupportAccess") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMaySupport(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_SUPPORT_REQUIRED",
          "Platform support access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const workspaceId = inputText(payload.workspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
      if (!workspaceRow || workspaceRow.status !== "active") {
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      }
      const [permanentMembership, activeGrant] = await Promise.all([
        this.store.list(TABLES.workspaceMembers, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "user_id", value: identity.userId },
          ],
          limit: 1,
        }),
        this.store.list(TABLES.supportGrants, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "user_id", value: identity.userId },
            { field: "status", value: "active" },
          ],
          limit: 1,
        }),
      ]);
      if (permanentMembership.length) {
        throw new HttpError(
          409,
          "SUPPORT_MEMBERSHIP_CONFLICT",
          "A permanent workspace member cannot request temporary support access.",
        );
      }
      if (activeGrant.length) {
        throw new HttpError(
          409,
          "SUPPORT_GRANT_ACTIVE",
          "Support access is already active.",
        );
      }
      const pending = await this.store.list(TABLES.supportCases, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
          { field: "status", value: "pending" },
        ],
        limit: 1,
      });
      if (pending.length)
        throw new HttpError(
          409,
          "SUPPORT_REQUEST_PENDING",
          "A support request is already pending.",
        );
      const requestedRole = role(payload.requestedRole);
      const requestedDurationHours = inputInteger(
        payload.requestedDurationHours,
        "Duration",
        1,
        24,
      );
      const reason = inputText(payload.reason, "Reason", {
        min: 10,
        max: 2_000,
      });
      const id = resourceId("support");
      await this.store.create(
        TABLES.supportCases,
        id,
        rowData(
          {
            organization_id: stringValue(workspaceRow.organization_id),
            workspace_id: workspaceId,
            user_id: identity.userId,
            email: identity.email,
            status: "pending",
            kind: "exceptional_access",
            request_id: options.requestId,
            created_by: identity.userId,
          },
          {
            requesterEmail: identity.email,
            requesterName: identity.name,
            requestedRole,
            requestedDurationHours,
            reason,
            grantedRole: null,
          } satisfies Partial<SupportAccessRequest>,
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "support.requested",
        targetType: "support-case",
        targetId: id,
        summary: "Temporary support access requested",
        metadata: { requestedRole, requestedDurationHours },
      });
      await queueNotification(this.store, {
        organizationId: stringValue(workspaceRow.organization_id),
        workspaceId,
        kind: "support.approval_requested",
        subjectId: id,
        idempotencyKey: `${options.idempotencyKey}:notify`,
        payload: { requestedRole, requestedDurationHours },
      });
      return { requested: true, requestId: id };
    }

    if (action === "extendSubscription" || action === "convertSubscription") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const workspaceId = inputText(payload.targetWorkspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
      if (!workspaceRow)
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      const workspace = decodePayload<WorkspaceRecord>(
        workspaceRow,
        null as never,
      );
      const subscription = await subscriptionForWorkspace(
        this.store,
        workspaceId,
      );
      if (!subscription)
        throw new HttpError(
          404,
          "SUBSCRIPTION_NOT_FOUND",
          "Subscription not found.",
        );
      const current = subscription.value;
      const changedAt = nowIso();
      const reason = inputText(payload.reason, "Reason", { min: 8, max: 500 });
      let next: SubscriptionRecord;
      if (action === "extendSubscription") {
        const newExpiry = new Date(
          inputText(payload.expiresAt, "New expiry", { min: 20, max: 40 }),
        );
        const currentExpiry = current.expiresAt
          ? Date.parse(current.expiresAt)
          : 0;
        if (
          !Number.isFinite(newExpiry.getTime()) ||
          newExpiry.getTime() <= Math.max(Date.now(), currentExpiry)
        ) {
          throw new HttpError(
            400,
            "SUBSCRIPTION_EXTENSION_INVALID",
            "The new expiry must be later than the current expiry.",
          );
        }
        next = {
          ...current,
          status: "active",
          expiresAt: newExpiry.toISOString(),
          graceDays: inputInteger(
            payload.graceDays ?? current.graceDays,
            "Grace days",
            0,
            30,
          ),
          retentionDays: inputInteger(
            payload.retentionDays ?? current.retentionDays,
            "Retention days",
            30,
            365,
          ),
          extendedAt: changedAt,
        };
      } else {
        const manualReference = inputText(
          payload.manualReference,
          "Contract or invoice reference",
          { min: 3, max: 128 },
        );
        const expiresAt =
          payload.expiresAt == null
            ? null
            : new Date(
                inputText(payload.expiresAt, "Expiry", { min: 20, max: 40 }),
              ).toISOString();
        const requestedPlan: CommercialPlan = isCommercialPlan(payload.plan)
          ? payload.plan
          : payload.plan === "pro"
            ? "pro"
            : "enterprise";
        if (requestedPlan === "pro_trial") {
          throw new HttpError(
            400,
            "SUBSCRIPTION_PLAN_INVALID",
            "Use grant Pro trial to start or restart a trial.",
          );
        }
        const complimentary = payload.complimentary === true;
        next = {
          ...current,
          kind: subscriptionKindForPlan(requestedPlan),
          plan: requestedPlan,
          status: "active",
          expiresAt: requestedPlan === "free" ? null : expiresAt,
          publicTrial: false,
          manualContract: requestedPlan !== "free",
          complimentary,
          convertedAt: changedAt,
          ...(requestedPlan === "free"
            ? { trialConsumed: true, downgradedAt: changedAt, graceDays: 0 }
            : {}),
        };
        await applyPlanEntitlements(this.store, {
          organizationId: workspace.organizationId,
          workspaceId,
          actorUserId: identity.userId,
          entitlements: entitlementsForPlan(requestedPlan),
        });
        if (requestedPlan !== "free") {
          await this.store.create(
            TABLES.manualInvoices,
            resourceId("invoice"),
            rowData(
              {
                organization_id: workspace.organizationId,
                workspace_id: workspaceId,
                subject_id: subscription.row.$id,
                status: "recorded",
                kind: "manual",
                request_id: options.requestId,
                created_by: identity.userId,
              },
              {
                manualReference,
                recordedAt: changedAt,
                recordedBy: identity.userId,
                paymentCollectedByKnowHow: false,
                complimentary,
              },
            ),
          );
        }
      }
      await this.store.update(
        TABLES.subscriptions,
        subscription.row.$id,
        rowData(
          {
            organization_id: workspace.organizationId,
            workspace_id: workspaceId,
            status: next.status,
            kind: next.kind,
            updated_by: identity.userId,
          },
          next,
        ),
      );
      if (
        workspace.status === "suspended" &&
        workspace.suspensionReason === "lifecycle"
      ) {
        await this.store.update(
          TABLES.workspaces,
          workspaceId,
          rowData(
            {
              organization_id: workspace.organizationId,
              slug: workspace.slug,
              status: "active",
              updated_by: identity.userId,
            },
            { ...workspace, status: "active", suspensionReason: null },
          ),
        );
      }
      for (const lifecycleCase of await this.store.list(TABLES.lifecycleCases, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "status", value: "awaiting_approval" },
        ],
      })) {
        const details = decodePayload<LifecycleCaseRecord>(
          lifecycleCase,
          null as never,
        );
        await this.store.update(
          TABLES.lifecycleCases,
          lifecycleCase.$id,
          rowData(
            { status: "cancelled", updated_by: identity.userId },
            {
              ...details,
              status: "cancelled",
              cancelledAt: changedAt,
              cancelledBy: identity.userId,
            },
          ),
        );
      }
      await appendAudit(this.store, identity, workspaceId, {
        action:
          action === "extendSubscription"
            ? "subscription.extended"
            : "subscription.converted",
        targetType: "subscription",
        targetId: subscription.row.$id,
        summary:
          action === "extendSubscription"
            ? "Subscription expiry extended"
            : "Subscription converted by manual contract",
        metadata: {
          kind: next.kind,
          plan: next.plan ?? inferredCommercialPlan(next),
          expiresAt: next.expiresAt,
          reason,
        },
      });
      return {
        subscriptionId: subscription.row.$id,
        status: next.status,
        kind: next.kind,
        plan: next.plan ?? inferredCommercialPlan(next),
        expiresAt: next.expiresAt,
      };
    }

    if (action === "grantProTrial" || action === "updateEntitlementOverrides") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const workspaceId = inputText(payload.targetWorkspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
      if (!workspaceRow) {
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      }
      const workspace = decodePayload<WorkspaceRecord>(
        workspaceRow,
        null as never,
      );
      const subscription = await subscriptionForWorkspace(
        this.store,
        workspaceId,
      );
      if (!subscription) {
        throw new HttpError(
          404,
          "SUBSCRIPTION_NOT_FOUND",
          "Subscription not found.",
        );
      }
      const reason = inputText(payload.reason, "Reason", { min: 8, max: 500 });
      const changedAt = nowIso();
      if (action === "grantProTrial") {
        const storedPlan = inferredCommercialPlan(subscription.value);
        if (storedPlan !== "free" && storedPlan !== "pro_trial") {
          throw new HttpError(
            409,
            "PRO_TRIAL_NOT_AVAILABLE",
            "A Pro trial can only be granted from Free or an existing trial.",
          );
        }
        const days = inputInteger(
          payload.days ?? PRO_TRIAL_DAYS,
          "Trial days",
          1,
          90,
        );
        const expiresAt = new Date(
          Date.now() + days * 86_400_000,
        ).toISOString();
        const next: SubscriptionRecord = {
          ...subscription.value,
          plan: "pro_trial",
          kind: subscriptionKindForPlan("pro_trial"),
          status: "active",
          expiresAt,
          graceDays: 0,
          publicTrial: false,
          manualContract: false,
          complimentary: false,
          trialConsumed: true,
          extendedAt: changedAt,
        };
        await this.store.update(
          TABLES.subscriptions,
          subscription.row.$id,
          rowData(
            {
              organization_id: workspace.organizationId,
              workspace_id: workspaceId,
              status: next.status,
              kind: next.kind,
              updated_by: identity.userId,
            },
            next,
          ),
        );
        await applyPlanEntitlements(this.store, {
          organizationId: workspace.organizationId,
          workspaceId,
          actorUserId: identity.userId,
          entitlements: entitlementsForPlan("pro_trial"),
        });
        if (
          workspace.status === "suspended" &&
          workspace.suspensionReason === "lifecycle"
        ) {
          await this.store.update(
            TABLES.workspaces,
            workspaceId,
            rowData(
              {
                organization_id: workspace.organizationId,
                slug: workspace.slug,
                status: "active",
                updated_by: identity.userId,
              },
              { ...workspace, status: "active", suspensionReason: null },
            ),
          );
        }
        await appendAudit(this.store, identity, workspaceId, {
          action: "subscription.trial-granted",
          targetType: "subscription",
          targetId: subscription.row.$id,
          summary: `Pro trial granted for ${days} days`,
          metadata: { plan: "pro_trial", days, expiresAt, reason },
        });
        return { plan: "pro_trial", days, expiresAt };
      }

      const currentPlan = inferredCommercialPlan(subscription.value);
      if (currentPlan === "free") {
        throw new HttpError(
          409,
          "ENTITLEMENT_OVERRIDE_FROZEN",
          "Grant a Pro trial or convert the plan before overriding Free entitlements.",
        );
      }
      const overrides = payload.overrides;
      if (
        !Array.isArray(overrides) ||
        overrides.length === 0 ||
        overrides.length > 12
      ) {
        throw new HttpError(
          400,
          "ENTITLEMENT_OVERRIDE_INVALID",
          "Provide between 1 and 12 entitlement overrides.",
        );
      }
      const allowed = new Set<string>(OVERRIDABLE_ENTITLEMENTS);
      const kinds: string[] = [];
      for (const item of overrides) {
        const entry = inputObject(item, "Override");
        const kind = inputText(entry.kind, "Entitlement", {
          min: 3,
          max: 64,
        }) as OverridableEntitlement;
        if (!allowed.has(kind)) {
          throw new HttpError(
            400,
            "ENTITLEMENT_OVERRIDE_INVALID",
            "That entitlement cannot be overridden.",
          );
        }
        const expiresAt = inputText(entry.expiresAt, "Override expiry", {
          min: 20,
          max: 40,
        });
        if (
          !Number.isFinite(Date.parse(expiresAt)) ||
          Date.parse(expiresAt) <= Date.now()
        ) {
          throw new HttpError(
            400,
            "ENTITLEMENT_OVERRIDE_INVALID",
            "Override expiry must be in the future.",
          );
        }
        let value: EntitlementValue = false;
        if (kind === "maximumUsers" || kind === "maximumCreators") {
          value = inputInteger(entry.value, kind, 1, 10_000);
        } else if (kind === "storageBytes") {
          value = inputInteger(entry.value, kind, 1, 5_000_000_000_000);
        } else {
          value = inputBoolean(entry.value, kind);
        }
        const payloadValue: EntitlementOverridePayload = {
          value,
          source: "override",
          reason,
          expiresAt,
          grantedBy: identity.userId,
          grantedAt: changedAt,
        };
        const existing = await this.store.list(TABLES.entitlements, {
          filters: [
            { field: "workspace_id", value: workspaceId },
            { field: "kind", value: kind },
          ],
          limit: 1,
        });
        const fields = rowData(
          {
            organization_id: workspace.organizationId,
            workspace_id: workspaceId,
            kind,
            status: "active",
            updated_by: identity.userId,
          },
          payloadValue,
        );
        if (existing[0]) {
          await this.store.update(TABLES.entitlements, existing[0].$id, fields);
        } else {
          const id = await deterministicResourceId(
            "entitle",
            `${workspaceId}:${kind}`,
          );
          await this.store.create(TABLES.entitlements, id, {
            ...fields,
            created_by: identity.userId,
          });
        }
        kinds.push(kind);
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "entitlements.overridden",
        targetType: "entitlement",
        targetId: workspaceId,
        summary: "Operator entitlement override applied",
        metadata: { kinds, reason },
      });
      return { updated: kinds.length };
    }

    if (
      action === "createPricingCatalog" ||
      action === "updatePricingCatalog" ||
      action === "retirePricingCatalog"
    ) {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles)) {
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform owner or operations access is required to manage pricing.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const service = new PricingCatalogService(this.store);
      if (action === "createPricingCatalog") {
        const catalog = await service.create(
          identity.userId,
          inputObject(payload.catalog ?? payload, "Pricing catalog"),
        );
        return { catalog };
      }
      const catalogId = inputText(payload.catalogId, "Pricing catalog", {
        min: 1,
        max: 36,
      });
      const expectedRevision = inputInteger(
        payload.expectedRevision,
        "Catalog revision",
        1,
        2_147_483_647,
      );
      const catalog =
        action === "updatePricingCatalog"
          ? await service.update(
              identity.userId,
              catalogId,
              expectedRevision,
              inputObject(payload.catalog, "Pricing catalog"),
            )
          : await service.retire(identity.userId, catalogId, expectedRevision);
      return { catalog };
    }

    if (action === "approveDeletionCase") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformRoles.includes("owner")) {
        throw new HttpError(
          403,
          "PLATFORM_OWNER_REQUIRED",
          "A platform owner must approve tenant deletion.",
        );
      }
      requireReauthentication(options.reauthenticated);
      const caseId = inputText(payload.caseId, "Deletion case", {
        min: 1,
        max: 36,
      });
      const confirmation = inputText(
        payload.confirmation,
        "Typed confirmation",
        { min: 8, max: 256 },
      );
      const caseRow = await this.store.get(TABLES.lifecycleCases, caseId);
      const lifecycleCase = caseRow
        ? decodePayload<LifecycleCaseRecord>(caseRow, null as never)
        : null;
      if (
        !caseRow ||
        !lifecycleCase ||
        lifecycleCase.kind !== "tenant_deletion_approval" ||
        lifecycleCase.status !== "awaiting_approval"
      ) {
        throw new HttpError(
          409,
          "DELETION_CASE_UNAVAILABLE",
          "The deletion case is not awaiting approval.",
        );
      }
      if (!constantTimeEqual(confirmation, lifecycleCase.confirmationText)) {
        throw new HttpError(
          400,
          "DELETION_CONFIRMATION_INVALID",
          "The typed deletion confirmation does not match.",
        );
      }
      if (Date.parse(lifecycleCase.eligibleAt) > Date.now()) {
        throw new HttpError(
          409,
          "DELETION_NOT_ELIGIBLE",
          "The retention period has not ended.",
        );
      }
      const subscriptionRow = await this.store.get(
        TABLES.subscriptions,
        lifecycleCase.subscriptionId,
      );
      if (
        !subscriptionRow ||
        subscriptionRow.workspace_id !== caseRow.workspace_id
      ) {
        throw new HttpError(
          409,
          "SUBSCRIPTION_NOT_FOUND",
          "The deletion subscription is unavailable.",
        );
      }
      const subscription = decodePayload<SubscriptionRecord>(
        subscriptionRow,
        null as never,
      );
      const approvedAt = nowIso();
      await this.store.update(
        TABLES.lifecycleCases,
        caseId,
        rowData(
          {
            status: "approved",
            scheduled_at: approvedAt,
            updated_by: identity.userId,
          },
          {
            ...lifecycleCase,
            status: "approved",
            approvedAt,
            approvedBy: identity.userId,
          },
        ),
      );
      await this.store.update(
        TABLES.subscriptions,
        subscriptionRow.$id,
        rowData(
          { status: "deleting", updated_by: identity.userId },
          {
            ...subscription,
            status: "deleting",
            deletionApprovedAt: approvedAt,
          },
        ),
      );
      await appendAudit(this.store, identity, String(caseRow.workspace_id), {
        action: "deletion.approved",
        targetType: "lifecycle-case",
        targetId: caseId,
        summary: "Tenant deletion approved after retention",
        metadata: { approvedAt },
      });
      return { caseId, status: "approved", queuedForPurge: true };
    }

    if (action === "cancelSupportRequest") {
      const requestId = inputText(payload.requestId, "Support request", {
        min: 1,
        max: 36,
      });
      const request = await this.store.get(TABLES.supportCases, requestId);
      if (
        !request ||
        request.user_id !== identity.userId ||
        request.status !== "pending"
      ) {
        throw new HttpError(
          404,
          "SUPPORT_REQUEST_NOT_FOUND",
          "Support request not found.",
        );
      }
      await this.store.update(
        TABLES.supportCases,
        requestId,
        rowData(
          { status: "cancelled", updated_by: identity.userId },
          decodePayload(request, {}),
        ),
      );
      await appendAudit(
        this.store,
        identity,
        stringValue(request.workspace_id),
        {
          action: "support.cancelled",
          targetType: "support-case",
          targetId: requestId,
          summary: "Temporary support request cancelled",
        },
      );
      return { cancelled: true };
    }

    if (action === "acceptAppointment") {
      requireReauthentication(options.reauthenticated);
      const token = inputText(payload.token, "Appointment", {
        min: 20,
        max: 8_192,
      });
      const claims = await verifyAppointmentToken(token);
      if (claims.email !== identity.email) {
        throw new HttpError(
          403,
          "APPOINTMENT_EMAIL_MISMATCH",
          "This appointment belongs to another account.",
        );
      }
      const appointment = await this.store.get(
        TABLES.initialAdminAppointments,
        claims.jti,
      );
      const valid =
        appointment !== null &&
        appointment.status === "active" &&
        appointment.workspace_id === claims.workspaceId &&
        appointment.email === identity.email &&
        appointment.subject_id === (await hashToken(token)) &&
        Date.parse(String(appointment.expires_at)) > Date.now();
      if (!valid || !appointment)
        throw new HttpError(
          409,
          "APPOINTMENT_INVALID",
          "The appointment is invalid or expired.",
        );
      const appointmentDetails = decodePayload<{
        organizationOwner?: boolean;
        organizationRoles?: OrganizationRole[];
        workspaceAdministrator?: boolean;
      }>(appointment, {});
      const appointedOrganizationRoles = appointmentDetails.organizationRoles
        ?.length
        ? organizationRoles(appointmentDetails.organizationRoles)
        : appointmentDetails.organizationOwner
          ? (["owner"] satisfies OrganizationRole[])
          : [];
      const workspaceAdministrator =
        appointmentDetails.workspaceAdministrator ?? true;
      const workspaceRow = await this.store.get(
        TABLES.workspaces,
        claims.workspaceId,
      );
      if (!workspaceRow || workspaceRow.status !== "active")
        throw new HttpError(
          409,
          "WORKSPACE_NOT_ACTIVE",
          "The workspace is not active.",
        );
      const workspace = decodePayload<WorkspaceRecord>(
        workspaceRow,
        null as never,
      );
      const appointmentSubscription = await subscriptionForWorkspace(
        this.store,
        claims.workspaceId,
      );
      if (
        evaluateSubscription(appointmentSubscription?.value ?? null).access !==
        "active"
      ) {
        throw new HttpError(
          409,
          "SUBSCRIPTION_NOT_ACTIVE",
          "The workspace is not accepting administrator appointments.",
        );
      }
      if (workspaceAdministrator) {
        const existing = await this.store.list(TABLES.workspaceMembers, {
          filters: [
            { field: "workspace_id", value: claims.workspaceId },
            { field: "user_id", value: identity.userId },
          ],
          limit: 1,
        });
        const memberPayload: WorkspaceMemberRecord = {
          name: identity.name,
          roles: ["administrator"],
          capabilities: [],
          groupIds: [],
          joinedAt: nowIso(),
        };
        if (existing[0]) {
          const current = decodePayload<WorkspaceMemberRecord>(
            existing[0],
            memberPayload,
          );
          if (!current.roles.includes("administrator")) {
            await new EntitlementService(
              this.store,
              claims.workspaceId,
            ).assertCreatorCapacity(identity.userId);
          }
          await this.store.update(
            TABLES.workspaceMembers,
            existing[0].$id,
            rowData(
              {
                status: "active",
                email: identity.email,
                updated_by: identity.userId,
              },
              {
                ...current,
                roles: [...new Set([...current.roles, "administrator"])],
              },
            ),
          );
        } else {
          const entitlements = new EntitlementService(
            this.store,
            claims.workspaceId,
          );
          await entitlements.assertMemberCapacity();
          await entitlements.assertCreatorCapacity(identity.userId);
          await this.store.create(
            TABLES.workspaceMembers,
            resourceId("member"),
            rowData(
              {
                organization_id: workspace.organizationId,
                workspace_id: claims.workspaceId,
                user_id: identity.userId,
                email: identity.email,
                status: "active",
                created_by: identity.userId,
              },
              memberPayload,
            ),
          );
        }
      }
      const orgMembership = appointedOrganizationRoles.length
        ? await this.store.list(TABLES.organizationMemberships, {
            filters: [
              { field: "organization_id", value: workspace.organizationId },
              { field: "user_id", value: identity.userId },
            ],
            limit: 1,
          })
        : [];
      if (appointedOrganizationRoles.length && orgMembership[0]) {
        const current = decodePayload<{
          roles?: OrganizationRole[];
          name?: string;
        }>(orgMembership[0], {});
        await this.store.update(
          TABLES.organizationMemberships,
          orgMembership[0].$id,
          rowData(
            {
              status: "active",
              email: identity.email,
              updated_by: identity.userId,
            },
            {
              ...current,
              roles: [
                ...new Set([
                  ...(current.roles ?? []),
                  ...appointedOrganizationRoles,
                ]),
              ],
              name: identity.name,
            },
          ),
        );
      } else if (appointedOrganizationRoles.length) {
        await this.store.create(
          TABLES.organizationMemberships,
          resourceId("orgmember"),
          rowData(
            {
              organization_id: workspace.organizationId,
              user_id: identity.userId,
              email: identity.email,
              status: "active",
              created_by: identity.userId,
            },
            { roles: appointedOrganizationRoles, name: identity.name },
          ),
        );
      }
      await this.store.update(
        TABLES.initialAdminAppointments,
        appointment.$id,
        rowData(
          { status: "accepted", updated_by: identity.userId },
          {
            ...appointmentDetails,
            acceptedAt: nowIso(),
            acceptedBy: identity.userId,
          },
        ),
      );
      await appendAudit(this.store, identity, claims.workspaceId, {
        action: "appointment.accepted",
        targetType: "administrator-appointment",
        targetId: appointment.$id,
        summary: "Initial administrator appointment accepted",
      });
      return {
        workspaceId: claims.workspaceId,
        workspaceAccessGranted: workspaceAdministrator,
      };
    }

    if (action === "revokeAppointment") {
      const platformRoles = await this.platformRoles(identity);
      requireReauthentication(options.reauthenticated);
      const appointmentId = inputText(payload.appointmentId, "Appointment", {
        min: 1,
        max: 36,
      });
      const appointment = await this.store.get(
        TABLES.initialAdminAppointments,
        appointmentId,
      );
      if (!appointment || appointment.status !== "active")
        throw new HttpError(
          404,
          "APPOINTMENT_NOT_FOUND",
          "Appointment not found.",
        );
      const organizationId = stringValue(appointment.organization_id);
      const organizationAccess = organizationId
        ? await this.access.organizationRoles(organizationId, identity.userId)
        : [];
      if (
        !platformMayManage(platformRoles) &&
        !organizationAccess.includes("owner")
      ) {
        throw new HttpError(
          403,
          "APPOINTMENT_REVOKE_DENIED",
          "Platform operations or organization owner access is required.",
        );
      }
      await this.store.update(
        TABLES.initialAdminAppointments,
        appointmentId,
        rowData(
          { status: "revoked", updated_by: identity.userId },
          { ...decodePayload(appointment, {}), revokedAt: nowIso() },
        ),
      );
      await appendAudit(
        this.store,
        identity,
        stringValue(appointment.workspace_id),
        {
          action: "appointment.revoked",
          targetType: "administrator-appointment",
          targetId: appointmentId,
          summary: "Initial administrator appointment revoked",
        },
      );
      return { revoked: true };
    }

    if (action === "updatePlatformSettings") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles))
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      requireReauthentication(options.reauthenticated);
      const limit = inputInteger(
        payload.selfServiceWorkspaceLimit,
        "Self-service limit",
        1,
        100,
      );
      await this.store.upsert(
        TABLES.catalogItems,
        "platform_settings",
        rowData(
          {
            slug: "platform_settings",
            kind: "platform_settings",
            status: "active",
            updated_by: identity.userId,
          },
          { selfServiceWorkspaceLimit: limit, publicSignupEnabled: false },
        ),
      );
      return { selfServiceWorkspaceLimit: limit };
    }

    if (action === "setWorkspaceStatus") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles))
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      requireReauthentication(options.reauthenticated);
      const workspaceId = inputText(payload.targetWorkspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const status = inputText(payload.status, "Status", { min: 6, max: 9 });
      if (!new Set(["active", "suspended", "archived"]).has(status))
        throw new HttpError(
          400,
          "WORKSPACE_STATUS_INVALID",
          "Workspace status is invalid.",
        );
      const row = await this.store.get(TABLES.workspaces, workspaceId);
      if (!row)
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      const workspace = decodePayload<WorkspaceRecord>(row, null as never);
      await this.store.update(
        TABLES.workspaces,
        workspaceId,
        rowData(
          { status, updated_by: identity.userId },
          {
            ...workspace,
            status,
            suspensionReason: status === "suspended" ? "manual" : null,
          },
        ),
      );
      if (status !== "active") {
        for (const invitation of await this.store.list(TABLES.invitations, {
          filters: [{ field: "workspace_id", value: workspaceId }],
        })) {
          if (invitation.status === "active")
            await this.store.update(
              TABLES.invitations,
              invitation.$id,
              rowData(
                { status: "revoked", updated_by: identity.userId },
                decodePayload(invitation, {}),
              ),
            );
        }
        for (const device of await this.store.list(TABLES.extensionDevices, {
          filters: [{ field: "workspace_id", value: workspaceId }],
        })) {
          if (device.status === "active")
            await this.store.update(
              TABLES.extensionDevices,
              device.$id,
              rowData(
                { status: "revoked", updated_by: identity.userId },
                decodePayload(device, {}),
              ),
            );
        }
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "workspace.status_changed",
        targetType: "workspace",
        targetId: workspaceId,
        targetLabel: workspace.name,
        summary: `Workspace marked ${status}`,
        metadata: { status },
      });
      return { status };
    }

    if (action === "assignWorkspaceAdministrator") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles))
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      requireReauthentication(options.reauthenticated);
      const workspaceId = inputText(payload.targetWorkspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const email = inputEmail(payload.email);
      const row = await this.store.get(TABLES.workspaces, workspaceId);
      if (!row)
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      const workspace = decodePayload<WorkspaceRecord>(row, null as never);
      const appointment = await this.createAppointment(
        identity,
        workspace,
        workspaceId,
        email,
        options,
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "appointment.created",
        targetType: "administrator-appointment",
        targetId: appointment.appointmentId,
        summary: "Administrator appointment created",
      });
      return {
        assigned: false,
        appointmentId: appointment.appointmentId,
        appointmentToken: appointment.token,
      };
    }

    if (action === "appointOrganizationMember") {
      requireReauthentication(options.reauthenticated);
      const organizationId = inputText(payload.organizationId, "Organization", {
        min: 1,
        max: 36,
      });
      const callerRoles = await this.access.organizationRoles(
        organizationId,
        identity.userId,
      );
      if (!callerRoles.includes("owner")) {
        throw new HttpError(
          403,
          "ORGANIZATION_OWNER_REQUIRED",
          "Organization owner access is required.",
        );
      }
      const email = inputEmail(payload.email);
      const appointedRoles = organizationRoles(payload.roles);
      const workspaceId = inputText(payload.anchorWorkspaceId, "Workspace", {
        min: 1,
        max: 36,
      });
      const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
      const workspace = workspaceRow
        ? decodePayload<WorkspaceRecord>(workspaceRow, null as never)
        : null;
      if (
        !workspaceRow ||
        !workspace ||
        workspace.organizationId !== organizationId
      ) {
        throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      }
      const existingMember = await this.store.list(
        TABLES.organizationMemberships,
        {
          filters: [
            { field: "organization_id", value: organizationId },
            { field: "email", value: email },
            { field: "status", value: "active" },
          ],
          limit: 1,
        },
      );
      if (existingMember.length) {
        throw new HttpError(
          409,
          "ORGANIZATION_MEMBER_EXISTS",
          "This email already belongs to the organization.",
        );
      }
      const pending = await this.store.list(TABLES.initialAdminAppointments, {
        filters: [
          { field: "organization_id", value: organizationId },
          { field: "email", value: email },
          { field: "status", value: "active" },
        ],
        limit: 1,
      });
      if (pending.length) {
        throw new HttpError(
          409,
          "ORGANIZATION_APPOINTMENT_EXISTS",
          "A current appointment already exists for this email.",
        );
      }
      const appointment = await this.createAppointment(
        identity,
        workspace,
        workspaceId,
        email,
        options,
        { organizationRoles: appointedRoles, workspaceAdministrator: false },
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "organization.appointment-created",
        targetType: "organization-membership",
        targetId: appointment.appointmentId,
        summary: "Organization role appointment created",
        metadata: { roles: appointedRoles },
      });
      return {
        appointmentId: appointment.appointmentId,
        appointmentToken: appointment.token,
        expiresAt: appointment.expiresAt,
      };
    }

    if (action === "updateOrganizationMember") {
      requireReauthentication(options.reauthenticated);
      const organizationId = inputText(payload.organizationId, "Organization", {
        min: 1,
        max: 36,
      });
      const callerRoles = await this.access.organizationRoles(
        organizationId,
        identity.userId,
      );
      if (!callerRoles.includes("owner")) {
        throw new HttpError(
          403,
          "ORGANIZATION_OWNER_REQUIRED",
          "Organization owner access is required.",
        );
      }
      const memberId = inputText(payload.memberId, "Organization member", {
        min: 1,
        max: 36,
      });
      const memberRow = await this.store.get(
        TABLES.organizationMemberships,
        memberId,
      );
      if (!memberRow || memberRow.organization_id !== organizationId) {
        throw new HttpError(
          404,
          "ORGANIZATION_MEMBER_NOT_FOUND",
          "Organization member not found.",
        );
      }
      const current = decodePayload<{
        roles?: OrganizationRole[];
        name?: string;
      }>(memberRow, {});
      const nextRoles = organizationRoles(payload.roles);
      const status = payload.status === "revoked" ? "revoked" : "active";
      const activeOwners = (
        await this.store.list(TABLES.organizationMemberships, {
          filters: [
            { field: "organization_id", value: organizationId },
            { field: "status", value: "active" },
          ],
        })
      ).filter((row) =>
        decodePayload<{ roles?: OrganizationRole[] }>(row, {}).roles?.includes(
          "owner",
        ),
      );
      const targetRemainsOwner =
        status === "active" && nextRoles.includes("owner");
      const ownersAfterChange =
        activeOwners.filter((row) => row.$id !== memberId).length +
        (targetRemainsOwner ? 1 : 0);
      if (ownersAfterChange < 2) {
        throw new HttpError(
          409,
          "MINIMUM_ORGANIZATION_OWNERS",
          "Keep at least two active organization owners.",
        );
      }
      await this.store.update(
        TABLES.organizationMemberships,
        memberId,
        rowData(
          { status, updated_by: identity.userId },
          { ...current, roles: nextRoles, updatedAt: nowIso() },
        ),
      );
      const workspaceRows = await this.store.list(TABLES.workspaces, {
        filters: [{ field: "organization_id", value: organizationId }],
        limit: 1,
      });
      if (workspaceRows[0]) {
        await appendAudit(this.store, identity, workspaceRows[0].$id, {
          action: "organization.member-updated",
          targetType: "organization-membership",
          targetId: memberId,
          summary:
            status === "active"
              ? "Organization roles updated"
              : "Organization membership revoked",
          metadata: { roles: nextRoles, status },
        });
      }
      return { memberId, roles: nextRoles, status };
    }

    if (action === "redeemInvite") {
      const token = inputText(payload.token, "Invitation", {
        min: 20,
        max: 8_192,
      });
      const claims = await verifyInviteToken(token);
      if (claims.email && claims.email !== identity.email)
        throw new HttpError(
          403,
          "INVITATION_EMAIL_MISMATCH",
          "This invitation belongs to another account.",
        );
      const invitation = await this.store.get(TABLES.invitations, claims.jti);
      const details = invitation
        ? decodePayload<{
            role?: WorkspaceRole;
            maxUses?: number;
            useCount?: number;
          }>(invitation, {})
        : {};
      const valid =
        invitation !== null &&
        invitation.status === "active" &&
        invitation.workspace_id === claims.workspaceId &&
        typeof invitation.subject_id === "string" &&
        constantTimeEqual(invitation.subject_id, await hashToken(token)) &&
        Date.parse(String(invitation.expires_at)) > Date.now() &&
        details.role === claims.role &&
        Number(details.useCount ?? 0) < Number(details.maxUses ?? 1);
      if (!valid || !invitation)
        throw new HttpError(
          409,
          "INVITATION_INVALID",
          "The invitation is invalid or no longer active.",
        );
      const workspaceRow = await this.store.get(
        TABLES.workspaces,
        claims.workspaceId,
      );
      if (!workspaceRow || workspaceRow.status !== "active")
        throw new HttpError(
          409,
          "WORKSPACE_NOT_ACTIVE",
          "The workspace is not active.",
        );
      const workspace = decodePayload<WorkspaceRecord>(
        workspaceRow,
        null as never,
      );
      const subscription = await subscriptionForWorkspace(
        this.store,
        claims.workspaceId,
      );
      if (
        evaluateSubscription(subscription?.value ?? null).access !== "active"
      ) {
        throw new HttpError(
          409,
          "SUBSCRIPTION_NOT_ACTIVE",
          "The workspace is not accepting invitations.",
        );
      }
      const existing = await this.store.list(TABLES.workspaceMembers, {
        filters: [
          { field: "workspace_id", value: claims.workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 1,
      });
      if (!existing[0]) {
        await new EntitlementService(
          this.store,
          claims.workspaceId,
        ).assertMemberCapacity();
        await this.store.create(
          TABLES.workspaceMembers,
          resourceId("member"),
          rowData(
            {
              organization_id: workspace.organizationId,
              workspace_id: claims.workspaceId,
              user_id: identity.userId,
              email: identity.email,
              status: "active",
              created_by: identity.userId,
            },
            {
              name: identity.name,
              roles: [claims.role],
              capabilities: [],
              groupIds: [],
              joinedAt: nowIso(),
            } satisfies WorkspaceMemberRecord,
          ),
        );
      }
      const useCount = Number(details.useCount ?? 0) + 1;
      const maxUses = Number(details.maxUses ?? 1);
      await this.store.update(
        TABLES.invitations,
        invitation.$id,
        rowData(
          {
            status: useCount >= maxUses ? "exhausted" : "active",
            updated_by: identity.userId,
          },
          { ...details, useCount },
        ),
      );
      await appendAudit(this.store, identity, claims.workspaceId, {
        action: "invitation.accepted",
        targetType: "invitation",
        targetId: invitation.$id,
        summary: "Workspace invitation accepted",
        metadata: { role: claims.role },
      });
      return { workspaceId: claims.workspaceId };
    }

    if (action === "requestDomainJoin" || action === "resolveJoinRequest") {
      throw new HttpError(
        403,
        "INVITATION_ONLY",
        "Pilot access is invitation-only.",
      );
    }

    if (action === "sweepExpiredSupportAccess") {
      const platformRoles = await this.platformRoles(identity);
      if (!platformMayManage(platformRoles))
        throw new HttpError(
          403,
          "PLATFORM_OPERATIONS_REQUIRED",
          "Platform operations access is required.",
        );
      let expired = 0;
      for (const grant of await this.store.list(TABLES.supportGrants, {
        filters: [{ field: "status", value: "active" }],
      })) {
        if (Date.parse(String(grant.expires_at)) <= Date.now()) {
          const details = decodePayload<SupportGrantRecord>(
            grant,
            null as never,
          );
          await this.store.update(
            TABLES.supportGrants,
            grant.$id,
            rowData(
              { status: "expired", updated_by: identity.userId },
              { ...details, endedAt: nowIso() },
            ),
          );
          expired += 1;
        }
      }
      return { expired };
    }

    if (action === "replySupportTicket" || action === "closeSupportTicket") {
      const platformRoles = await this.platformRoles(identity);
      if (platformMaySupport(platformRoles)) {
        const ticketId = inputText(payload.ticketId, "Support ticket", {
          min: 1,
          max: 36,
        });
        const ticket = await this.store.get(TABLES.supportTickets, ticketId);
        if (!ticket) {
          throw new HttpError(
            404,
            "SUPPORT_TICKET_NOT_FOUND",
            "Support ticket not found.",
          );
        }
        const workspaceId = stringValue(ticket.workspace_id);
        const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
        const workspace = workspaceRow
          ? decodePayload<WorkspaceRecord>(workspaceRow, null as never)
          : null;
        if (!workspaceRow || !workspace) {
          throw new HttpError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
        }
        const ticketDetails = decodePayload<Record<string, unknown>>(ticket, {});
        const changedAt = nowIso();
        if (action === "closeSupportTicket") {
          await this.store.update(
            TABLES.supportTickets,
            ticketId,
            rowData(
              { status: "closed", updated_by: identity.userId },
              {
                ...ticketDetails,
                status: "closed",
                updatedAt: changedAt,
                closedAt: changedAt,
                closedBy: identity.userId,
              },
            ),
          );
          await appendAudit(this.store, identity, workspaceId, {
            action: "support.ticket-closed",
            targetType: "support-ticket",
            targetId: ticketId,
            summary: "In-app support ticket closed",
          });
          return { closed: true, workspaceId };
        }
        if (ticket.status === "closed") {
          throw new HttpError(
            409,
            "SUPPORT_TICKET_CLOSED",
            "This support ticket is closed.",
          );
        }
        const body = supportText(payload.message, "Support message", {
          min: 2,
          max: 4_000,
        });
        const messages = await this.store.list(TABLES.supportMessages, {
          filters: [{ field: "subject_id", value: ticketId }],
          orderBy: "sequence",
          order: "desc",
          limit: 1,
        });
        const sequence = Number(messages[0]?.sequence ?? 0) + 1;
        await this.store.create(
          TABLES.supportMessages,
          resourceId("message"),
          rowData(
            {
              organization_id: workspace.organizationId,
              workspace_id: workspaceId,
              user_id: identity.userId,
              subject_id: ticketId,
              status: "visible",
              kind: "support",
              sequence,
              occurred_at: changedAt,
              created_by: identity.userId,
            },
            { authorName: identity.name, authorKind: "support", body },
          ),
        );
        await this.store.update(
          TABLES.supportTickets,
          ticketId,
          rowData(
            { status: "waiting_customer", updated_by: identity.userId },
            { ...ticketDetails, updatedAt: changedAt },
          ),
        );
        const targetEmail = String(ticket.email ?? "");
        if (targetEmail) {
          await queueNotification(this.store, {
            organizationId: workspace.organizationId,
            workspaceId,
            userId: String(ticket.user_id),
            email: targetEmail,
            kind: "support.ticket_updated",
            subjectId: ticketId,
            idempotencyKey: `${options.idempotencyKey}:support-reply`,
            payload: { workspaceName: workspace.name },
          });
        }
        await appendAudit(this.store, identity, workspaceId, {
          action: "support.ticket-replied",
          targetType: "support-ticket",
          targetId: ticketId,
          summary: "In-app support ticket updated",
          metadata: { sequence, authorKind: "support" },
        });
        return { replied: true, sequence, workspaceId };
      }
    }

    const workspaceId = inputText(payload.workspaceId, "Workspace", {
      min: 1,
      max: 36,
    });
    const workspaceAccess = await this.access.requireWorkspace(
      workspaceId,
      identity,
    );
    const context = this.access.context(workspaceAccess, false);
    if (
      workspaceAccess.lifecycleAccess === "read_only" &&
      ![
        "recordGuideView",
        "recordGuideReaction",
        "revokeSupportAccess",
        "revokeCaptureDevices",
        "revokeDesktopDevice",
      ].includes(action)
    ) {
      throw new HttpError(
        403,
        "SUBSCRIPTION_READ_ONLY",
        "The subscription is in read-only grace.",
      );
    }
    if (
      ["suspended", "deletion_pending", "deleting", "deleted"].includes(
        workspaceAccess.lifecycleAccess,
      ) &&
      ![
        "revokeSupportAccess",
        "revokeCaptureDevices",
        "revokeDesktopDevice",
      ].includes(action)
    ) {
      throw new HttpError(
        403,
        "SUBSCRIPTION_SUSPENDED",
        "The subscription is suspended.",
      );
    }

    if (action === "confirmOnboardingReadiness") {
      requireAuthorized("workspace.read", context);
      if (workspaceAccess.supportGrant) {
        throw new HttpError(
          403,
          "ONBOARDING_MEMBERSHIP_REQUIRED",
          "A permanent workspace member must complete onboarding.",
        );
      }
      const ordinaryDataOnly = inputBoolean(
        payload.ordinaryDataOnly,
        "Ordinary-data confirmation",
      );
      const pilotPoliciesReviewed = inputBoolean(
        payload.pilotPoliciesReviewed,
        "Pilot-policy confirmation",
      );
      if (!ordinaryDataOnly || !pilotPoliciesReviewed) {
        throw new HttpError(
          400,
          "ONBOARDING_CONFIRMATION_REQUIRED",
          "Confirm both pilot boundaries before continuing.",
        );
      }
      const fallbackProgressId = await deterministicId(
        "onboard",
        `${workspaceId}:${identity.userId}`,
      );
      const existingRows = await this.store.list(TABLES.onboardingProgress, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 1,
      });
      // Self-service setup creates onboarding before this confirmation and
      // uses its own stable row ID. Reuse the row selected by the table's
      // unique workspace/user key instead of attempting a duplicate create.
      const existing = existingRows[0] ?? null;
      const progressId = existing?.$id ?? fallbackProgressId;
      const current = existing
        ? decodePayload<{
            startedAt?: string;
            dismissedAt?: string;
            skippedSteps?: unknown;
            extensionPinnedAt?: string;
          }>(existing, {})
        : {};
      const confirmedAt = nowIso();
      await this.store.upsert(
        TABLES.onboardingProgress,
        progressId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            status: "active",
            occurred_at: confirmedAt,
            updated_by: identity.userId,
          },
          {
            startedAt: current.startedAt ?? confirmedAt,
            readinessConfirmedAt: confirmedAt,
            ordinaryDataOnly: true,
            pilotPoliciesReviewed: true,
            ...(typeof current.dismissedAt === "string"
              ? { dismissedAt: current.dismissedAt }
              : {}),
            ...(Array.isArray(current.skippedSteps)
              ? { skippedSteps: current.skippedSteps }
              : {}),
            ...(typeof current.extensionPinnedAt === "string"
              ? { extensionPinnedAt: current.extensionPinnedAt }
              : {}),
          },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "onboarding.readiness-confirmed",
        targetType: "onboarding",
        targetId: progressId,
        summary: "Pilot workspace readiness confirmed",
        metadata: { ordinaryDataOnly: true, pilotPoliciesReviewed: true },
      });
      return { confirmed: true, confirmedAt };
    }

    if (action === "dismissOnboarding") {
      requireAuthorized("workspace.read", context);
      if (workspaceAccess.supportGrant) {
        throw new HttpError(
          403,
          "ONBOARDING_MEMBERSHIP_REQUIRED",
          "A permanent workspace member must complete onboarding.",
        );
      }
      const fallbackProgressId = await deterministicId(
        "onboard",
        `${workspaceId}:${identity.userId}`,
      );
      const existingRows = await this.store.list(TABLES.onboardingProgress, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 1,
      });
      const existing = existingRows[0] ?? null;
      const progressId = existing?.$id ?? fallbackProgressId;
      const current = existing
        ? decodePayload<{
            startedAt?: string;
            readinessConfirmedAt?: string;
            ordinaryDataOnly?: boolean;
            pilotPoliciesReviewed?: boolean;
            skippedSteps?: unknown;
            extensionPinnedAt?: string;
          }>(existing, {})
        : {};
      const dismissedAt = nowIso();
      await this.store.upsert(
        TABLES.onboardingProgress,
        progressId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            status: "active",
            occurred_at: dismissedAt,
            updated_by: identity.userId,
          },
          {
            startedAt: current.startedAt ?? dismissedAt,
            dismissedAt,
            ...(typeof current.readinessConfirmedAt === "string"
              ? { readinessConfirmedAt: current.readinessConfirmedAt }
              : {}),
            ...(current.ordinaryDataOnly === true
              ? { ordinaryDataOnly: true }
              : {}),
            ...(current.pilotPoliciesReviewed === true
              ? { pilotPoliciesReviewed: true }
              : {}),
            ...(Array.isArray(current.skippedSteps)
              ? { skippedSteps: current.skippedSteps }
              : {}),
            ...(typeof current.extensionPinnedAt === "string"
              ? { extensionPinnedAt: current.extensionPinnedAt }
              : {}),
          },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "onboarding.dismissed",
        targetType: "onboarding",
        targetId: progressId,
        summary: "Getting started dismissed",
      });
      return { dismissed: true, dismissedAt };
    }

    if (action === "confirmExtensionPinned") {
      requireAuthorized("workspace.read", context);
      if (workspaceAccess.supportGrant) {
        throw new HttpError(
          403,
          "ONBOARDING_MEMBERSHIP_REQUIRED",
          "A permanent workspace member must complete onboarding.",
        );
      }
      const fallbackProgressId = await deterministicId(
        "onboard",
        `${workspaceId}:${identity.userId}`,
      );
      const existingRows = await this.store.list(TABLES.onboardingProgress, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
        limit: 1,
      });
      const existing = existingRows[0] ?? null;
      const progressId = existing?.$id ?? fallbackProgressId;
      const current = existing
        ? decodePayload<{
            startedAt?: string;
            readinessConfirmedAt?: string;
            dismissedAt?: string;
            ordinaryDataOnly?: boolean;
            pilotPoliciesReviewed?: boolean;
            skippedSteps?: unknown;
            extensionPinnedAt?: string;
          }>(existing, {})
        : {};
      const pinnedAt = current.extensionPinnedAt ?? nowIso();
      await this.store.upsert(
        TABLES.onboardingProgress,
        progressId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            status: "active",
            occurred_at: pinnedAt,
            updated_by: identity.userId,
          },
          {
            startedAt: current.startedAt ?? pinnedAt,
            extensionPinnedAt: pinnedAt,
            ...(typeof current.readinessConfirmedAt === "string"
              ? { readinessConfirmedAt: current.readinessConfirmedAt }
              : {}),
            ...(typeof current.dismissedAt === "string"
              ? { dismissedAt: current.dismissedAt }
              : {}),
            ...(current.ordinaryDataOnly === true
              ? { ordinaryDataOnly: true }
              : {}),
            ...(current.pilotPoliciesReviewed === true
              ? { pilotPoliciesReviewed: true }
              : {}),
            ...(Array.isArray(current.skippedSteps)
              ? { skippedSteps: current.skippedSteps }
              : {}),
          },
        ),
      );
      return { pinned: true, pinnedAt };
    }

    if (
      action === "startProTrial" ||
      action === "selectProPlan" ||
      action === "requestEnterprisePlan"
    ) {
      requireAuthorized("workspace.settings.manage", context);
      if (workspaceAccess.supportGrant) {
        throw new HttpError(
          403,
          "SUPPORT_GRANT_RESTRICTED",
          "Temporary support access cannot change the workspace plan.",
        );
      }
      const subscription = await subscriptionForWorkspace(
        this.store,
        workspaceId,
      );
      if (!subscription) {
        throw new HttpError(
          404,
          "SUBSCRIPTION_NOT_FOUND",
          "Subscription not found.",
        );
      }
      const current = subscription.value;
      const storedPlan = inferredCommercialPlan(current);
      const changedAt = nowIso();
      if (action === "requestEnterprisePlan" || action === "selectProPlan") {
        const requestedPlan =
          action === "requestEnterprisePlan" ? "enterprise" : "pro";
        const requestedPlanLabel =
          requestedPlan === "enterprise" ? "Enterprise" : "Pro";
        const leadId = resourceId("lead");
        const existing = (
          await this.store.list(TABLES.leads, {
            filters: [
              { field: "email", value: identity.email },
              { field: "status", value: "new" },
            ],
            order: "desc",
            limit: 25,
          })
        ).find((row) => {
          const details = decodePayload<{
            kind?: string;
            workspaceId?: string;
            requestedPlan?: string;
          }>(row, {});
          return (
            details.kind === "pricing" &&
            details.workspaceId === workspaceId &&
            details.requestedPlan === requestedPlan &&
            Date.parse(row.$createdAt) > Date.now() - 24 * 60 * 60 * 1_000
          );
        });
        if (existing) {
          return { requested: true, leadId: existing.$id, duplicate: true };
        }
        await this.store.create(
          TABLES.leads,
          leadId,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              email: identity.email,
              user_id: identity.userId,
              status: "new",
              kind: "pricing",
              request_id: options.requestId,
              occurred_at: changedAt,
              created_by: identity.userId,
            },
            {
              kind: "pricing",
              name: identity.name,
              email: identity.email,
              organization: workspaceAccess.workspace.name,
              role: "administrator",
              teamSize: null,
              country: "",
              workflow: `${requestedPlanLabel} plan request`,
              notes: `In-app ${requestedPlanLabel} request for ${workspaceAccess.workspace.name}`,
              ordinaryDataOnly: true,
              workspaceId,
              requestedPlan,
              occurredAt: changedAt,
            },
          ),
        );
        await appendAudit(this.store, identity, workspaceId, {
          action: `plan.${requestedPlan}-requested`,
          targetType: "subscription",
          targetId: subscription.row.$id,
          summary: `${requestedPlanLabel} plan requested`,
        });
        return { requested: true, leadId, duplicate: false };
      }

      const nextPlan: CommercialPlan = "pro_trial";
      if (storedPlan !== "free") {
        throw new HttpError(
          409,
          "PRO_TRIAL_NOT_AVAILABLE",
          "A Pro trial can only be started from the Free plan.",
        );
      }
      if (trialConsumed(current)) {
        throw new HttpError(
          409,
          "PRO_TRIAL_USED",
          "This workspace already used its Pro trial.",
        );
      }

      const expiresAt = new Date(
        Date.now() + PRO_TRIAL_DAYS * 86_400_000,
      ).toISOString();
      const next: SubscriptionRecord = {
        ...current,
        plan: nextPlan,
        kind: subscriptionKindForPlan(nextPlan),
        status: "active",
        startsAt: current.startsAt,
        expiresAt,
        graceDays: 0,
        publicTrial: false,
        manualContract: false,
        trialConsumed: true,
      };
      await this.store.update(
        TABLES.subscriptions,
        subscription.row.$id,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            status: next.status,
            kind: next.kind,
            updated_by: identity.userId,
          },
          next,
        ),
      );
      await applyPlanEntitlements(this.store, {
        organizationId: workspaceAccess.workspace.organizationId,
        workspaceId,
        actorUserId: identity.userId,
        entitlements: entitlementsForPlan(nextPlan),
      });
      await appendAudit(this.store, identity, workspaceId, {
        action: "plan.pro-trial-started",
        targetType: "subscription",
        targetId: subscription.row.$id,
        summary: "14-day Pro trial started",
        metadata: { plan: nextPlan, expiresAt },
      });
      return {
        plan: nextPlan,
        kind: next.kind,
        expiresAt,
        paymentMethodRequired: false,
      };
    }

    if (action === "createSupportTicket") {
      requireAuthorized("workspace.read", context);
      if (
        workspaceAccess.supportGrant ||
        !(
          workspaceAccess.roles.includes("administrator") ||
          workspaceAccess.roles.includes("creator")
        )
      ) {
        throw new HttpError(
          403,
          "SUPPORT_TICKET_ROLE_REQUIRED",
          "A workspace administrator or creator can open a support ticket.",
        );
      }
      await new EntitlementService(this.store, workspaceId).requireFeature(
        "supportEnabled",
      );
      const subject = supportText(payload.subject, "Support subject", {
        min: 4,
        max: 160,
      });
      const body = supportText(payload.message, "Support message", {
        min: 10,
        max: 4_000,
      });
      const ticketId = resourceId("ticket");
      const messageId = resourceId("message");
      const createdAt = nowIso();
      const responseTargetAt = nextBusinessDay(new Date(createdAt));
      await this.store.create(
        TABLES.supportTickets,
        ticketId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            email: identity.email,
            status: "waiting_support",
            kind: "in_app",
            occurred_at: createdAt,
            request_id: options.requestId,
            created_by: identity.userId,
          },
          {
            subject,
            requesterName: identity.name,
            createdAt,
            updatedAt: createdAt,
            responseTargetAt,
          },
        ),
      );
      await this.store.create(
        TABLES.supportMessages,
        messageId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: ticketId,
            status: "visible",
            kind: "customer",
            sequence: 1,
            occurred_at: createdAt,
            created_by: identity.userId,
          },
          { authorName: identity.name, authorKind: "customer", body },
        ),
      );
      const supportEmail =
        process.env.KNOWHOW_SUPPORT_EMAIL?.trim().toLowerCase();
      if (supportEmail) {
        await queueNotification(this.store, {
          organizationId: workspaceAccess.workspace.organizationId,
          workspaceId,
          email: supportEmail,
          kind: "support.ticket_opened",
          subjectId: ticketId,
          idempotencyKey: `${options.idempotencyKey}:support-ticket`,
          payload: {
            workspaceName: workspaceAccess.workspace.name,
            responseTargetAt,
          },
        });
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "support.ticket-opened",
        targetType: "support-ticket",
        targetId: ticketId,
        summary: "In-app support ticket opened",
        metadata: { responseTargetAt },
      });
      return { ticketId, responseTargetAt };
    }

    if (action === "replySupportTicket" || action === "closeSupportTicket") {
      requireAuthorized("workspace.read", context);
      const ticketId = inputText(payload.ticketId, "Support ticket", {
        min: 1,
        max: 36,
      });
      const ticket = await this.store.get(TABLES.supportTickets, ticketId);
      if (!ticket || ticket.workspace_id !== workspaceId) {
        throw new HttpError(
          404,
          "SUPPORT_TICKET_NOT_FOUND",
          "Support ticket not found.",
        );
      }
      const isWorkspaceAdmin =
        workspaceAccess.roles.includes("administrator") &&
        !workspaceAccess.supportGrant;
      const isRequester = ticket.user_id === identity.userId;
      const isSupport = Boolean(workspaceAccess.supportGrant);
      if (!isWorkspaceAdmin && !isRequester && !isSupport) {
        throw new HttpError(
          403,
          "SUPPORT_TICKET_FORBIDDEN",
          "This support ticket is unavailable.",
        );
      }
      const ticketDetails = decodePayload<Record<string, unknown>>(ticket, {});
      const changedAt = nowIso();
      if (action === "closeSupportTicket") {
        await this.store.update(
          TABLES.supportTickets,
          ticketId,
          rowData(
            { status: "closed", updated_by: identity.userId },
            {
              ...ticketDetails,
              status: "closed",
              updatedAt: changedAt,
              closedAt: changedAt,
              closedBy: identity.userId,
            },
          ),
        );
        await appendAudit(this.store, identity, workspaceId, {
          action: "support.ticket-closed",
          targetType: "support-ticket",
          targetId: ticketId,
          summary: "In-app support ticket closed",
        });
        return { closed: true };
      }
      if (ticket.status === "closed")
        throw new HttpError(
          409,
          "SUPPORT_TICKET_CLOSED",
          "This support ticket is closed.",
        );
      const body = supportText(payload.message, "Support message", {
        min: 2,
        max: 4_000,
      });
      const messages = await this.store.list(TABLES.supportMessages, {
        filters: [{ field: "subject_id", value: ticketId }],
        orderBy: "sequence",
        order: "desc",
        limit: 1,
      });
      const sequence = Number(messages[0]?.sequence ?? 0) + 1;
      const authorKind = isSupport ? "support" : "customer";
      await this.store.create(
        TABLES.supportMessages,
        resourceId("message"),
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: ticketId,
            status: "visible",
            kind: authorKind,
            sequence,
            occurred_at: changedAt,
            created_by: identity.userId,
          },
          { authorName: identity.name, authorKind, body },
        ),
      );
      await this.store.update(
        TABLES.supportTickets,
        ticketId,
        rowData(
          {
            status: isSupport ? "waiting_customer" : "waiting_support",
            updated_by: identity.userId,
          },
          { ...ticketDetails, updatedAt: changedAt },
        ),
      );
      const targetEmail = isSupport
        ? String(ticket.email ?? "")
        : process.env.KNOWHOW_SUPPORT_EMAIL?.trim().toLowerCase();
      if (targetEmail) {
        await queueNotification(this.store, {
          organizationId: workspaceAccess.workspace.organizationId,
          workspaceId,
          userId: isSupport ? String(ticket.user_id) : undefined,
          email: targetEmail,
          kind: "support.ticket_updated",
          subjectId: ticketId,
          idempotencyKey: `${options.idempotencyKey}:support-reply`,
          payload: { workspaceName: workspaceAccess.workspace.name },
        });
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "support.ticket-replied",
        targetType: "support-ticket",
        targetId: ticketId,
        summary: "In-app support ticket updated",
        metadata: { sequence, authorKind },
      });
      return { replied: true, sequence };
    }

    if (action === "resolveSupportRequest") {
      requireAuthorized("workspace.support.decide", context);
      requireReauthentication(options.reauthenticated);
      const supportCaseId = inputText(payload.requestId, "Support request", {
        min: 1,
        max: 36,
      });
      const supportCase = await this.store.get(
        TABLES.supportCases,
        supportCaseId,
      );
      if (
        !supportCase ||
        supportCase.workspace_id !== workspaceId ||
        supportCase.status !== "pending"
      ) {
        throw new HttpError(
          409,
          "SUPPORT_REQUEST_UNAVAILABLE",
          "This support request is no longer pending.",
        );
      }
      const approve = inputBoolean(payload.approve, "Decision");
      const details = decodePayload<Partial<SupportAccessRequest>>(
        supportCase,
        {},
      );
      if (supportCase.user_id === identity.userId) {
        throw new HttpError(
          403,
          "SUPPORT_SELF_APPROVAL",
          "Support operators cannot approve their own access requests.",
        );
      }
      if (!approve) {
        await this.store.update(
          TABLES.supportCases,
          supportCaseId,
          rowData(
            { status: "denied", updated_by: identity.userId },
            { ...details, decidedAt: nowIso(), decidedBy: identity.userId },
          ),
        );
        await appendAudit(this.store, identity, workspaceId, {
          action: "support.denied",
          targetType: "support-case",
          targetId: supportCaseId,
          summary: "Temporary support request denied",
        });
        return { approved: false };
      }
      const grantedRole = role(payload.grantedRole ?? details.requestedRole);
      const grantedDurationHours = inputInteger(
        payload.grantedDurationHours ?? details.requestedDurationHours,
        "Duration",
        1,
        24,
      );
      if (
        grantedRole === "administrator" &&
        payload.explicitAdministrator !== true
      ) {
        throw new HttpError(
          400,
          "SUPPORT_ADMIN_CONFIRM_REQUIRED",
          "Confirm administrator-level support explicitly.",
        );
      }
      const existing = await this.store.list(TABLES.supportGrants, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: stringValue(supportCase.user_id) },
          { field: "status", value: "active" },
        ],
        limit: 1,
      });
      if (existing.length)
        throw new HttpError(
          409,
          "SUPPORT_GRANT_ACTIVE",
          "Support access is already active.",
        );
      const grantedAt = nowIso();
      const expiresAt = new Date(
        Date.now() + grantedDurationHours * 60 * 60 * 1_000,
      ).toISOString();
      const grantId = resourceId("grant");
      const grant: SupportGrantRecord = {
        requestId: supportCaseId,
        role: grantedRole,
        email: details.requesterEmail ?? stringValue(supportCase.email),
        displayName: details.requesterName ?? "Support operator",
        approvedBy: identity.userId,
        grantedAt,
        expiresAt,
        endedAt: null,
        revokedBy: null,
        reason: details.reason ?? "Approved support request",
      };
      await this.store.create(
        TABLES.supportGrants,
        grantId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: stringValue(supportCase.user_id),
            email: grant.email,
            status: "active",
            kind: grantedRole,
            expires_at: expiresAt,
            created_by: identity.userId,
          },
          grant,
        ),
      );
      await this.store.update(
        TABLES.supportCases,
        supportCaseId,
        rowData(
          { status: "approved", updated_by: identity.userId },
          {
            ...details,
            grantedRole,
            grantId,
            decidedAt: grantedAt,
            decidedBy: identity.userId,
          },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "support.approved",
        targetType: "support-grant",
        targetId: grantId,
        summary: "Temporary support access approved",
        metadata: { grantedRole, grantedDurationHours },
      });
      await queueNotification(this.store, {
        organizationId: workspaceAccess.workspace.organizationId,
        workspaceId,
        userId: stringValue(supportCase.user_id),
        email: grant.email,
        kind: "support.approved",
        subjectId: grantId,
        idempotencyKey: `${options.idempotencyKey}:support-approved`,
        payload: { grantedRole, expiresAt },
      });
      return { approved: true, grantId, expiresAt };
    }

    if (action === "revokeSupportAccess") {
      const grantId = inputText(payload.grantId, "Support grant", {
        min: 1,
        max: 36,
      });
      const grantRow = await this.store.get(TABLES.supportGrants, grantId);
      if (
        !grantRow ||
        grantRow.workspace_id !== workspaceId ||
        grantRow.status !== "active"
      )
        throw new HttpError(
          404,
          "SUPPORT_GRANT_NOT_FOUND",
          "Support grant not found.",
        );
      const ownGrant =
        grantRow.user_id === identity.userId &&
        workspaceAccess.supportGrant?.id === grantId;
      if (!ownGrant) {
        requireAuthorized("workspace.support.revoke", context);
        requireReauthentication(options.reauthenticated);
      }
      const grant = decodePayload<SupportGrantRecord>(grantRow, null as never);
      await this.store.update(
        TABLES.supportGrants,
        grantId,
        rowData(
          { status: "revoked", updated_by: identity.userId },
          { ...grant, endedAt: nowIso(), revokedBy: identity.userId },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "support.revoked",
        targetType: "support-grant",
        targetId: grantId,
        summary: "Temporary support access revoked",
      });
      return { revoked: true };
    }

    if (action === "updateWorkspaceSettings") {
      requireAuthorized("workspace.settings.manage", context);
      const input = inputObject(payload.settings, "Settings");
      const rows = await this.store.list(TABLES.workspaceSettings, {
        filters: [{ field: "workspace_id", value: workspaceId }],
        limit: 1,
      });
      const current = rows[0]
        ? {
            ...DEFAULT_WORKSPACE_SETTINGS,
            ...decodePayload<Partial<WorkspaceSettings>>(rows[0], {}),
          }
        : DEFAULT_WORKSPACE_SETTINGS;
      const desktopTypedTextPolicy = inputText(
        input.desktopTypedTextPolicy ?? current.desktopTypedTextPolicy,
        "Desktop typed-text policy",
        { min: 7, max: 8 },
      );
      if (
        desktopTypedTextPolicy !== "allowed" &&
        desktopTypedTextPolicy !== "disabled"
      ) {
        throw new HttpError(
          400,
          "INPUT_INVALID",
          "Desktop typed-text policy must be allowed or disabled.",
        );
      }
      const settings: WorkspaceSettings = {
        logoUrl: null,
        accentColor: inputText(input.accentColor, "Accent color", {
          min: 4,
          max: 20,
        }),
        clickTargetColor: inputText(
          input.clickTargetColor,
          "Click target color",
          { min: 4, max: 20 },
        ),
        removeBranding: inputBoolean(input.removeBranding, "Branding"),
        allowRestrictedExports: inputBoolean(
          input.allowRestrictedExports,
          "Restricted exports",
        ),
        watermarkExports: inputBoolean(
          input.watermarkExports,
          "Export watermark",
        ),
        requireReviewBeforePublish: inputBoolean(
          input.requireReviewBeforePublish,
          "Require review before publish",
        ),
        desktopTypedTextPolicy,
      };
      if (settings.removeBranding) {
        await new EntitlementService(this.store, workspaceId).requireFeature(
          "removeBranding",
        );
      }
      const next: WorkspaceSettings = {
        logoUrl: current.logoUrl,
        accentColor: settings.accentColor,
        clickTargetColor: settings.clickTargetColor,
        removeBranding: settings.removeBranding,
        allowRestrictedExports: settings.allowRestrictedExports,
        watermarkExports: settings.watermarkExports,
        requireReviewBeforePublish: settings.requireReviewBeforePublish,
        desktopTypedTextPolicy: settings.desktopTypedTextPolicy,
      };
      if (rows[0])
        await this.store.update(
          TABLES.workspaceSettings,
          rows[0].$id,
          rowData({ updated_by: identity.userId }, next),
        );
      else
        await this.store.create(
          TABLES.workspaceSettings,
          resourceId("settings"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              status: "active",
              created_by: identity.userId,
            },
            next,
          ),
        );
      await appendAudit(this.store, identity, workspaceId, {
        action: "workspace.settings_updated",
        targetType: "workspace",
        targetId: workspaceId,
        summary: "Workspace settings updated",
      });
      return { updated: true };
    }

    if (action === "saveGroup") {
      requireAuthorized("workspace.groups.manage", context);
      const id =
        typeof payload.id === "string"
          ? inputText(payload.id, "Group", { min: 1, max: 36 })
          : resourceId("group");
      const name = inputText(payload.name, "Group name", { min: 2, max: 128 });
      const description = inputText(payload.description ?? "", "Description", {
        max: 1_000,
      });
      const sensitive = inputBoolean(payload.sensitive ?? false, "Sensitivity");
      const memberIds = inputStringList(
        payload.memberIds ?? [],
        "Members",
        1_000,
        36,
      );
      const existing = await this.store.get(TABLES.workspaceGroups, id);
      const group: WorkspaceGroupRecord = {
        name,
        description,
        sensitive,
        kind: "custom",
        createdAt: existing?.$createdAt ?? nowIso(),
      };
      if (existing)
        await this.store.update(
          TABLES.workspaceGroups,
          id,
          rowData({ slug: slugify(name), updated_by: identity.userId }, group),
        );
      else
        await this.store.create(
          TABLES.workspaceGroups,
          id,
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              slug: `${slugify(name)}-${id.slice(-5)}`,
              kind: "custom",
              status: "active",
              created_by: identity.userId,
            },
            group,
          ),
        );
      for (const membership of await this.store.list(TABLES.groupMemberships, {
        filters: [{ field: "subject_id", value: id }],
      }))
        await this.store.delete(TABLES.groupMemberships, membership.$id);
      for (const userId of memberIds)
        await this.store.create(
          TABLES.groupMemberships,
          resourceId("groupmem"),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              subject_id: id,
              user_id: userId,
              status: "active",
              created_by: identity.userId,
            },
            {},
          ),
        );
      await appendAudit(this.store, identity, workspaceId, {
        action: existing ? "group.updated" : "group.created",
        targetType: "group",
        targetId: id,
        targetLabel: name,
        summary: existing
          ? "Workspace group updated"
          : "Workspace group created",
        metadata: { memberCount: memberIds.length },
      });
      return { id };
    }

    if (action === "deleteGroup") {
      requireAuthorized("workspace.groups.manage", context);
      const groupId = inputText(payload.groupId, "Group", { min: 1, max: 36 });
      const group = await this.store.get(TABLES.workspaceGroups, groupId);
      if (!group || group.workspace_id !== workspaceId)
        throw new HttpError(404, "GROUP_NOT_FOUND", "Group not found.");
      if (group.kind === "all_members")
        throw new HttpError(
          409,
          "GROUP_PROTECTED",
          "The all-members group cannot be deleted.",
        );
      const used = await this.store.list(TABLES.guideAudiences, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "kind", value: "group" },
          { field: "user_id", value: groupId },
        ],
        limit: 1,
      });
      if (used.length)
        throw new HttpError(
          409,
          "GROUP_IN_USE",
          "Remove this group from guide audiences first.",
        );
      for (const membership of await this.store.list(TABLES.groupMemberships, {
        filters: [{ field: "subject_id", value: groupId }],
      }))
        await this.store.delete(TABLES.groupMemberships, membership.$id);
      await this.store.delete(TABLES.workspaceGroups, groupId);
      await appendAudit(this.store, identity, workspaceId, {
        action: "group.deleted",
        targetType: "group",
        targetId: groupId,
        summary: "Workspace group deleted",
      });
      return { deleted: true };
    }

    if (action === "createInvite") {
      requireAuthorized("workspace.invitations.manage", context);
      await new EntitlementService(
        this.store,
        workspaceId,
      ).assertMemberCapacity();
      const inviteRole = role(payload.role, true);
      const email = inputEmail(payload.email);
      const label = inputText(payload.label ?? `Invite ${email}`, "Label", {
        min: 2,
        max: 128,
      });
      const maxUses = inputInteger(payload.maxUses ?? 1, "Maximum uses", 1, 1);
      const expiresInHours = inputInteger(
        payload.expiresInHours ?? 168,
        "Expiry",
        1,
        30 * 24,
      );
      const invitationId = resourceId("invite");
      const expiresAtSeconds =
        Math.floor(Date.now() / 1_000) + expiresInHours * 60 * 60;
      const token = await signInviteToken({
        jti: invitationId,
        workspaceId,
        role: inviteRole as Exclude<WorkspaceRole, "administrator">,
        email,
        expiresAt: expiresAtSeconds,
      });
      const expiresAt = new Date(expiresAtSeconds * 1_000).toISOString();
      await this.store.create(
        TABLES.invitations,
        invitationId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            email: email ?? null,
            subject_id: await hashToken(token),
            status: "active",
            kind: inviteRole,
            expires_at: expiresAt,
            created_by: identity.userId,
          },
          {
            label,
            role: inviteRole,
            maxUses,
            useCount: 0,
            createdAt: nowIso(),
          },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "invitation.created",
        targetType: "invitation",
        targetId: invitationId,
        summary: "Workspace invitation created",
        metadata: { role: inviteRole, maxUses, emailScoped: Boolean(email) },
      });
      await queueNotification(this.store, {
        organizationId: workspaceAccess.workspace.organizationId,
        workspaceId,
        email,
        kind: "invitation.created",
        subjectId: invitationId,
        idempotencyKey: `${options.idempotencyKey}:invitation`,
        payload: {
          expiresAt,
          credential: token,
          workspaceName: workspaceAccess.workspace.name,
        },
      });
      return {
        id: invitationId,
        token,
        inviteUrl: `/app?invite=${encodeURIComponent(token)}`,
        expiresAt,
      };
    }

    if (action === "revokeInvite") {
      requireAuthorized("workspace.invitations.manage", context);
      const invitationId = inputText(payload.invitationId, "Invitation", {
        min: 1,
        max: 36,
      });
      const invitation = await this.store.get(TABLES.invitations, invitationId);
      if (!invitation || invitation.workspace_id !== workspaceId)
        throw new HttpError(
          404,
          "INVITATION_NOT_FOUND",
          "Invitation not found.",
        );
      await this.store.update(
        TABLES.invitations,
        invitationId,
        rowData(
          { status: "revoked", updated_by: identity.userId },
          decodePayload(invitation, {}),
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "invitation.revoked",
        targetType: "invitation",
        targetId: invitationId,
        summary: "Workspace invitation revoked",
      });
      return { revoked: true };
    }

    if (action === "updateMember") {
      requireAuthorized("workspace.members.manage", context);
      const memberId = inputText(payload.memberId, "Member", {
        min: 1,
        max: 36,
      });
      const member = await this.store.get(TABLES.workspaceMembers, memberId);
      if (!member || member.workspace_id !== workspaceId)
        throw new HttpError(404, "MEMBER_NOT_FOUND", "Member not found.");
      const nextRoles = roles(payload.roles);
      const nextStatus = inputText(payload.status, "Status", {
        min: 6,
        max: 9,
      });
      if (!new Set(["active", "suspended"]).has(nextStatus))
        throw new HttpError(
          400,
          "MEMBER_STATUS_INVALID",
          "Member status is invalid.",
        );
      const capabilities = inputStringList(
        payload.capabilities ?? [],
        "Capabilities",
        1,
        32,
      ).filter((item): item is "vault" => item === "vault");
      const current = decodePayload<WorkspaceMemberRecord>(
        member,
        null as never,
      );
      const entitlements = new EntitlementService(this.store, workspaceId);
      if (nextStatus === "active" && member.status !== "active") {
        await entitlements.assertMemberCapacity();
      }
      if (
        nextStatus === "active" &&
        nextRoles.some((item) => item === "creator" || item === "administrator")
      ) {
        await entitlements.assertCreatorCapacity(String(member.user_id));
      }
      const removingAdmin =
        current.roles.includes("administrator") &&
        (!nextRoles.includes("administrator") || nextStatus !== "active");
      if (removingAdmin) {
        const administrators = (
          await this.store.list(TABLES.workspaceMembers, {
            filters: [
              { field: "workspace_id", value: workspaceId },
              { field: "status", value: "active" },
            ],
          })
        ).filter((row) =>
          decodePayload<WorkspaceMemberRecord>(
            row,
            null as never,
          )?.roles.includes("administrator"),
        );
        if (administrators.length <= 1)
          throw new HttpError(
            409,
            "LAST_ADMINISTRATOR",
            "Add another active administrator first.",
          );
      }
      await this.store.update(
        TABLES.workspaceMembers,
        memberId,
        rowData(
          { status: nextStatus, updated_by: identity.userId },
          { ...current, roles: nextRoles, capabilities },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "member.updated",
        targetType: "member",
        targetId: memberId,
        summary: "Workspace member access updated",
        metadata: { roles: nextRoles, status: nextStatus, capabilities },
      });
      return { updated: true };
    }

    if (action === "saveVaultItem" || action === "deleteVaultItem") {
      throw new HttpError(
        403,
        "PILOT_DATA_CLASSIFICATION_BLOCKED",
        "Credentials and secrets are prohibited in the external pilot.",
      );
    }

    if (action === "recordGuideView" || action === "recordGuideCompletion") {
      const guideId = inputText(payload.guideId, "Guide", { min: 1, max: 36 });
      const guide = await this.store.get(TABLES.guides, guideId);
      if (!guide || guide.workspace_id !== workspaceId)
        throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
      const guideDetails = decodePayload<GuideRecord>(guide, null as never);
      if (!guideDetails?.publishedRevisionId) {
        throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
      }
      await new GuideAccessService(this.store).require(
        identity,
        workspaceId,
        guideId,
        guideDetails.publishedRevisionId,
        "guide.read",
      );
      const activationKind =
        guideDetails.authorUserId &&
        guideDetails.authorUserId !== identity.userId
          ? action === "recordGuideView"
            ? "activation.first_teammate_view"
            : "activation.first_teammate_completion"
          : null;
      // Query before staging the ordinary view/completion event. Appwrite's
      // transaction overlay may otherwise satisfy this filtered query with
      // the staged ordinary event and suppress the activation milestone.
      const existingActivation = activationKind
        ? await this.store.list(TABLES.usageEvents, {
            filters: [
              { field: "workspace_id", value: workspaceId },
              { field: "kind", value: activationKind },
            ],
            limit: 1,
          })
        : [];
      const kind =
        action === "recordGuideView" ? "guide.viewed" : "guide.completed";
      await this.store.create(
        TABLES.usageEvents,
        resourceId("usage"),
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: guideId,
            kind,
            status: "recorded",
            occurred_at: nowIso(),
            request_id: options.requestId,
            created_by: identity.userId,
          },
          {},
        ),
      );
      if (action === "recordGuideCompletion") {
        await this.store.upsert(
          TABLES.completions,
          await deterministicId(
            "complete",
            `${guideDetails.publishedRevisionId}:${identity.userId}`,
          ),
          rowData(
            {
              organization_id: workspaceAccess.workspace.organizationId,
              workspace_id: workspaceId,
              user_id: identity.userId,
              subject_id: guideDetails.publishedRevisionId,
              status: "completed",
              occurred_at: nowIso(),
              updated_by: identity.userId,
            },
            { guideId },
          ),
        );
        await appendAudit(this.store, identity, workspaceId, {
          action: "guide.completed",
          targetType: "guide",
          targetId: guideId,
          summary: "Published guide completed",
        });
      }
      if (activationKind && !existingActivation.length) {
        const activationKey = `${workspaceId}:${activationKind}`;
          await this.store.create(
            TABLES.usageEvents,
            await deterministicId("usage", activationKey),
            rowData(
              {
                organization_id: workspaceAccess.workspace.organizationId,
                workspace_id: workspaceId,
                user_id: identity.userId,
                subject_id: guideId,
                kind: activationKind,
                status: "recorded",
                occurred_at: nowIso(),
                request_id: await deterministicId("request", activationKey),
                created_by: identity.userId,
              },
              { contentIncluded: false },
            ),
          );
      }
      return { recorded: true };
    }

    if (action === "recordGuideReaction") {
      const guideId = inputText(payload.guideId, "Guide", { min: 1, max: 36 });
      const reaction = inputText(payload.reaction, "Reaction", {
        min: 1,
        max: 8,
      });
      if (!["like", "dislike", "clear"].includes(reaction)) {
        throw new HttpError(
          400,
          "INPUT_INVALID",
          "Reaction must be like, dislike, or clear.",
        );
      }
      const guide = await this.store.get(TABLES.guides, guideId);
      if (!guide || guide.workspace_id !== workspaceId)
        throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
      const guideDetails = decodePayload<GuideRecord>(guide, null as never);
      if (!guideDetails?.publishedRevisionId) {
        throw new HttpError(404, "GUIDE_NOT_FOUND", "Guide not found.");
      }
      await new GuideAccessService(this.store).require(
        identity,
        workspaceId,
        guideId,
        guideDetails.publishedRevisionId,
        "guide.read",
      );
      const reactionKey = `${workspaceId}:guide.reaction:${guideId}:${identity.userId}`;
      const reactionId = await deterministicId("usage", reactionKey);
      if (reaction === "clear") {
        const existing = await this.store.get(TABLES.usageEvents, reactionId);
        if (existing) await this.store.delete(TABLES.usageEvents, reactionId);
        return { reaction: null };
      }
      const kind = reaction === "like" ? "guide.liked" : "guide.disliked";
      await this.store.upsert(
        TABLES.usageEvents,
        reactionId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: guideId,
            kind,
            status: "recorded",
            occurred_at: nowIso(),
            request_id: await deterministicId("request", reactionKey),
            created_by: identity.userId,
          },
          {},
        ),
      );
      return { reaction };
    }

    if (action === "inspectDesktopAuthorization") {
      return new DesktopAuthService(this.store).inspectAuthorization(
        identity,
        workspaceId,
        inputText(payload.authorizationId, "Desktop authorization", {
          min: 1,
          max: 36,
        }),
      );
    }

    if (action === "approveDesktopAuthorization") {
      return new DesktopAuthService(this.store).approveAuthorization(
        identity,
        workspaceId,
        inputText(payload.authorizationId, "Desktop authorization", {
          min: 1,
          max: 36,
        }),
      );
    }

    if (action === "denyDesktopAuthorization") {
      return new DesktopAuthService(this.store).denyAuthorization(
        identity,
        workspaceId,
        inputText(payload.authorizationId, "Desktop authorization", {
          min: 1,
          max: 36,
        }),
      );
    }

    if (action === "revokeDesktopDevice") {
      return new DesktopAuthService(this.store).revokeDevice(
        identity,
        workspaceId,
        inputText(payload.deviceRecordId, "Desktop device", {
          min: 1,
          max: 36,
        }),
      );
    }

    if (action === "createPairingCode") {
      requireAuthorized("capture.create", context);
      await new EntitlementService(this.store, workspaceId).requireFeature(
        "extensionEnabled",
      );
      const code = pairingCode();
      const deviceRecordId = resourceId("device");
      const expiresAt = new Date(Date.now() + 10 * 60 * 1_000).toISOString();
      await this.store.create(
        TABLES.extensionDevices,
        deviceRecordId,
        rowData(
          {
            organization_id: workspaceAccess.workspace.organizationId,
            workspace_id: workspaceId,
            user_id: identity.userId,
            subject_id: await hashToken(code),
            status: "pairing",
            kind: "browser-extension",
            expires_at: expiresAt,
            request_id: options.requestId,
            created_by: identity.userId,
          },
          {
            email: identity.email,
            displayName: identity.name,
            scopes: ["capture:write", "media:write"],
            createdAt: nowIso(),
            minimumVersion:
              process.env.KNOWHOW_EXTENSION_MIN_VERSION?.trim() || "0.1.0",
          },
        ),
      );
      await appendAudit(this.store, identity, workspaceId, {
        action: "capture.pairing-code-created",
        targetType: "extension-device",
        targetId: deviceRecordId,
        summary: "One-time browser pairing code created",
      });
      return { code, expiresAt };
    }

    if (action === "revokeCaptureDevices") {
      if (
        workspaceAccess.membershipStatus !== "active" ||
        workspaceAccess.roles.length === 0
      ) {
        throw new HttpError(
          403,
          "MEMBERSHIP_REQUIRED",
          "An active workspace membership is required.",
        );
      }
      let revoked = 0;
      for (const device of await this.store.list(TABLES.extensionDevices, {
        filters: [
          { field: "workspace_id", value: workspaceId },
          { field: "user_id", value: identity.userId },
        ],
      })) {
        if (device.status !== "active" && device.status !== "pairing") continue;
        await this.store.update(
          TABLES.extensionDevices,
          device.$id,
          rowData(
            { status: "revoked", updated_by: identity.userId },
            {
              ...decodePayload(device, {}),
              revokedAt: nowIso(),
              revokedBy: identity.userId,
            },
          ),
        );
        revoked += 1;
      }
      await appendAudit(this.store, identity, workspaceId, {
        action: "capture.devices-revoked",
        targetType: "extension-device",
        targetId: identity.userId,
        summary: "All paired browser credentials revoked",
        metadata: { revoked },
      });
      return { revoked: true, deviceCount: revoked };
    }

    if (
      [
        "saveGuide",
        "reviewGuide",
        "publishGuide",
        "shareGuide",
        "archiveGuide",
        "deleteGuide",
        "restoreRevision",
      ].includes(action)
    ) {
      return new GuideCommandService(this.store, this.objects).execute(
        identity,
        action,
        payload,
        workspaceAccess,
        context,
        { requestId: options.requestId },
      );
    }

    throw new HttpError(
      400,
      "ACTION_UNKNOWN",
      "The requested action is not supported.",
    );
  }
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}
