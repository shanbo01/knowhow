import {
  clip,
  degrees,
  endPath,
  PDFDocument,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  StandardFonts,
  rgb,
  type PDFFont,
  type PDFImage,
  type PDFPage,
} from "pdf-lib";
import type {
  GuideActionMedia,
  GuideBlock,
  PublishedGuideRevision,
} from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  formatIsoDate,
  formatWatermark,
  hexToRgb,
  pdfSafeText,
} from "./shared";
import {
  GuideRendererError,
  type GuideExportAsset,
  type GuideRenderOptions,
} from "./types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 48;
const TOP = 790;
const BOTTOM = 52;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;

const INK = rgb(0.09, 0.13, 0.1);
const MUTED = rgb(0.36, 0.42, 0.38);
const RULE = rgb(0.82, 0.85, 0.82);
const NOTE_BACKGROUND = rgb(0.95, 0.97, 0.95);
const WARNING_BACKGROUND = rgb(1, 0.97, 0.9);
const SUCCESS_BACKGROUND = rgb(0.93, 0.98, 0.95);

interface PdfFonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
  readonly mono: PDFFont;
}

interface WrappedTextOptions {
  readonly font?: PDFFont;
  readonly size?: number;
  readonly color?: ReturnType<typeof rgb>;
  readonly lineHeight?: number;
  readonly indent?: number;
  readonly after?: number;
}

function wrapLine(
  value: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const safe = pdfSafeText(value).replace(/\s+/g, " ").trim();
  if (!safe) return [""];
  const words = safe.split(" ");
  const lines: string[] = [];
  let current = "";

  const pushLongWord = (word: string): string => {
    let fragment = "";
    for (const character of word) {
      const candidate = `${fragment}${character}`;
      if (fragment && font.widthOfTextAtSize(candidate, size) > width) {
        lines.push(fragment);
        fragment = character;
      } else {
        fragment = candidate;
      }
    }
    return fragment;
  };

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current =
      font.widthOfTextAtSize(word, size) > width ? pushLongWord(word) : word;
  }
  if (current) lines.push(current);
  return lines;
}

function wrapParagraphs(
  value: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const result: string[] = [];
  const paragraphs = value.split(/\r?\n/);
  paragraphs.forEach((paragraph, index) => {
    result.push(...wrapLine(paragraph, font, size, width));
    if (index < paragraphs.length - 1 && paragraph.trim()) result.push("");
  });
  return result;
}

function centeredX(text: string, font: PDFFont, size: number): number {
  return Math.max(MARGIN_X, (PAGE_WIDTH - font.widthOfTextAtSize(text, size)) / 2);
}

async function embedImage(
  document: PDFDocument,
  asset: GuideExportAsset,
): Promise<PDFImage | undefined> {
  if (!asset.bytes) return undefined;
  try {
    return asset.mimeType === "image/png"
      ? await document.embedPng(asset.bytes)
      : await document.embedJpg(asset.bytes);
  } catch (error) {
    throw new GuideRendererError(
      "INVALID_MEDIA",
      `Rivet could not decode media ${asset.mediaId}.`,
      { format: "pdf", cause: error },
    );
  }
}

