import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(scriptDirectory, "..");
const destination = resolve(extensionRoot, "dist");
const publicDirectory = resolve(extensionRoot, "..", "public");
const archivePath = resolve(publicDirectory, "knowhow-extension.zip");
const expectedExtensionId = "phbofjenfnnnnndghhinoldlfbpaedpo";

if (dirname(destination) !== extensionRoot || destination === extensionRoot) {
  throw new Error("Refusing to build outside extension/dist.");
}
if (dirname(archivePath) !== publicDirectory) {
  throw new Error("Refusing to package outside public/knowhow-extension.zip.");
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chromeExtensionId(publicKey) {
  const digest = createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex")
    .slice(0, 32);
  return Array.from(digest, (character) =>
    String.fromCharCode("a".charCodeAt(0) + Number.parseInt(character, 16)),
  ).join("");
}

async function listFiles(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, absolute)));
    } else if (entry.isFile()) {
      files.push({
        absolute,
        name: relative(root, absolute).split(sep).join("/"),
      });
    } else {
      throw new Error("Unsupported extension package entry: " + absolute);
    }
  }
  return files;
}

async function deterministicZip(root) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const files = await listFiles(root);

  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const contents = await readFile(file.absolute);
    const compressed = deflateRawSync(contents, { level: 9 });
    const checksum = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

const manifestPath = resolve(extensionRoot, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const contentSource = await readFile(
  resolve(extensionRoot, "src/content/capture.js"),
  "utf8",
);
const backgroundSource = await readFile(
  resolve(extensionRoot, "src/background/index.js"),
  "utf8",
);
const captureStoreSource = await readFile(
  resolve(extensionRoot, "src/core/capture-store.js"),
  "utf8",
);

if (manifest.manifest_version !== 3) {
  throw new Error("KnowHow Capture must remain a Manifest V3 extension.");
}
if (
  typeof manifest.key !== "string" ||
  chromeExtensionId(manifest.key) !== expectedExtensionId
) {
  throw new Error(
    "KnowHow Capture must retain the manifest key for extension ID " +
      expectedExtensionId +
      ".",
  );
}
if (manifest.incognito !== "not_allowed") {
  throw new Error("Incognito capture must remain disabled.");
}
if (manifest.content_scripts?.length) {
  throw new Error("Static content scripts are prohibited.");
}
if (manifest.host_permissions?.includes("<all_urls>")) {
  throw new Error("Required <all_urls> access is prohibited.");
}
if (
  JSON.stringify(manifest.optional_host_permissions || []) !==
  JSON.stringify(["<all_urls>"])
) {
  throw new Error(
    "Website capture access must remain an explicit optional <all_urls> request.",
  );
}
if (
  (manifest.content_scripts || []).some((entry) =>
    (entry.matches || []).includes("<all_urls>"),
  )
) {
  throw new Error("Static <all_urls> content injection is prohibited.");
}
for (const forbiddenPermission of [
  "clipboardRead",
  "desktopCapture",
  "tabCapture",
]) {
  if (manifest.permissions?.includes(forbiddenPermission)) {
    throw new Error("Forbidden permission: " + forbiddenPermission);
  }
}
for (const forbiddenContentPattern of [
  ["clipboard", /clipboard/i],
  ["raw keyboard listener", /addEventListener\(\s*["']key(?:down|up|press)/],
  ["form value read", /\.value\b/],
]) {
  if (forbiddenContentPattern[1].test(contentSource)) {
    throw new Error(
      "Content capture contains a forbidden " +
        forbiddenContentPattern[0] +
        " operation.",
    );
  }
}
if (
  (backgroundSource.match(/captureVisibleTab/g) || []).length !== 1
) {
  throw new Error(
    "captureVisibleTab must remain isolated to one guarded code path.",
  );
}
if (/dataUrl/.test(captureStoreSource)) {
  throw new Error("Raw screenshot data must never enter capture storage.");
}

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(resolve(extensionRoot, "src"), resolve(destination, "src"), {
  recursive: true,
});
const popupFontDirectory = resolve(destination, "src", "popup", "fonts");
await mkdir(popupFontDirectory, { recursive: true });
for (const weight of ["400", "700"]) {
  await cp(
    resolve(
      extensionRoot,
      "..",
      "node_modules",
      "@fontsource",
      "kumbh-sans",
      "files",
      `kumbh-sans-latin-${weight}-normal.woff2`,
    ),
    resolve(popupFontDirectory, `kumbh-sans-latin-${weight}-normal.woff2`),
  );
}
await writeFile(
  resolve(destination, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8",
);

await mkdir(publicDirectory, { recursive: true });
await writeFile(archivePath, await deterministicZip(destination));

console.log("Built unpacked extension at " + destination);
console.log("Packaged deterministic download at " + archivePath);
