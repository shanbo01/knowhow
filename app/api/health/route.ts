import { APPWRITE_RESOURCES } from "@/lib/server/appwrite-resources";
import {
  deploymentConfigurationIssues,
  restoreApplicationConfiguration,
} from "@/lib/server/appwrite-config";
import { jsonResponse, toErrorResponse } from "@/lib/server/http-security";
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
    const { config, users, tables, storage, functions } = createRequestServices();
    const issues = deploymentConfigurationIssues(config);
    const restoreApplication = restoreApplicationConfiguration(config);
    await Promise.all([
      users.list({ queries: [Query.limit(1)], total: false }),
      tables.get({ databaseId: config.databaseId }),
      storage.getBucket({ bucketId: config.privateMediaBucketId }),
      storage.getBucket({ bucketId: config.exportsBucketId }),
      functions.get({ functionId: APPWRITE_RESOURCES.operationsFunction }),
      functions.get({ functionId: APPWRITE_RESOURCES.exportFunction }),
    ]);
    const status = issues.length ? "not_ready" : "ready";
    return withRequestId(
      jsonResponse(
        {
          status,
          deployment: {
            environment: config.environment,
            release: process.env.KNOWHOW_RELEASE?.trim() || "unversioned",
            projectFingerprint: createHash("sha256")
              .update(`project\0${config.projectId}`)
              .digest("hex"),
            ...(restoreApplication.enabled
              ? {
                  mode: "isolated-restore-application",
                  databaseFingerprint: createHash("sha256")
                    .update(`database\0${config.databaseId}`)
                    .digest("hex"),
                  restorationFingerprint: createHash("sha256")
                    .update(`restoration\0${restoreApplication.restorationId}`)
                    .digest("hex"),
                  disposableSiteFingerprint: createHash("sha256")
                    .update(`site\0${restoreApplication.siteId}`)
                    .digest("hex"),
                  siteOriginFingerprint: createHash("sha256")
                    .update(`site-origin\0${restoreApplication.siteOrigin}`)
                    .digest("hex"),
                  sourceSiteOriginFingerprint: createHash("sha256")
                    .update(
                      `site-origin\0${restoreApplication.sourceSiteOrigin}`,
                    )
                    .digest("hex"),
                }
              : {}),
          },
          checks: {
            identity: "ok",
            tables: "ok",
            storage: "ok",
            functions: "ok",
            configuration: issues.length ? "attention" : "ok",
            ...(restoreApplication.enabled
              ? {
                  restoreIsolation: restoreApplication.valid
                    ? "ok"
                    : "attention",
                }
              : {}),
          },
          requestId,
        },
        { status: issues.length ? 503 : 200 },
      ),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
