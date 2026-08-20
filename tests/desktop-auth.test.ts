import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  DesktopAuthService,
  type DesktopDeviceDetails,
} from "../lib/server/desktop-auth-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import type { AuthenticatedIdentity } from "../lib/server/session-identity";
import { seedWorkspace, seedWorkspaceMember } from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-device-signing-secret-with-at-least-thirty-two-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";
process.env.KNOWHOW_DESKTOP_MIN_VERSION = "0.1.0";
process.env.KNOWHOW_PUBLIC_APP_ORIGIN = "https://knowhow.example";

const identity: AuthenticatedIdentity = {
  userId: "desktop-creator",
  email: "desktop.creator@acme.example",
  name: "Desktop Creator",
  emailVerified: true,
  mfaEnabled: true,
};

function request(path: string, body: Record<string, unknown>, headers?: HeadersInit) {
  return new Request(`https://knowhow.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function verifierAndChallenge(seed = "A") {
  const verifier = seed.repeat(43);
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}

async function desktopFixture() {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    subscription: { expiresAt: null, kind: "paid" },
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: identity.userId,
    email: identity.email,
    roles: ["creator"],
  });
  await store.create(
    TABLES.entitlements,
    "entitlement_desktop_capture",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "desktopCaptureEnabled",
        status: "active",
      },
      { value: true },
    ),
  );
  return { store, workspaceId, service: new DesktopAuthService(store) };
}

async function createAuthorization(
  service: DesktopAuthService,
  challenge: string,
  version = "0.1.0",
) {
  return service.createAuthorization(
    request(
      "/api/desktop/v1/authorizations",
      {
        deviceId: "windows-device-0001",
        deviceName: "Creator workstation",
        architecture: "x64",
        desktopVersion: version,
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
      { "idempotency-key": "desktop-auth-test-0001" },
    ),
  );
}

test("desktop device authorization requires browser approval and PKCE", async () => {
  const { service, workspaceId } = await desktopFixture();
  const { verifier, challenge } = verifierAndChallenge();
  const authorization = await createAuthorization(service, challenge);
  assert.equal(
    authorization.verificationUri,
    `https://knowhow.example/desktop/authorize/${authorization.authorizationId}`,
  );

  await assert.rejects(
    service.token(
      request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
        codeVerifier: verifier,
        deviceId: "windows-device-0001",
        architecture: "x64",
        desktopVersion: "0.1.0",
      }),
      authorization.authorizationId,
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "DESKTOP_AUTHORIZATION_PENDING",
  );

  await service.approveAuthorization(identity, workspaceId, authorization.authorizationId);
  await assert.rejects(
    service.token(
      request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
        codeVerifier: "B".repeat(43),
        deviceId: "windows-device-0001",
        architecture: "x64",
        desktopVersion: "0.1.0",
      }),
      authorization.authorizationId,
    ),
    (error: unknown) => error instanceof HttpError && error.code === "PKCE_VERIFIER_INVALID",
  );

  const paired = await service.token(
    request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
      codeVerifier: verifier,
      deviceId: "windows-device-0001",
      architecture: "x64",
      desktopVersion: "0.1.0",
    }),
    authorization.authorizationId,
  );
  assert.equal(paired.workspaceId, workspaceId);
  assert.ok(paired.accessToken.length > 40);
  assert.ok(paired.refreshToken.length > 40);

  const credential = await service.authenticate(
    new Request("https://knowhow.example/api/desktop/v1/context", {
      headers: { authorization: `Bearer ${paired.accessToken}` },
    }),
    ["capture:write"],
  );
  assert.equal(credential.identity.userId, identity.userId);
  assert.equal(credential.access.workspaceRow.$id, workspaceId);
});

test("desktop refresh credentials rotate and reuse revokes the paired device", async () => {
  const { service, store, workspaceId } = await desktopFixture();
  const { verifier, challenge } = verifierAndChallenge("C");
  const authorization = await createAuthorization(service, challenge);
  await service.approveAuthorization(identity, workspaceId, authorization.authorizationId);
  const paired = await service.token(
    request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
      codeVerifier: verifier,
      deviceId: "windows-device-0001",
      architecture: "x64",
      desktopVersion: "0.1.0",
    }),
    authorization.authorizationId,
  );

  const rotated = await service.refresh(
    request("/api/desktop/v1/token/refresh", {
      refreshToken: paired.refreshToken,
      architecture: "x64",
      desktopVersion: "0.1.0",
    }),
  );
  assert.notEqual(rotated.refreshToken, paired.refreshToken);

  await assert.rejects(
    service.refresh(
      request("/api/desktop/v1/token/refresh", {
        refreshToken: paired.refreshToken,
        architecture: "x64",
        desktopVersion: "0.1.0",
      }),
    ),
    (error: unknown) => error instanceof HttpError && error.code === "DEVICE_REFRESH_INVALID",
  );
  const row = await store.get(TABLES.extensionDevices, authorization.authorizationId);
  assert.equal(row?.status, "revoked");
  const details = decodePayload<DesktopDeviceDetails>(row, null as never);
  assert.equal(details.revokedBy, "refresh-reuse-detection");
});

test("desktop authorization enforces version, denial, expiry, and tenant membership", async () => {
  const { service, store, workspaceId } = await desktopFixture();
  const { verifier, challenge } = verifierAndChallenge("D");
  await assert.rejects(
    createAuthorization(service, challenge, "0.0.9"),
    (error: unknown) => error instanceof HttpError && error.status === 426,
  );

  const authorization = await createAuthorization(service, challenge);
  await service.denyAuthorization(identity, workspaceId, authorization.authorizationId);
  await assert.rejects(
    service.token(
      request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
        codeVerifier: verifier,
        deviceId: "windows-device-0001",
        architecture: "x64",
        desktopVersion: "0.1.0",
      }),
      authorization.authorizationId,
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "DESKTOP_AUTHORIZATION_DENIED",
  );

  const expired = await store.update(
    TABLES.extensionDevices,
    authorization.authorizationId,
    { status: "authorization_approved", expires_at: "2026-01-01T00:00:00.000Z" },
  );
  assert.equal(expired.status, "authorization_approved");
  await assert.rejects(
    service.token(
      request(`/api/desktop/v1/authorizations/${authorization.authorizationId}/token`, {
        codeVerifier: verifier,
        deviceId: "windows-device-0001",
        architecture: "x64",
        desktopVersion: "0.1.0",
      }),
      authorization.authorizationId,
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "DESKTOP_AUTHORIZATION_EXPIRED",
  );

  await assert.rejects(
    service.inspectAuthorization(identity, "workspace-not-mine", authorization.authorizationId),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
});
