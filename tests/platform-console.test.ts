import assert from "node:assert/strict";
import test from "node:test";
import { TABLES } from "../lib/server/appwrite-resources";
import { BootstrapService } from "../lib/server/bootstrap-service";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData, type OrganizationRecord } from "../lib/server/domain-records";
import { PlatformQueryService } from "../lib/server/platform-query-service";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  parseAppRoute,
  platformCanonicalPath,
} from "../lib/workspace-routes";
import {
  identity,
  seedOrganizationMember,
  seedWorkspace,
  seedWorkspaceMember,
} from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-signing-secret-with-at-least-thirty-two-random-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";

const ORDINARY_EMAIL = "ordinary.viewer@client.example";
const ADMIN_EMAIL = "admin@client.example";

const options = (suffix: string) => ({
  requestId: `request_platform_${suffix}_0000000000`,
  idempotencyKey: `idempotency_platform_${suffix}_0000000000`,
  reauthenticated: true,
});

async function seedPlatformRole(
  store: InMemoryRecordStore,
  userId: string,
  role: "owner" | "operations" | "support",
) {
  await store.create(
    TABLES.platformRoles,
    `platform_${role}_${userId}`,
    rowData(
      {
        user_id: userId,
        kind: role,
        status: "active",
        created_by: "seed",
      },
      { role },
    ),
  );
}

async function seedClient(store: InMemoryRecordStore) {
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    organizationId: "org_client",
    workspaceId: "workspace_client",
    workspaceName: "Client Operations",
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: "user_client_admin",
    email: ADMIN_EMAIL,
    roles: ["administrator"],
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: "user_client_viewer",
    email: ORDINARY_EMAIL,
    roles: ["viewer"],
  });
  await seedOrganizationMember(store, {
    organizationId,
    userId: "user_client_admin",
    email: ADMIN_EMAIL,
    roles: ["owner", "billing"],
  });
  return { organizationId, workspaceId };
}

test("platform bootstrap does not hydrate customer member directories", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  await seedClient(store);

  const bootstrap = await new BootstrapService(store).bootstrap(operator);
  assert.ok(bootstrap.platform);
  assert.equal(bootstrap.activeWorkspace, null);
  const serialized = JSON.stringify(bootstrap);
  assert.equal(serialized.includes(ORDINARY_EMAIL), false);
  assert.equal(serialized.includes(ADMIN_EMAIL), false);
  assert.equal("workspaces" in (bootstrap.platform ?? {}), false);
  assert.equal("leads" in (bootstrap.platform ?? {}), false);
  assert.equal("betaAccess" in (bootstrap.platform ?? {}), false);
});

test("account list stays company-scoped and detail returns admins plus seat count", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  const { workspaceId } = await seedClient(store);
  const query = new PlatformQueryService(store);

  const list = await query.listAccounts(operator, { limit: "20" });
  assert.equal(list.items.length, 1);
  assert.equal(list.items[0]?.id, workspaceId);
  assert.equal("administrators" in (list.items[0] ?? {}), false);
  assert.equal(JSON.stringify(list).includes(ORDINARY_EMAIL), false);

  const account = await query.account(operator, workspaceId);
  assert.equal(account.memberCount, 2);
  assert.deepEqual(
    account.administrators.map((person) => person.email),
    [ADMIN_EMAIL],
  );
  assert.ok(account.billingContacts.some((person) => person.email === ADMIN_EMAIL));
  assert.equal(JSON.stringify(account).includes(ORDINARY_EMAIL), false);
});

test("exact member email search finds the client workspace", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  const { workspaceId } = await seedClient(store);
  const found = await new PlatformQueryService(store).search(
    operator,
    ORDINARY_EMAIL,
  );
  assert.ok(
    found.results.some(
      (hit) => hit.kind === "person" && hit.href.includes(workspaceId),
    ),
  );
});

test("updateLead and convertLead move a public request into provisioning", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  const occurredAt = "2026-08-16T08:00:00.000Z";
  await store.create(
    TABLES.leads,
    "lead_acme",
    rowData(
      {
        email: "pat@acme.example",
        status: "new",
        kind: "contact",
        occurred_at: occurredAt,
        created_by: "public",
      },
      {
        kind: "contact",
        name: "Pat Lee",
        email: "pat@acme.example",
        organization: "Acme Logistics",
        role: "Operations",
        teamSize: 40,
        country: "QA",
        workflow: "Warehouse intake",
        ordinaryDataOnly: true,
        occurredAt,
      },
    ),
  );
  const commands = new CommandService(store);
  await commands.execute(
    operator,
    "updateLead",
    { leadId: "lead_acme", status: "qualified", notes: "Ready to provision." },
    options("update_lead"),
  );
  const updated = await store.get(TABLES.leads, "lead_acme");
  assert.equal(updated?.status, "qualified");
  assert.equal(
    decodePayload<{ notes?: string }>(updated!, {}).notes,
    "Ready to provision.",
  );

  const converted = (await commands.execute(
    operator,
    "convertLead",
    { leadId: "lead_acme" },
    options("convert_lead"),
  )) as { runId: string; converted: boolean };
  assert.equal(converted.converted, true);
  const lead = await store.get(TABLES.leads, "lead_acme");
  assert.equal(lead?.status, "converted");
  const run = await store.get(TABLES.provisioningRuns, converted.runId);
  assert.ok(run);
  assert.equal(run.status, "draft");
});

