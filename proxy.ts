import { createHash, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  deploymentConfigurationIssues,
  getAppwriteServerConfig,
  restoreApplicationConfiguration,
} from "@/lib/server/appwrite-config";

const RESTORE_ACCESS_HEADER = "x-knowhow-restore-access";

function digest(value: string) {
  return createHash("sha256").update(value, "utf8").digest();
}

function restoreAccessAllowed(request: NextRequest) {
  const expected =
    process.env.KNOWHOW_RESTORE_APPLICATION_ACCESS_TOKEN?.trim() ?? "";
  const supplied = request.headers.get(RESTORE_ACCESS_HEADER) ?? "";
  return (
    expected.length >= 32 &&
    !expected.toLowerCase().includes("replace-with-") &&
    timingSafeEqual(digest(supplied), digest(expected))
  );
}

function restoreRuntimeReady() {
  try {
    const config = getAppwriteServerConfig();
    const restoreApplication = restoreApplicationConfiguration(config);
    return (
      restoreApplication.enabled &&
      restoreApplication.valid &&
      deploymentConfigurationIssues(config).length === 0
    );
  } catch {
    return false;
  }
}

export function proxy(request: NextRequest) {
  if (process.env.KNOWHOW_RESTORE_APPLICATION_MODE !== "1") {
    return NextResponse.next();
  }
  if (!restoreRuntimeReady() || !restoreAccessAllowed(request)) {
    return Response.json(
      { code: "NOT_FOUND", message: "The requested resource was not found." },
      {
        status: 404,
        headers: {
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "x-robots-tag": "noindex, nofollow, noarchive",
        },
      },
    );
  }

  const headers = new Headers(request.headers);
  headers.delete(RESTORE_ACCESS_HEADER);
  return NextResponse.next({ request: { headers } });
}
