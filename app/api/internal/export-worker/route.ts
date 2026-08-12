import {
  assertExportWorkerRequest,
} from "../../../../lib/server/worker-auth";
import { processExportJob } from "../../../../lib/server/export-job-service";
import {
  correlationId,
  createRequestServices,
  withRequestId,
} from "../../../../lib/server/request-services";
import {
  HttpError,
  jsonResponse,
  readJsonObject,
  toErrorResponse,
} from "../../../../lib/server/http-security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

export async function POST(request: Request) {
  const requestId = correlationId(request);
  try {
    const body = await readJsonObject(request, 2_048);
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!ID.test(jobId)) {
      throw new HttpError(400, "EXPORT_JOB_ID_INVALID", "Export job ID is invalid.");
    }
    await assertExportWorkerRequest(request, jobId);
    const { store, objects, exportObjects } = createRequestServices();
    const result = await processExportJob(store, objects, exportObjects, jobId);
    return withRequestId(jsonResponse({ ok: true, ...result }), requestId);
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