export async function renderGuideToPdf(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): Promise<Uint8Array> {
  const prepared = prepareGuideExport(candidate, "pdf", options);
  const { revision, assets, watermark } = prepared;

  try {
    const document = await PDFDocument.create({ updateMetadata: false });
    const fonts: PdfFonts = {
      regular: await document.embedFont(StandardFonts.Helvetica),
      bold: await document.embedFont(StandardFonts.HelveticaBold),
      mono: await document.embedFont(StandardFonts.Courier),
    };
    const accentValue = hexToRgb(revision.branding.accentColor);
    const accent = rgb(accentValue.red, accentValue.green, accentValue.blue);
    const imageCache = new Map<string, PDFImage | undefined>();

    document.setTitle(pdfSafeText(revision.title));
    document.setAuthor(pdfSafeText(revision.branding.workspaceName));
    document.setSubject(`Published guide revision ${revision.revisionNumber}`);
    document.setCreator("Rivet");
    document.setProducer("Rivet");
    document.setKeywords(["Rivet", "guide", "SOP", revision.guideId]);
    const publishedDate = new Date(revision.publishedAt);
    document.setCreationDate(publishedDate);
    document.setModificationDate(publishedDate);

    let page: PDFPage = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = TOP;

    const continuationHeader = (target: PDFPage) => {
      const left = pdfSafeText(revision.title);
      const right = `Revision ${revision.revisionNumber}`;
      target.drawText(left, {
        x: MARGIN_X,
        y: PAGE_HEIGHT - 30,
        font: fonts.regular,
        size: 8,
        color: MUTED,
        maxWidth: CONTENT_WIDTH - 80,
      });
      target.drawText(right, {
        x: PAGE_WIDTH - MARGIN_X - fonts.regular.widthOfTextAtSize(right, 8),
        y: PAGE_HEIGHT - 30,
        font: fonts.regular,
        size: 8,
        color: MUTED,
      });
      target.drawLine({
        start: { x: MARGIN_X, y: PAGE_HEIGHT - 37 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - 37 },
        thickness: 0.5,
        color: RULE,
      });
    };

    const addPage = (continuation = true) => {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      if (continuation) continuationHeader(page);
      y = continuation ? PAGE_HEIGHT - 58 : TOP;
    };

    const ensureSpace = (height: number) => {
      if (y - height < BOTTOM) addPage(true);
    };

    const drawWrapped = (
      value: string,
      settings: WrappedTextOptions = {},
    ): void => {
      const font = settings.font ?? fonts.regular;
      const size = settings.size ?? 10.5;
      const lineHeight = settings.lineHeight ?? size * 1.45;
      const indent = settings.indent ?? 0;
      const lines = wrapParagraphs(value, font, size, CONTENT_WIDTH - indent);
      for (const line of lines) {
        ensureSpace(lineHeight);
        if (line) {
          page.drawText(line, {
            x: MARGIN_X + indent,
            y,
            font,
            size,
            color: settings.color ?? INK,
          });
        }
        y -= lineHeight;
      }
      y -= settings.after ?? 5;
    };

    const drawCallout = (
      title: string,
      body: string,
      tone: "note" | "warning" | "success",
    ) => {
      const titleLines = wrapParagraphs(title, fonts.bold, 10, CONTENT_WIDTH - 28);
      const bodyLines = wrapParagraphs(body, fonts.regular, 9.5, CONTENT_WIDTH - 28);
      const height =
        14 + titleLines.length * 13 + bodyLines.length * 13.5 + 10;
      if (height > PAGE_HEIGHT - 130) {
        ensureSpace(48);
        page.drawRectangle({
          x: MARGIN_X,
          y: y - 31,
          width: 3,
          height: 36,
          color: tone === "warning" ? rgb(0.63, 0.36, 0) : accent,
        });
        drawWrapped(title, {
          font: fonts.bold,
          size: 10,
          lineHeight: 13,
          indent: 14,
          after: 3,
        });
        drawWrapped(body, {
          size: 9.5,
          lineHeight: 13.5,
          indent: 14,
          after: 10,
        });
        return;
      }
      ensureSpace(Math.min(height, PAGE_HEIGHT - 120));
      const startY = y;
      const background =
        tone === "warning"
          ? WARNING_BACKGROUND
          : tone === "success"
            ? SUCCESS_BACKGROUND
            : NOTE_BACKGROUND;
      const border = tone === "warning" ? rgb(0.63, 0.36, 0) : accent;
      page.drawRectangle({
        x: MARGIN_X,
        y: y - height + 5,
        width: CONTENT_WIDTH,
        height,
        color: background,
      });
      page.drawRectangle({
        x: MARGIN_X,
        y: y - height + 5,
        width: 3,
        height,
        color: border,
      });
      y -= 13;
      for (const line of titleLines) {
        page.drawText(line, {
          x: MARGIN_X + 14,
          y,
          font: fonts.bold,
          size: 10,
          color: INK,
        });
        y -= 13;
      }
      for (const line of bodyLines) {
        if (line) {
          page.drawText(line, {
            x: MARGIN_X + 14,
            y,
            font: fonts.regular,
            size: 9.5,
            color: INK,
          });
        }
        y -= 13.5;
      }
      y = startY - height - 8;
    };

    const imageFor = async (
      media: GuideActionMedia,
      source: GuideExportAsset | undefined,
    ): Promise<PDFImage | undefined> => {
      if (imageCache.has(media.mediaId)) return imageCache.get(media.mediaId);
      const embedded = source ? await embedImage(document, source) : undefined;
      imageCache.set(media.mediaId, embedded);
      return embedded;
    };

    const drawMedia = async (media: GuideActionMedia) => {
      const embedded = await imageFor(media, assets.get(media.mediaId));
      if (!embedded) {
        ensureSpace(62);
        page.drawRectangle({
          x: MARGIN_X + 38,
          y: y - 48,
          width: CONTENT_WIDTH - 38,
          height: 48,
          borderColor: RULE,
          borderWidth: 1,
        });
        const placeholder = pdfSafeText(`Screenshot: ${media.altText}`);
        const lines = wrapLine(placeholder, fonts.regular, 9, CONTENT_WIDTH - 62);
        lines.slice(0, 2).forEach((line, index) => {
          page.drawText(line, {
            x: MARGIN_X + 50,
            y: y - 20 - index * 12,
            font: fonts.regular,
            size: 9,
            color: MUTED,
          });
        });
        y -= 62;
        return;
      }

      const maxWidth = CONTENT_WIDTH - 38;
      const maxHeight = 420;
      const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const croppedWidth = embedded.width * crop.width;
      const croppedHeight = embedded.height * crop.height;
      const scale = Math.min(maxWidth / croppedWidth, maxHeight / croppedHeight, 1);
      const width = croppedWidth * scale;
      const height = croppedHeight * scale;
      ensureSpace(height + 28);
      const frameX = MARGIN_X + 38;
      const frameY = y - height;
      const fullWidth = embedded.width * scale;
      const fullHeight = embedded.height * scale;
      const imageX = frameX - crop.x * fullWidth;
      const imageY = frameY - (1 - crop.y - crop.height) * fullHeight;
      page.pushOperators(
        pushGraphicsState(),
        rectangle(frameX, frameY, width, height),
        clip(),
        endPath(),
      );
      page.drawImage(embedded, {
        x: imageX,
        y: imageY,
        width: fullWidth,
        height: fullHeight,
      });
      page.pushOperators(popGraphicsState());
      page.drawRectangle({
        x: frameX,
        y: frameY,
        width,
        height,
        borderColor: RULE,
        borderWidth: 0.7,
      });

      const point = (x: number, topY: number) => ({
        x: frameX + ((x - crop.x) / crop.width) * width,
        y: frameY + height - ((topY - crop.y) / crop.height) * height,
      });
      if (
        media.clickTarget &&
        media.clickTarget.point.x >= crop.x &&
        media.clickTarget.point.x <= crop.x + crop.width &&
        media.clickTarget.point.y >= crop.y &&
        media.clickTarget.point.y <= crop.y + crop.height
      ) {
        const location = point(
          media.clickTarget.point.x,
          media.clickTarget.point.y,
        );
        const clickColor = hexToRgb(media.clickTarget.color);
        const radius = Math.max(
          3,
          (media.clickTarget.radius / Math.max(crop.width, crop.height)) *
            Math.min(width, height),
        );
        page.drawCircle({
          ...location,
          size: radius,
          borderColor: rgb(clickColor.red, clickColor.green, clickColor.blue),
          borderWidth: 2,
        });
        page.drawCircle({
          ...location,
          size: 1.5,
          color: rgb(clickColor.red, clickColor.green, clickColor.blue),
        });
      }
      for (const item of media.annotations) {
        const left = Math.max(item.region.x, crop.x);
        const top = Math.max(item.region.y, crop.y);
        const right = Math.min(item.region.x + item.region.width, crop.x + crop.width);
        const bottom = Math.min(item.region.y + item.region.height, crop.y + crop.height);
        if (right <= left || bottom <= top) continue;
        const topLeft = point(left, top);
        const bottomRight = point(right, bottom);
        const annotationWidth = bottomRight.x - topLeft.x;
        const annotationHeight = topLeft.y - bottomRight.y;
        const parsedColor = hexToRgb(item.color);
        const color = rgb(parsedColor.red, parsedColor.green, parsedColor.blue);
        if (item.type === "arrow") {
          page.drawLine({
            start: topLeft,
            end: bottomRight,
            color,
            thickness: 2,
          });
          page.drawLine({
            start: bottomRight,
            end: { x: bottomRight.x - 6, y: bottomRight.y + 2 },
            color,
            thickness: 2,
          });
          page.drawLine({
            start: bottomRight,
            end: { x: bottomRight.x - 2, y: bottomRight.y + 6 },
            color,
            thickness: 2,
          });
        } else if (item.type === "highlight") {
          page.drawRectangle({
            x: topLeft.x,
            y: bottomRight.y,
            width: annotationWidth,
            height: annotationHeight,
            color,
            opacity: 0.22,
            borderColor: color,
            borderWidth: 1,
          });
        } else if (item.type === "text") {
          page.drawRectangle({
            x: topLeft.x,
            y: bottomRight.y,
            width: Math.max(annotationWidth, 55),
            height: Math.max(annotationHeight, 14),
            color,
            opacity: 0.92,
          });
          page.drawText(pdfSafeText(item.text ?? "Annotation").slice(0, 48), {
            x: topLeft.x + 4,
            y: topLeft.y - 10,
            font: fonts.bold,
            size: 7,
            color: rgb(1, 1, 1),
          });
        } else {
          page.drawRectangle({
            x: topLeft.x,
            y: bottomRight.y,
            width: annotationWidth,
            height: annotationHeight,
            borderColor: color,
            borderWidth: 2,
          });
        }
      }
      y -= height + 11;
      const caption = wrapLine(pdfSafeText(media.altText), fonts.regular, 8, maxWidth);
      for (const line of caption.slice(0, 2)) {
        page.drawText(line, {
          x: frameX,
          y,
          font: fonts.regular,
          size: 8,
          color: MUTED,
        });
        y -= 10;
      }
      y -= 8;
    };

    const logoId = revision.branding.logoMediaId;
    const logoAsset = logoId ? assets.get(logoId) : undefined;
    const logo = logoAsset ? await embedImage(document, logoAsset) : undefined;
    if (logo) {
      const logoScale = Math.min(130 / logo.width, 42 / logo.height, 1);
      const logoWidth = logo.width * logoScale;
      const logoHeight = logo.height * logoScale;
      page.drawImage(logo, {
        x: MARGIN_X,
        y: y - logoHeight,
        width: logoWidth,
        height: logoHeight,
      });
      y -= logoHeight + 14;
    }

    page.drawText(pdfSafeText(revision.branding.workspaceName).toUpperCase(), {
      x: MARGIN_X,
      y,
      font: fonts.bold,
      size: 8.5,
      color: MUTED,
    });
    y -= 28;
    drawWrapped(revision.title, {
      font: fonts.bold,
      size: 28,
      lineHeight: 33,
      after: 10,
    });
    if (revision.summary) {
      drawWrapped(revision.summary, {
        size: 12,
        lineHeight: 17,
        color: MUTED,
        after: 13,
      });
    }
    const metadata = `Revision ${revision.revisionNumber} | Published ${formatIsoDate(revision.publishedAt)}`;
    drawWrapped(metadata, {
      font: fonts.mono,
      size: 8.5,
      color: MUTED,
      lineHeight: 11,
      after: 13,
    });
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: PAGE_WIDTH - MARGIN_X, y },
      thickness: 1.5,
      color: accent,
    });
    y -= 25;

    let actionNumber = 0;
    for (const block of revision.blocks) {
      await renderPdfBlock(block, {
        fonts,
        accent,
        getPage: () => page,
        getY: () => y,
        setY: (next) => {
          y = next;
        },
        ensureSpace,
        drawWrapped,
        drawCallout,
        drawMedia,
        nextActionNumber: () => {
          actionNumber += 1;
          return actionNumber;
        },
      });
    }

    const watermarkText = formatWatermark(watermark);
    const pages = document.getPages();
    pages.forEach((target, index) => {
      target.drawLine({
        start: { x: MARGIN_X, y: 39 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: 39 },
        thickness: 0.5,
        color: RULE,
      });
      const footer = `Page ${index + 1} of ${pages.length}`;
      target.drawText(footer, {
        x: PAGE_WIDTH - MARGIN_X - fonts.regular.widthOfTextAtSize(footer, 8),
        y: 25,
        font: fonts.regular,
        size: 8,
        color: MUTED,
      });
      if (revision.branding.showRivetBranding) {
        target.drawText("Generated with Rivet", {
          x: MARGIN_X,
          y: 25,
          font: fonts.regular,
          size: 8,
          color: MUTED,
        });
      }
      if (watermarkText) {
        const safe = pdfSafeText(watermarkText);
        const size = Math.max(
          10,
          Math.min(22, (PAGE_WIDTH * 0.72 * 18) / fonts.bold.widthOfTextAtSize(safe, 18)),
        );
        target.drawText(safe, {
          x: centeredX(safe, fonts.bold, size),
          y: PAGE_HEIGHT * 0.47,
          font: fonts.bold,
          size,
          color: MUTED,
          opacity: 0.13,
          rotate: degrees(32),
        });
      }
    });

    return await document.save({ useObjectStreams: false });
  } catch (error) {
    if (error instanceof GuideRendererError) throw error;
    throw new GuideRendererError("RENDER_FAILED", "Rivet could not render the PDF.", {
      format: "pdf",
      cause: error,
    });
  }
}

