import { HttpError } from "./http-security";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_WORKSPACE_LOGO_BYTES = 1024 * 1024;
const MAX_DIMENSION = 16_384;
const MAX_SCREENSHOT_PIXELS = 64_000_000;
const MAX_LOGO_DIMENSION = 4_096;
const MAX_LOGO_PIXELS = 16_000_000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export type ScreenshotContentType = "image/png" | "image/jpeg" | "image/webp";
export type WorkspaceLogoContentType = "image/png" | "image/jpeg";

export interface R2ObjectBodyLike {
  body: ReadableStream<Uint8Array>;
  size: number;
  httpMetadata?: Record<string, unknown>;
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>,
    options?: {
      httpMetadata?: Record<string, string>;
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  delete(key: string): Promise<void>;
}

export function requireR2Binding(value: unknown): R2BucketLike {
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as Partial<R2BucketLike>).put !== "function" ||
    typeof (value as Partial<R2BucketLike>).get !== "function" ||
    typeof (value as Partial<R2BucketLike>).delete !== "function"
  ) {
    throw new HttpError(500, "R2_BINDING_MISSING", "Private media storage is unavailable.", {
      expose: false,
    });
  }
  return value as R2BucketLike;
}

export interface RedactedScreenshotInput {
  workspaceId: string;
  revisionId: string;
  captureId?: string;
  uploadedBy: string;
  contentType: ScreenshotContentType;
  bytes: ArrayBuffer | Uint8Array;
  width: number;
  height: number;
  /** Must describe the already-redacted, rasterized bytes passed in `bytes`. */
  redactionAttested: true;
  /** Canvas/raster output strips DOM data and source image metadata. */
  sourceRasterized: true;
}

export interface StoredPrivateMedia {
  objectKey: string;
  contentType: ScreenshotContentType;
  byteSize: number;
  sha256: string;
  width: number;
  height: number;
  redactionState: "redacted";
  sourceRasterized: true;
}

export interface StoredWorkspaceLogo {
  objectKey: string;
  contentType: WorkspaceLogoContentType;
  byteSize: number;
  sha256: string;
}

function asBytes(value: ArrayBuffer | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function detectedType(bytes: Uint8Array): ScreenshotContentType | null {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

function rasterDimensions(
  bytes: Uint8Array,
  contentType: ScreenshotContentType,
): { width: number; height: number } | null {
  if (contentType === "image/png") {
    if (bytes.length < 24) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (contentType !== "image/jpeg" || bytes.length < 10) return null;
  const startOfFrame = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ]);
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) continue;
    if (offset + 1 >= bytes.length) return null;
    const segmentLength = (bytes[offset] << 8) | bytes[offset + 1];
    if (segmentLength < 2 || offset + segmentLength > bytes.length) return null;
    if (startOfFrame.has(marker)) {
      if (segmentLength < 7) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += segmentLength;
  }
  return null;
}

