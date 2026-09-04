import { AccessService, type WorkspaceAccess } from "./access-service";
import { appendAudit } from "./audit-service";
import { TABLES } from "./appwrite-resources";
import { decodePayload, rowData } from "./domain-records";
import {
  EntitlementDeniedError,
  EntitlementService,
  recordEntitlementBlocked,
} from "./entitlement-service";
import { versionAtLeast } from "./extension-auth-service";
import { HttpError, readJsonObject } from "./http-security";
import { deterministicResourceId } from "./ids";
import { inputText } from "./input";
import { requireAuthorized } from "./policy";
import type { RecordData, RecordStore, StoredRecord } from "./record-store";
import type { AuthenticatedIdentity } from "./session-identity";
import {
  constantTimeEqual,
  hashToken,
  randomTokenId,
  signDeviceToken,
  verifyDeviceToken,
  type DeviceScope,
} from "./tokens";

const ACCESS_SECONDS = 5 * 60;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const AUTHORIZATION_SECONDS = 10 * 60;
const DEVICE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const AUTHORIZATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.-]{1,40})?$/;
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;

export type DesktopArchitecture = "x64" | "arm64";

export type DesktopDeviceDetails = {
  deviceId: string;
  deviceName: string;
  architecture: DesktopArchitecture;
  desktopVersion: string;
  minimumVersion: string;
  scopes: DeviceScope[];
  createdAt: string;
  codeChallenge?: string;
  email?: string;
  displayName?: string;
  workspaceName?: string;
  approvedAt?: string;
  approvedBy?: string;
  deniedAt?: string;
  deniedBy?: string;
  pairedAt?: string;
  lastUsedAt?: string;
  refreshExpiresAt?: string;
  refreshRotation?: number;
  previousRefreshHash?: string;
  revokedAt?: string;
  revokedBy?: string;
};

export type DesktopCredential = {
  row: StoredRecord<RecordData>;
  details: DesktopDeviceDetails;
  identity: AuthenticatedIdentity;
  access: WorkspaceAccess;
  scopes: DeviceScope[];
};

export type DesktopDeviceSummary = {
  id: string;
  deviceId: string;
  name: string;
  architecture: DesktopArchitecture;
  version: string;
  minimumVersion: string;
  status: "active" | "approved" | "revoked";
  pairedAt: string | null;
  lastUsedAt: string | null;
  refreshExpiresAt: string | null;
};

function minimumVersion() {
  const configured = process.env.KNOWHOW_DESKTOP_MIN_VERSION?.trim() || "0.1.0";
  if (!VERSION.test(configured)) {
    throw new Error("KNOWHOW_DESKTOP_MIN_VERSION is invalid.");
  }
  return configured;
}

function publicOrigin(request: Request) {
  const configured = process.env.KNOWHOW_PUBLIC_APP_ORIGIN?.trim();
  const candidate = configured || new URL(request.url).origin;
  let origin: URL;
  try {
    origin = new URL(candidate);
  } catch {
    throw new HttpError(500, "PUBLIC_ORIGIN_INVALID", "Device authorization is unavailable.", {
      expose: false,
    });
  }
  const controlled =
    process.env.KNOWHOW_ENVIRONMENT === "production" ||
    process.env.KNOWHOW_ENVIRONMENT === "staging";
  if (
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    (controlled && origin.protocol !== "https:") ||
    (!controlled && origin.protocol !== "https:" && origin.protocol !== "http:")
  ) {
    throw new HttpError(500, "PUBLIC_ORIGIN_INVALID", "Device authorization is unavailable.", {
      expose: false,
    });
  }
  return origin.origin;
}

function desktopVersion(value: unknown) {
  const version = inputText(value ?? "0.1.0", "Desktop version", {
    min: 5,
    max: 64,
  });
  if (!VERSION.test(version)) {
    throw new HttpError(400, "DESKTOP_VERSION_INVALID", "The desktop app version is invalid.");
  }
  const currentMinimum = minimumVersion();
  if (!versionAtLeast(version, currentMinimum)) {
    throw new HttpError(
      426,
      "DESKTOP_UPDATE_REQUIRED",
      `Update KnowHow Capture to version ${currentMinimum} or later.`,
    );
  }
  return { version, currentMinimum };
}

