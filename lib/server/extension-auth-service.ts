import { AccessService, type WorkspaceAccess } from "./access-service";
import { appendAudit } from "./audit-service";
import { decodePayload, rowData } from "./domain-records";
import { HttpError, readJsonObject } from "./http-security";
import { inputText } from "./input";
import { TABLES } from "./appwrite-resources";
import { requireAuthorized } from "./policy";
import { EntitlementDeniedError, EntitlementService, recordEntitlementBlocked } from "./entitlement-service";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";
import {
  constantTimeEqual,
  hashToken,
  signDeviceToken,
  verifyDeviceToken,
  type DeviceScope,
} from "./tokens";

const ACCESS_SECONDS = 5 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/;

export type ExtensionDeviceDetails = {
  email: string;
  displayName: string;
  deviceId?: string;
  extensionVersion?: string;
  minimumVersion: string;
  scopes: DeviceScope[];
  createdAt: string;
  pairedAt?: string;
  lastUsedAt?: string;
  toolbarPinnedAt?: string;
  refreshExpiresAt?: string;
  refreshRotation?: number;
  previousRefreshHash?: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type ExtensionCredential = {
  row: StoredRecord<RecordData>;
  details: ExtensionDeviceDetails;
  identity: AuthenticatedIdentity;
  access: WorkspaceAccess;
  scopes: DeviceScope[];
};

function minimumVersion() {
  const configured = process.env.KNOWHOW_EXTENSION_MIN_VERSION?.trim() || "0.1.0";
  if (!VERSION.test(configured)) throw new Error("KNOWHOW_EXTENSION_MIN_VERSION is invalid.");
  return configured;
}

function versionParts(version: string) {
  return version.split("-", 1)[0].split(".").map(Number);
}

export function versionAtLeast(version: string, minimum: string) {
  if (!VERSION.test(version) || !VERSION.test(minimum)) return false;
  const left = versionParts(version);
  const right = versionParts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  // A prerelease never satisfies the same stable minimum.
  return !version.includes("-") || minimum.includes("-");
}

function randomCredential(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A paired device is not a session, so it cannot speak for the account's
 * verification state — the device record stores an address, not whether that
 * address was ever confirmed. This surface authorizes `capture.create` and
 * nothing else, which is deliberately available before verification, so the
 * value is unused today. It is stated as false rather than true so that a
 * verification-gated action added to this surface later fails closed instead
 * of trusting a claim no device is in a position to make.
 */
function identityFrom(row: StoredRecord<RecordData>, details: ExtensionDeviceDetails): AuthenticatedIdentity {
  return {
    userId: String(row.user_id),
    email: details.email,
    name: details.displayName || details.email,
    emailVerified: false,
    mfaEnabled: false,
  };
}

async function accessToken(
  row: StoredRecord<RecordData>,
  details: ExtensionDeviceDetails,
) {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + ACCESS_SECONDS;
  const token = await signDeviceToken({
    jti: row.$id,
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    deviceId: details.deviceId!,
    scopes: details.scopes,
    expiresAt: expiresAtSeconds,
  });
  return {
    accessToken: token,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/.exec(value);
  if (!match) throw new HttpError(401, "DEVICE_AUTH_REQUIRED", "Pair the browser extension to continue.");
  return match[1];
}

export class ExtensionAuthService {
  constructor(private readonly store: RecordStore) {}

  async pair(request: Request) {
    const payload = await readJsonObject(request, 20_000);
    const code = inputText(payload.code, "Pairing code", { min: 12, max: 20 }).toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{12,20}$/.test(code)) {
      throw new HttpError(401, "PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
    }
    const deviceId = inputText(payload.deviceId, "Device ID", { min: 8, max: 128 });
    if (!DEVICE_ID.test(deviceId)) throw new HttpError(400, "DEVICE_ID_INVALID", "The browser device ID is invalid.");
    const extensionVersion = inputText(payload.extensionVersion ?? "0.1.0", "Extension version", { min: 5, max: 64 });
    const currentMinimum = minimumVersion();
    if (!versionAtLeast(extensionVersion, currentMinimum)) {
      throw new HttpError(426, "EXTENSION_UPDATE_REQUIRED", `Update KnowHow Capture to version ${currentMinimum} or later.`);
    }
    const codeHash = await hashToken(code);
    const candidates = await this.store.list(TABLES.extensionDevices, {
      filters: [
        { field: "subject_id", value: codeHash },
        { field: "status", value: "pairing" },
      ],
      limit: 1,
    });
    const candidate = candidates[0];
    if (!candidate || Date.parse(String(candidate.expires_at)) <= Date.now()) {
      throw new HttpError(401, "PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
    }
    const initial = decodePayload<ExtensionDeviceDetails>(candidate, null as never);
    if (!initial?.email || !initial?.displayName) {
      throw new HttpError(401, "PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
    }
    const identity = identityFrom(candidate, initial);
    const accessService = new AccessService(this.store);
    const access = await accessService.requireWorkspace(String(candidate.workspace_id), identity);
    if (!access.membershipRow || access.membershipStatus !== "active") {
      throw new HttpError(403, "PAIRING_NOT_ALLOWED", "This account can no longer pair a capture device.");
    }
    requireAuthorized("capture.create", accessService.context(access));
    await new EntitlementService(this.store, String(candidate.workspace_id)).requireFeature("extensionEnabled");
    const refreshToken = randomCredential();
    const refreshHash = await hashToken(refreshToken);
    const pairedAt = new Date().toISOString();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_SECONDS * 1_000).toISOString();
    let pairedRow!: StoredRecord<RecordData>;
    await this.store.transaction(async (transaction) => {
      const latest = await transaction.get(TABLES.extensionDevices, candidate.$id);
      if (!latest || latest.status !== "pairing" || latest.subject_id !== codeHash || Date.parse(String(latest.expires_at)) <= Date.now()) {
        throw new HttpError(401, "PAIRING_CODE_INVALID", "The pairing code is invalid or expired.");
      }
      for (const row of await transaction.list(TABLES.extensionDevices, {
        filters: [
          { field: "workspace_id", value: String(candidate.workspace_id) },
          { field: "user_id", value: String(candidate.user_id) },
          { field: "status", value: "active" },
        ],
      })) {
        const previous = decodePayload<ExtensionDeviceDetails>(row, null as never);
        if (previous?.deviceId !== deviceId) continue;
        await transaction.update(TABLES.extensionDevices, row.$id, rowData({ status: "revoked", updated_by: identity.userId }, { ...previous, revokedAt: pairedAt, revokedBy: identity.userId }));
      }
      const details: ExtensionDeviceDetails = {
        ...initial,
        deviceId,
        extensionVersion,
        minimumVersion: currentMinimum,
        pairedAt,
        lastUsedAt: pairedAt,
        refreshExpiresAt,
        refreshRotation: 1,
      };
      pairedRow = await transaction.update(
        TABLES.extensionDevices,
        candidate.$id,
        rowData(
          {
            subject_id: refreshHash,
            status: "active",
            kind: "browser-extension",
            expires_at: refreshExpiresAt,
            updated_by: identity.userId,
          },
          details,
        ),
      );
      await appendAudit(transaction, identity, String(candidate.workspace_id), {
        action: "capture.device-paired",
        targetType: "extension-device",
        targetId: candidate.$id,
        summary: "Browser capture extension paired",
        metadata: { deviceId, extensionVersion },
      });
    });
    return {
      ...(await accessToken(pairedRow, decodePayload<ExtensionDeviceDetails>(pairedRow, initial))),
      refreshToken,
      workspaceId: String(candidate.workspace_id),
      minimumVersion: currentMinimum,
    };
  }

  async refresh(request: Request) {
    const payload = await readJsonObject(request, 20_000);
    const refreshToken = inputText(payload.refreshToken, "Device credential", { min: 40, max: 256 });
    const toolbarPinned = payload.toolbarPinned === true;
    if (!/^[A-Za-z0-9_-]+$/.test(refreshToken)) {
      throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The browser credential is invalid or expired.");
    }
    const suppliedHash = await hashToken(refreshToken);
    const candidates = await this.store.list(TABLES.extensionDevices, {
      filters: [
        { field: "subject_id", value: suppliedHash },
        { field: "status", value: "active" },
      ],
      limit: 1,
    });
    let current = candidates[0];
    if (!current) {
      const active = await this.store.list(TABLES.extensionDevices, {
        filters: [{ field: "status", value: "active" }],
      });
      const reused = active.find((row) => {
        const details = decodePayload<ExtensionDeviceDetails>(row, null as never);
        return Boolean(details?.previousRefreshHash && constantTimeEqual(details.previousRefreshHash, suppliedHash));
      });
      if (reused) {
        const details = decodePayload<ExtensionDeviceDetails>(reused, null as never);
        const identity = identityFrom(reused, details);
        await this.store.transaction(async (transaction) => {
          await transaction.update(TABLES.extensionDevices, reused.$id, rowData({ status: "revoked", updated_by: identity.userId }, { ...details, revokedAt: new Date().toISOString(), revokedBy: "refresh-reuse-detection" }));
          await appendAudit(transaction, identity, String(reused.workspace_id), { action: "capture.device-refresh-reuse", targetType: "extension-device", targetId: reused.$id, summary: "Reused browser refresh credential revoked" });
        });
      }
      throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The browser credential is invalid or expired.");
    }
    const currentDetails = decodePayload<ExtensionDeviceDetails>(current, null as never);
    if (
      !currentDetails?.deviceId || !currentDetails.refreshExpiresAt ||
      Date.parse(currentDetails.refreshExpiresAt) <= Date.now() ||
      Date.parse(String(current.expires_at)) <= Date.now()
    ) {
      throw new HttpError(401, "DEVICE_REFRESH_EXPIRED", "The browser credential has expired.");
    }
    const currentMinimum = minimumVersion();
    if (!versionAtLeast(currentDetails.extensionVersion ?? "0.0.0", currentMinimum)) {
      throw new HttpError(426, "EXTENSION_UPDATE_REQUIRED", `Update KnowHow Capture to version ${currentMinimum} or later.`);
    }
    const nextRefresh = randomCredential();
    const nextHash = await hashToken(nextRefresh);
    const refreshedAt = new Date().toISOString();
    try {
      await this.store.transaction(async (transaction) => {
        const latest = await transaction.get(TABLES.extensionDevices, current!.$id);
        if (!latest || latest.status !== "active" || latest.subject_id !== suppliedHash) {
          throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The browser credential was already rotated.");
        }
        const accessService = new AccessService(transaction);
        const latestDetails = decodePayload<ExtensionDeviceDetails>(latest, currentDetails);
        const latestIdentity = identityFrom(latest, latestDetails);
        const access = await accessService.requireWorkspace(String(latest.workspace_id), latestIdentity);
        if (!access.membershipRow) throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Workspace membership ended.");
        requireAuthorized("capture.create", accessService.context(access));
        await new EntitlementService(transaction, String(latest.workspace_id)).requireFeature("extensionEnabled");
        current = await transaction.update(TABLES.extensionDevices, latest.$id, rowData({ subject_id: nextHash, updated_by: latestIdentity.userId }, { ...latestDetails, minimumVersion: currentMinimum, previousRefreshHash: suppliedHash, refreshRotation: Number(latestDetails.refreshRotation ?? 0) + 1, lastUsedAt: refreshedAt, ...(toolbarPinned ? { toolbarPinnedAt: latestDetails.toolbarPinnedAt ?? refreshedAt } : {}) }));
      });
    } catch (error) {
      if (error instanceof EntitlementDeniedError) {
        await recordEntitlementBlocked(
          this.store,
          String(current.workspace_id),
          error.entitlementKind,
        );
      }
      throw error;
    }
    return {
      ...(await accessToken(current, decodePayload<ExtensionDeviceDetails>(current, currentDetails))),
      refreshToken: nextRefresh,
      workspaceId: String(current.workspace_id),
      minimumVersion: currentMinimum,
    };
  }

  async authenticate(request: Request, requiredScopes: readonly DeviceScope[]): Promise<ExtensionCredential> {
    const claims = await verifyDeviceToken(bearer(request));
    const row = await this.store.get(TABLES.extensionDevices, claims.jti);
    const details = row ? decodePayload<ExtensionDeviceDetails>(row, null as never) : null;
    if (
      !row || row.status !== "active" || !details?.deviceId ||
      row.workspace_id !== claims.workspaceId || row.user_id !== claims.userId ||
      details.deviceId !== claims.deviceId || Date.parse(String(row.expires_at)) <= Date.now() ||
      requiredScopes.some((scope) => !claims.scopes.includes(scope) || !details.scopes.includes(scope))
    ) {
      throw new HttpError(401, "DEVICE_CREDENTIAL_REVOKED", "The browser credential is invalid or revoked.");
    }
    const currentMinimum = minimumVersion();
    if (!versionAtLeast(details.extensionVersion ?? "0.0.0", currentMinimum)) {
      throw new HttpError(426, "EXTENSION_UPDATE_REQUIRED", `Update KnowHow Capture to version ${currentMinimum} or later.`);
    }
    const identity = identityFrom(row, details);
    const accessService = new AccessService(this.store);
    const access = await accessService.requireWorkspace(claims.workspaceId, identity);
    if (!access.membershipRow) throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Workspace membership ended.");
    requireAuthorized("capture.create", accessService.context(access));
    await new EntitlementService(this.store, claims.workspaceId).requireFeature("extensionEnabled");
    const lastUsed = Date.parse(details.lastUsedAt ?? "");
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > 5 * 60 * 1_000) {
      await this.store.update(TABLES.extensionDevices, row.$id, rowData({ updated_by: identity.userId }, { ...details, lastUsedAt: new Date().toISOString(), minimumVersion: currentMinimum }));
    }
    return { row, details, identity, access, scopes: [...claims.scopes] };
  }
}