function safeId(value: string, field: string): string {
  if (!SAFE_ID.test(value)) {
    throw new HttpError(400, "MEDIA_ID_INVALID", `${field} is invalid.`);
  }
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function storeRedactedScreenshot(
  bucket: R2BucketLike,
  input: RedactedScreenshotInput,
): Promise<StoredPrivateMedia> {
  if (input.redactionAttested !== true || input.sourceRasterized !== true) {
    throw new HttpError(
      400,
      "REDACTION_REQUIRED",
      "Only locally redacted, rasterized screenshots may be uploaded.",
    );
  }
  const bytes = asBytes(input.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_SCREENSHOT_BYTES) {
    throw new HttpError(413, "MEDIA_SIZE_INVALID", "The screenshot size is not allowed.");
  }
  if (
    !Number.isSafeInteger(input.width) ||
    !Number.isSafeInteger(input.height) ||
    input.width < 1 ||
    input.height < 1 ||
    input.width > MAX_DIMENSION ||
    input.height > MAX_DIMENSION
  ) {
    throw new HttpError(400, "MEDIA_DIMENSIONS_INVALID", "The screenshot dimensions are not allowed.");
  }
  const detected = detectedType(bytes);
  if (!detected || detected === "image/webp" || detected !== input.contentType) {
    throw new HttpError(415, "MEDIA_TYPE_INVALID", "The screenshot file type is not allowed.");
  }
  const actualDimensions = rasterDimensions(bytes, detected);
  if (
    !actualDimensions ||
    actualDimensions.width !== input.width ||
    actualDimensions.height !== input.height ||
    actualDimensions.width * actualDimensions.height > MAX_SCREENSHOT_PIXELS
  ) {
    throw new HttpError(400, "MEDIA_DIMENSIONS_INVALID", "The screenshot dimensions do not match its raster bytes.");
  }

  const workspaceId = safeId(input.workspaceId, "Workspace ID");
  const revisionId = safeId(input.revisionId, "Revision ID");
  const uploadedBy = safeId(input.uploadedBy, "Uploader ID");
  const captureId = input.captureId ? safeId(input.captureId, "Capture ID") : "manual";
  const extension = detected === "image/png" ? "png" : detected === "image/jpeg" ? "jpg" : "webp";
  const objectKey = `workspaces/${workspaceId}/revisions/${revisionId}/${crypto.randomUUID()}.${extension}`;
  const digest = await sha256(bytes);

  await bucket.put(objectKey, bytes, {
    httpMetadata: {
      contentType: detected,
      cacheControl: "private, no-store",
      contentDisposition: "inline",
    },
    customMetadata: {
      workspaceId,
      revisionId,
      captureId,
      uploadedBy,
      sha256: digest,
      redactionState: "redacted",
      sourceRasterized: "true",
    },
  });

  return {
    objectKey,
    contentType: detected,
    byteSize: bytes.byteLength,
    sha256: digest,
    width: input.width,
    height: input.height,
    redactionState: "redacted",
    sourceRasterized: true,
  };
}

export async function storeWorkspaceLogo(
  bucket: R2BucketLike,
  input: {
    workspaceId: string;
    uploadedBy: string;
    contentType: WorkspaceLogoContentType;
    bytes: ArrayBuffer | Uint8Array;
  },
): Promise<StoredWorkspaceLogo> {
  const bytes = asBytes(input.bytes);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_WORKSPACE_LOGO_BYTES) {
    throw new HttpError(413, "LOGO_SIZE_INVALID", "The workspace logo must be 1 MB or smaller.");
  }
  const detected = detectedType(bytes);
  if (
    (detected !== "image/png" && detected !== "image/jpeg") ||
    detected !== input.contentType
  ) {
    throw new HttpError(415, "LOGO_TYPE_INVALID", "Use a valid PNG or JPEG workspace logo.");
  }
  const dimensions = rasterDimensions(bytes, detected);
  if (
    !dimensions ||
    dimensions.width < 1 ||
    dimensions.height < 1 ||
    dimensions.width > MAX_LOGO_DIMENSION ||
    dimensions.height > MAX_LOGO_DIMENSION ||
    dimensions.width * dimensions.height > MAX_LOGO_PIXELS
  ) {
    throw new HttpError(400, "LOGO_DIMENSIONS_INVALID", "The workspace logo dimensions are not allowed.");
  }
  const workspaceId = safeId(input.workspaceId, "Workspace ID");
  const uploadedBy = safeId(input.uploadedBy, "Uploader ID");
  const extension = detected === "image/png" ? "png" : "jpg";
  const objectKey = `workspaces/${workspaceId}/branding/${crypto.randomUUID()}.${extension}`;
  const digest = await sha256(bytes);
  await bucket.put(objectKey, bytes, {
    httpMetadata: {
      contentType: detected,
      cacheControl: "private, no-store",
      contentDisposition: "inline",
    },
    customMetadata: {
      workspaceId,
      uploadedBy,
      sha256: digest,
      mediaKind: "workspace-logo",
    },
  });
  return {
    objectKey,
    contentType: detected,
    byteSize: bytes.byteLength,
    sha256: digest,
  };
}

