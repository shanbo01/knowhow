import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Query } from "node-appwrite";
import operationsWorker, {
  deliverNotifications,
  services as operationsServices,
} from "../functions/operations/src/main.js";
import exportWorker from "../functions/export/src/main.js";

const HEARTBEAT_PATH = resolve(".tmp/local-workers-heartbeat.json");
const LOCAL_PROJECT_ID = "knowhow-local";
const LOCAL_RESOURCE_IDS = Object.freeze({
  database: "knowhow_core",
  privateMedia: "knowhow_private_media",
  exports: "knowhow_exports",
});

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`LOCAL_WORKER_CONFIG_MISSING:${name}`);
  return value;
}

function exactLoopbackUrl(raw, pathname, port = "") {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    url.pathname.replace(/\/$/, "") !== pathname ||
    url.port !== port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  return url;
}

function validateLocalWorkerEnvironment(env = process.env) {
  if (required(env, "KNOWHOW_LOCAL_WORKER_MODE") !== "emulated")
    throw new Error("LOCAL_WORKER_MODE_INVALID");
  if (required(env, "KNOWHOW_ENVIRONMENT") !== "development")
    throw new Error("LOCAL_WORKER_ENVIRONMENT_INVALID");
  const endpoint = exactLoopbackUrl(required(env, "APPWRITE_ENDPOINT"), "/v1");
  if (!endpoint) throw new Error("LOCAL_WORKER_ENDPOINT_INVALID");
  if (required(env, "APPWRITE_PROJECT_ID") !== LOCAL_PROJECT_ID)
    throw new Error("LOCAL_WORKER_PROJECT_INVALID");
  if (required(env, "APPWRITE_DATABASE_ID") !== LOCAL_RESOURCE_IDS.database)
    throw new Error("LOCAL_WORKER_DATABASE_INVALID");
  if (
    required(env, "APPWRITE_PRIVATE_MEDIA_BUCKET_ID") !==
    LOCAL_RESOURCE_IDS.privateMedia
  ) {
    throw new Error("LOCAL_WORKER_PRIVATE_BUCKET_INVALID");
  }
  if (
    required(env, "APPWRITE_EXPORTS_BUCKET_ID") !== LOCAL_RESOURCE_IDS.exports
  ) {
    throw new Error("LOCAL_WORKER_EXPORTS_BUCKET_INVALID");
  }
  required(env, "APPWRITE_API_KEY");
  const mailpit = exactLoopbackUrl(
    env.KNOWHOW_LOCAL_MAILPIT_URL?.trim() || "http://127.0.0.1:8025",
    "",
    "8025",
  );
  if (!mailpit) throw new Error("LOCAL_MAILPIT_URL_INVALID");
  const site = exactLoopbackUrl(required(env, "KNOWHOW_SITE_ORIGIN"), "", "3001");
  if (!site) throw new Error("LOCAL_WORKER_SITE_ORIGIN_INVALID");
  return { endpoint, mailpit, site };
}

function configureFunctionEnvironment(local, env = process.env) {
  env.APPWRITE_FUNCTION_API_ENDPOINT = local.endpoint
    .toString()
    .replace(/\/$/, "");
  env.APPWRITE_FUNCTION_PROJECT_ID = LOCAL_PROJECT_ID;
  env.APPWRITE_FUNCTION_API_KEY = required(env, "APPWRITE_API_KEY");
  env.KNOWHOW_LOCAL_MAILPIT_URL = local.mailpit.origin;
}

function responseAdapter() {
  let recorded;
  return {
    res: {
      json(body, status = 200) {
        recorded = { body, status };
        return recorded;
      },
    },
    response() {
      if (!recorded) throw new Error("LOCAL_WORKER_RESPONSE_MISSING");
      return recorded;
    },
  };
}

async function invoke(handler) {
  const adapter = responseAdapter();
  await handler({
    req: { headers: {}, bodyJson: {} },
    res: adapter.res,
    log() {},
    error() {},
  });
  const response = adapter.response();
  if (response.status >= 300 || !response.body?.ok)
    throw new Error("LOCAL_WORKER_EXECUTION_FAILED");
  return response.body;
}

async function notificationQueueState(tables, now = new Date()) {
  const [due, failed] = await Promise.all([
    tables.listRows({
      databaseId: LOCAL_RESOURCE_IDS.database,
      tableId: "notification_deliveries",
      queries: [
        Query.equal("status", ["queued"]),
        Query.lessThanEqual("scheduled_at", now.toISOString()),
        Query.limit(1),
      ],
      total: false,
    }),
    tables.listRows({
      databaseId: LOCAL_RESOURCE_IDS.database,
      tableId: "notification_deliveries",
      queries: [Query.equal("status", ["failed"]), Query.limit(1)],
      total: false,
    }),
  ]);
  return { due: due.rows.length, terminalFailed: failed.rows.length };
}