test("platform support can reply to a ticket without workspace membership", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-support",
    "support@knowhow.test",
    "Support Operator",
  );
  await seedPlatformRole(store, operator.userId, "support");
  const { organizationId, workspaceId } = await seedClient(store);
  const createdAt = "2026-08-16T09:00:00.000Z";
  await store.create(
    TABLES.supportTickets,
    "ticket_client",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: "user_client_admin",
        email: ADMIN_EMAIL,
        status: "waiting_support",
        kind: "in_app",
        occurred_at: createdAt,
        created_by: "user_client_admin",
      },
      {
        subject: "Cannot publish a guide",
        requesterName: "Client Admin",
        createdAt,
        updatedAt: createdAt,
        responseTargetAt: "2026-08-17T09:00:00.000Z",
      },
    ),
  );

  await new CommandService(store).execute(
    operator,
    "replySupportTicket",
    { ticketId: "ticket_client", message: "We received this and will look now." },
    options("reply_ticket"),
  );
  const ticket = await store.get(TABLES.supportTickets, "ticket_client");
  assert.equal(ticket?.status, "waiting_customer");
  const messages = await store.list(TABLES.supportMessages, {
    filters: [{ field: "subject_id", value: "ticket_client" }],
  });
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.kind, "support");
  assert.equal(
    decodePayload<{ authorKind?: string }>(messages[0]!, {}).authorKind,
    "support",
  );
});

test("in-memory record lists honor cursorAfter and reject unknown cursors", async () => {
  const store = new InMemoryRecordStore();
  for (const id of ["lead_c", "lead_a", "lead_b"]) {
    await store.create(
      TABLES.leads,
      id,
      rowData(
        {
          email: `${id}@example.com`,
          status: "new",
          kind: "contact",
          created_by: "public",
        },
        { name: id },
      ),
    );
  }
  const first = await store.list(TABLES.leads, {
    orderBy: "$id",
    order: "asc",
    limit: 2,
  });
  assert.deepEqual(
    first.map((row) => row.$id),
    ["lead_a", "lead_b"],
  );
  const next = await store.list(TABLES.leads, {
    orderBy: "$id",
    order: "asc",
    limit: 2,
    cursor: "lead_b",
  });
  assert.deepEqual(
    next.map((row) => row.$id),
    ["lead_c"],
  );
  const missing = await store.list(TABLES.leads, {
    orderBy: "$id",
    order: "asc",
    limit: 2,
    cursor: "missing",
  });
  assert.equal(missing.length, 0);
});

test("legacy platform URLs map onto the rebuilt operator IA", () => {
  const accounts = parseAppRoute("/platform/accounts");
  assert.equal(accounts.kind, "platform");
  if (accounts.kind === "platform") {
    assert.equal(accounts.section, "customers");
  }
  assert.equal(platformCanonicalPath("/platform/accounts"), "/platform/customers");
  assert.equal(platformCanonicalPath("/platform/ops"), "/platform/tools");
  assert.equal(platformCanonicalPath("/platform/billing"), "/platform/tools");
  assert.equal(platformCanonicalPath("/platform/customers"), null);
});