interface PdfBlockContext {
  readonly fonts: PdfFonts;
  readonly accent: ReturnType<typeof rgb>;
  readonly getPage: () => PDFPage;
  readonly getY: () => number;
  readonly setY: (value: number) => void;
  readonly ensureSpace: (height: number) => void;
  readonly drawWrapped: (value: string, options?: WrappedTextOptions) => void;
  readonly drawCallout: (
    title: string,
    body: string,
    tone: "note" | "warning" | "success",
  ) => void;
  readonly drawMedia: (media: GuideActionMedia) => Promise<void>;
  readonly nextActionNumber: () => number;
}

async function renderPdfBlock(
  block: GuideBlock,
  context: PdfBlockContext,
): Promise<void> {
  if (block.type === "heading") {
    context.ensureSpace(42);
    context.setY(context.getY() - (block.level === 2 ? 10 : 5));
    context.drawWrapped(block.text, {
      font: context.fonts.bold,
      size: block.level === 2 ? 19 : 14,
      lineHeight: block.level === 2 ? 23 : 18,
      after: 9,
    });
    if (block.level === 2) {
      const page = context.getPage();
      const y = context.getY() + 5;
      page.drawLine({
        start: { x: MARGIN_X, y },
        end: { x: PAGE_WIDTH - MARGIN_X, y },
        thickness: 0.5,
        color: RULE,
      });
      context.setY(context.getY() - 12);
    }
    return;
  }

  if (block.type === "paragraph") {
    context.drawWrapped(block.text, { after: 10 });
    return;
  }

  if (block.type === "callout") {
    const fallback =
      block.tone === "warning"
        ? "Warning"
        : block.tone === "success"
          ? "Success"
          : "Note";
    context.drawCallout(block.title || fallback, block.text, block.tone);
    return;
  }

  const titleHeight =
    wrapParagraphs(
      block.title,
      context.fonts.bold,
      14,
      CONTENT_WIDTH - 38,
    ).length * 18;
  context.ensureSpace(Math.max(58, titleHeight + 26));
  const number = context.nextActionNumber();
  const page = context.getPage();
  const markerY = context.getY() - 7;
  page.drawCircle({
    x: MARGIN_X + 13,
    y: markerY,
    size: 12,
    color: context.accent,
  });
  const numberText = String(number);
  page.drawText(numberText, {
    x:
      MARGIN_X +
      13 -
      context.fonts.bold.widthOfTextAtSize(numberText, 8.5) / 2,
    y: markerY - 3,
    font: context.fonts.bold,
    size: 8.5,
    color: rgb(1, 1, 1),
  });
  context.drawWrapped(block.title, {
    font: context.fonts.bold,
    size: 14,
    lineHeight: 18,
    indent: 38,
    after: 4,
  });
  context.drawWrapped(block.instructions, {
    size: 10.5,
    lineHeight: 15,
    indent: 38,
    after: 8,
  });
  if (block.systemReference) {
    context.drawWrapped(`System: ${block.systemReference.name}`, {
      font: context.fonts.mono,
      size: 8.5,
      lineHeight: 11,
      color: MUTED,
      indent: 38,
      after: 7,
    });
  }
  if (block.media) await context.drawMedia(block.media);
  if (block.expectedResult && block.requiresConfirmation) {
    context.ensureSpace(170);
  }
  if (block.expectedResult) {
    context.drawCallout("Expected result", block.expectedResult, "success");
  }
  if (block.requiresConfirmation) {
    context.drawCallout(
      "Confirmation required",
      "Confirm the expected result before continuing.",
      "warning",
    );
  }
  context.setY(context.getY() - 6);
}
