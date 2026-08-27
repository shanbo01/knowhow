import {
  decodePayload,
  type GuideStepRecord,
  type PrivateMediaRecord,
} from "../../../../../../../lib/server/domain-records";
import { HttpError, toErrorResponse } from "../../../../../../../lib/server/http-security";
import { sha256Bytes } from "../../../../../../../lib/server/media-validation";
import { TABLES } from "../../../../../../../lib/server/appwrite-resources";
import {
  correlationId,
  createRequestServices,
  requestFingerprint,
  withRequestId,
} from "../../../../../../../lib/server/request-services";
import {
  assertShareToken,
  requirePublicGuideRows,
} from "../../../../../../../lib/server/public-guide-service";
import { consumeFixedWindows } from "../../../../../../../lib/server/rate-limit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MEDIA_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/;

export async function GET(
  request: Request,
  context: { params: Promise<{ token: string; mediaId: string }> },
) {
  const requestId = correlationId(request);
  try {
    const { token: suppliedToken, mediaId } = await context.params;
    const token = assertShareToken(suppliedToken);
    if (!MEDIA_ID.test(mediaId)) {
      throw new HttpError(404, "PUBLIC_MEDIA_NOT_FOUND", "Shared screenshot not found.");
    }
    const services = createRequestServices();
    await consumeFixedWindows(services.store, [
      {
        scope: "public-guide-media-token",
        subject: token,
        limit: 600,
        windowSeconds: 60,
      },
      {
        scope: "public-guide-media-client",
        subject: requestFingerprint(request),
        limit: 240,
        windowSeconds: 60,
      },
    ]);
    const shared = await requirePublicGuideRows(services.store, token);
    const [mediaRow, stepRows] = await Promise.all([
      services.store.get(TABLES.privateMedia, mediaId),
      services.store.list(TABLES.guideSteps, {
        filters: [{ field: "subject_id", value: shared.revisionRow.$id }],
      }),
    ]);
    const referenced = stepRows.some(
      (row) =>
        decodePayload<GuideStepRecord>(row, null as never)?.screenshotMediaId ===
        mediaId,
    );
    if (
      !referenced ||
      !mediaRow ||
      mediaRow.workspace_id !== shared.guideRow.workspace_id ||
      mediaRow.subject_id !== shared.revisionRow.$id ||
      mediaRow.status !== "ready"
    ) {
      throw new HttpError(404, "PUBLIC_MEDIA_NOT_FOUND", "Shared screenshot not found.");
    }
    const media = decodePayload<PrivateMediaRecord>(mediaRow, null as never);
    if (!media || media.deletedAt || media.storageFileId !== mediaId) {
      throw new HttpError(404, "PUBLIC_MEDIA_NOT_FOUND", "Shared screenshot not found.");
    }
    const object = await services.objects.get(media.storageFileId);
    if (!object) {
      throw new HttpError(404, "PUBLIC_MEDIA_NOT_FOUND", "Shared screenshot not found.");
    }
    if (
      object.contentType !== media.contentType ||
      (media.sha256 && (await sha256Bytes(object.bytes)) !== media.sha256)
    ) {
      throw new HttpError(500, "MEDIA_INTEGRITY_FAILURE", "Shared screenshot failed its integrity check.", {
        expose: false,
      });
    }
    return withRequestId(
      new Response(object.bytes.slice().buffer as ArrayBuffer, {
        headers: {
          "content-type": media.contentType,
          "cache-control": "private, no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
          "cross-origin-resource-policy": "same-origin",
        },
      }),
      requestId,
    );
  } catch (error) {
    return withRequestId(toErrorResponse(error, requestId), requestId);
  }
}
