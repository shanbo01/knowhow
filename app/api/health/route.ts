import { TABLES } from "@/lib/server/appwrite-resources";
import {
  deploymentConfigurationIssues,
  emailTransportConfigured,
} from "@/lib/server/appwrite-config";
import { jsonResponse } from "@/lib/server/http-security";
import { workerReadiness } from "@/lib/server/worker-readiness";
import {
  correlationId,
  createRequestServices,
  withRequestId,
} from "@/lib/server/request-services";
import { createHash } from "node:crypto";
import { Query } from "node-appwrite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * How long a queued notification may sit past its scheduled time before the
 * deployment is unhealthy rather than merely busy.
 *
 * The operations worker runs every five minutes, so a due notification is the
 * normal state for most of every cycle — treating any due row as a fault would
 * flap the probe continuously. What matters is a row that has outlived several
 * cycles, which means the worker is not draining the queue.
 */
const NOTIFICATION_OVERDUE_MS = 15 * 60_000;

export async function GET(request: Request) {
  const requestId = correlationId(request);
  const ready = new URL(request.url).searchParams.get("ready") === "1";
  if (!ready) {
    return withRequestId(
      jsonResponse({ status: "ok", requestId }),
      requestId,
    );
  }
  try {
    const { config, users, tables, storage, functions } = createRequestServices();
    const issues = deploymentConfigurationIssues(config);
    const infrastructureChecks = await Promise.allSettled([
      users.list({ queries: [Query.limit(1)], total: false }),
      tables.get({ databaseId: config.databaseId }),
      storage.getBucket({ bucketId: config.privateMediaBucketId }),
      storage.getBucket({ bucketId: config.exportsBucketId }),
    ]);
    const [identity, database, privateStorage, exportStorage] =
      infrastructureChecks;
    const workers = await workerReadiness(config, { functions });
    let notificationQueue = { overdue: 0, terminalFailed: 0 };
    let queueCheck: "ok" | "failed" = "ok";
    if (database.status === "fulfilled") {
      const overdueBefore = new Date(
        Date.now() - NOTIFICATION_OVERDUE_MS,
      ).toISOString();
      const [overdue, failed] = await Promise.allSettled([
        tables.listRows({
          databaseId: config.databaseId,
          tableId: TABLES.notificationDeliveries,
          queries: [
            Query.equal("status", ["queued"]),
            Query.lessThanEqual("scheduled_at", overdueBefore),
            Query.limit(1),
          ],
          total: false,
        }),
        tables.listRows({
          databaseId: config.databaseId,
          tableId: TABLES.notificationDeliveries,
          queries: [Query.equal("status", ["failed"]), Query.limit(1)],
          total: false,
        }),
      ]);
      if (overdue.status === "fulfilled" && failed.status === "fulfilled") {
        notificationQueue = {
          overdue: overdue.value.rows.length,
          terminalFailed: failed.value.rows.length,
        };
      } else {
        queueCheck = "failed";
      }
    } else {
      queueCheck = "failed";
    }
    const mailReady = emailTransportConfigured();
    const infrastructureReady = infrastructureChecks.every(
      (check) => check.status === "fulfilled",
    );
    const queueReady =
      queueCheck === "ok" &&
      notificationQueue.overdue === 0 &&
      notificationQueue.terminalFailed === 0;
    const runtimeReady =
      infrastructureReady && workers.ready && queueReady;
    const status = issues.length || !runtimeReady ? "not_ready" : "ready";
    const settledStatus = (result: PromiseSettledResult<unknown>) =>
      result.status === "fulfilled" ? "ok" : "failed";
    return withRequestId(
      jsonResponse(
        {
          status,
          deployment: {
            environment: config.environment,
            release: process.env.KNOWHOW_RELEASE?.trim() || "unversioned",
            runtime: workers.mode,
            projectFingerprint: createHash("sha256")
              .update(`project\0${config.projectId}`)
              .digest("hex"),
          },
          checks: {
            identity: settledStatus(identity),
            tables: settledStatus(database),
            privateStorage: settledStatus(privateStorage),
            exportStorage: settledStatus(exportStorage),
            workers: workers.ready ? "ok" : "failed",
            workerState: workers.state,
            // Seconds rather than milliseconds, and only when known: this is
            // read by whoever is working out why a probe went red, and "the
            // last run was 47 minutes ago" is the answer they need.
            ...(workers.ageMs === undefined
              ? {}
              : { workerLastRunSeconds: Math.round(workers.ageMs / 1000) }),
            notificationQueue: queueReady ? "ok" : "failed",
            notificationQueueOverdue: notificationQueue.overdue,
            notificationQueueFailed: notificationQueue.terminalFailed,
            // Reported in every environment, not only the controlled ones the
            // configuration issue list covers: a workspace whose invitations
            // silently fail looks identical to a healthy one from the outside,
            // and this is the check that separates them.
            emailTransport: mailReady ? "ok" : "failed",
            configuration: issues.length ? "failed" : "ok",
            configurationIssueCount: issues.length,
          },
          requestId,
        },
        { status: status === "ready" ? 200 : 503 },
      ),
      requestId,
    );
  } catch (error) {
    void error;
    return withRequestId(
      jsonResponse(
        {
          status: "not_ready",
          checks: { configuration: "failed" },
          requestId,
        },
        { status: 503 },
      ),
      requestId,
    );
  }
}
