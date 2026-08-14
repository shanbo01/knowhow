import "server-only";

import type {
  BetaAccessEvent,
  BetaAccessGrant,
  BetaAdmissionSummary,
} from "../knowhow-types";
import { decodePayload, rowData } from "./domain-records";
import { HttpError } from "./http-security";
import { resourceId } from "./ids";
import { TABLES } from "./appwrite-resources";
import {
  RecordConflictError,
  type RecordStore,
  type StoredRecord,
} from "./record-store";
import { constantTimeEqual, hashToken } from "./tokens";

const CODE_PREFIX = "khbeta1";
const CODE_PATTERN = /^khbeta1\.([A-Za-z0-9][A-Za-z0-9._-]{0,35})\.([a-f0-9]{64})$/;
const RESERVATION_TTL_MS = 10 * 60 * 1_000;
const MAX_GRANT_LIFETIME_MS = 366 * 24 * 60 * 60 * 1_000;
const MAX_TRANSACTION_ATTEMPTS = 4;

type GrantStatus = "active" | "exhausted" | "expired" | "revoked";

type GrantPayload = {
  label: string;
  exactEmail: string | null;
  maxUses: number;
  usedCount: number;
  reservedCount: number;
  createdAt: string;
  createdBy: string;
  expiresAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  revokedBy?: string;
};

type EventPayload = {
  grantId: string;
  reason?: string;
  createdAt?: string;
  reservedAt?: string;
  consumedAt?: string;
  releasedAt?: string;
  revokedAt?: string;
};

type GrantRow = StoredRecord & {
  subject_id?: string | null;
  email?: string | null;
  status?: string | null;
  expires_at?: string | null;
};

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

function normalizeEmail(value: string) {
  const email = value.trim().toLowerCase();
  if (
    email.length < 5 ||
    email.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new HttpError(400, "EMAIL_INVALID", "Email is invalid.");
  }
  return email;
}

function optionalLabel(value: string | undefined) {
  const label = value?.trim() ?? "";
  if (label.length > 128) {
    throw new HttpError(400, "BETA_ACCESS_LABEL_INVALID", "Label is invalid.");
  }
  return label;
}

function grantPayload(row: StoredRecord): GrantPayload {
  return decodePayload<GrantPayload>(row, {
    label: "",
    exactEmail: typeof row.email === "string" ? row.email : null,
    maxUses: 1,
    usedCount: 0,
    reservedCount: 0,
    createdAt: row.$createdAt,
    createdBy: typeof row.created_by === "string" ? row.created_by : "",
    expiresAt:
      typeof row.expires_at === "string" ? row.expires_at : row.$createdAt,
  });
}

function effectiveStatus(
  row: StoredRecord,
  details: GrantPayload,
  now = Date.now(),
): GrantStatus {
  if (row.status === "revoked") return "revoked";
  if (row.status === "expired" || Date.parse(details.expiresAt) <= now) {
    return "expired";
  }
  if (row.status === "exhausted" || details.usedCount >= details.maxUses) {
    return "exhausted";
  }
  return "active";
}

function grantView(row: StoredRecord, now = Date.now()): BetaAccessGrant {
  const details = grantPayload(row);
  return {
    id: row.$id,
    label: details.label,
    exactEmail: details.exactEmail,
    status: effectiveStatus(row, details, now),
    maxUses: details.maxUses,
    usedCount: details.usedCount,
    reservedCount: details.reservedCount,
    createdAt: details.createdAt,
    createdBy: details.createdBy,
    expiresAt: details.expiresAt,
    lastUsedAt: details.lastUsedAt ?? null,
    revokedAt: details.revokedAt ?? null,
    revokedBy: details.revokedBy ?? null,
  };
}