test("founder home queues trials, domain clusters, and excludes VIP accounts", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  const { organizationId, workspaceId } = await seedClient(store);
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: "user_client_ops",
    email: "ops@client.example",
    roles: ["viewer"],
  });
  const trialEnds = new Date(Date.now() + 3 * 86_400_000).toISOString();
  const { organizationId: trialOrg, workspaceId: trialWorkspace } = await seedWorkspace(
    store,
    {
      organizationId: "org_trial",
      workspaceId: "workspace_trial",
      workspaceName: "Trial Co",
      subscription: {
        kind: "trial",
        plan: "pro_trial",
        startsAt: new Date().toISOString(),
        expiresAt: trialEnds,
        graceDays: 0,
        retentionDays: 90,
        publicTrial: false,
        manualContract: false,
        status: "active",
        trialConsumed: true,
      },
    },
  );
  await seedWorkspaceMember(store, {
    organizationId: trialOrg,
    workspaceId: trialWorkspace,
    userId: "user_trial_admin",
    email: "admin@trialco.qa",
    roles: ["administrator"],
  });
  const { organizationId: vipOrg, workspaceId: vipWorkspace } = await seedWorkspace(
    store,
    {
      organizationId: "org_vip",
      workspaceId: "workspace_vip",
      workspaceName: "Partner Lab",
      subscription: {
        kind: "trial",
        plan: "pro_trial",
        startsAt: new Date().toISOString(),
        expiresAt: trialEnds,
        graceDays: 0,
        retentionDays: 90,
        publicTrial: false,
        manualContract: false,
        status: "active",
        complimentary: true,
        trialConsumed: true,
      },
    },
  );
  const vipRow = await store.get(TABLES.organizations, vipOrg);
  const vipOrgRecord = decodePayload<OrganizationRecord>(vipRow!, null as never);
  await store.update(
    TABLES.organizations,
    vipOrg,
    rowData(
      { slug: vipOrg, status: "active", created_by: "seed" },
      { ...vipOrgRecord, accountTags: ["partner"] },
    ),
  );
  await seedWorkspaceMember(store, {
    organizationId: vipOrg,
    workspaceId: vipWorkspace,
    userId: "user_vip_admin",
    email: "partner@knowhow.test",
    roles: ["administrator"],
  });
  const home = await new PlatformQueryService(store).home(operator);
  const trialQueue = home.queues.find((queue) => queue.id === "trials");
  assert.ok(trialQueue?.items.some((item) => item.workspaceId === trialWorkspace));
  assert.equal(
    trialQueue?.items.some((item) => item.workspaceId === vipWorkspace),
    false,
  );
  const enterprise = home.queues.find((queue) => queue.id === "enterprise");
  assert.ok(
    enterprise?.items.some((item) => item.organizationName === "@client.example"),
  );
});

test("customer 360 counts export requests, storage, and same-domain siblings", async () => {
  const store = new InMemoryRecordStore();
  const operator = identity(
    "platform-owner",
    "platform-owner@knowhow.test",
    "Platform Owner",
  );
  await seedPlatformRole(store, operator.userId, "owner");
  const { organizationId, workspaceId } = await seedClient(store);
  const clientOrg = await store.get(TABLES.organizations, organizationId);
  const clientOrgRecord = decodePayload<OrganizationRecord>(clientOrg!, null as never);
  await store.update(
    TABLES.organizations,
    organizationId,
    rowData(
      { slug: organizationId, status: "active", created_by: "seed" },
      { ...clientOrgRecord, primaryContactEmail: ADMIN_EMAIL },
    ),
  );
  const { workspaceId: siblingId } = await seedWorkspace(store, {
    organizationId: "org_sibling",
    workspaceId: "workspace_sibling",
    workspaceName: "Client HQ",
    subscription: {
      kind: "trial",
      plan: "free",
      startsAt: "2026-01-01T00:00:00.000Z",
      expiresAt: null,
      graceDays: 0,
      retentionDays: 90,
      publicTrial: false,
      manualContract: false,
      status: "active",
    },
  });
  await seedWorkspaceMember(store, {
    organizationId: "org_sibling",
    workspaceId: siblingId,
    userId: "user_sibling_admin",
    email: "finance@client.example",
    roles: ["administrator"],
  });
  const occurredAt = new Date().toISOString();
  await store.create(
    TABLES.usageEvents,
    "usage_export",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "guide.export-requested",
        status: "recorded",
        occurred_at: occurredAt,
        created_by: "seed",
      },
      {},
    ),
  );
  await store.create(
    TABLES.usageEvents,
    "usage_capture",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "capture.completed",
        status: "recorded",
        occurred_at: occurredAt,
        created_by: "seed",
      },
      {},
    ),
  );
  await store.create(
    TABLES.privateMedia,
    "media_shot",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        status: "ready",
        kind: "screenshot",
        created_by: "seed",
      },
      {
        guideId: "guide_1",
        revisionId: "rev_1",
        stepId: "step_1",
        storageFileId: "file_1",
        filename: "shot.png",
        contentType: "image/png",
        byteSize: 2_000_000,
        width: 800,
        height: 600,
        sha256: "a".repeat(64),
        redactionState: "redacted",
        sourceRasterized: true,
        uploadedBy: "seed",
        createdAt: occurredAt,
        deletedAt: null,
      },
    ),
  );
  await store.create(
    TABLES.extensionDevices,
    "device_live",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: "user_client_admin",
        status: "active",
        kind: "browser-extension",
        created_by: "seed",
      },
      { lastUsedAt: occurredAt, extensionVersion: "0.4.0" },
    ),
  );
  const account = await new PlatformQueryService(store).account(operator, workspaceId);
  assert.equal(account.usage?.exportRequests, 1);
  assert.equal(account.usage?.captures, 1);
  assert.equal(account.usage?.storageBytes, 2_000_000);
  assert.equal(account.extension?.lastUsedAt, occurredAt);
  assert.ok(account.domainSiblings?.some((item) => item.workspaceId === siblingId));
});

