import { appendAudit } from "./audit-service";
import { TABLES } from "./appwrite-resources";
import {
  DEFAULT_WORKSPACE_SETTINGS,
  decodePayload,
  rowData,
  type OrganizationRecord,
  type SubscriptionRecord,
  type WorkspaceRecord,
} from "./domain-records";
import { HttpError } from "./http-security";
import { resourceId } from "./ids";
import { inputText, slugify } from "./input";
import { LifecycleService } from "./lifecycle-service";
import { resolveSelfServiceTrialPlan } from "./pricing-catalog-service";
import type { RecordStore } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";

const DAY = 86_400_000;

export const LIFECYCLE_SIMULATION_CREATE_CONFIRMATION =
  "CREATE SYNTHETIC LIFECYCLE TENANT";

export type LifecycleSimulationState =
  | "trial_active"
  | "near_expiry"
  | "read_only"
  | "suspended"
  | "retention"
  | "deletion_eligible"
  | "pending_deletion";

const STATE_ORDER: Record<LifecycleSimulationState, number> = {
  trial_active: 0,
  near_expiry: 1,
  read_only: 2,
  suspended: 3,
  retention: 4,
  deletion_eligible: 5,
  pending_deletion: 6,
};

export type LifecycleSimulationEnvironment = {
  [key: string]: string | undefined;
  KNOWHOW_ENVIRONMENT?: string;
  NEXT_PUBLIC_KNOWHOW_ENVIRONMENT?: string;
  KNOWHOW_LIFECYCLE_SIMULATION_ENABLED?: string;
};

export function lifecycleSimulationAvailability(
  environment: LifecycleSimulationEnvironment = process.env,
) {
  const serverEnvironment = (environment.KNOWHOW_ENVIRONMENT ?? "development")
    .trim()
    .toLowerCase();
  const publicEnvironment = (
    environment.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT ?? serverEnvironment
  )
    .trim()
    .toLowerCase();
  const productionForbidden =
    serverEnvironment === "production" || publicEnvironment === "production";
  return {
    enabled:
      !productionForbidden &&
      new Set(["development", "test", "staging"]).has(serverEnvironment) &&
      environment.KNOWHOW_LIFECYCLE_SIMULATION_ENABLED === "1",
    environment: serverEnvironment,
    productionForbidden: true as const,
  };
}

export function assertLifecycleSimulationEnabled(
  environment: LifecycleSimulationEnvironment = process.env,
) {
  const availability = lifecycleSimulationAvailability(environment);
  const serverEnvironment = availability.environment;
  const publicEnvironment = (
    environment.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT ?? serverEnvironment
  )
    .trim()
    .toLowerCase();
  // This rejection is unconditional: setting the feature flag can never turn
  // the simulator into a production control.
  if (
    serverEnvironment === "production" ||
    publicEnvironment === "production"
  ) {
    throw new HttpError(
      403,
      "LIFECYCLE_SIMULATION_PRODUCTION_FORBIDDEN",
      "Lifecycle simulation is permanently disabled in production.",
    );
  }
  if (!new Set(["development", "test", "staging"]).has(serverEnvironment)) {
    throw new HttpError(
      403,
      "LIFECYCLE_SIMULATION_ENVIRONMENT_INVALID",
      "Lifecycle simulation requires a recognized non-production environment.",
    );
  }
  if (!availability.enabled) {
    throw new HttpError(
      403,
      "LIFECYCLE_SIMULATION_DISABLED",
      "Lifecycle simulation is not enabled for this environment.",
    );
  }
  return { environment: serverEnvironment };
}

export function lifecycleSimulationConfirmation(
  workspaceSlug: string,
  state: LifecycleSimulationState,
) {
  return `SIMULATE ${workspaceSlug} AS ${state.toUpperCase()}`;
}

export function lifecycleTimestamps(
  state: LifecycleSimulationState,
  now = new Date(),
) {
  const timestamp = now.getTime();
  const offset = (days: number) =>
    new Date(timestamp + days * DAY).toISOString();
  switch (state) {
    case "trial_active":
      return { startsAt: offset(0), expiresAt: offset(14) };
    case "near_expiry":
      return { startsAt: offset(-10), expiresAt: offset(4) };
    case "read_only":
      return { startsAt: offset(-15), expiresAt: offset(-1) };
    case "suspended":
      return { startsAt: offset(-22), expiresAt: offset(-8) };
    case "retention":
      return { startsAt: offset(-44), expiresAt: offset(-30) };
    case "deletion_eligible":
      return { startsAt: offset(-104), expiresAt: offset(-90) };
    case "pending_deletion":
      return { startsAt: offset(-105), expiresAt: offset(-91) };
  }
}

