import { TABLES } from "./appwrite-resources";
import { decodePayload, rowData } from "./domain-records";
import { HttpError } from "./http-security";
import { resourceId } from "./ids";
import { inputBoolean, inputEmail, inputInteger, inputText } from "./input";
import type { RecordStore } from "./record-store";

export type LeadKind = "demo" | "pricing";

export type LeadInput = {
  kind: LeadKind;
  name: unknown;
  email: unknown;
  organization: unknown;
  role: unknown;
  teamSize: unknown;
  country: unknown;
  workflow: unknown;
  ordinaryDataOnly: unknown;
  website?: unknown;
};

function isoNow() {
  return new Date().toISOString();
}

async function digest(value: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function deterministicId(prefix: string, value: string) {
  const hash = await digest(value);
  return `${prefix}_${hash.slice(0, 35 - prefix.length)}`;
}

function leadKind(value: unknown): LeadKind {
  if (value !== "demo" && value !== "pricing") {
    throw new HttpError(400, "LEAD_KIND_INVALID", "Choose a valid request type.");
  }
  return value;
}

function compactText(value: unknown, label: string, maximum: number) {
  const text = inputText(value, label, { min: 2, max: maximum });
  if (/[\u0000-\u001f\u007f]/.test(text)) {
    throw new HttpError(400, "INPUT_INVALID", `${label} contains unsupported characters.`);
  }
  return text.replace(/\s+/g, " ");
}

type WindowPolicy = { key: string; limit: number; seconds: number };

async function consumeWindow(store: RecordStore, policy: WindowPolicy, now: Date) {
  const windowStart = Math.floor(now.getTime() / (policy.seconds * 1_000)) * policy.seconds;
  const id = await deterministicId("limit", `${policy.key}:${windowStart}`);
  const current = await store.get(TABLES.idempotencyKeys, id);
  const count = Number(current?.sequence ?? 0);
  if (count >= policy.limit) {
    throw new HttpError(429, "RATE_LIMITED", "Too many requests. Try again later.");
  }
  const expiresAt = new Date((windowStart + policy.seconds + 60) * 1_000).toISOString();
  const fields = rowData(
    {
      workspace_id: "public",
      status: "active",
      kind: "rate_limit",
      idempotency_key: id,
      sequence: count + 1,
      expires_at: expiresAt,
      occurred_at: now.toISOString(),
    },
    { windowStart, seconds: policy.seconds },
  );
  if (current) await store.update(TABLES.idempotencyKeys, id, fields);
  else await store.create(TABLES.idempotencyKeys, id, fields);
}

export class LeadService {
  constructor(private readonly store: RecordStore) {}

  async create(input: LeadInput, context: { requestId: string; clientFingerprint: string }) {
    const kind = leadKind(input.kind);
    const name = compactText(input.name, "Name", 128);
    const email = inputEmail(input.email);
    const organization = compactText(input.organization, "Organization", 160);
    const role = compactText(input.role, "Role", 120);
    const teamSize = inputInteger(input.teamSize, "Team size", 1, 10_000);
    const country = compactText(input.country, "Country", 80);
    const workflow = compactText(input.workflow, "Workflow", 240);
    const ordinaryDataOnly = inputBoolean(input.ordinaryDataOnly, "Data-use confirmation");
    if (!ordinaryDataOnly) {
      throw new HttpError(
        400,
        "DATA_CLASSIFICATION_REQUIRED",
        "Confirm that the proposed use involves ordinary business-process data only.",
      );
    }
    // A hidden field is intentionally accepted but must remain empty.
    if (typeof input.website === "string" && input.website.trim()) {
      throw new HttpError(400, "REQUEST_INVALID", "The request could not be accepted.");
    }

    const now = new Date();
    const fingerprintHash = await digest(context.clientFingerprint);
    return this.store.transaction(async (transaction) => {
      await consumeWindow(transaction, { key: `lead:ip:${fingerprintHash}`, limit: 5, seconds: 3_600 }, now);
      await consumeWindow(transaction, { key: `lead:email:${email}`, limit: 3, seconds: 86_400 }, now);

      const duplicate = (await transaction.list(TABLES.leads, {
        filters: [
          { field: "email", value: email },
          { field: "status", value: "new" },
        ],
        order: "desc",
        limit: 25,
      })).find((row) => {
        const details = decodePayload<{ kind?: string }>(row, {});
        return details.kind === kind && Date.parse(row.$createdAt) > now.getTime() - 24 * 60 * 60 * 1_000;
      });
      if (duplicate) return { leadId: duplicate.$id, duplicate: true };

      const leadId = resourceId("lead");
      const occurredAt = isoNow();
      await transaction.create(
        TABLES.leads,
        leadId,
        rowData(
          {
            email,
            status: "new",
            kind,
            request_id: context.requestId,
            occurred_at: occurredAt,
            subject_id: fingerprintHash.slice(0, 64),
            created_by: "public",
          },
          { kind, name, email, organization, role, teamSize, country, workflow, ordinaryDataOnly, occurredAt },
        ),
      );

      const confirmationId = await deterministicId("notice", `lead:${leadId}:confirmation`);
      await transaction.create(
        TABLES.notificationDeliveries,
        confirmationId,
        rowData(
          {
            email,
            kind: "lead.confirmation",
            subject_id: leadId,
            status: "queued",
            scheduled_at: occurredAt,
            idempotency_key: `lead:${leadId}:confirmation`,
            request_id: context.requestId,
          },
          { kind, name, organization },
        ),
      );

      const internalEmail = process.env.KNOWHOW_LEADS_EMAIL?.trim().toLowerCase();
      if (internalEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(internalEmail)) {
        const internalId = await deterministicId("notice", `lead:${leadId}:internal`);
        await transaction.create(
          TABLES.notificationDeliveries,
          internalId,
          rowData(
            {
              email: internalEmail,
              kind: "lead.received",
              subject_id: leadId,
              status: "queued",
              scheduled_at: occurredAt,
              idempotency_key: `lead:${leadId}:internal`,
              request_id: context.requestId,
            },
            { kind, organization, teamSize, country },
          ),
        );
      }
      return { leadId, duplicate: false };
    });
  }
}
