import assert from "node:assert/strict";
import test from "node:test";
import { BetaAccessService } from "../lib/server/beta-access-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { CommandService } from "../lib/server/command-service";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import {
  registrationMode,
  signupAdmission,
} from "../lib/server/registration-mode";
import { hashToken } from "../lib/server/tokens";
import { identity } from "./helpers/appwrite-fixtures";

function future(milliseconds = 60 * 60 * 1_000) {
  return new Date(Date.now() + milliseconds).toISOString();
}

function grantInput(suffix: string, overrides: Record<string, unknown> = {}) {
  return {
    actorUserId: "platform-owner",
    label: `QA ${suffix}`,
    expiresAt: future(),
    maxUses: 1,
    requestId: `request_${suffix}_0000000000000000`,
    ...overrides,
  } as Parameters<BetaAccessService["createGrant"]>[0];
}

test("beta codes are high-entropy, hash-only, exact-email bound, and consumed once", async () => {
  const store = new InMemoryRecordStore();
  const service = new BetaAccessService(store);
  const created = await service.createGrant(
    grantInput("single", { exactEmail: "Person@Example.COM" }),
  );
  assert.match(created.code, /^khbeta1\.beta_[a-f0-9]+\.[a-f0-9]{64}$/);
  assert.equal(created.grant.exactEmail, "person@example.com");

  const row = await store.get(TABLES.betaAccessGrants, created.grant.id);
  assert.ok(row);
  assert.equal(row.subject_id, await hashToken(created.code));
  assert.doesNotMatch(String(row.payload_json), new RegExp(created.code));
  assert.equal(JSON.stringify(await store.list(TABLES.betaAccessEvents)).includes(created.code), false);

  await assert.rejects(
    service.reserve({ code: created.code, email: "other@example.com" }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BETA_ACCESS_INVALID",
  );
  const reservation = await service.reserve({
    code: created.code,
    email: "PERSON@example.com",
  });
  const admission = await service.consume({
    reservationId: reservation.reservationId,
    email: "person@example.com",
    userId: "user-one",
  });
  assert.equal(admission.grantId, created.grant.id);
  assert.equal(admission.email, "person@example.com");
  assert.equal(admission.usedCount, 1);
  assert.deepEqual(
    await service.getConsumedGrantForUser("user-one", "person@example.com"),
    admission,
  );
  assert.equal(
    await service.getConsumedGrantForUser("user-two", "person@example.com"),
    null,
  );
  assert.equal(
    await service.getConsumedGrantForUser("user-one", "other@example.com"),
    null,
  );
  await assert.rejects(
    service.reserve({ code: created.code, email: "person@example.com" }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BETA_ACCESS_EXHAUSTED",
  );
});

test("capacity reservation is atomic under concurrency and release restores the use", async () => {
  const store = new InMemoryRecordStore();
  const service = new BetaAccessService(store);
  const { code, grant } = await service.createGrant(grantInput("race"));
  const attempts = await Promise.allSettled(
    Array.from({ length: 12 }, (_, index) =>
      service.reserve({ code, email: `person-${index}@example.com` }),
    ),
  );
  const accepted = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<BetaAccessService["reserve"]>>> =>
      result.status === "fulfilled",
  );
  assert.equal(accepted.length, 1);
  assert.equal(
    attempts.filter(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof HttpError &&
        result.reason.code === "BETA_ACCESS_EXHAUSTED",
    ).length,
    11,
  );
  assert.deepEqual(
    await service.release({ reservationId: accepted[0]!.value.reservationId }),
    { released: true },
  );
  const replacement = await service.reserve({ code, email: "replacement@example.com" });
  await service.consume({
    reservationId: replacement.reservationId,
    email: "replacement@example.com",
    userId: "replacement-user",
  });
  const stored = await store.get(TABLES.betaAccessGrants, grant.id);
  const details = decodePayload<{ usedCount: number; reservedCount: number }>(stored, {
    usedCount: -1,
    reservedCount: -1,
  });
  assert.equal(details.usedCount, 1);
  assert.equal(details.reservedCount, 0);
});

test("a reservation can only be consumed by one canonical identity", async () => {
  const store = new InMemoryRecordStore();
  const service = new BetaAccessService(store);
  const { code, grant } = await service.createGrant(grantInput("consume-race"));
  const reservation = await service.reserve({ code, email: "person@example.com" });
  const results = await Promise.allSettled([
    service.consume({
      reservationId: reservation.reservationId,
      email: "person@example.com",
      userId: "user-one",
    }),
    service.consume({
      reservationId: reservation.reservationId,
      email: "person@example.com",
      userId: "user-two",
    }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stored = await store.get(TABLES.betaAccessGrants, grant.id);
  assert.equal(decodePayload<{ usedCount?: number }>(stored, {}).usedCount, 1);
});

test("revocation releases pending reservations and preserves safe platform history", async () => {
  const store = new InMemoryRecordStore();
  const service = new BetaAccessService(store);
  const created = await service.createGrant(grantInput("revoke", { maxUses: 3 }));
  await service.reserve({ code: created.code, email: "one@example.com" });
  const revoked = await service.revokeGrant({
    grantId: created.grant.id,
    actorUserId: "platform-owner",
    requestId: "request_revoke_0000000000000000",
  });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.reservedCount, 0);
  await assert.rejects(
    service.reserve({ code: created.code, email: "two@example.com" }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BETA_ACCESS_INVALID",
  );
  const events = await service.listEvents();
  assert.ok(events.some((event) => event.kind === "released" && event.reason === "grant_revoked"));
  assert.ok(events.some((event) => event.kind === "revoked"));
  assert.equal(JSON.stringify({ grants: await service.listGrants(), events }).includes(created.code), false);
});

test("expired grants fail closed and persist their effective status", async () => {
  const store = new InMemoryRecordStore();
  const service = new BetaAccessService(store);
  const created = await service.createGrant(grantInput("expiry", { expiresAt: future(5) }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  await assert.rejects(
    service.reserve({ code: created.code, email: "person@example.com" }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BETA_ACCESS_EXPIRED",
  );
  assert.equal((await store.get(TABLES.betaAccessGrants, created.grant.id))?.status, "expired");
});

test("platform beta-grant commands require owner or operations plus recent TOTP", async () => {
  const store = new InMemoryRecordStore();
  const owner = identity("platform-owner", "owner@example.com", "Platform Owner");
  await store.create(
    TABLES.platformRoles,
    "platform_role_owner",
    rowData(
      { user_id: owner.userId, kind: "owner", status: "active" },
      {},
    ),
  );
  const service = new CommandService(store);
  const payload = {
    label: "Founder cohort",
    email: "founder@example.com",
    expiresAt: future(),
    maxUses: 1,
  };
  const options = {
    requestId: "request_command_beta_000000000000",
    idempotencyKey: "idempotency_command_beta_00000000",
  };
  await assert.rejects(
    service.execute(owner, "createBetaAccessGrant", payload, options),
    (error: unknown) =>
      error instanceof HttpError && error.code === "TOTP_REAUTH_REQUIRED",
  );
  const result = (await service.execute(owner, "createBetaAccessGrant", payload, {
    ...options,
    reauthenticated: true,
  })) as { grant: { id: string }; code: string };
  assert.match(result.code, /^khbeta1\./);
  const replay = (await service.execute(owner, "createBetaAccessGrant", payload, {
    ...options,
    reauthenticated: true,
  })) as { grant: { id: string }; code: null; replayed: true };
  assert.equal(replay.grant.id, result.grant.id);
  assert.equal(replay.code, null);
  assert.equal(replay.replayed, true);
  for (const row of await store.list(TABLES.idempotencyKeys)) {
    assert.equal(String(row.payload_json).includes(result.code), false);
  }

  const outsider = identity("support-user", "support@example.com", "Support");
  await store.create(
    TABLES.platformRoles,
    "platform_role_support",
    rowData(
      { user_id: outsider.userId, kind: "support", status: "active" },
      {},
    ),
  );
  await assert.rejects(
    service.execute(outsider, "revokeBetaAccessGrant", { grantId: result.grant.id }, {
      requestId: "request_revoke_denied_0000000000",
      idempotencyKey: "idempotency_revoke_denied_000000",
      reauthenticated: true,
    }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "PLATFORM_OPERATIONS_REQUIRED",
  );
});

test("registration policy is explicit, validated, and fails closed", () => {
  assert.equal(registrationMode({}), "disabled");
  assert.equal(
    registrationMode({ KNOWHOW_REGISTRATION_MODE: "private_beta" }),
    "private_beta",
  );
  assert.equal(registrationMode({ KNOWHOW_REGISTRATION_MODE: "open" }), "open");
  assert.throws(
    () => registrationMode({ KNOWHOW_REGISTRATION_MODE: "enabled" }),
    (error: unknown) =>
      error instanceof HttpError &&
      error.code === "REGISTRATION_MODE_INVALID" &&
      error.expose === false,
  );
  assert.equal(
    signupAdmission({
      mode: "disabled",
      credentialKind: "invite",
      hasCredential: true,
    }),
    "signed_credential",
  );
  assert.equal(
    signupAdmission({
      mode: "private_beta",
      credentialKind: "beta",
      hasCredential: true,
    }),
    "beta",
  );
  assert.equal(
    signupAdmission({ mode: "open", hasCredential: false }),
    "open",
  );
  assert.throws(
    () => signupAdmission({ mode: "disabled", hasCredential: false }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "REGISTRATION_DISABLED",
  );
  assert.throws(
    () => signupAdmission({ mode: "private_beta", hasCredential: false }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "BETA_ACCESS_REQUIRED",
  );
  assert.throws(
    () =>
      signupAdmission({
        mode: "open",
        credentialKind: "unknown",
        hasCredential: true,
      }),
    (error: unknown) =>
      error instanceof HttpError && error.code === "SIGNUP_CREDENTIAL_INVALID",
  );
});
