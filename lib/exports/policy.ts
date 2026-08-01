import {
  GuideContractError,
  parsePublishedGuideRevision,
  type GuideExportFormat,
  type PublishedGuideRevision,
} from "../guide-contracts";
import {
  GuideRendererError,
  type GuideExportAsset,
  type GuideExportWatermark,
  type GuideRenderOptions,
  type PreparedGuideExport,
} from "./types";

const SAFE_ASSET_URL = /^(?:https?:\/\/|\/|\.\/|\.\.\/|data:image\/(?:png|jpeg);base64,)/i;

function validateWatermark(
  value: GuideExportWatermark | undefined,
): GuideExportWatermark | undefined {
  if (value === undefined) return undefined;
  const allowed = new Set(["viewer", "workspace", "exportedAt"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new GuideRendererError(
        "INVALID_OPTIONS",
        `Unknown watermark option: ${key}.`,
      );
    }
  }
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate !== undefined && (typeof candidate !== "string" || !candidate.trim())) {
      throw new GuideRendererError(
        "INVALID_OPTIONS",
        `Watermark ${key} must be a non-empty string.`,
      );
    }
    if (typeof candidate === "string" && candidate.length > 500) {
      throw new GuideRendererError(
        "INVALID_OPTIONS",
        `Watermark ${key} must not exceed 500 characters.`,
      );
    }
  }
  if (value.exportedAt && Number.isNaN(Date.parse(value.exportedAt))) {
    throw new GuideRendererError(
      "INVALID_OPTIONS",
      "Watermark exportedAt must be an ISO date or date-time string.",
    );
  }
  return Object.freeze({
    viewer: value.viewer?.trim(),
    workspace: value.workspace?.trim(),
    exportedAt: value.exportedAt,
  });
}

function validateAsset(asset: GuideExportAsset): GuideExportAsset {
  const allowed = new Set(["mediaId", "mimeType", "bytes", "href"]);
  for (const key of Object.keys(asset)) {
    if (!allowed.has(key)) {
      throw new GuideRendererError(
        "INVALID_OPTIONS",
        `Unknown export asset option: ${key}.`,
      );
    }
  }
  if (!asset.mediaId?.trim()) {
    throw new GuideRendererError("INVALID_OPTIONS", "Export assets require a mediaId.");
  }
  if (asset.mimeType !== "image/png" && asset.mimeType !== "image/jpeg") {
    throw new GuideRendererError(
      "INVALID_OPTIONS",
      `Unsupported export asset type for ${asset.mediaId}.`,
    );
  }
  if (asset.bytes !== undefined && !(asset.bytes instanceof Uint8Array)) {
    throw new GuideRendererError(
      "INVALID_OPTIONS",
      `Export asset ${asset.mediaId} bytes must be a Uint8Array.`,
    );
  }
  if (asset.href !== undefined && !SAFE_ASSET_URL.test(asset.href)) {
    throw new GuideRendererError(
      "INVALID_OPTIONS",
      `Export asset ${asset.mediaId} has an unsafe href.`,
    );
  }
  return asset;
}

function assetMap(
  revision: PublishedGuideRevision,
  assets: readonly GuideExportAsset[] | undefined,
): ReadonlyMap<string, GuideExportAsset> {
  const result = new Map<string, GuideExportAsset>();
  for (const asset of assets ?? []) {
    const valid = validateAsset(asset);
    if (result.has(valid.mediaId)) {
      throw new GuideRendererError(
        "INVALID_OPTIONS",
        `Duplicate export asset: ${valid.mediaId}.`,
      );
    }
    result.set(valid.mediaId, valid);
  }

  for (const block of revision.blocks) {
    if (block.type !== "action" || !block.media) continue;
    const supplied = result.get(block.media.mediaId);
    if (supplied && supplied.mimeType !== block.media.mimeType) {
      throw new GuideRendererError(
        "INVALID_MEDIA",
        `Media type mismatch for ${block.media.mediaId}.`,
      );
    }
  }
  if (revision.branding.logoMediaId) {
    const logo = result.get(revision.branding.logoMediaId);
    if (logo && logo.mimeType !== "image/png" && logo.mimeType !== "image/jpeg") {
      throw new GuideRendererError("INVALID_MEDIA", "The workspace logo is not an image.");
    }
  }
  return result;
}

function resolveWatermark(
  revision: PublishedGuideRevision,
  supplied: GuideExportWatermark | undefined,
  format: GuideExportFormat,
): GuideExportWatermark | undefined {
  const policy = revision.exportPolicy.watermark;
  if (policy.mode === "none") return undefined;

  const valid = validateWatermark(supplied);
  const resolved: GuideExportWatermark = {
    viewer: policy.includeViewer ? valid?.viewer : undefined,
    workspace: policy.includeWorkspace
      ? valid?.workspace ?? revision.branding.workspaceName
      : undefined,
    exportedAt: policy.includeDate ? valid?.exportedAt : undefined,
  };

  if (policy.mode === "required") {
    const missing = [
      policy.includeViewer && !resolved.viewer ? "viewer" : "",
      policy.includeWorkspace && !resolved.workspace ? "workspace" : "",
      policy.includeDate && !resolved.exportedAt ? "date" : "",
    ].filter(Boolean);
    if (missing.length) {
      throw new GuideRendererError(
        "WATERMARK_REQUIRED",
        `This guide requires watermark ${missing.join(", ")}.`,
        { format },
      );
    }
  }

  return resolved.viewer || resolved.workspace || resolved.exportedAt
    ? Object.freeze(resolved)
    : undefined;
}

export function prepareGuideExport(
  candidate: PublishedGuideRevision,
  format: Exclude<GuideExportFormat, "live-link">,
  options: GuideRenderOptions = {},
): PreparedGuideExport {
  let revision: PublishedGuideRevision;
  try {
    revision = parsePublishedGuideRevision(candidate);
  } catch (error) {
    throw new GuideRendererError(
      "INVALID_REVISION",
      error instanceof GuideContractError
        ? `${error.message} ${error.issues.map((item) => `${item.path}: ${item.message}`).join(" ")}`
        : "The published guide revision is invalid.",
      { format, cause: error },
    );
  }

  if (!revision.exportPolicy.allowedFormats.includes(format)) {
    throw new GuideRendererError(
      "FORMAT_DISABLED",
      `${format.toUpperCase()} export is disabled for this guide.`,
      { format },
    );
  }
  if (
    revision.audience.mode === "restricted" &&
    revision.exportPolicy.restrictedGuideExports === "disabled"
  ) {
    throw new GuideRendererError(
      "RESTRICTED_EXPORT_DISABLED",
      "Exports are disabled for this restricted guide.",
      { format },
    );
  }

  const allowedOptionKeys = new Set(["assets", "watermark"]);
  for (const key of Object.keys(options)) {
    if (!allowedOptionKeys.has(key)) {
      throw new GuideRendererError("INVALID_OPTIONS", `Unknown render option: ${key}.`, {
        format,
      });
    }
  }

  return {
    revision,
    assets: assetMap(revision, options.assets),
    watermark: resolveWatermark(revision, options.watermark, format),
  };
}
