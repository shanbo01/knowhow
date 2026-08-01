import type { GuideBlock, PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import {
  assetSource,
  bytesToBase64,
  escapeHtml,
  formatIsoDate,
  formatWatermark,
  safeDocumentHref,
} from "./shared";
import type { GuideRenderOptions, PreparedGuideExport } from "./types";

function projected(value: number, start: number, size: number): number {
  return ((value - start) / size) * 100;
}

function mediaFigure(
  block: Extract<GuideBlock, { type: "action" }>,
  source: string,
): string {
  const media = block.media!;
  const crop = media.crop ?? { x: 0, y: 0, width: 1, height: 1 };
  const shapes: string[] = [];
  const click = media.clickTarget;
  if (
    click &&
    click.point.x >= crop.x &&
    click.point.x <= crop.x + crop.width &&
    click.point.y >= crop.y &&
    click.point.y <= crop.y + crop.height
  ) {
    const cx = projected(click.point.x, crop.x, crop.width);
    const cy = projected(click.point.y, crop.y, crop.height);
    const radius = Math.max(1.2, (click.radius / Math.max(crop.width, crop.height)) * 100);
    shapes.push(
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="none" stroke="${escapeHtml(click.color)}" stroke-width="1.4"/><circle cx="${cx}" cy="${cy}" r="1.2" fill="${escapeHtml(click.color)}"/>`,
    );
  }
  for (const item of media.annotations) {
    const x = projected(item.region.x, crop.x, crop.width);
    const y = projected(item.region.y, crop.y, crop.height);
    const width = (item.region.width / crop.width) * 100;
    const height = (item.region.height / crop.height) * 100;
    const color = escapeHtml(item.color);
    if (item.type === "arrow") {
      shapes.push(
        `<line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="${color}" stroke-width="1.4"/><path d="M ${x + width} ${y + height} l -3 -1.2 l 1.2 -3 z" fill="${color}"/>`,
      );
    } else if (item.type === "highlight") {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${color}" fill-opacity=".24" stroke="${color}" stroke-width=".7"/>`,
      );
    } else if (item.type === "text") {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${Math.max(width, 12)}" height="${Math.max(height, 7)}" rx="1.2" fill="${color}" fill-opacity=".92"/><text x="${x + 1.5}" y="${y + 4.8}" fill="#fff" font-size="3.4" font-family="ui-sans-serif,system-ui">${escapeHtml(item.text ?? "Annotation")}</text>`,
      );
    } else {
      shapes.push(
        `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="none" stroke="${color}" stroke-width="1.3"/>`,
      );
    }
  }
  const imageStyle = [
    `width:${100 / crop.width}%`,
    `height:${100 / crop.height}%`,
    `left:${(-crop.x / crop.width) * 100}%`,
    `top:${(-crop.y / crop.height) * 100}%`,
  ].join(";");
  const aspect = (media.width * crop.width) / (media.height * crop.height);
  return `<figure><div class="media-frame" style="aspect-ratio:${aspect}"><img src="${escapeHtml(source)}" alt="${escapeHtml(media.altText)}" style="${imageStyle}"><svg class="annotation-layer" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${shapes.join("")}</svg></div><figcaption>${escapeHtml(media.altText)}</figcaption></figure>`;
}