function eventView(row: StoredRecord): BetaAccessEvent {
  const details = decodePayload<EventPayload>(row, { grantId: "" });
  return {
    id: row.$id,
    grantId: details.grantId || String(row.subject_id ?? ""),
    kind: String(row.kind ?? "recorded") as BetaAccessEvent["kind"],
    status: String(row.status ?? "recorded") as BetaAccessEvent["status"],
    email: typeof row.email === "string" ? row.email : null,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    occurredAt:
      typeof row.occurred_at === "string" ? row.occurred_at : row.$createdAt,
    expiresAt: typeof row.expires_at === "string" ? row.expires_at : null,
    reason: details.reason ?? null,
  };
}

function randomHex(bytes: number) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function parseCode(code: string) {
  const normalized = code.trim();
  const match = CODE_PATTERN.exec(normalized);
  if (!match || normalized.length > 128) {
    throw new HttpError(
      403,
      "BETA_ACCESS_INVALID",
      "A current private-beta access code is required.",
    );
  }
  return { code: normalized, grantId: match[1]! };
}

function accessError(code: string) {
  if (code === "BETA_ACCESS_EXPIRED") {
    return new HttpError(403, code, "The private-beta access code has expired.");
  }
  if (code === "BETA_ACCESS_EXHAUSTED") {
    return new HttpError(403, code, "The private-beta access code has no uses remaining.");
  }
  return new HttpError(
    403,
    "BETA_ACCESS_INVALID",
    "A current private-beta access code is required.",
  );
}

export class BetaAccessService {
  constructor(private readonly store: RecordStore) {}

  private async transaction<T>(work: (store: RecordStore) => Promise<T>) {
    for (let attempt = 0; attempt < MAX_TRANSACTION_ATTEMPTS; attempt += 1) {
      try {
        return await this.store.transaction(work);
      } catch (error) {
        if (!(error instanceof RecordConflictError) || attempt === MAX_TRANSACTION_ATTEMPTS - 1) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
      }
    }
    throw new Error("Beta access transaction retry loop exhausted.");
  }

