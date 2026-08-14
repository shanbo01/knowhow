import { buildDevelopmentExtensionPackage } from "../../../lib/server/extension-package";
import { toErrorResponse } from "../../../lib/server/http-security";
import {
  correlationId,
  withRequestId,
} from "../../../lib/server/request-services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requestId = correlationId(request);
  try {
    const artifact = await buildDevelopmentExtensionPackage(request);
    const body = Uint8Array.from(artifact.zip);
    const headers = new Headers({
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${artifact.filename}"`,
      "content-length": String(body.byteLength),
      "content-type": "application/zip",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
    });
    return new Response(body, {
      status: 200,
      headers,
    });
  } catch (error) {
    console.error("[extension-package]", error);
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
