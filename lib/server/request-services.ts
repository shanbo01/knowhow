import "server-only";

import { createAdminAppwrite } from "./appwrite-clients";
import { AppwritePrivateObjectStore } from "./appwrite-object-store";
import { AppwriteRecordStore } from "./appwrite-record-store";

export function createRequestServices() {
  const appwrite = createAdminAppwrite();
  return {
    ...appwrite,
    store: new AppwriteRecordStore(appwrite.tables, appwrite.config.databaseId),
    objects: new AppwritePrivateObjectStore(
      appwrite.storage,
      appwrite.config.privateMediaBucketId,
    ),
    exportObjects: new AppwritePrivateObjectStore(
      appwrite.storage,
      appwrite.config.exportsBucketId,
    ),
  };
}

export function allowedRequestOrigins() {
  return (process.env.KNOWHOW_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function correlationId(request: Request) {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9._:-]{8,64}$/.test(supplied)
    ? supplied
    : crypto.randomUUID();
}

export function requestFingerprint(request: Request) {
  const forwarded = request.headers
    .get("x-forwarded-for")
    ?.split(",", 1)[0]
    ?.trim();
  const address =
    forwarded && /^[0-9a-f:.]{3,64}$/i.test(forwarded)
      ? forwarded
      : request.headers.get("x-real-ip")?.slice(0, 64) || "unknown";
  const agent = (request.headers.get("user-agent") ?? "unknown").slice(0, 256);
  return `${address}:${agent}`;
}

export function withRequestId(response: Response, requestId: string) {
  const headers = new Headers(response.headers);
  headers.set("x-request-id", requestId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
