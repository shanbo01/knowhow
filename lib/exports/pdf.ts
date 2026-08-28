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
  formatLongDate,
  hexToRgb,
  pdfSafeText,
  watermarkParts,
} from "./shared";
import {
  GuideRendererError,
  type GuideExportAsset,
  type GuideRenderOptions,
} from "./types";

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN_X = 56;
const TOP = 786;
/** First baseline on a continuation page, below the running header. */
const CONTINUED_TOP = PAGE_HEIGHT - 62;
const BOTTOM = 66;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN_X * 2;
/** Left gutter reserved for the step number rail. */
const STEP_INDENT = 34;

const INK = rgb(0.08, 0.09, 0.1);
const INK_SOFT = rgb(0.24, 0.28, 0.29);
const MUTED = rgb(0.42, 0.46, 0.48);
const RULE = rgb(0.886, 0.902, 0.902);
const RULE_STRONG = rgb(0.804, 0.831, 0.831);
const WARNING = rgb(0.6, 0.29, 0);
const WARNING_BACKGROUND = rgb(1, 0.965, 0.914);
const SUCCESS = rgb(0.122, 0.42, 0.282);
const SUCCESS_BACKGROUND = rgb(0.933, 0.973, 0.949);
const WHITE = rgb(1, 1, 1);

interface PdfFonts {
  readonly regular: PDFFont;
  readonly bold: PDFFont;
}

interface TextStyle {
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

/**
 * Lays out a multi-paragraph string. A blank source line is a paragraph break
 * and becomes one blank output line; a single newline stays a line break.
 */
function wrapParagraphs(
  value: string,
  font: PDFFont,
  size: number,
  width: number,
): string[] {
  const result: string[] = [];
  for (const paragraph of pdfSafeText(value).split(/\n{2,}/)) {
    const lines = paragraph
      .split("\n")
      .filter((line) => line.trim())
      .flatMap((line) => wrapLine(line, font, size, width));
    if (!lines.length) continue;
    if (result.length) result.push("");
    result.push(...lines);
  }
  return result.length ? result : [""];
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
      `KnowHow could not decode media ${asset.mediaId}.`,
      { format: "pdf", cause: error },
    );
  }
}