export async function readPrivateMedia(
  bucket: R2BucketLike,
  objectKey: string,
  workspaceId: string,
): Promise<R2ObjectBodyLike> {
  const safeWorkspace = safeId(workspaceId, "Workspace ID");
  if (!objectKey.startsWith(`workspaces/${safeWorkspace}/`)) {
    throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
  }
  const object = await bucket.get(objectKey);
  if (!object) throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
  if (
    object.customMetadata?.workspaceId !== safeWorkspace ||
    object.customMetadata?.redactionState !== "redacted" ||
    object.customMetadata?.sourceRasterized !== "true"
  ) {
    throw new HttpError(500, "MEDIA_BOUNDARY_INVALID", "Media failed its privacy boundary.", {
      expose: false,
    });
  }
  return object;
}

export async function readWorkspaceLogo(
  bucket: R2BucketLike,
  objectKey: string,
  workspaceId: string,
): Promise<R2ObjectBodyLike> {
  const safeWorkspace = safeId(workspaceId, "Workspace ID");
  if (!objectKey.startsWith(`workspaces/${safeWorkspace}/branding/`)) {
    throw new HttpError(404, "LOGO_NOT_FOUND", "Workspace logo not found.");
  }
  const object = await bucket.get(objectKey);
  if (!object) throw new HttpError(404, "LOGO_NOT_FOUND", "Workspace logo not found.");
  if (
    object.customMetadata?.workspaceId !== safeWorkspace ||
    object.customMetadata?.mediaKind !== "workspace-logo"
  ) {
    throw new HttpError(500, "MEDIA_BOUNDARY_INVALID", "Media failed its workspace boundary.", {
      expose: false,
    });
  }
  return object;
}

export async function clonePrivateMedia(
  bucket: R2BucketLike,
  input: {
    sourceObjectKey: string;
    workspaceId: string;
    revisionId: string;
    uploadedBy: string;
  },
): Promise<string> {
  const workspaceId = safeId(input.workspaceId, "Workspace ID");
  const revisionId = safeId(input.revisionId, "Revision ID");
  const uploadedBy = safeId(input.uploadedBy, "Uploader ID");
  const source = await readPrivateMedia(bucket, input.sourceObjectKey, workspaceId);
  const contentType = source.httpMetadata?.contentType;
  if (
    contentType !== "image/png" &&
    contentType !== "image/jpeg" &&
    contentType !== "image/webp"
  ) {
    throw new HttpError(415, "MEDIA_TYPE_INVALID", "The source media cannot be restored.");
  }
  const extension = contentType === "image/png" ? "png" : contentType === "image/jpeg" ? "jpg" : "webp";
  const objectKey = `workspaces/${workspaceId}/revisions/${revisionId}/${crypto.randomUUID()}.${extension}`;
  await bucket.put(objectKey, source.body, {
    httpMetadata: {
      contentType,
      cacheControl: "private, no-store",
      contentDisposition: "inline",
    },
    customMetadata: {
      workspaceId,
      revisionId,
      captureId: "restored",
      uploadedBy,
      sha256: source.customMetadata?.sha256 ?? "unknown",
      redactionState: "redacted",
      sourceRasterized: "true",
    },
  });
  return objectKey;
}

export function deletePrivateMedia(
  bucket: R2BucketLike,
  objectKey: string,
  workspaceId: string,
): Promise<void> {
  const safeWorkspace = safeId(workspaceId, "Workspace ID");
  if (!objectKey.startsWith(`workspaces/${safeWorkspace}/`)) {
    throw new HttpError(404, "MEDIA_NOT_FOUND", "Media not found.");
  }
  return bucket.delete(objectKey);
}
