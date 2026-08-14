import { createHmac } from "node:crypto";
import { Client, Query, TablesDB } from "node-appwrite";

const DATABASE_ID = "knowhow_core";
const EXPORT_TABLE = "export_jobs";
const EVENT_SUFFIX = `.tables.${EXPORT_TABLE}.rows.`;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function siteOrigin() {
  const origin = new URL(required("KNOWHOW_SITE_ORIGIN"));
  const localEmulation =
    process.env.KNOWHOW_LOCAL_WORKER_MODE === "emulated" &&
    process.env.KNOWHOW_ENVIRONMENT === "development" &&
    process.env.APPWRITE_FUNCTION_PROJECT_ID === "knowhow-local" &&
    origin.protocol === "http:" &&
    (origin.hostname === "localhost" || origin.hostname === "127.0.0.1");
  if (
    (!localEmulation && origin.protocol !== "https:") ||
    origin.pathname !== "/" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  ) {
    throw new Error("KNOWHOW_SITE_ORIGIN must be an HTTPS origin without a path.");
  }
  return origin.origin;
}

function workerSecret() {
  const secret = required("KNOWHOW_EXPORT_WORKER_SECRET");
  if (secret.length < 32) {
    throw new Error("KNOWHOW_EXPORT_WORKER_SECRET must contain at least 32 characters.");
  }
  return secret;
}

function services(req) {
  const client = new Client()
    .setEndpoint(required("APPWRITE_FUNCTION_API_ENDPOINT"))
    .setProject(required("APPWRITE_FUNCTION_PROJECT_ID"))
    .setKey(req.headers["x-appwrite-key"] || required("APPWRITE_FUNCTION_API_KEY"));
  return { tables: new TablesDB(client) };
}

function eventJobId(req) {
  const event = req.headers["x-appwrite-event"] || "";
  if (!event || !event.includes(EVENT_SUFFIX) || !event.endsWith(".create")) {
    return null;
  }
  const body = req.bodyJson;
  return body && typeof body === "object" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/.test(body.$id)
    ? body.$id
    : null;
}

async function scheduledJobs(tables, now) {
  const result = await tables.listRows({
    databaseId: DATABASE_ID,
    tableId: EXPORT_TABLE,
    queries: [
      Query.equal("status", ["queued", "retry", "processing"]),
      Query.lessThanEqual("scheduled_at", now.toISOString()),
      Query.orderAsc("scheduled_at"),
      Query.limit(10),
    ],
    total: false,
  });
  return result.rows.map((row) => row.$id);
}

async function processJob(jobId) {
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", workerSecret())
    .update(`${timestamp}.${jobId}`)
    .digest("hex");
  const response = await fetch(`${siteOrigin()}/api/internal/export-worker`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-knowhow-worker-timestamp": timestamp,
      "x-knowhow-worker-signature": signature,
      "x-request-id": crypto.randomUUID(),
    },
    body: JSON.stringify({ jobId }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`Export processor returned HTTP ${response.status}.`);
  }
  const result = await response.json();
  if (!result?.ok) throw new Error("Export processor rejected the job.");
  return { jobId, status: result.status, skipped: Boolean(result.skipped) };
}

const exportWorker = async ({ req, res, log, error }) => {
  const requestId = crypto.randomUUID();
  try {
    const eventId = eventJobId(req);
    const ids = eventId
      ? [eventId]
      : await scheduledJobs(services(req).tables, new Date());
    const settled = await Promise.allSettled(ids.map(processJob));
    const completed = settled
      .filter((result) => result.status === "fulfilled")
      .map((result) => result.value);
    const failures = settled.length - completed.length;
    log(
      JSON.stringify({
        event: "knowhow.exports.completed",
        requestId,
        inspected: ids.length,
        completed: completed.length,
        failures,
      }),
    );
    if (failures) {
      error(
        JSON.stringify({
          event: "knowhow.exports.failed",
          requestId,
          failures,
        }),
      );
      return res.json({ ok: false, requestId, completed, failures }, 500);
    }
    return res.json({ ok: true, requestId, completed, failures: 0 });
  } catch (caught) {
    error(
      JSON.stringify({
        event: "knowhow.exports.failed",
        requestId,
        failureClass: caught instanceof Error ? caught.name : "UnknownError",
      }),
    );
    return res.json({ ok: false, requestId }, 500);
  }
};

export { eventJobId, processJob, scheduledJobs };
export default exportWorker;