function architecture(value: unknown): DesktopArchitecture {
  if (value !== "x64" && value !== "arm64") {
    throw new HttpError(
      400,
      "DESKTOP_ARCHITECTURE_INVALID",
      "The Windows architecture must be x64 or arm64.",
    );
  }
  return value;
}

function authorizationId(value: string) {
  const id = value.trim();
  if (!AUTHORIZATION_ID.test(id)) {
    throw new HttpError(
      400,
      "DESKTOP_AUTHORIZATION_INVALID",
      "The device authorization is invalid.",
    );
  }
  return id;
}

function bearer(request: Request) {
  const value = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9._~-]{20,8192})$/.exec(value);
  if (!match) {
    throw new HttpError(
      401,
      "DEVICE_AUTH_REQUIRED",
      "Connect KnowHow Capture to continue.",
    );
  }
  return match[1];
}

function identityFrom(
  row: StoredRecord<RecordData>,
  details: DesktopDeviceDetails,
): AuthenticatedIdentity {
  if (!details.email || !details.displayName || !row.user_id) {
    throw new HttpError(
      401,
      "DEVICE_CREDENTIAL_INVALID",
      "The desktop credential is incomplete.",
    );
  }
  // A paired device cannot speak for the account's verification state; it
  // holds an address, not a confirmation of one. This surface authorizes
  // `capture.create` and nothing else, which is available before verification,
  // so the value is unused today — and stated as false so that anything
  // verification-gated added here later fails closed.
  return {
    userId: String(row.user_id),
    email: details.email,
    name: details.displayName,
    emailVerified: false,
    mfaEnabled: false,
  };
}

async function accessToken(
  row: StoredRecord<RecordData>,
  details: DesktopDeviceDetails,
) {
  const expiresAtSeconds = Math.floor(Date.now() / 1_000) + ACCESS_SECONDS;
  const token = await signDeviceToken({
    jti: row.$id,
    workspaceId: String(row.workspace_id),
    userId: String(row.user_id),
    deviceId: details.deviceId,
    scopes: details.scopes,
    expiresAt: expiresAtSeconds,
  });
  return {
    accessToken: token,
    expiresAt: new Date(expiresAtSeconds * 1_000).toISOString(),
  };
}

