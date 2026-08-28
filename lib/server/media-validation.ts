import { HttpError } from "./http-security";

export type SafeImageType = "image/png" | "image/jpeg";

const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
const MAX_LOGO_BYTES = 1024 * 1024;
const MAX_FAVICON_BYTES = 256 * 1024;
const MAX_SCREENSHOT_DIMENSION = 16_384;
const MAX_SCREENSHOT_PIXELS = 64_000_000;
const MAX_LOGO_DIMENSION = 4_096;
const MAX_LOGO_PIXELS = 16_000_000;
const MAX_FAVICON_DIMENSION = 256;
const MAX_FAVICON_PIXELS = MAX_FAVICON_DIMENSION * MAX_FAVICON_DIMENSION;

function detectedType(bytes: Uint8Array): SafeImageType | null {
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 10 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

function dimensions(bytes: Uint8Array, type: SafeImageType) {
  if (type === "image/png") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  const frameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
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
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return null;
    if (frameMarkers.has(marker)) {
      if (length < 7) return null;
      return {
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
      };
    }
    offset += length;
  }
  return null;
}

async function digest(bytes: Uint8Array) {
  const hash = await crypto.subtle.digest("SHA-256", bytes.slice().buffer);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function validate(
  bytes: Uint8Array,
  claimedType: string,
  limits: { bytes: number; dimension: number; pixels: number; label: "screenshot" | "logo" | "favicon" },
) {
  if (bytes.byteLength === 0 || bytes.byteLength > limits.bytes) {
    throw new HttpError(413, limits.label === "logo" ? "LOGO_SIZE_INVALID" : "MEDIA_SIZE_INVALID", `The ${limits.label} size is not allowed.`);
  }
  const contentType = detectedType(bytes);
  if (!contentType || contentType !== claimedType) {
    throw new HttpError(415, limits.label === "logo" ? "LOGO_TYPE_INVALID" : "MEDIA_TYPE_INVALID", `Use a valid rasterized PNG or JPEG ${limits.label}.`);
  }
  const raster = dimensions(bytes, contentType);
  if (
    !raster || raster.width < 1 || raster.height < 1 ||
    raster.width > limits.dimension || raster.height > limits.dimension ||
    raster.width * raster.height > limits.pixels
  ) {
    throw new HttpError(400, limits.label === "logo" ? "LOGO_DIMENSIONS_INVALID" : "MEDIA_DIMENSIONS_INVALID", `The ${limits.label} dimensions are not allowed.`);
  }
  return {
    contentType,
    byteSize: bytes.byteLength,
    width: raster.width,
    height: raster.height,
    sha256: await digest(bytes),
  };
}

export async function validateScreenshot(
  bytes: Uint8Array,
  claimedType: string,
  claimedWidth: number,
  claimedHeight: number,
) {
  const result = await validate(bytes, claimedType, {
    bytes: MAX_SCREENSHOT_BYTES,
    dimension: MAX_SCREENSHOT_DIMENSION,
    pixels: MAX_SCREENSHOT_PIXELS,
    label: "screenshot",
  });
  if (
    !Number.isSafeInteger(claimedWidth) || !Number.isSafeInteger(claimedHeight) ||
    result.width !== claimedWidth || result.height !== claimedHeight
  ) {
    throw new HttpError(400, "MEDIA_DIMENSIONS_INVALID", "The screenshot dimensions do not match its raster bytes.");
  }
  return result;
}

export function validateLogo(bytes: Uint8Array, claimedType: string) {
  return validate(bytes, claimedType, {
    bytes: MAX_LOGO_BYTES,
    dimension: MAX_LOGO_DIMENSION,
    pixels: MAX_LOGO_PIXELS,
    label: "logo",
  });
}

export async function validateFavicon(bytes: Uint8Array, claimedType: string) {
  if (claimedType !== "image/png") {
    throw new HttpError(415, "MEDIA_TYPE_INVALID", "Use a rasterized PNG favicon.");
  }
  return validate(bytes, claimedType, {
    bytes: MAX_FAVICON_BYTES,
    dimension: MAX_FAVICON_DIMENSION,
    pixels: MAX_FAVICON_PIXELS,
    label: "favicon",
  });
}

export async function sha256Bytes(bytes: Uint8Array) {
  return digest(bytes);
}