function projectFingerprint() {
  return createHash("sha256")
    .update(`project\0${LOCAL_PROJECT_ID}`)
    .digest("hex");
}

async function writeHeartbeat(heartbeat) {
  await mkdir(dirname(HEARTBEAT_PATH), { recursive: true });
  await writeFile(HEARTBEAT_PATH, `${JSON.stringify(heartbeat)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

async function runNotificationsOnly() {
  const api = operationsServices({ headers: {} });
  const notifications = await deliverNotifications(api, new Date());
  const queue = await notificationQueueState(api.tables);
  return { notifications, queue };
}

async function runFullWorkers() {
  const startedAt = new Date();
  try {
    const operations = await invoke(operationsWorker);
    const exports = await invoke(exportWorker);
    const api = operationsServices({ headers: {} });
    const queue = await notificationQueueState(api.tables);
    const heartbeat = {
      version: 1,
      mode: "full",
      ok: queue.due === 0 && queue.terminalFailed === 0,
      generatedAt: new Date().toISOString(),
      projectFingerprint: projectFingerprint(),
      operations: {
        ok: true,
        notificationFailures: operations.notifications?.failed ?? 0,
      },
      exports: {
        ok: true,
        failures: exports.failures ?? 0,
      },
      queue,
      durationMs: Date.now() - startedAt.getTime(),
    };
    await writeHeartbeat(heartbeat);
    if (!heartbeat.ok) throw new Error("LOCAL_WORKER_QUEUE_NOT_READY");
    return heartbeat;
  } catch (error) {
    await writeHeartbeat({
      version: 1,
      mode: "full",
      ok: false,
      generatedAt: new Date().toISOString(),
      projectFingerprint: projectFingerprint(),
      failureClass: error instanceof Error ? error.name : "UnknownError",
      durationMs: Date.now() - startedAt.getTime(),
    });
    throw error;
  }
}

function publicSummary(result) {
  if ("notifications" in result) {
    return {
      ok: result.notifications.failed === 0 && result.queue.due === 0,
      mode: "notifications-only",
      due: result.notifications.due,
      sent: result.notifications.sent,
      failed: result.notifications.failed,
      queue: result.queue,
    };
  }
  return {
    ok: result.ok,
    mode: result.mode,
    generatedAt: result.generatedAt,
    notificationFailures: result.operations.notificationFailures,
    exportFailures: result.exports.failures,
    queue: result.queue,
    durationMs: result.durationMs,
  };
}

async function main(argv = process.argv.slice(2)) {
  const local = validateLocalWorkerEnvironment();
  configureFunctionEnvironment(local);
  const notificationsOnly = argv.includes("--notifications-only");
  const watch = argv.includes("--watch");
  if (notificationsOnly && watch)
    throw new Error("LOCAL_WORKER_ARGUMENTS_INVALID");
  if (notificationsOnly) {
    console.log(JSON.stringify(publicSummary(await runNotificationsOnly())));
    return;
  }
  const run = async () => {
    try {
      console.log(JSON.stringify(publicSummary(await runFullWorkers())));
    } catch (error) {
      console.error(
        JSON.stringify({
          ok: false,
          mode: "full",
          failureClass: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      if (!watch) throw error;
    }
  };
  await run();
  if (!watch) return;
  const rawInterval = Number(process.env.KNOWHOW_LOCAL_WORKER_INTERVAL_MS || 60_000);
  const interval = Math.min(300_000, Math.max(30_000, rawInterval));
  await new Promise((resolvePromise) => {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await run();
      } finally {
        running = false;
      }
    }, interval);
    const stop = () => {
      clearInterval(timer);
      resolvePromise();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const directInvocation =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    pathToFileURL(fileURLToPath(import.meta.url)).href;
if (directInvocation) {
  main().catch((error) => {
    console.error(
      JSON.stringify({
        ok: false,
        failureClass: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    process.exitCode = 1;
  });
}

export {
  HEARTBEAT_PATH,
  configureFunctionEnvironment,
  exactLoopbackUrl,
  main,
  notificationQueueState,
  projectFingerprint,
  publicSummary,
  runFullWorkers,
  runNotificationsOnly,
  validateLocalWorkerEnvironment,
};