function paragraphs(value: string): string {
  return value
    .split(/\r?\n\s*\r?\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll(/\r?\n/g, "<br>")}</p>`)
    .join("");
}

function renderBlock(
  block: GuideBlock,
  actionNumber: number,
  prepared: PreparedGuideExport,
): string {
  if (block.type === "heading") {
    const tag = block.level === 2 ? "h2" : "h3";
    return `<${tag} class="guide-heading">${escapeHtml(block.text)}</${tag}>`;
  }
  if (block.type === "paragraph") {
    return `<section class="guide-paragraph">${paragraphs(block.text)}</section>`;
  }
  if (block.type === "callout") {
    const fallback =
      block.tone === "warning"
        ? "Warning"
        : block.tone === "success"
          ? "Success"
          : "Note";
    return `<aside class="callout callout-${block.tone}"><strong>${escapeHtml(block.title || fallback)}</strong>${paragraphs(block.text)}</aside>`;
  }

  const systemUrl = safeDocumentHref(block.systemReference?.url);
  const system = block.systemReference
    ? `<p class="system-reference"><strong>System:</strong> ${
        systemUrl
          ? `<a href="${escapeHtml(systemUrl)}" rel="noreferrer">${escapeHtml(block.systemReference.name)}</a>`
          : escapeHtml(block.systemReference.name)
      }</p>`
    : "";
  const mediaSource = block.media
    ? assetSource(block.media, prepared.assets.get(block.media.mediaId))
    : undefined;
  const media = block.media
    ? mediaSource
      ? mediaFigure(block, mediaSource)
      : `<div class="media-placeholder" role="img" aria-label="${escapeHtml(block.media.altText)}">Screenshot: ${escapeHtml(block.media.altText)}</div>`
    : "";
  const expected = block.expectedResult
    ? `<div class="expected"><strong>Expected result</strong>${paragraphs(block.expectedResult)}</div>`
    : "";
  const confirmation = block.requiresConfirmation
    ? '<p class="confirmation">Confirmation required before continuing.</p>'
    : "";

  return `<section class="action-step"><div class="action-number" aria-hidden="true">${actionNumber}</div><div class="action-body"><h2>${escapeHtml(block.title)}</h2>${paragraphs(block.instructions)}${system}${media}${expected}${confirmation}</div></section>`;
}

export function renderGuideToHtml(
  candidate: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): string {
  const prepared = prepareGuideExport(candidate, "html", options);
  const { revision, assets, watermark } = prepared;
  const accent = revision.branding.accentColor;
  const watermarkText = formatWatermark(watermark);
  const logoMediaId = revision.branding.logoMediaId;
  const logoAsset = logoMediaId ? assets.get(logoMediaId) : undefined;
  const logoSource = logoAsset?.bytes
    ? `data:${logoAsset.mimeType};base64,${bytesToBase64(logoAsset.bytes)}`
    : logoAsset?.href;
  const logo = logoSource
    ? `<img class="workspace-logo" src="${escapeHtml(logoSource)}" alt="${escapeHtml(revision.branding.workspaceName)} logo">`
    : "";

  let actionNumber = 0;
  const blocks = revision.blocks
    .map((block) => {
      if (block.type === "action") actionNumber += 1;
      return renderBlock(block, actionNumber, prepared);
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline';">
  <title>${escapeHtml(revision.title)}</title>
  <style>
    :root { color-scheme: light; --accent: ${accent}; --ink: #172019; --muted: #5f6b63; --rule: #d8ddd7; --paper: #ffffff; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #f1f3ef; color: var(--ink); font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(880px, calc(100% - 32px)); margin: 32px auto; padding: 56px 64px; background: var(--paper); box-shadow: 0 12px 40px rgba(23, 32, 25, .1); }
    .document-header { padding-bottom: 30px; border-bottom: 2px solid var(--accent); }
    .brand-row { display: flex; align-items: center; gap: 14px; margin-bottom: 26px; color: var(--muted); font-size: 13px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    .workspace-logo { display: block; max-width: 160px; max-height: 54px; object-fit: contain; }
    h1 { margin: 0; font-size: clamp(34px, 6vw, 52px); line-height: 1.05; letter-spacing: -.035em; }
    .summary { max-width: 720px; margin: 18px 0 0; color: var(--muted); font-size: 18px; }
    .metadata { display: flex; flex-wrap: wrap; gap: 10px 22px; margin-top: 22px; color: var(--muted); font-size: 13px; }
    .guide-content { padding-top: 30px; }
    .guide-heading { margin: 40px 0 14px; line-height: 1.2; }
    h2.guide-heading { padding-bottom: 8px; border-bottom: 1px solid var(--rule); font-size: 27px; }
    h3.guide-heading { font-size: 21px; }
    p { margin: 0 0 14px; }
    .guide-paragraph { margin: 0 0 22px; }
    .action-step { display: grid; grid-template-columns: 38px minmax(0, 1fr); gap: 18px; margin: 34px 0; break-inside: avoid; }
    .action-number { display: grid; width: 34px; height: 34px; place-items: center; border-radius: 50%; background: var(--accent); color: white; font-size: 14px; font-weight: 800; }
    .action-body > h2 { margin: 2px 0 10px; font-size: 22px; line-height: 1.25; }
    figure { margin: 22px 0; }
    .media-frame { position: relative; overflow: hidden; width: 100%; border: 1px solid var(--rule); border-radius: 8px; background: #eef1ed; }
    .media-frame img { position: absolute; display: block; max-width: none; object-fit: fill; }
    .annotation-layer { position: absolute; inset: 0; width: 100%; height: 100%; overflow: hidden; pointer-events: none; }
    figcaption { margin-top: 7px; color: var(--muted); font-size: 12px; }
    .media-placeholder { margin: 20px 0; padding: 38px 22px; border: 1px dashed var(--rule); border-radius: 8px; color: var(--muted); text-align: center; }
    .callout, .expected { margin: 22px 0; padding: 16px 18px; border-left: 4px solid var(--accent); background: #f3f7f4; break-inside: avoid; }
    .callout-warning { border-color: #a15d00; background: #fff7e8; }
    .callout-success { border-color: #24784f; background: #edf8f1; }
    .callout strong, .expected strong { display: block; margin-bottom: 5px; }
    .callout p:last-child, .expected p:last-child { margin-bottom: 0; }
    .system-reference { color: var(--muted); font-size: 14px; }
    a { color: var(--accent); }
    .confirmation { color: #754300; font-weight: 700; }
    .document-footer { margin-top: 52px; padding-top: 18px; border-top: 1px solid var(--rule); color: var(--muted); font-size: 12px; }
    .watermark { position: fixed; right: 18px; bottom: 12px; z-index: 10; max-width: calc(100% - 36px); color: rgba(23, 32, 25, .42); font-size: 10px; letter-spacing: .02em; }
    @media print { body { background: white; } main { width: auto; margin: 0; padding: 36px 44px; box-shadow: none; } .watermark { position: fixed; } }
    @media (max-width: 640px) { main { width: 100%; margin: 0; padding: 36px 22px; } .action-step { grid-template-columns: 32px minmax(0, 1fr); gap: 12px; } }
  </style>
</head>
<body>
  ${watermarkText ? `<div class="watermark">${escapeHtml(watermarkText)}</div>` : ""}
  <main>
    <header class="document-header">
      <div class="brand-row">${logo}<span>${escapeHtml(revision.branding.workspaceName)}</span></div>
      <h1>${escapeHtml(revision.title)}</h1>
      ${revision.summary ? `<p class="summary">${escapeHtml(revision.summary).replaceAll(/\r?\n/g, "<br>")}</p>` : ""}
      <div class="metadata"><span>Revision ${revision.revisionNumber}</span><span>Published ${formatIsoDate(revision.publishedAt)}</span></div>
    </header>
    <article class="guide-content">
${blocks}
    </article>
    ${revision.branding.showRivetBranding ? '<footer class="document-footer">Generated with Rivet.</footer>' : ""}
  </main>
</body>
</html>
`;
}