async function s256(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export class DesktopAuthService {
  constructor(private readonly store: RecordStore) {}

  private async workspaceAccess(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    requireEntitlement = true,
  ) {
    const accessService = new AccessService(this.store);
    const access = await accessService.requireWorkspace(workspaceId, identity);
    if (!access.membershipRow || access.membershipStatus !== "active") {
      throw new HttpError(
        403,
        "MEMBERSHIP_REQUIRED",
        "An active workspace membership is required.",
      );
    }
    requireAuthorized("capture.create", accessService.context(access));
    if (requireEntitlement) {
      await new EntitlementService(this.store, workspaceId).requireFeature(
        "desktopCaptureEnabled",
      );
    }
    return access;
  }

  async createAuthorization(request: Request) {
    const payload = await readJsonObject(request, 20_000);
    const deviceId = inputText(payload.deviceId, "Device ID", {
      min: 8,
      max: 128,
    });
    if (!DEVICE_ID.test(deviceId)) {
      throw new HttpError(
        400,
        "DEVICE_ID_INVALID",
        "The Windows device ID is invalid.",
      );
    }
    const deviceName = inputText(payload.deviceName, "Device name", {
      min: 1,
      max: 100,
    });
    const targetArchitecture = architecture(payload.architecture);
    const version = desktopVersion(payload.desktopVersion);
    const codeChallenge = inputText(payload.codeChallenge, "Code challenge", {
      min: 43,
      max: 43,
    });
    if (!PKCE_CHALLENGE.test(codeChallenge) || payload.codeChallengeMethod !== "S256") {
      throw new HttpError(
        400,
        "PKCE_CHALLENGE_INVALID",
        "A valid S256 device challenge is required.",
      );
    }
    const idempotencyKey = inputText(
      request.headers.get("idempotency-key"),
      "Idempotency key",
      { min: 16, max: 128 },
    );
    const id = await deterministicResourceId(
      "deskauth",
      `${deviceId}:${idempotencyKey}`,
    );
    const existing = await this.store.get(TABLES.extensionDevices, id);
    if (existing) {
      const details = decodePayload<DesktopDeviceDetails>(existing, null as never);
      if (
        existing.kind !== "desktop-authorization" ||
        details?.deviceId !== deviceId ||
        details?.codeChallenge !== codeChallenge
      ) {
        throw new HttpError(
          409,
          "DESKTOP_AUTHORIZATION_CONFLICT",
          "This authorization request conflicts with an earlier request.",
        );
      }
      return this.authorizationResponse(request, existing, details);
    }
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + AUTHORIZATION_SECONDS * 1_000).toISOString();
    const details: DesktopDeviceDetails = {
      deviceId,
      deviceName,
      architecture: targetArchitecture,
      desktopVersion: version.version,
      minimumVersion: version.currentMinimum,
      scopes: ["capture:write", "media:write"],
      createdAt,
      codeChallenge,
    };
    const row = await this.store.create(
      TABLES.extensionDevices,
      id,
      rowData(
        {
          subject_id: await hashToken(`desktop-authorization:${id}`),
          status: "authorization_pending",
          kind: "desktop-authorization",
          expires_at: expiresAt,
          idempotency_key: idempotencyKey,
          created_by: "desktop-client",
        },
        details,
      ),
    );
    return this.authorizationResponse(request, row, details);
  }

  private authorizationResponse(
    request: Request,
    row: StoredRecord<RecordData>,
    details: DesktopDeviceDetails,
  ) {
    return {
      authorizationId: row.$id,
      verificationUri: new URL(
        `/desktop/authorize/${encodeURIComponent(row.$id)}`,
        publicOrigin(request),
      ).toString(),
      expiresAt: String(row.expires_at),
      intervalSeconds: 2,
      device: {
        id: details.deviceId,
        name: details.deviceName,
        architecture: details.architecture,
      },
    };
  }

  async inspectAuthorization(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    requestedId: string,
  ) {
    const access = await this.workspaceAccess(identity, workspaceId);
    const id = authorizationId(requestedId);
    const row = await this.store.get(TABLES.extensionDevices, id);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (!row || row.kind !== "desktop-authorization" || !details) {
      throw new HttpError(
        404,
        "DESKTOP_AUTHORIZATION_NOT_FOUND",
        "This desktop authorization is unavailable.",
      );
    }
    const expired = Date.parse(String(row.expires_at)) <= Date.now();
    return {
      authorizationId: id,
      status: expired ? "expired" : String(row.status),
      expiresAt: String(row.expires_at),
      workspace: {
        id: workspaceId,
        name: access.workspace.name,
      },
      device: {
        id: details.deviceId,
        name: details.deviceName,
        architecture: details.architecture,
        version: details.desktopVersion,
      },
    };
  }

  async approveAuthorization(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    requestedId: string,
  ) {
    const access = await this.workspaceAccess(identity, workspaceId);
    const id = authorizationId(requestedId);
    const row = await this.store.get(TABLES.extensionDevices, id);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (!row || row.kind !== "desktop-authorization" || !details) {
      throw new HttpError(404, "DESKTOP_AUTHORIZATION_NOT_FOUND", "This desktop authorization is unavailable.");
    }
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      throw new HttpError(410, "DESKTOP_AUTHORIZATION_EXPIRED", "This desktop authorization has expired.");
    }
    if (row.status === "authorization_approved") {
      if (row.workspace_id !== workspaceId || row.user_id !== identity.userId) {
        throw new HttpError(409, "DESKTOP_AUTHORIZATION_CLAIMED", "This desktop authorization was approved elsewhere.");
      }
      return { authorizationId: id, status: "approved" as const };
    }
    if (row.status !== "authorization_pending") {
      throw new HttpError(409, "DESKTOP_AUTHORIZATION_UNAVAILABLE", "This desktop authorization can no longer be approved.");
    }
    const approvedAt = new Date().toISOString();
    await this.store.update(
      TABLES.extensionDevices,
      id,
      rowData(
        {
          organization_id: access.workspace.organizationId,
          workspace_id: workspaceId,
          user_id: identity.userId,
          status: "authorization_approved",
          updated_by: identity.userId,
        },
        {
          ...details,
          email: identity.email,
          displayName: identity.name || identity.email,
          workspaceName: access.workspace.name,
          approvedAt,
          approvedBy: identity.userId,
        },
      ),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "capture.desktop-authorization-approved",
      targetType: "desktop-device",
      targetId: id,
      targetLabel: details.deviceName,
      summary: "Windows capture device approved",
      metadata: {
        deviceId: details.deviceId,
        architecture: details.architecture,
        desktopVersion: details.desktopVersion,
      },
    });
    return { authorizationId: id, status: "approved" as const };
  }

  async denyAuthorization(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    requestedId: string,
  ) {
    const access = await this.workspaceAccess(identity, workspaceId);
    const id = authorizationId(requestedId);
    const row = await this.store.get(TABLES.extensionDevices, id);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (!row || row.kind !== "desktop-authorization" || !details) {
      throw new HttpError(404, "DESKTOP_AUTHORIZATION_NOT_FOUND", "This desktop authorization is unavailable.");
    }
    if (row.status !== "authorization_pending") {
      throw new HttpError(409, "DESKTOP_AUTHORIZATION_UNAVAILABLE", "This desktop authorization can no longer be denied.");
    }
    const deniedAt = new Date().toISOString();
    await this.store.update(
      TABLES.extensionDevices,
      id,
      rowData(
        {
          organization_id: access.workspace.organizationId,
          workspace_id: workspaceId,
          user_id: identity.userId,
          status: "authorization_denied",
          updated_by: identity.userId,
        },
        { ...details, deniedAt, deniedBy: identity.userId },
      ),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "capture.desktop-authorization-denied",
      targetType: "desktop-device",
      targetId: id,
      targetLabel: details.deviceName,
      summary: "Windows capture device denied",
    });
    return { authorizationId: id, status: "denied" as const };
  }

  async token(request: Request, requestedId: string) {
    const id = authorizationId(requestedId);
    const payload = await readJsonObject(request, 20_000);
    const verifier = inputText(payload.codeVerifier, "Code verifier", {
      min: 43,
      max: 128,
    });
    if (!PKCE_VERIFIER.test(verifier)) {
      throw new HttpError(401, "PKCE_VERIFIER_INVALID", "The device verifier is invalid.");
    }
    const row = await this.store.get(TABLES.extensionDevices, id);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (!row || row.kind !== "desktop-authorization" || !details?.codeChallenge) {
      throw new HttpError(401, "DESKTOP_AUTHORIZATION_INVALID", "The desktop authorization is invalid.");
    }
    const suppliedChallenge = await s256(verifier);
    if (!constantTimeEqual(suppliedChallenge, details.codeChallenge)) {
      throw new HttpError(401, "PKCE_VERIFIER_INVALID", "The device verifier is invalid.");
    }
    const version = desktopVersion(payload.desktopVersion ?? details.desktopVersion);
    if (details.deviceId !== payload.deviceId || details.architecture !== payload.architecture) {
      throw new HttpError(401, "DEVICE_BINDING_INVALID", "The desktop authorization belongs to another device.");
    }
    if (Date.parse(String(row.expires_at)) <= Date.now()) {
      throw new HttpError(410, "DESKTOP_AUTHORIZATION_EXPIRED", "This desktop authorization has expired.");
    }
    if (row.status === "authorization_pending") {
      throw new HttpError(428, "DESKTOP_AUTHORIZATION_PENDING", "Approve this device in your browser.");
    }
    if (row.status === "authorization_denied") {
      throw new HttpError(403, "DESKTOP_AUTHORIZATION_DENIED", "This desktop authorization was denied.");
    }
    if (row.status !== "authorization_approved") {
      throw new HttpError(409, "DESKTOP_AUTHORIZATION_COMPLETE", "This desktop authorization has already been used.");
    }
    const identity = identityFrom(row, details);
    await this.workspaceAccess(identity, String(row.workspace_id));
    const refreshToken = randomTokenId();
    const refreshHash = await hashToken(refreshToken);
    const pairedAt = new Date().toISOString();
    const refreshExpiresAt = new Date(Date.now() + REFRESH_SECONDS * 1_000).toISOString();
    let active!: StoredRecord<RecordData>;
    await this.store.transaction(async (transaction) => {
      const latest = await transaction.get(TABLES.extensionDevices, id);
      if (!latest || latest.status !== "authorization_approved") {
        throw new HttpError(409, "DESKTOP_AUTHORIZATION_COMPLETE", "This desktop authorization has already been used.");
      }
      const latestDetails = decodePayload<DesktopDeviceDetails>(latest, details);
      if (!constantTimeEqual(latestDetails.codeChallenge ?? "", details.codeChallenge!)) {
        throw new HttpError(401, "PKCE_VERIFIER_INVALID", "The device verifier is invalid.");
      }
      for (const candidate of await transaction.list(TABLES.extensionDevices, {
        filters: [
          { field: "workspace_id", value: String(latest.workspace_id) },
          { field: "user_id", value: String(latest.user_id) },
          { field: "status", value: "active" },
        ],
      })) {
        const previous = decodePayload<DesktopDeviceDetails>(candidate, null as never);
        if (candidate.kind !== "desktop-windows" || previous?.deviceId !== details.deviceId) continue;
        await transaction.update(
          TABLES.extensionDevices,
          candidate.$id,
          rowData(
            { status: "revoked", updated_by: identity.userId },
            { ...previous, revokedAt: pairedAt, revokedBy: identity.userId },
          ),
        );
      }
      const nextDetails: DesktopDeviceDetails = {
        ...latestDetails,
        desktopVersion: version.version,
        minimumVersion: version.currentMinimum,
        pairedAt,
        lastUsedAt: pairedAt,
        refreshExpiresAt,
        refreshRotation: 1,
      };
      delete nextDetails.codeChallenge;
      active = await transaction.update(
        TABLES.extensionDevices,
        id,
        rowData(
          {
            subject_id: refreshHash,
            status: "active",
            kind: "desktop-windows",
            expires_at: refreshExpiresAt,
            updated_by: identity.userId,
          },
          nextDetails,
        ),
      );
      await appendAudit(transaction, identity, String(latest.workspace_id), {
        action: "capture.device-paired",
        targetType: "desktop-device",
        targetId: id,
        targetLabel: details.deviceName,
        summary: "Windows capture device paired",
        metadata: {
          deviceId: details.deviceId,
          architecture: details.architecture,
          desktopVersion: version.version,
        },
      });
    });
    const activeDetails = decodePayload<DesktopDeviceDetails>(active, details);
    return {
      ...(await accessToken(active, activeDetails)),
      refreshToken,
      refreshExpiresAt,
      workspaceId: String(active.workspace_id),
      workspaceName: activeDetails.workspaceName,
      minimumVersion: version.currentMinimum,
    };
  }

  async refresh(request: Request) {
    const payload = await readJsonObject(request, 20_000);
    const refreshToken = inputText(payload.refreshToken, "Device credential", {
      min: 40,
      max: 256,
    });
    if (!/^[A-Za-z0-9_-]+$/.test(refreshToken)) {
      throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The desktop credential is invalid or expired.");
    }
    const version = desktopVersion(payload.desktopVersion);
    const suppliedHash = await hashToken(refreshToken);
    const candidates = await this.store.list(TABLES.extensionDevices, {
      filters: [
        { field: "subject_id", value: suppliedHash },
        { field: "status", value: "active" },
      ],
      limit: 1,
    });
    let current = candidates.find((row) => row.kind === "desktop-windows");
    if (!current) {
      const activeRows = await this.store.list(TABLES.extensionDevices, {
        filters: [{ field: "status", value: "active" }],
      });
      const reused = activeRows.find((row) => {
        if (row.kind !== "desktop-windows") return false;
        const details = decodePayload<DesktopDeviceDetails>(row, null as never);
        return Boolean(
          details?.previousRefreshHash &&
            constantTimeEqual(details.previousRefreshHash, suppliedHash),
        );
      });
      if (reused) {
        const details = decodePayload<DesktopDeviceDetails>(reused, null as never);
        const identity = identityFrom(reused, details);
        await this.store.transaction(async (transaction) => {
          await transaction.update(
            TABLES.extensionDevices,
            reused.$id,
            rowData(
              { status: "revoked", updated_by: identity.userId },
              {
                ...details,
                revokedAt: new Date().toISOString(),
                revokedBy: "refresh-reuse-detection",
              },
            ),
          );
          await appendAudit(transaction, identity, String(reused.workspace_id), {
            action: "capture.device-refresh-reuse",
            targetType: "desktop-device",
            targetId: reused.$id,
            targetLabel: details.deviceName,
            summary: "Reused desktop refresh credential revoked",
          });
        });
      }
      throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The desktop credential is invalid or expired.");
    }
    const details = decodePayload<DesktopDeviceDetails>(current, null as never);
    if (
      !details?.deviceId ||
      !details.refreshExpiresAt ||
      details.architecture !== payload.architecture ||
      Date.parse(details.refreshExpiresAt) <= Date.now() ||
      Date.parse(String(current.expires_at)) <= Date.now()
    ) {
      throw new HttpError(401, "DEVICE_REFRESH_EXPIRED", "The desktop credential has expired.");
    }
    const nextRefresh = randomTokenId();
    const nextHash = await hashToken(nextRefresh);
    const refreshedAt = new Date().toISOString();
    try {
      await this.store.transaction(async (transaction) => {
        const latest = await transaction.get(TABLES.extensionDevices, current!.$id);
        if (
          !latest ||
          latest.kind !== "desktop-windows" ||
          latest.status !== "active" ||
          latest.subject_id !== suppliedHash
        ) {
          throw new HttpError(401, "DEVICE_REFRESH_INVALID", "The desktop credential was already rotated.");
        }
        const latestDetails = decodePayload<DesktopDeviceDetails>(latest, details);
        const identity = identityFrom(latest, latestDetails);
        const accessService = new AccessService(transaction);
        const access = await accessService.requireWorkspace(String(latest.workspace_id), identity);
        if (!access.membershipRow || access.membershipStatus !== "active") {
          throw new HttpError(403, "MEMBERSHIP_REQUIRED", "Workspace membership ended.");
        }
        requireAuthorized("capture.create", accessService.context(access));
        await new EntitlementService(transaction, String(latest.workspace_id)).requireFeature(
          "desktopCaptureEnabled",
        );
        current = await transaction.update(
          TABLES.extensionDevices,
          latest.$id,
          rowData(
            { subject_id: nextHash, updated_by: identity.userId },
            {
              ...latestDetails,
              desktopVersion: version.version,
              minimumVersion: version.currentMinimum,
              previousRefreshHash: suppliedHash,
              refreshRotation: Number(latestDetails.refreshRotation ?? 0) + 1,
              lastUsedAt: refreshedAt,
            },
          ),
        );
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
    const nextDetails = decodePayload<DesktopDeviceDetails>(current, details);
    return {
      ...(await accessToken(current, nextDetails)),
      refreshToken: nextRefresh,
      refreshExpiresAt: nextDetails.refreshExpiresAt,
      workspaceId: String(current.workspace_id),
      workspaceName: nextDetails.workspaceName,
      minimumVersion: version.currentMinimum,
    };
  }

  async authenticate(
    request: Request,
    requiredScopes: readonly DeviceScope[],
  ): Promise<DesktopCredential> {
    const claims = await verifyDeviceToken(bearer(request));
    const row = await this.store.get(TABLES.extensionDevices, claims.jti);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (
      !row ||
      row.kind !== "desktop-windows" ||
      row.status !== "active" ||
      !details?.deviceId ||
      row.workspace_id !== claims.workspaceId ||
      row.user_id !== claims.userId ||
      details.deviceId !== claims.deviceId ||
      Date.parse(String(row.expires_at)) <= Date.now() ||
      requiredScopes.some(
        (scope) =>
          !claims.scopes.includes(scope) || !details.scopes.includes(scope),
      )
    ) {
      throw new HttpError(401, "DEVICE_CREDENTIAL_REVOKED", "The desktop credential is invalid or revoked.");
    }
    const currentMinimum = minimumVersion();
    if (!versionAtLeast(details.desktopVersion, currentMinimum)) {
      throw new HttpError(426, "DESKTOP_UPDATE_REQUIRED", `Update KnowHow Capture to version ${currentMinimum} or later.`);
    }
    const identity = identityFrom(row, details);
    const access = await this.workspaceAccess(identity, claims.workspaceId);
    const lastUsed = Date.parse(details.lastUsedAt ?? "");
    if (!Number.isFinite(lastUsed) || Date.now() - lastUsed > 5 * 60 * 1_000) {
      await this.store.update(
        TABLES.extensionDevices,
        row.$id,
        rowData(
          { updated_by: identity.userId },
          { ...details, lastUsedAt: new Date().toISOString(), minimumVersion: currentMinimum },
        ),
      );
    }
    return { row, details, identity, access, scopes: [...claims.scopes] };
  }

  async listDevices(
    identity: AuthenticatedIdentity,
    workspaceId: string,
  ): Promise<DesktopDeviceSummary[]> {
    await this.workspaceAccess(identity, workspaceId, false);
    const rows = await this.store.list(TABLES.extensionDevices, {
      filters: [
        { field: "workspace_id", value: workspaceId },
        { field: "user_id", value: identity.userId },
      ],
      order: "desc",
    });
    return rows.flatMap((row) => {
      if (row.kind !== "desktop-windows" && row.kind !== "desktop-authorization") return [];
      if (![
        "active",
        "authorization_approved",
        "revoked",
      ].includes(String(row.status))) return [];
      const details = decodePayload<DesktopDeviceDetails>(row, null as never);
      if (!details?.deviceId) return [];
      return [{
        id: row.$id,
        deviceId: details.deviceId,
        name: details.deviceName,
        architecture: details.architecture,
        version: details.desktopVersion,
        minimumVersion: details.minimumVersion,
        status:
          row.status === "active"
            ? "active" as const
            : row.status === "authorization_approved"
              ? "approved" as const
              : "revoked" as const,
        pairedAt: details.pairedAt ?? null,
        lastUsedAt: details.lastUsedAt ?? null,
        refreshExpiresAt: details.refreshExpiresAt ?? null,
      }];
    });
  }

  async revokeDevice(
    identity: AuthenticatedIdentity,
    workspaceId: string,
    deviceRecordId: string,
  ) {
    await this.workspaceAccess(identity, workspaceId, false);
    const id = authorizationId(deviceRecordId);
    const row = await this.store.get(TABLES.extensionDevices, id);
    const details = row
      ? decodePayload<DesktopDeviceDetails>(row, null as never)
      : null;
    if (
      !row ||
      !details ||
      row.workspace_id !== workspaceId ||
      row.user_id !== identity.userId ||
      (row.kind !== "desktop-windows" && row.kind !== "desktop-authorization")
    ) {
      throw new HttpError(404, "DESKTOP_DEVICE_NOT_FOUND", "Desktop device not found.");
    }
    if (row.status === "revoked") return { revoked: true, deviceId: id };
    const revokedAt = new Date().toISOString();
    await this.store.update(
      TABLES.extensionDevices,
      id,
      rowData(
        { status: "revoked", updated_by: identity.userId },
        { ...details, revokedAt, revokedBy: identity.userId },
      ),
    );
    await appendAudit(this.store, identity, workspaceId, {
      action: "capture.device-revoked",
      targetType: "desktop-device",
      targetId: id,
      targetLabel: details.deviceName,
      summary: "Windows capture device revoked",
    });
    return { revoked: true, deviceId: id };
  }
}
