import { TABLES } from "./appwrite-resources";
import { rowData } from "./domain-records";
import { HttpError } from "./http-security";
import { deterministicResourceId } from "./ids";
import { RecordConflictError, type RecordStore } from "./record-store";

const MAX_CONFLICT_ATTEMPTS = 6;

export type FixedWindowPolicy = {
  scope: string;
  subject: string;
  limit: number;
  windowSeconds: number;
};

async function subjectHash(value: string) {
  const pepper = process.env.KNOWHOW_RATE_LIMIT_PEPPER?.trim();
  if (!pepper && process.env.NODE_ENV === "production") {
    throw new HttpError(
      503,
      "RATE_LIMIT_CONFIGURATION_INVALID",
      "Request protection is temporarily unavailable.",
      { expose: false },
    );
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${pepper || "local-development"}:${value}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function consumeFixedWindows(
  store: RecordStore,
  policies: FixedWindowPolicy[],
  now = new Date(),
) {
  if (!policies.length) return;
  const prepared = await Promise.all(
    policies.map(async (policy) => {
      if (
        !/^[a-z0-9._:-]{2,80}$/i.test(policy.scope) ||
        !Number.isInteger(policy.limit) ||
        policy.limit < 1 ||
        !Number.isInteger(policy.windowSeconds) ||
        policy.windowSeconds < 1
      ) {
        throw new Error("Invalid fixed-window rate-limit policy.");
      }
      const hashedSubject = await subjectHash(policy.subject);
      const windowStart =
        Math.floor(now.getTime() / (policy.windowSeconds * 1_000)) *
        policy.windowSeconds;
      return {
        ...policy,
        hashedSubject,
        windowStart,
        id: await deterministicResourceId(
          "limit",
          `${policy.scope}:${hashedSubject}:${windowStart}`,
        ),
      };
    }),
  );

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_CONFLICT_ATTEMPTS; attempt += 1) {
    try {
      await store.transaction(async (transaction) => {
        for (const policy of prepared) {
          const current = await transaction.get(TABLES.idempotencyKeys, policy.id);
          const count = Number(current?.sequence ?? 0);
          if (count >= policy.limit) {
            throw new HttpError(
              429,
              "RATE_LIMITED",
              "Too many requests. Try again later.",
            );
          }
          const expiresAt = new Date(
            (policy.windowStart + policy.windowSeconds + 60) * 1_000,
          ).toISOString();
          const data = rowData(
            {
              workspace_id: "system",
              subject_id: policy.hashedSubject.slice(0, 64),
              status: "active",
              kind: "rate_limit",
              idempotency_key: policy.id,
              sequence: count + 1,
              expires_at: expiresAt,
              occurred_at: now.toISOString(),
            },
            {
              scope: policy.scope,
              windowStart: policy.windowStart,
              windowSeconds: policy.windowSeconds,
            },
          );
          if (current) {
            await transaction.update(TABLES.idempotencyKeys, policy.id, data);
          } else {
            await transaction.create(TABLES.idempotencyKeys, policy.id, data);
          }
        }
      });
      return;
    } catch (error) {
      lastError = error;
      if (
        !(error instanceof RecordConflictError) ||
        attempt === MAX_CONFLICT_ATTEMPTS - 1
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
  throw lastError;
}