function calloutLabel(tone: "note" | "warning" | "success"): string {
  if (tone === "warning") return "Warning";
  if (tone === "success") return "Tip";
  return "Note";
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
    };
    const accentValue = hexToRgb(revision.branding.accentColor);
    const accent = rgb(accentValue.red, accentValue.green, accentValue.blue);
    const accentDeep = rgb(
      accentValue.red * 0.68,
      accentValue.green * 0.68,
      accentValue.blue * 0.68,
    );
    const accentWash = rgb(
      accentValue.red + (1 - accentValue.red) * 0.94,
      accentValue.green + (1 - accentValue.green) * 0.94,
      accentValue.blue + (1 - accentValue.blue) * 0.94,
    );
    const accentEdge = rgb(
      accentValue.red + (1 - accentValue.red) * 0.7,
      accentValue.green + (1 - accentValue.green) * 0.7,
      accentValue.blue + (1 - accentValue.blue) * 0.7,
    );
    const imageCache = new Map<string, PDFImage | undefined>();
    const marks = watermarkParts(watermark);

    document.setTitle(pdfSafeText(revision.title));
    document.setAuthor(pdfSafeText(revision.branding.workspaceName));
    document.setSubject(`Published guide revision ${revision.revisionNumber}`);
    document.setCreator("KnowHow");
    document.setProducer("KnowHow");
    document.setKeywords(["KnowHow", "guide", "SOP", revision.guideId]);
    document.setLanguage("en");
    const publishedDate = new Date(revision.publishedAt);
    document.setCreationDate(publishedDate);
    document.setModificationDate(publishedDate);

    let page: PDFPage = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = TOP;

    const runningHeader = (target: PDFPage) => {
      const left = pdfSafeText(revision.title);
      const right = `Revision ${revision.revisionNumber}`;
      const rightWidth = fonts.regular.widthOfTextAtSize(right, 8);
      const [clipped] = wrapLine(
        left,
        fonts.bold,
        8,
        CONTENT_WIDTH - rightWidth - 24,
      );
      target.drawText(clipped ?? left, {
        x: MARGIN_X,
        y: PAGE_HEIGHT - 36,
        font: fonts.bold,
        size: 8,
        color: MUTED,
      });
      target.drawText(right, {
        x: PAGE_WIDTH - MARGIN_X - rightWidth,
        y: PAGE_HEIGHT - 36,
        font: fonts.regular,
        size: 8,
        color: MUTED,
      });
      target.drawLine({
        start: { x: MARGIN_X, y: PAGE_HEIGHT - 44 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - 44 },
        thickness: 0.5,
        color: RULE,
      });
    };

    const addPage = () => {
      page = document.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
      runningHeader(page);
      y = CONTINUED_TOP;
    };

    const ensureSpace = (height: number) => {
      if (y - height < BOTTOM) addPage();
    };

    /**
     * Moves to a fresh page when `height` will not fit here but would fit on an
     * empty one. Used to stop a step's heading from being stranded above the
     * page break, away from its instructions and screenshot.
     */
    const keepTogether = (height: number) => {
      if (height <= y - BOTTOM) return;
      if (height <= CONTINUED_TOP - BOTTOM) addPage();
    };

    const measure = (value: string, style: TextStyle = {}): number => {
      const font = style.font ?? fonts.regular;
      const size = style.size ?? 10.5;
      const lineHeight = style.lineHeight ?? size * 1.45;
      const lines = wrapParagraphs(
        value,
        font,
        size,
        CONTENT_WIDTH - (style.indent ?? 0),
      );
      return lines.length * lineHeight + (style.after ?? 5);
    };

    const drawWrapped = (value: string, style: TextStyle = {}): void => {
      const font = style.font ?? fonts.regular;
      const size = style.size ?? 10.5;
      const lineHeight = style.lineHeight ?? size * 1.45;
      const indent = style.indent ?? 0;
      const lines = wrapParagraphs(value, font, size, CONTENT_WIDTH - indent);
      for (const line of lines) {
        ensureSpace(lineHeight);
        if (line) {
          page.drawText(line, {
            x: MARGIN_X + indent,
            y: y - size,
            font,
            size,
            color: style.color ?? INK,
          });
        }
        y -= lineHeight;
      }
      y -= style.after ?? 5;
    };

    const panelLines = (label: string, body: string, indent: number) => {
      const inner = CONTENT_WIDTH - indent - 26;
      return {
        labelLines: wrapLine(label.toUpperCase(), fonts.bold, 8, inner),
        bodyLines: wrapParagraphs(body, fonts.regular, 9.75, inner),
      };
    };

    const panelHeight = (label: string, body: string, indent = 0): number => {
      const { labelLines, bodyLines } = panelLines(label, body, indent);
      return 26 + labelLines.length * 11 + 4 + bodyLines.length * 13.5 + 12;
    };

    const drawPanel = (
      label: string,
      body: string,
      tone: "note" | "warning" | "success",
      indent = 0,
    ) => {
      const width = CONTENT_WIDTH - indent;
      const padding = 13;
      const { labelLines, bodyLines } = panelLines(label, body, indent);
      const height = padding * 2 + labelLines.length * 11 + 4 + bodyLines.length * 13.5;
      const background =
        tone === "warning"
          ? WARNING_BACKGROUND
          : tone === "success"
            ? SUCCESS_BACKGROUND
            : accentWash;
      const edge =
        tone === "warning"
          ? rgb(0.94, 0.83, 0.65)
          : tone === "success"
            ? rgb(0.749, 0.878, 0.804)
            : accentEdge;
      const labelColor =
        tone === "warning" ? WARNING : tone === "success" ? SUCCESS : accentDeep;
      const spine = tone === "warning" ? WARNING : tone === "success" ? SUCCESS : accent;

      keepTogether(height + 10);
      // A panel taller than a page has to flow, so fall back to a plain rule.
      if (height > CONTINUED_TOP - BOTTOM) {
        page.drawRectangle({
          x: MARGIN_X + indent,
          y: y - 30,
          width: 2.5,
          height: 34,
          color: spine,
        });
        drawWrapped(label.toUpperCase(), {
          font: fonts.bold,
          size: 8,
          lineHeight: 11,
          color: labelColor,
          indent: indent + 12,
          after: 3,
        });
        drawWrapped(body, {
          size: 9.75,
          lineHeight: 13.5,
          color: INK_SOFT,
          indent: indent + 12,
          after: 12,
        });
        return;
      }

      const top = y;
      page.drawRectangle({
        x: MARGIN_X + indent,
        y: top - height,
        width,
        height,
        color: background,
        borderColor: edge,
        borderWidth: 0.7,
      });
      page.drawRectangle({
        x: MARGIN_X + indent,
        y: top - height,
        width: 2.5,
        height,
        color: spine,
      });
      let cursor = top - padding;
      for (const line of labelLines) {
        page.drawText(line, {
          x: MARGIN_X + indent + padding,
          y: cursor - 8,
          font: fonts.bold,
          size: 8,
          color: labelColor,
        });
        cursor -= 11;
      }
      cursor -= 4;
      for (const line of bodyLines) {
        if (line) {
          page.drawText(line, {
            x: MARGIN_X + indent + padding,
            y: cursor - 9.75,
            font: fonts.regular,
            size: 9.75,
            color: INK_SOFT,
          });
        }
        cursor -= 13.5;
      }
      y = top - height - 12;
    };

    const imageFor = async (
      media: GuideActionMedia,
    ): Promise<PDFImage | undefined> => {
      if (imageCache.has(media.mediaId)) return imageCache.get(media.mediaId);
      const source = assets.get(media.mediaId);
      const embedded = source ? await embedImage(document, source) : undefined;
      imageCache.set(media.mediaId, embedded);
      return embedded;
    };

    /** Screenshot box, in flow order, so a step can be measured before drawing. */
    const mediaBox = (media: GuideActionMedia, embedded: PDFImage | undefined) => {
      const maxWidth = CONTENT_WIDTH - STEP_INDENT;
      if (!embedded) return { width: maxWidth, height: 54, total: 54 + 12 };
      const maxHeight = 400;
      const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const croppedWidth = embedded.width * crop.width;
      const croppedHeight = embedded.height * crop.height;
      const scale = Math.min(maxWidth / croppedWidth, maxHeight / croppedHeight, 1);
      const width = croppedWidth * scale;
      const height = croppedHeight * scale;
      return { width, height, total: height + 14 };
    };

    const drawMedia = async (media: GuideActionMedia) => {
      const embedded = await imageFor(media);
      const box = mediaBox(media, embedded);
      const frameX = MARGIN_X + STEP_INDENT;

      if (!embedded) {
        ensureSpace(box.total);
        page.drawRectangle({
          x: frameX,
          y: y - box.height,
          width: box.width,
          height: box.height,
          borderColor: RULE_STRONG,
          borderWidth: 0.7,
          color: rgb(0.976, 0.98, 0.976),
        });
        const label = "Screenshot unavailable in this export";
        page.drawText(label, {
          x: frameX + (box.width - fonts.regular.widthOfTextAtSize(label, 9)) / 2,
          y: y - box.height / 2 - 3,
          font: fonts.regular,
          size: 9,
          color: MUTED,
        });
        y -= box.total;
        return;
      }

      ensureSpace(box.total);
      const { width, height } = box;
      const frameY = y - height;
      const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
      const scale = width / (embedded.width * crop.width);
      const fullWidth = embedded.width * scale;
      const fullHeight = embedded.height * scale;
      page.pushOperators(
        pushGraphicsState(),
        rectangle(frameX, frameY, width, height),
        clip(),
        endPath(),
      );
      page.drawImage(embedded, {
        x: frameX - crop.x * fullWidth,
        y: frameY - (1 - crop.y - crop.height) * fullHeight,
        width: fullWidth,
        height: fullHeight,
      });
      page.pushOperators(popGraphicsState());
      page.drawRectangle({
        x: frameX,
        y: frameY,
        width,
        height,
        borderColor: RULE_STRONG,
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
        const location = point(media.clickTarget.point.x, media.clickTarget.point.y);
        const clickColor = hexToRgb(media.clickTarget.color);
        const marker = rgb(clickColor.red, clickColor.green, clickColor.blue);
        const radius = Math.max(
          3,
          (media.clickTarget.radius / Math.max(crop.width, crop.height)) *
            Math.min(width, height),
        );
        page.drawCircle({ ...location, size: radius, borderColor: marker, borderWidth: 2 });
        page.drawCircle({ ...location, size: 1.5, color: marker });
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
          page.drawLine({ start: topLeft, end: bottomRight, color, thickness: 2 });
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
          const text = pdfSafeText(item.text ?? "Annotation").slice(0, 48);
          const boxWidth = Math.max(
            annotationWidth,
            fonts.bold.widthOfTextAtSize(text, 7) + 8,
          );
          const boxHeight = Math.max(annotationHeight, 14);
          // Keep the label inside the frame even when the region hugs an edge.
          const boxX = Math.min(topLeft.x, frameX + width - boxWidth);
          page.drawRectangle({
            x: boxX,
            y: bottomRight.y,
            width: boxWidth,
            height: boxHeight,
            color,
            opacity: 0.92,
          });
          page.drawText(text, {
            x: boxX + 4,
            y: bottomRight.y + boxHeight / 2 - 2.5,
            font: fonts.bold,
            size: 7,
            color: WHITE,
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
      y -= box.total;
    };

    // ---- Cover -------------------------------------------------------------
    page.drawRectangle({
      x: 0,
      y: PAGE_HEIGHT - 7,
      width: PAGE_WIDTH,
      height: 7,
      color: accent,
    });

    const logoId = revision.branding.logoMediaId;
    const logoAsset = logoId ? assets.get(logoId) : undefined;
    const logo = logoAsset ? await embedImage(document, logoAsset) : undefined;
    const workspace = pdfSafeText(revision.branding.workspaceName).toUpperCase();
    if (logo) {
      const logoScale = Math.min(120 / logo.width, 34 / logo.height, 1);
      const logoWidth = logo.width * logoScale;
      const logoHeight = logo.height * logoScale;
      page.drawImage(logo, {
        x: MARGIN_X,
        y: y - logoHeight,
        width: logoWidth,
        height: logoHeight,
      });
      page.drawText(workspace, {
        x: MARGIN_X + logoWidth + 12,
        y: y - logoHeight / 2 - 3,
        font: fonts.bold,
        size: 8.5,
        color: MUTED,
      });
      y -= logoHeight + 34;
    } else {
      page.drawText(workspace, {
        x: MARGIN_X,
        y: y - 9,
        font: fonts.bold,
        size: 8.5,
        color: MUTED,
      });
      y -= 40;
    }

    drawWrapped(revision.title, {
      font: fonts.bold,
      size: 27,
      lineHeight: 32,
      after: 12,
    });
    if (revision.summary) {
      drawWrapped(revision.summary, {
        size: 11.5,
        lineHeight: 16.5,
        color: INK_SOFT,
        after: 20,
      });
    }

    let actionTotal = 0;
    for (const block of revision.blocks) if (block.type === "action") actionTotal += 1;

    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: PAGE_WIDTH - MARGIN_X, y },
      thickness: 0.7,
      color: RULE,
    });
    y -= 18;
    const facts: Array<readonly [string, string]> = [
      ["REVISION", String(revision.revisionNumber)],
      ["PUBLISHED", formatLongDate(revision.publishedAt)],
      ...(actionTotal ? ([["STEPS", String(actionTotal)]] as const) : []),
    ];
    let factX = MARGIN_X;
    for (const [label, text] of facts) {
      page.drawText(label, {
        x: factX,
        y: y - 7,
        font: fonts.bold,
        size: 7.5,
        color: MUTED,
      });
      page.drawText(pdfSafeText(text), {
        x: factX,
        y: y - 22,
        font: fonts.bold,
        size: 11,
        color: INK,
      });
      factX += Math.max(
        96,
        fonts.bold.widthOfTextAtSize(pdfSafeText(text), 11) + 28,
      );
    }
    y -= 40;

    if (marks.length) {
      drawPanel("Controlled copy", marks.join("\n"), "note");
    }

    // ---- Contents ----------------------------------------------------------
    const contents = revision.blocks.filter(
      (block) => block.type === "heading" || block.type === "action",
    );
    if (contents.length > 2) {
      y -= 12;
      drawWrapped("Contents", {
        font: fonts.bold,
        size: 8.5,
        lineHeight: 12,
        color: MUTED,
        after: 8,
      });
      let entryNumber = 0;
      for (const block of contents) {
        ensureSpace(16);
        if (block.type === "heading") {
          const indent = block.level === 3 ? 12 : 0;
          const [text] = wrapLine(
            block.text,
            fonts.bold,
            10,
            CONTENT_WIDTH - indent,
          );
          page.drawText(text ?? "", {
            x: MARGIN_X + indent,
            y: y - 10,
            font: fonts.bold,
            size: 10,
            color: INK,
          });
          y -= 17;
          continue;
        }
        entryNumber += 1;
        const label = String(entryNumber);
        page.drawText(label, {
          x: MARGIN_X + 14 - fonts.regular.widthOfTextAtSize(label, 9) / 2,
          y: y - 9.5,
          font: fonts.regular,
          size: 9,
          color: MUTED,
        });
        const [text] = wrapLine(block.title, fonts.regular, 10, CONTENT_WIDTH - 26);
        page.drawText(text ?? "", {
          x: MARGIN_X + 26,
          y: y - 10,
          font: fonts.regular,
          size: 10,
          color: INK_SOFT,
        });
        y -= 16;
      }
      addPage();
    } else {
      y -= 8;
    }

    // ---- Body --------------------------------------------------------------
    let actionNumber = 0;
    for (const block of revision.blocks) {
      await renderBlock(block);
    }

    async function renderBlock(block: GuideBlock): Promise<void> {
      if (block.type === "heading") {
        const size = block.level === 2 ? 17 : 13;
        keepTogether(size * 2.6 + 46);
        y -= block.level === 2 ? 16 : 10;
        drawWrapped(block.text, {
          font: fonts.bold,
          size,
          lineHeight: size * 1.3,
          after: block.level === 2 ? 8 : 6,
        });
        if (block.level === 2) {
          page.drawLine({
            start: { x: MARGIN_X, y: y + 4 },
            end: { x: PAGE_WIDTH - MARGIN_X, y: y + 4 },
            thickness: 1,
            color: RULE_STRONG,
          });
          y -= 12;
        }
        return;
      }

      if (block.type === "paragraph") {
        drawWrapped(block.text, { lineHeight: 15, color: INK_SOFT, after: 12 });
        return;
      }

      if (block.type === "callout") {
        drawPanel(block.title || calloutLabel(block.tone), block.text, block.tone);
        return;
      }

      const titleStyle: TextStyle = {
        font: fonts.bold,
        size: 13,
        lineHeight: 17,
        indent: STEP_INDENT,
        after: 5,
      };
      const bodyStyle: TextStyle = {
        size: 10.5,
        lineHeight: 15,
        color: INK_SOFT,
        indent: STEP_INDENT,
        after: 8,
      };
      const embedded = block.media ? await imageFor(block.media) : undefined;
      // Hold the number, title, instructions and screenshot on one page so a
      // step never opens at the foot of a page with its evidence overleaf.
      const together =
        measure(block.title, titleStyle) +
        measure(block.instructions, bodyStyle) +
        (block.systemReference ? 20 : 0) +
        (block.media ? mediaBox(block.media, embedded).total : 0);
      const trailing =
        (block.expectedResult
          ? panelHeight("Expected result", block.expectedResult, STEP_INDENT)
          : 0) +
        (block.requiresConfirmation
          ? panelHeight(
              "Confirmation required",
              "Confirm the expected result before continuing.",
              STEP_INDENT,
            )
          : 0);
      // Pull the result panels along too when the whole step still fits a page.
      keepTogether(
        together + trailing <= CONTINUED_TOP - BOTTOM ? together + trailing : together,
      );

      actionNumber += 1;
      const markerY = y - 11;
      page.drawCircle({ x: MARGIN_X + 11, y: markerY, size: 11, color: accent });
      const numberText = String(actionNumber);
      page.drawText(numberText, {
        x: MARGIN_X + 11 - fonts.bold.widthOfTextAtSize(numberText, 8.5) / 2,
        y: markerY - 3,
        font: fonts.bold,
        size: 8.5,
        color: WHITE,
      });

      drawWrapped(block.title, titleStyle);
      drawWrapped(block.instructions, bodyStyle);
      if (block.systemReference) {
        page.drawText("SYSTEM", {
          x: MARGIN_X + STEP_INDENT,
          y: y - 7,
          font: fonts.bold,
          size: 7.5,
          color: MUTED,
        });
        const [name] = wrapLine(
          block.systemReference.name,
          fonts.regular,
          9.5,
          CONTENT_WIDTH - STEP_INDENT - 44,
        );
        page.drawText(name ?? "", {
          x: MARGIN_X + STEP_INDENT + 44,
          y: y - 7.5,
          font: fonts.regular,
          size: 9.5,
          color: INK_SOFT,
        });
        y -= 20;
      }
      if (block.media) await drawMedia(block.media);
      if (block.expectedResult) {
        drawPanel("Expected result", block.expectedResult, "success", STEP_INDENT);
      }
      if (block.requiresConfirmation) {
        drawPanel(
          "Confirmation required",
          "Confirm the expected result before continuing.",
          "warning",
          STEP_INDENT,
        );
      }
      y -= 10;
    }

    // ---- Furniture ---------------------------------------------------------
    const footerLeft = marks.length
      ? marks.join(" | ")
      : revision.branding.showKnowHowBranding
        ? "Generated with KnowHow"
        : "";
    const pages = document.getPages();
    pages.forEach((target, index) => {
      target.drawLine({
        start: { x: MARGIN_X, y: 48 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: 48 },
        thickness: 0.5,
        color: RULE,
      });
      const footer = `${index + 1} / ${pages.length}`;
      target.drawText(footer, {
        x: PAGE_WIDTH - MARGIN_X - fonts.regular.widthOfTextAtSize(footer, 8),
        y: 34,
        font: fonts.regular,
        size: 8,
        color: MUTED,
      });
      if (footerLeft) {
        const [line] = wrapLine(footerLeft, fonts.regular, 7.5, CONTENT_WIDTH - 60);
        target.drawText(line ?? "", {
          x: MARGIN_X,
          y: 34,
          font: fonts.regular,
          size: 7.5,
          color: MUTED,
        });
      }
      if (marks.length) {
        const safe = pdfSafeText(marks.join(" | "));
        const size = Math.max(
          9,
          Math.min(20, (PAGE_WIDTH * 0.7 * 18) / fonts.bold.widthOfTextAtSize(safe, 18)),
        );
        target.drawText(safe, {
          x: centeredX(safe, fonts.bold, size),
          y: PAGE_HEIGHT * 0.47,
          font: fonts.bold,
          size,
          color: MUTED,
          opacity: 0.1,
          rotate: degrees(30),
        });
      }
    });

    return await document.save({ useObjectStreams: false });
  } catch (error) {
    if (error instanceof GuideRendererError) throw error;
    throw new GuideRendererError("RENDER_FAILED", "KnowHow could not render the PDF.", {
      format: "pdf",
      cause: error,
    });
  }
}