  async createGrant(input: {
    actorUserId: string;
    label?: string;
    exactEmail?: string;
    expiresAt: string;
    maxUses: number;
    requestId: string;
  }): Promise<{ grant: BetaAccessGrant; code: string }> {
    const createdAt = nowIso();
    const expiresAt = new Date(input.expiresAt);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      expiresAt.getTime() > Date.now() + MAX_GRANT_LIFETIME_MS
    ) {
      throw new HttpError(
        400,
        "BETA_ACCESS_EXPIRY_INVALID",
        "Expiry must be in the future and no more than 366 days away.",
      );
    }
    if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1 || input.maxUses > 10_000) {
      throw new HttpError(
        400,
        "BETA_ACCESS_USES_INVALID",
        "Maximum uses must be between 1 and 10,000.",
      );
    }
    const exactEmail = input.exactEmail ? normalizeEmail(input.exactEmail) : null;
    const grantId = resourceId("beta");
    const code = `${CODE_PREFIX}.${grantId}.${randomHex(32)}`;
    const details: GrantPayload = {
      label: optionalLabel(input.label),
      exactEmail,
      maxUses: input.maxUses,
      usedCount: 0,
      reservedCount: 0,
      createdAt,
      createdBy: input.actorUserId,
      expiresAt: expiresAt.toISOString(),
    };
    const row = await this.store.create(
      TABLES.betaAccessGrants,
      grantId,
      rowData(
        {
          subject_id: await hashToken(code),
          email: exactEmail,
          status: "active",
          kind: "private_beta",
          occurred_at: createdAt,
          expires_at: details.expiresAt,
          created_by: input.actorUserId,
          request_id: input.requestId,
        },
        details,
      ),
    );
    try {
      await this.store.create(
        TABLES.betaAccessEvents,
        resourceId("betaevt"),
        rowData(
          {
            subject_id: grantId,
            email: exactEmail,
            status: "recorded",
            kind: "created",
            occurred_at: createdAt,
            expires_at: details.expiresAt,
            created_by: input.actorUserId,
            request_id: input.requestId,
          },
          { grantId, createdAt } satisfies EventPayload,
        ),
      );
    } catch (error) {
      await this.store.delete(TABLES.betaAccessGrants, grantId).catch(() => undefined);
      throw error;
    }
    return { grant: grantView(row), code };
  }

  async reserve(input: {
    code: string;
    email: string;
    requestId?: string;
  }): Promise<{ reservationId: string; grantId: string; expiresAt: string }> {
    const { code, grantId } = parseCode(input.code);
    const email = normalizeEmail(input.email);
    const presentedHash = await hashToken(code);
    const reservationId = resourceId("betares");
    const now = Date.now();
    const outcome = await this.transaction(async (store) => {
      const row = (await store.get(TABLES.betaAccessGrants, grantId)) as GrantRow | null;
      if (
        !row ||
        typeof row.subject_id !== "string" ||
        !constantTimeEqual(row.subject_id, presentedHash)
      ) {
        return { error: "BETA_ACCESS_INVALID" as const };
      }
      const details = grantPayload(row);
      if (details.exactEmail !== null && details.exactEmail !== email) {
        return { error: "BETA_ACCESS_INVALID" as const };
      }
      const status = effectiveStatus(row, details, now);
      if (status === "revoked") return { error: "BETA_ACCESS_INVALID" as const };
      if (status === "expired") {
        if (row.status !== "expired") {
          await store.update(
            TABLES.betaAccessGrants,
            grantId,
            rowData({ status: "expired" }, details),
          );
        }
        return { error: "BETA_ACCESS_EXPIRED" as const };
      }
      if (status === "exhausted") {
        return { error: "BETA_ACCESS_EXHAUSTED" as const };
      }

      const reservations = await store.list(TABLES.betaAccessEvents, {
        filters: [
          { field: "subject_id", value: grantId },
          { field: "status", value: "reserved" },
        ],
      });
      const activeReservations = [];
      for (const reservation of reservations) {
        if (Date.parse(String(reservation.expires_at ?? "")) > now) {
          activeReservations.push(reservation);
          continue;
        }
        const expired = decodePayload<EventPayload>(reservation, { grantId });
        await store.update(
          TABLES.betaAccessEvents,
          reservation.$id,
          rowData(
            {
              status: "released",
              kind: "released",
              occurred_at: nowIso(now),
            },
            {
              ...expired,
              reason: "reservation_expired",
              releasedAt: nowIso(now),
            },
          ),
        );
      }
      if (details.usedCount + activeReservations.length >= details.maxUses) {
        return { error: "BETA_ACCESS_EXHAUSTED" as const };
      }
      const expiresAt = new Date(
        Math.min(Date.parse(details.expiresAt), now + RESERVATION_TTL_MS),
      ).toISOString();
      await store.update(
        TABLES.betaAccessGrants,
        grantId,
        rowData(
          { status: "active" },
          { ...details, reservedCount: activeReservations.length + 1 },
        ),
      );
      await store.create(
        TABLES.betaAccessEvents,
        reservationId,
        rowData(
          {
            subject_id: grantId,
            email,
            status: "reserved",
            kind: "reservation",
            occurred_at: nowIso(now),
            expires_at: expiresAt,
            request_id: input.requestId,
          },
          { grantId, reservedAt: nowIso(now) } satisfies EventPayload,
        ),
      );
      return { reservationId, grantId, expiresAt };
    });
    if ("error" in outcome) throw accessError(outcome.error!);
    return outcome;
  }

  async consume(input: {
    reservationId: string;
    email: string;
    userId: string;
    requestId?: string;
  }): Promise<BetaAdmissionSummary> {
    const email = normalizeEmail(input.email);
    const now = Date.now();
    const outcome = await this.transaction(async (store) => {
      const event = await store.get(TABLES.betaAccessEvents, input.reservationId);
      if (!event || event.email !== email) {
        return { error: "BETA_ACCESS_INVALID" as const };
      }
      const eventDetails = decodePayload<EventPayload>(event, { grantId: "" });
      const grantId = eventDetails.grantId || String(event.subject_id ?? "");
      if (
        event.status === "consumed" &&
        event.kind === "consumed" &&
        event.user_id === input.userId
      ) {
        const existingGrant = await store.get(TABLES.betaAccessGrants, grantId);
        if (!existingGrant) return { error: "BETA_ACCESS_INVALID" as const };
        return this.admissionSummary(existingGrant, event);
      }
      if (
        event.status !== "reserved" ||
        event.kind !== "reservation" ||
        Date.parse(String(event.expires_at ?? "")) <= now
      ) {
        return { error: "BETA_ACCESS_INVALID" as const };
      }
      const grant = await store.get(TABLES.betaAccessGrants, grantId);
      if (!grant) return { error: "BETA_ACCESS_INVALID" as const };
      const details = grantPayload(grant);
      const status = effectiveStatus(grant, details, now);
      if (status !== "active" || (details.exactEmail !== null && details.exactEmail !== email)) {
        return {
          error:
            status === "expired"
              ? ("BETA_ACCESS_EXPIRED" as const)
              : status === "exhausted"
                ? ("BETA_ACCESS_EXHAUSTED" as const)
                : ("BETA_ACCESS_INVALID" as const),
        };
      }
      const usedCount = details.usedCount + 1;
      const consumedAt = nowIso(now);
      const updatedGrant = await store.update(
        TABLES.betaAccessGrants,
        grantId,
        rowData(
          { status: usedCount >= details.maxUses ? "exhausted" : "active" },
          {
            ...details,
            usedCount,
            reservedCount: Math.max(0, details.reservedCount - 1),
            lastUsedAt: consumedAt,
          },
        ),
      );
      const consumedEvent = await store.update(
        TABLES.betaAccessEvents,
        input.reservationId,
        rowData(
          {
            user_id: input.userId,
            email,
            status: "consumed",
            kind: "consumed",
            occurred_at: consumedAt,
            request_id: input.requestId,
            updated_by: input.userId,
          },
          { ...eventDetails, consumedAt },
        ),
      );
      return this.admissionSummary(updatedGrant, consumedEvent);
    });
    if ("error" in outcome) throw accessError(outcome.error!);
    return outcome;
  }

  async release(input: {
    reservationId: string;
    email?: string;
    reason?: string;
    requestId?: string;
  }): Promise<{ released: boolean }> {
    const email = input.email ? normalizeEmail(input.email) : null;
    return this.transaction(async (store) => {
      const event = await store.get(TABLES.betaAccessEvents, input.reservationId);
      if (!event || (email !== null && event.email !== email)) {
        return { released: false };
      }
      if (event.status !== "reserved" || event.kind !== "reservation") {
        return { released: false };
      }
      const eventDetails = decodePayload<EventPayload>(event, { grantId: "" });
      const grantId = eventDetails.grantId || String(event.subject_id ?? "");
      const grant = await store.get(TABLES.betaAccessGrants, grantId);
      if (grant) {
        const details = grantPayload(grant);
        const reservedCount = Math.max(0, details.reservedCount - 1);
        const status = effectiveStatus(grant, details);
        await store.update(
          TABLES.betaAccessGrants,
          grantId,
          rowData(
            {
              status:
                status === "exhausted" && details.usedCount < details.maxUses
                  ? "active"
                  : status,
            },
            { ...details, reservedCount },
          ),
        );
      }
      const releasedAt = nowIso();
      await store.update(
        TABLES.betaAccessEvents,
        input.reservationId,
        rowData(
          {
            status: "released",
            kind: "released",
            occurred_at: releasedAt,
            request_id: input.requestId,
          },
          {
            ...eventDetails,
            reason: input.reason?.slice(0, 128) || "signup_not_completed",
            releasedAt,
          },
        ),
      );
      return { released: true };
    });
  }

  async revokeGrant(input: {
    grantId: string;
    actorUserId: string;
    requestId: string;
  }): Promise<BetaAccessGrant> {
    const row = await this.store.get(TABLES.betaAccessGrants, input.grantId);
    if (!row) {
      throw new HttpError(404, "BETA_ACCESS_NOT_FOUND", "Beta access grant not found.");
    }
    if (row.status === "revoked") return grantView(row);
    const revokedAt = nowIso();
    const details = grantPayload(row);
    const reservations = await this.store.list(TABLES.betaAccessEvents, {
      filters: [
        { field: "subject_id", value: input.grantId },
        { field: "status", value: "reserved" },
      ],
    });
    for (const reservation of reservations) {
      const event = decodePayload<EventPayload>(reservation, {
        grantId: input.grantId,
      });
      await this.store.update(
        TABLES.betaAccessEvents,
        reservation.$id,
        rowData(
          {
            status: "released",
            kind: "released",
            occurred_at: revokedAt,
            updated_by: input.actorUserId,
          },
          { ...event, reason: "grant_revoked", releasedAt: revokedAt },
        ),
      );
    }
    const updated = await this.store.update(
      TABLES.betaAccessGrants,
      input.grantId,
      rowData(
        { status: "revoked", updated_by: input.actorUserId },
        {
          ...details,
          reservedCount: 0,
          revokedAt,
          revokedBy: input.actorUserId,
        },
      ),
    );
    await this.store.create(
      TABLES.betaAccessEvents,
      resourceId("betaevt"),
      rowData(
        {
          subject_id: input.grantId,
          email: details.exactEmail,
          status: "recorded",
          kind: "revoked",
          occurred_at: revokedAt,
          created_by: input.actorUserId,
          request_id: input.requestId,
        },
        { grantId: input.grantId, revokedAt } satisfies EventPayload,
      ),
    );
    return grantView(updated);
  }

  async listGrants(limit = 500): Promise<BetaAccessGrant[]> {
    const rows = await this.store.list(TABLES.betaAccessGrants, {
      order: "desc",
      limit,
    });
    return rows.map((row) => grantView(row));
  }

  async listEvents(limit = 1_000): Promise<BetaAccessEvent[]> {
    const rows = await this.store.list(TABLES.betaAccessEvents, {
      order: "desc",
      limit,
    });
    return rows.map(eventView);
  }

  async getConsumedGrantForUser(
    userId: string,
    email: string,
  ): Promise<BetaAdmissionSummary | null> {
    const normalizedEmail = normalizeEmail(email);
    const events = await this.store.list(TABLES.betaAccessEvents, {
      filters: [
        { field: "user_id", value: userId },
        { field: "status", value: "consumed" },
      ],
      order: "desc",
      limit: 100,
    });
    for (const event of events) {
      if (
        event.kind !== "consumed" ||
        event.user_id !== userId ||
        event.email !== normalizedEmail
      ) {
        continue;
      }
      const details = decodePayload<EventPayload>(event, { grantId: "" });
      const grantId = details.grantId || String(event.subject_id ?? "");
      const grant = await this.store.get(TABLES.betaAccessGrants, grantId);
      if (grant) return this.admissionSummary(grant, event);
    }
    return null;
  }

  async hasConsumedAdmission(userId: string, email: string) {
    return Boolean(await this.getConsumedGrantForUser(userId, email));
  }

  async requireConsumedAdmission(userId: string, email: string) {
    const admission = await this.getConsumedGrantForUser(userId, email);
    if (!admission) throw accessError("BETA_ACCESS_INVALID");
    return admission;
  }

  private admissionSummary(
    grant: StoredRecord,
    event: StoredRecord,
  ): BetaAdmissionSummary {
    const details = grantPayload(grant);
    const eventDetails = decodePayload<EventPayload>(event, { grantId: grant.$id });
    return {
      grantId: grant.$id,
      email: String(event.email ?? ""),
      consumedAt:
        eventDetails.consumedAt ??
        (typeof event.occurred_at === "string" ? event.occurred_at : event.$updatedAt),
      maxUses: details.maxUses,
      usedCount: details.usedCount,
    };
  }
}
