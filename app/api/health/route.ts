import { TABLES } from "@/lib/server/appwrite-resources";
import { deploymentConfigurationIssues } from "@/lib/server/appwrite-config";
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
    const { config, users, tables, storage } = createRequestServices();
    const issues = deploymentConfigurationIssues(config);
    const infrastructureChecks = await Promise.allSettled([
      users.list({ queries: [Query.limit(1)], total: false }),
      tables.get({ databaseId: config.databaseId }),
      storage.getBucket({ bucketId: config.privateMediaBucketId }),
      storage.getBucket({ bucketId: config.exportsBucketId }),
    ]);
    const [identity, database, privateStorage, exportStorage] =
      infrastructureChecks;
    const workers = await workerReadiness(config);
    let notificationQueue = { due: 0, terminalFailed: 0 };
    let queueCheck: "ok" | "failed" = "ok";
    if (database.status === "fulfilled") {
      const now = new Date().toISOString();
      const [due, failed] = await Promise.allSettled([
        tables.listRows({
          databaseId: config.databaseId,
          tableId: TABLES.notificationDeliveries,
          queries: [
            Query.equal("status", ["queued"]),
            Query.lessThanEqual("scheduled_at", now),
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
      if (due.status === "fulfilled" && failed.status === "fulfilled") {
        notificationQueue = {
          due: due.value.rows.length,
          terminalFailed: failed.value.rows.length,
        };
      } else {
        queueCheck = "failed";
      }
    } else {
      queueCheck = "failed";
    }
    const infrastructureReady = infrastructureChecks.every(
      (check) => check.status === "fulfilled",
    );
    const queueReady =
      queueCheck === "ok" &&
      notificationQueue.due === 0 &&
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
            notificationQueue: queueReady ? "ok" : "failed",
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
