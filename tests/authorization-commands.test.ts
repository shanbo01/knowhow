import assert from "node:assert/strict";
import test from "node:test";
import { AccessService } from "../lib/server/access-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import { decodePayload } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import {
  InMemoryRecordStore,
  RecordConflictError,
  type RecordStore,
} from "../lib/server/record-store";
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

const commandOptions = (suffix: string) => ({
  requestId: `request_${suffix}_0000000000000000`,
  idempotencyKey: `idempotency_${suffix}_0000000000000000`,
  reauthenticated: true,
});

function conflictingTransactionStore(store: RecordStore): RecordStore {
  return new Proxy(store, {
    get(target, property) {
      if (property === "transaction") {
        return async () => {
          throw new RecordConflictError();
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("organization governance never grants workspace guide access", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  await seedOrganizationMember(store, {
    organizationId,
    userId: "org-owner",
    roles: ["owner"],
  });
  const owner = identity("org-owner");
  const access = new AccessService(store);
  assert.deepEqual(
    await access.organizationRoles(organizationId, owner.userId),
    ["owner"],
  );
  assert.equal(await access.workspaceAccess(workspaceId, owner), null);

  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: owner.userId,
    roles: ["viewer"],
  });
  assert.deepEqual((await access.workspaceAccess(workspaceId, owner))?.roles, [
    "viewer",
  ]);
});

test("workspace invitations are exact-email, single-use, and idempotent", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const admin = identity("admin", "admin@acme.example", "Admin");
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: admin.userId,
    email: admin.email,
    roles: ["administrator"],
  });
  const service = new CommandService(store);

  await assert.rejects(
    service.execute(
      admin,
      "createInvite",
      {
        workspaceId,
        role: "viewer",
        email: "person@acme.example",
        maxUses: 2,
      },
      commandOptions("multiuse"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "INPUT_INVALID",
  );

  const options = {
    ...commandOptions("single-invite"),
    idempotencyKey: "i".repeat(128),
  };
  const [first, replay] = (await Promise.all([
    service.execute(
      admin,
      "createInvite",
      { workspaceId, role: "viewer", email: "person@acme.example" },
      options,
    ),
    service.execute(
      admin,
      "createInvite",
      { workspaceId, role: "viewer", email: "person@acme.example" },
      options,
    ),
  ])) as Array<{ id: string; token: string }>;
  assert.equal(replay.id, first.id);
  assert.equal(replay.token, first.token);
  const committedReplay = (await new CommandService(
    conflictingTransactionStore(store),
  ).execute(
    admin,
    "createInvite",
    { workspaceId, role: "viewer", email: "person@acme.example" },
    options,
  )) as { id: string; token: string };
  assert.deepEqual(committedReplay, first);
  assert.equal((await store.list(TABLES.invitations)).length, 1);
  const deliveries = await store.list(TABLES.notificationDeliveries);
  assert.equal(deliveries.length, 1);
  assert.ok(String(deliveries[0].idempotency_key).length <= 128);
  const delivery = decodePayload<Record<string, unknown>>(deliveries[0], {});
  assert.equal(delivery.credential, undefined);
  assert.equal(typeof delivery.credentialEnvelope, "object");
  assert.doesNotMatch(
    String(deliveries[0].payload_json),
    new RegExp(first.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
  assert.equal((await store.list(TABLES.auditSegments)).length, 1);
});

test("last workspace administrator and two-owner governance invariants are atomic", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store);
  const ownerOne = identity("owner-one", "owner-one@acme.example", "Owner One");
  const adminMemberId = `member_${workspaceId}_${ownerOne.userId}`;
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: ownerOne.userId,
    email: ownerOne.email,
    roles: ["administrator"],
  });
  const ownerOneId = await seedOrganizationMember(store, {
    organizationId,
    userId: ownerOne.userId,
    email: ownerOne.email,
    roles: ["owner"],
  });
  const ownerTwoId = await seedOrganizationMember(store, {
    organizationId,
    userId: "owner-two",
    email: "owner-two@acme.example",
    roles: ["owner"],
  });
  const service = new CommandService(store);

  await assert.rejects(
    service.execute(
      ownerOne,
      "updateMember",
      {
        workspaceId,
        memberId: adminMemberId,
        roles: ["viewer"],
        status: "active",
        capabilities: [],
      },
      commandOptions("last-admin"),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "LAST_ADMINISTRATOR",
  );
  assert.equal(
    (await store.get(TABLES.workspaceMembers, adminMemberId))?.status,
    "active",
  );

  await assert.rejects(
    service.execute(
      ownerOne,
      "updateOrganizationMember",
      {
        organizationId,
        memberId: ownerTwoId,
        roles: ["billing"],
        status: "active",
      },
      commandOptions("last-two-owners"),
    ),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "MINIMUM_ORGANIZATION_OWNERS",
  );
  assert.equal(
    (await store.get(TABLES.organizationMemberships, ownerTwoId))?.status,
    "active",
  );

  await seedOrganizationMember(store, {
    organizationId,
    userId: "owner-three",
    email: "owner-three@acme.example",
    roles: ["owner"],
  });
  await service.execute(
    ownerOne,
    "updateOrganizationMember",
    {
      organizationId,
      memberId: ownerTwoId,
      roles: ["billing"],
      status: "active",
    },
    commandOptions("three-owners"),
  );
  assert.ok(await store.get(TABLES.organizationMemberships, ownerOneId));
});
