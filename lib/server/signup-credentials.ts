import "server-only";

import { createAdminAppwrite } from "./appwrite-clients";
import { AppwriteRecordStore } from "./appwrite-record-store";
import { TABLES } from "./appwrite-resources";
import { HttpError } from "./http-security";
import {
  constantTimeEqual,
  hashToken,
  verifyAppointmentToken,
  verifyInviteToken,
} from "./tokens";

type CredentialPayload = {
  maxUses?: number;
  useCount?: number;
  email?: string;
};

function payload(value: string): CredentialPayload {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as CredentialPayload) : {};
  } catch {
    return {};
  }
}

export async function assertSignupCredential(input: {
  kind: "invite" | "appointment";
  token: string;
  email: string;
}) {
  const { config, tables } = createAdminAppwrite();
  const store = new AppwriteRecordStore(tables, config.databaseId);
  const now = Date.now();
  const normalizedEmail = input.email.trim().toLowerCase();

  if (input.kind === "invite") {
    const claims = await verifyInviteToken(input.token);
    const row = await store.get(TABLES.invitations, claims.jti);
    const details = row ? payload(String(row.payload_json)) : {};
    const presentedHash = await hashToken(input.token);
    const valid =
      row !== null &&
      row.status === "active" &&
      row.workspace_id === claims.workspaceId &&
      typeof row.subject_id === "string" &&
      constantTimeEqual(row.subject_id, presentedHash) &&
      typeof row.expires_at === "string" &&
      Date.parse(row.expires_at) > now &&
      (claims.email === undefined || claims.email === normalizedEmail) &&
      (typeof details.maxUses !== "number" ||
        Number(details.useCount ?? 0) < details.maxUses);
    if (!valid) {
      throw new HttpError(403, "INVITATION_REQUIRED", "A current invitation is required to create an account.");
    }
    return { workspaceId: claims.workspaceId, email: normalizedEmail };
  }

  const claims = await verifyAppointmentToken(input.token);
  const row = await store.get(TABLES.initialAdminAppointments, claims.jti);
  const presentedHash = await hashToken(input.token);
  const valid =
    row !== null &&
    row.status === "active" &&
    row.workspace_id === claims.workspaceId &&
    row.email === normalizedEmail &&
    claims.email === normalizedEmail &&
    typeof row.subject_id === "string" &&
    constantTimeEqual(row.subject_id, presentedHash) &&
    typeof row.expires_at === "string" &&
    Date.parse(row.expires_at) > now;
  if (!valid) {
    throw new HttpError(403, "APPOINTMENT_REQUIRED", "A current administrator appointment is required to create an account.");
  }
  return { workspaceId: claims.workspaceId, email: normalizedEmail };
}

