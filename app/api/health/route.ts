import { TABLES } from "@/lib/server/appwrite-resources";
import { deploymentConfigurationIssues } from "@/lib/server/appwrite-config";
import { jsonResponse, toErrorResponse } from "@/lib/server/http-security";
import { localWorkerReadiness } from "@/lib/server/local-worker-readiness";
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
    const workers = await localWorkerReadiness(config);
    const infrastructureChecks: Promise<unknown>[] = [
      users.list({ queries: [Query.limit(1)], total: false }),
      tables.get({ databaseId: config.databaseId }),
      storage.getBucket({ bucketId: config.privateMediaBucketId }),
      storage.getBucket({ bucketId: config.exportsBucketId }),
    ];
    await Promise.all(infrastructureChecks);
    let notificationQueue = { due: 0, terminalFailed: 0 };
    if (workers.enabled) {
      const now = new Date().toISOString();
      const [due, failed] = await Promise.all([
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
      notificationQueue = {
        due: due.rows.length,
        terminalFailed: failed.rows.length,
      };
    }
    const runtimeReady =
      workers.ready &&
      notificationQueue.due === 0 &&
      notificationQueue.terminalFailed === 0;
    const status = issues.length || !runtimeReady ? "not_ready" : "ready";
    return withRequestId(
      jsonResponse(
        {
          status,
          deployment: {
            environment: config.environment,
            release: process.env.KNOWHOW_RELEASE?.trim() || "unversioned",
            runtime: workers.enabled ? "local-workers" : "local-appwrite",
            projectFingerprint: createHash("sha256")
              .update(`project\0${config.projectId}`)
              .digest("hex"),
          },
          checks: {
            identity: "ok",
            tables: "ok",
            storage: "ok",
            workers: runtimeReady ? "ok" : "attention",
            workerState: workers.state,
            notificationQueue:
              notificationQueue.due || notificationQueue.terminalFailed
                ? "attention"
                : "ok",
            configuration: issues.length ? "attention" : "ok",
          },
          requestId,
        },
        { status: status === "ready" ? 200 : 503 },
      ),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
