import type { GuideBlock, PublishedGuideRevision } from "../guide-contracts";
import { prepareGuideExport } from "./policy";
import { formatWatermark, pdfSafeText } from "./shared";
import {
  GuideRendererError,
  type GuideExportAsset,
  type GuideRenderOptions,
} from "./types";

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const value of bytes) {
    crc = CRC_TABLE[(crc ^ value) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf8(value: string) {
  return new TextEncoder().encode(value);
}

function concat(parts: Uint8Array[]) {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

function u16(value: number) {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return bytes;
}

function u32(value: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function zipStore(files: Array<{ name: string; data: Uint8Array }>) {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = utf8(file.name);
    const crc = crc32(file.data);
    const local = concat([
      utf8("PK\u0003\u0004"),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(crc),
      u32(file.data.byteLength),
      u32(file.data.byteLength),
      u16(name.byteLength),
      u16(0),
      name,
      file.data,
    ]);
    locals.push(local);
    centrals.push(
      concat([
        utf8("PK\u0001\u0002"),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(crc),
        u32(file.data.byteLength),
        u32(file.data.byteLength),
        u16(name.byteLength),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(offset),
        name,
      ]),
    );
    offset += local.byteLength;
  }
  const central = concat(centrals);
  const end = concat([
    utf8("PK\u0005\u0006"),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(central.byteLength),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, central, end]);
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function extensionFor(asset: GuideExportAsset) {
  return asset.mimeType === "image/jpeg" ? "jpeg" : "png";
}

function contentTypes(images: Array<{ name: string; mime: string }>, slideCount: number) {
  const overrides = [
    ...Array.from({ length: slideCount }, (_, index) =>
      `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
    ),
    ...images.map(
      (image) =>
        `<Override PartName="/ppt/media/${image.name}" ContentType="${image.mime}"/>`,
    ),
  ].join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  ${overrides}
</Types>`;
}

function slideXml(title: string, body: string, imageRel?: string) {
  const picture = imageRel
    ? `<p:pic>
        <p:nvPicPr>
          <p:cNvPr id="3" name="Screenshot"/>
          <p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr>
          <p:nvPr/>
        </p:nvPicPr>
        <p:blipFill>
          <a:blip r:embed="${imageRel}"/>
          <a:stretch><a:fillRect/></a:stretch>
        </p:blipFill>
        <p:spPr>
          <a:xfrm>
            <a:off x="457200" y="1828800"/>
            <a:ext cx="11277600" cy="4572000"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
      </p:pic>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Title"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="457200" y="274320"/>
            <a:ext cx="11277600" cy="1371600"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr/>
            <a:r><a:rPr lang="en-US" sz="2800" b="1"/><a:t>${xml(title)}</a:t></a:r>
          </a:p>
          ${body ? `<a:p><a:r><a:rPr lang="en-US" sz="1600"/><a:t>${xml(body)}</a:t></a:r></a:p>` : ""}
        </p:txBody>
      </p:sp>
      ${picture}
    </p:spTree>
  </p:cSld>
  <p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>
</p:sld>`;
}

function blockText(block: GuideBlock) {
  if (block.type === "heading") return { title: block.text, body: "" };
  if (block.type === "callout") return { title: block.title || "Note", body: block.text };
  if (block.type === "action") return { title: block.title, body: block.instructions };
  return { title: "Step", body: "" };
}

export async function renderGuideToPptx(
  revision: PublishedGuideRevision,
  options: GuideRenderOptions = {},
): Promise<Uint8Array> {
  const prepared = prepareGuideExport(revision, "pptx", options);
  const watermark = formatWatermark(prepared.watermark);
  const slides: Array<{ title: string; body: string; asset?: GuideExportAsset }> = [
    {
      title: pdfSafeText(revision.title).slice(0, 200),
      body: [revision.summary, watermark].filter(Boolean).join(" — ").slice(0, 400),
    },
  ];
  for (const block of revision.blocks) {
    const copy = blockText(block);
    const asset =
      block.type === "action" && block.media
        ? prepared.assets.get(block.media.mediaId)
        : undefined;
    slides.push({
      title: pdfSafeText(copy.title).slice(0, 180) || "Step",
      body: pdfSafeText(copy.body).slice(0, 400),
      asset: asset?.bytes ? asset : undefined,
    });
  }

  const files: Array<{ name: string; data: Uint8Array }> = [];
  const images: Array<{ name: string; mime: string }> = [];
  const slideRels: string[] = [];
  slides.forEach((slide, index) => {
    const slideNumber = index + 1;
    let imageRel: string | undefined;
    if (slide.asset?.bytes) {
      const name = `image${slideNumber}.${extensionFor(slide.asset)}`;
      images.push({ name, mime: slide.asset.mimeType });
      files.push({ name: `ppt/media/${name}`, data: slide.asset.bytes });
      imageRel = "rId1";
      slideRels.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${name}"/>
</Relationships>`);
    } else {
      slideRels.push(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    }
    files.push({
      name: `ppt/slides/slide${slideNumber}.xml`,
      data: utf8(slideXml(slide.title, slide.body, imageRel)),
    });
    files.push({
      name: `ppt/slides/_rels/slide${slideNumber}.xml.rels`,
      data: utf8(slideRels[index]),
    });
  });

  const presentationRels = slides
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`,
    )
    .join("");
  const slideIds = slides
    .map(
      (_, index) =>
        `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`,
    )
    .join("");

  files.push(
    {
      name: "[Content_Types].xml",
      data: utf8(contentTypes(images, slides.length)),
    },
    {
      name: "_rels/.rels",
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`),
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${presentationRels}
</Relationships>`),
    },
    {
      name: "ppt/presentation.xml",
      data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>${slideIds}</p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`),
    },
  );

  try {
    return zipStore(files);
  } catch (error) {
    throw new GuideRendererError("RENDER_FAILED", "PowerPoint export failed.", {
      format: "pptx",
      cause: error,
    });
  }
}
