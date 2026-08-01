import type {
  GuideExportFormat,
  PublishedGuideRevision,
} from "../guide-contracts";

export interface GuideExportAsset {
  readonly mediaId: string;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly bytes?: Uint8Array;
  readonly href?: string;
}

export interface GuideExportWatermark {
  readonly viewer?: string;
  readonly workspace?: string;
  readonly exportedAt?: string;
}

export interface GuideRenderOptions {
  readonly assets?: readonly GuideExportAsset[];
  readonly watermark?: GuideExportWatermark;
}

export interface PreparedGuideExport {
  readonly revision: PublishedGuideRevision;
  readonly assets: ReadonlyMap<string, GuideExportAsset>;
  readonly watermark?: GuideExportWatermark;
}

export type GuideRendererErrorCode =
  | "INVALID_REVISION"
  | "FORMAT_DISABLED"
  | "RESTRICTED_EXPORT_DISABLED"
  | "WATERMARK_REQUIRED"
  | "INVALID_OPTIONS"
  | "INVALID_MEDIA"
  | "RENDER_FAILED";

export class GuideRendererError extends Error {
  readonly code: GuideRendererErrorCode;
  readonly format?: GuideExportFormat;
  readonly cause?: unknown;

  constructor(
    code: GuideRendererErrorCode,
    message: string,
    options: { format?: GuideExportFormat; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "GuideRendererError";
    this.code = code;
    this.format = options.format;
    this.cause = options.cause;
  }
}
