import type { PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  assetSource,
  escapeMarkdown,
  formatIsoDate,
  formatWatermark,
  markdownText,
  safeDocumentHref,
} from "./shared";
import type { GuideRenderOptions } from "./types";

function calloutLabel(tone: "note" | "warning" | "success"): string {
  if (tone === "warning") return "Warning";
  if (tone === "success") return "Success";
  return "Note";
}

function markdownDestination(value: string): string {
  return `<${value
    .replaceAll("<", "%3C")
    .replaceAll(">", "%3E")
    .replaceAll(" ", "%20")}>`;
}

export function renderGuideToMarkdown(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): string {
  const { revision, assets, watermark } = prepareGuideExport(
    candidate,
    "markdown",
    options,
  );
  const output: string[] = [];
  const watermarkText = formatWatermark(watermark);

  if (watermarkText) {
    output.push(`> **Watermark:** ${escapeMarkdown(watermarkText)}`, "");
  }

  output.push(`# ${escapeMarkdown(revision.title)}`, "");
  if (revision.summary) output.push(markdownText(revision.summary), "");
  output.push(
    `**Workspace:** ${escapeMarkdown(revision.branding.workspaceName)}`,
    `**Revision:** ${revision.revisionNumber}`,
    `**Published:** ${formatIsoDate(revision.publishedAt)}`,
    "",
  );

  let actionNumber = 0;
  for (const block of revision.blocks) {
    if (block.type === "heading") {
      output.push(`${"#".repeat(block.level)} ${escapeMarkdown(block.text)}`, "");
      continue;
    }
    if (block.type === "paragraph") {
      output.push(markdownText(block.text), "");
      continue;
    }
    if (block.type === "callout") {
      const title = block.title || calloutLabel(block.tone);
      const body = markdownText(block.text).replaceAll("\n", "\n> ");
      output.push(
        `> **${escapeMarkdown(title)}**`,
        `> ${body}`,
        "",
      );
      continue;
    }

    actionNumber += 1;
    output.push(`## ${actionNumber}. ${escapeMarkdown(block.title)}`, "");
    output.push(markdownText(block.instructions), "");
    if (block.systemReference) {
      const safeUrl = safeDocumentHref(block.systemReference.url);
      output.push(
        safeUrl
          ? `**System:** [${escapeMarkdown(block.systemReference.name)}](${markdownDestination(safeUrl)})`
          : `**System:** ${escapeMarkdown(block.systemReference.name)}`,
        "",
      );
    }
    if (block.media) {
      const source = assetSource(assets.get(block.media.mediaId));
      output.push(
        source
          ? `![${escapeMarkdown(block.media.altText)}](${markdownDestination(source)})`
          : `_[Screenshot: ${escapeMarkdown(block.media.altText)}]_`,
        "",
      );
    }
    if (block.expectedResult) {
      output.push(
        `**Expected result:** ${markdownText(block.expectedResult)}`,
        "",
      );
    }
    if (block.requiresConfirmation) {
      output.push("**Confirmation required before continuing.**", "");
    }
  }

  if (revision.branding.showKnowHowBranding) {
    output.push("---", "", "Generated with KnowHow.", "");
  }

  return `${output.join("\n").trimEnd()}\n`;
}
