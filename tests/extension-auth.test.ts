import assert from "node:assert/strict";
import test from "node:test";
import {
  ExtensionAuthService,
  versionAtLeast,
  type ExtensionDeviceDetails,
} from "../lib/server/extension-auth-service";
import { TABLES } from "../lib/server/appwrite-resources";
import { decodePayload, rowData } from "../lib/server/domain-records";
import { HttpError } from "../lib/server/http-security";
import { InMemoryRecordStore } from "../lib/server/record-store";
import { hashToken } from "../lib/server/tokens";
import { seedWorkspace, seedWorkspaceMember } from "./helpers/appwrite-fixtures";

process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({
  test: "test-device-signing-secret-with-at-least-thirty-two-bytes",
});
process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";
process.env.KNOWHOW_EXTENSION_MIN_VERSION = "0.1.0";

function jsonRequest(path: string, body: Record<string, unknown>) {
  return new Request(`https://knowhow.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("extension version policy rejects stale and matching prerelease builds", () => {
  assert.equal(versionAtLeast("0.1.0", "0.1.0"), true);
  assert.equal(versionAtLeast("0.2.0", "0.1.9"), true);
  assert.equal(versionAtLeast("0.1.0-beta.1", "0.1.0"), false);
  assert.equal(versionAtLeast("0.0.9", "0.1.0"), false);
  assert.equal(versionAtLeast("not-semver", "0.1.0"), false);
});

test("pairing is single-use and reused refresh credentials revoke the device", async () => {
  const store = new InMemoryRecordStore();
  const { organizationId, workspaceId } = await seedWorkspace(store, {
    subscription: { expiresAt: null, kind: "paid" },
  });
  await seedWorkspaceMember(store, {
    organizationId,
    workspaceId,
    userId: "creator",
    email: "creator@acme.example",
    roles: ["creator"],
  });
  await store.create(
    TABLES.entitlements,
    "entitlement_extension",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        kind: "extensionEnabled",
        status: "active",
      },
      { value: true },
    ),
  );
  const code = "ABCDEFGHJKLM";
  const pairingDetails: ExtensionDeviceDetails = {
    email: "creator@acme.example",
    displayName: "Creator",
    minimumVersion: "0.1.0",
    scopes: ["capture:write", "media:write"],
    createdAt: new Date().toISOString(),
  };
  await store.create(
    TABLES.extensionDevices,
    "device_pairing_0000000000000001",
    rowData(
      {
        organization_id: organizationId,
        workspace_id: workspaceId,
        user_id: "creator",
        subject_id: await hashToken(code),
        status: "pairing",
        kind: "browser-extension",
        expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
      pairingDetails,
    ),
  );
  const service = new ExtensionAuthService(store);
  const paired = await service.pair(
    jsonRequest("/api/extension/pair", {
      code,
      deviceId: "browser-device-0001",
      extensionVersion: "0.1.0",
    }),
  );
  assert.ok(paired.accessToken.length > 40);
  assert.ok(paired.refreshToken.length > 40);
  assert.equal(paired.workspaceId, workspaceId);

  await assert.rejects(
    service.pair(
      jsonRequest("/api/extension/pair", {
        code,
        deviceId: "browser-device-0002",
        extensionVersion: "0.1.0",
      }),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "PAIRING_CODE_INVALID",
  );

  const rotated = await service.refresh(
    jsonRequest("/api/extension/refresh", {
      refreshToken: paired.refreshToken,
    }),
  );
  assert.notEqual(rotated.refreshToken, paired.refreshToken);

  await assert.rejects(
    service.refresh(
      jsonRequest("/api/extension/refresh", {
        refreshToken: paired.refreshToken,
      }),
    ),
    (error: unknown) =>
      error instanceof HttpError && error.code === "DEVICE_REFRESH_INVALID",
  );
  const device = await store.get(
    TABLES.extensionDevices,
    "device_pairing_0000000000000001",
  );
  assert.equal(device?.status, "revoked");
  const details = decodePayload<ExtensionDeviceDetails>(device, pairingDetails);
  assert.equal(details.revokedBy, "refresh-reuse-detection");
  const auditActions = (await store.list(TABLES.auditSegments)).map(
    (row) => decodePayload<{ action: string }>(row, { action: "" }).action,
  );
  assert.ok(auditActions.includes("capture.device-paired"));
  assert.ok(auditActions.includes("capture.device-refresh-reuse"));
});