function assertState(value: unknown): LifecycleSimulationState {
  const state = inputText(value, "Lifecycle state", {
    min: 9,
    max: 32,
  }) as LifecycleSimulationState;
  if (!(state in STATE_ORDER)) {
    throw new HttpError(
      400,
      "LIFECYCLE_SIMULATION_STATE_INVALID",
      "Select a supported lifecycle state.",
    );
  }
  return state;
}

export class LifecycleSimulationService {
  constructor(
    private readonly store: RecordStore,
    private readonly environment: LifecycleSimulationEnvironment = process.env,
  ) {}

  async createSyntheticTenant(
    identity: AuthenticatedIdentity,
    input: { label: unknown; confirmation: unknown; requestId: string },
    now = new Date(),
  ) {
    assertLifecycleSimulationEnabled(this.environment);
    const confirmation = inputText(input.confirmation, "Typed confirmation", {
      min: LIFECYCLE_SIMULATION_CREATE_CONFIRMATION.length,
      max: LIFECYCLE_SIMULATION_CREATE_CONFIRMATION.length,
    });
    if (confirmation !== LIFECYCLE_SIMULATION_CREATE_CONFIRMATION) {
      throw new HttpError(
        400,
        "LIFECYCLE_SIMULATION_CONFIRMATION_INVALID",
        "The lifecycle simulator confirmation does not match.",
      );
    }
    const label = inputText(input.label, "Simulation label", {
      min: 2,
      max: 64,
    });
    const plan = await resolveSelfServiceTrialPlan(this.store, now);
    const organizationId = resourceId("org");
    const workspaceId = resourceId("workspace");
    const subscriptionId = resourceId("subscription");
    const createdAt = now.toISOString();
    const workspaceName = `[SYNTHETIC] ${label}`;
    const workspace: WorkspaceRecord = {
      organizationId,
      name: workspaceName,
      slug: `${slugify(`synthetic-${label}`)}-${workspaceId.slice(-5)}`,
      status: "active",
      createdAt,
      auditSequence: 0,
      auditHash: "0".repeat(64),
      suspensionReason: null,
      simulation: {
        synthetic: true,
        disposable: true,
        lifecycleAllowed: true,
        createdBy: identity.userId,
        createdAt,
      },
    };
    const organization: OrganizationRecord = {
      legalName: workspaceName,
      displayName: workspaceName,
      primaryContactName: "Synthetic lifecycle operator",
      primaryContactEmail: "lifecycle-simulator@synthetic.knowhow.invalid",
      country: "QA",
      status: "active",
      createdAt,
    };
    const timeline = lifecycleTimestamps("trial_active", now);
    const subscription: SubscriptionRecord = {
      kind: "trial",
      startsAt: timeline.startsAt,
      expiresAt: timeline.expiresAt,
      graceDays: plan.graceDays,
      retentionDays: plan.retentionDays,
      publicTrial: false,
      manualContract: false,
      status: "active",
    };
    await this.store.create(
      TABLES.organizations,
      organizationId,
      rowData(
        {
          slug: `${slugify(`synthetic-${label}`)}-${organizationId.slice(-5)}`,
          status: "active",
          kind: "lifecycle_simulation",
          request_id: input.requestId,
          created_by: identity.userId,
        },
        {
          ...organization,
          simulation: { synthetic: true, disposable: true },
        },
      ),
    );
    await this.store.create(
      TABLES.workspaces,
      workspaceId,
      rowData(
        {
          organization_id: organizationId,
          slug: workspace.slug,
          status: "active",
          kind: "lifecycle_simulation",
          request_id: input.requestId,
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
          kind: "lifecycle_simulation",
          created_by: identity.userId,
        },
        DEFAULT_WORKSPACE_SETTINGS,
      ),
    );
    await this.store.create(
      TABLES.subscriptions,
      subscriptionId,
      rowData(
        {
          organization_id: organizationId,
          workspace_id: workspaceId,
          status: "active",
          kind: "trial",
          request_id: input.requestId,
          created_by: identity.userId,
        },
        {
          ...subscription,
          catalogItemId: plan.catalogItemId,
          catalogVersion: plan.catalogVersion,
          originalExpiresAt: timeline.expiresAt,
          simulationState: "trial_active",
        },
      ),
    );
    for (const [kind, value] of Object.entries(plan.entitlements)) {
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
          { value, source: plan.catalogItemId },
        ),
      );
    }
    await appendAudit(this.store, identity, workspaceId, {
      action: "lifecycle_simulation.tenant_created",
      targetType: "workspace",
      targetId: workspaceId,
      targetLabel: workspaceName,
      summary: "Disposable synthetic lifecycle tenant created",
      metadata: { synthetic: true, disposable: true },
    });
    return {
      organizationId,
      workspaceId,
      workspaceSlug: workspace.slug,
      subscriptionId,
      state: "trial_active" as const,
      confirmation: lifecycleSimulationConfirmation(
        workspace.slug,
        "near_expiry",
      ),
    };
  }

  async simulate(
    identity: AuthenticatedIdentity,
    input: {
      workspaceId: unknown;
      state: unknown;
      confirmation: unknown;
    },
    now = new Date(),
  ) {
    assertLifecycleSimulationEnabled(this.environment);
    const workspaceId = inputText(input.workspaceId, "Workspace", {
      min: 1,
      max: 36,
    });
    const state = assertState(input.state);
    const workspaceRow = await this.store.get(TABLES.workspaces, workspaceId);
    const workspace = workspaceRow
      ? decodePayload<WorkspaceRecord | null>(workspaceRow, null)
      : null;
    if (
      !workspaceRow ||
      !workspace ||
      workspaceRow.kind !== "lifecycle_simulation" ||
      workspace.simulation?.synthetic !== true ||
      workspace.simulation.disposable !== true ||
      workspace.simulation.lifecycleAllowed !== true
    ) {
      throw new HttpError(
        403,
        "LIFECYCLE_SIMULATION_WORKSPACE_FORBIDDEN",
        "Only simulator-created disposable synthetic workspaces can be advanced.",
      );
    }
    const expected = lifecycleSimulationConfirmation(workspace.slug, state);
    const confirmation = inputText(input.confirmation, "Typed confirmation", {
      min: expected.length,
      max: expected.length,
    });
    if (confirmation !== expected) {
      throw new HttpError(
        400,
        "LIFECYCLE_SIMULATION_CONFIRMATION_INVALID",
        "The lifecycle simulator confirmation does not match.",
      );
    }
    const subscriptionRows = await this.store.list(TABLES.subscriptions, {
      filters: [{ field: "workspace_id", value: workspaceId }],
      order: "desc",
      limit: 10,
    });
    const subscriptionRow =
      subscriptionRows.find((row) => row.status !== "cancelled") ??
      subscriptionRows[0];
    const subscription = subscriptionRow
      ? decodePayload<
          | (SubscriptionRecord & {
              simulationState?: LifecycleSimulationState;
            })
          | null
        >(subscriptionRow, null)
      : null;
    if (
      !subscriptionRow ||
      !subscription ||
      subscription.kind !== "trial" ||
      subscription.manualContract
    ) {
      throw new HttpError(
        409,
        "LIFECYCLE_SIMULATION_SUBSCRIPTION_INVALID",
        "The synthetic workspace does not have a simulator trial.",
      );
    }
    const currentState = subscription.simulationState ?? "trial_active";
    if (STATE_ORDER[state] < STATE_ORDER[currentState]) {
      throw new HttpError(
        409,
        "LIFECYCLE_SIMULATION_REWIND_FORBIDDEN",
        "Create a new synthetic tenant instead of rewinding lifecycle history.",
      );
    }
    const timeline = lifecycleTimestamps(state, now);
    await this.store.update(
      TABLES.subscriptions,
      subscriptionRow.$id,
      rowData(
        {
          organization_id: workspace.organizationId,
          workspace_id: workspaceId,
          status: subscription.status,
          kind: "trial",
          updated_by: identity.userId,
        },
        {
          ...subscription,
          startsAt: timeline.startsAt,
          expiresAt: timeline.expiresAt,
          originalExpiresAt: timeline.expiresAt,
          simulationState: state,
          simulatedAt: now.toISOString(),
          simulatedBy: identity.userId,
        },
      ),
    );
    await this.store.update(
      TABLES.workspaces,
      workspaceId,
      rowData(
        {
          organization_id: workspace.organizationId,
          slug: workspace.slug,
          status: workspace.status,
          kind: "lifecycle_simulation",
          updated_by: identity.userId,
        },
        {
          ...workspace,
          simulation: {
            ...workspace.simulation,
            lastState: state,
            lastSimulatedAt: now.toISOString(),
          },
        },
      ),
    );
    const transition = await new LifecycleService(
      this.store,
    ).sweepWorkspaceInTransaction(workspaceId, now);
    await appendAudit(this.store, identity, workspaceId, {
      action: "lifecycle_simulation.advanced",
      targetType: "subscription",
      targetId: subscriptionRow.$id,
      targetLabel: state,
      summary: `Synthetic lifecycle advanced to ${state}`,
      metadata: {
        synthetic: true,
        lifecycleState: state,
        resultingAccess: transition.access,
      },
    });
    return {
      workspaceId,
      subscriptionId: subscriptionRow.$id,
      state,
      access: transition.access,
      startsAt: timeline.startsAt,
      expiresAt: timeline.expiresAt,
      caseCreated: transition.caseCreated,
      nextConfirmation:
        state === "pending_deletion"
          ? null
          : lifecycleSimulationConfirmation(
              workspace.slug,
              (Object.entries(STATE_ORDER).find(
                ([, order]) => order === STATE_ORDER[state] + 1,
              )?.[0] ?? "pending_deletion") as LifecycleSimulationState,
            ),
    };
  }
}
