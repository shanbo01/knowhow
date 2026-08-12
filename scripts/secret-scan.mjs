import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .split(/\r?\n/)
  .map((value) => value.trim())
  .filter(Boolean);

const binaryExtensions = new Set([
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".pdf",
  ".png",
  ".webp",
  ".zip",
]);
const signatures = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/],
  ["live Stripe secret", /\bsk_live_[A-Za-z0-9]{20,}\b/],
  ["Sentry auth token", /\bsntrys_[A-Za-z0-9_-]{20,}\b/],
  ["credential in URL", /\bhttps?:\/\/[^\s/:]+:[^\s/@]+@/],
];
const assignment = /^\s*(APPWRITE_API_KEY|KNOWHOW_(?:TOKEN_KEYS_JSON|TOKEN_SIGNING_KEY|RATE_LIMIT_PEPPER|EXPORT_WORKER_SECRET|DELETION_RECEIPT_PEPPER)|RESEND_API_KEY|SENTRY_AUTH_TOKEN)\s*=\s*(.+?)\s*$/;
const safeExample = /^(?:$|replace-|example|placeholder|local|development|\$\{|<)/i;
const findings = [];

for (const file of files) {
  const dot = file.lastIndexOf(".");
  if (dot >= 0 && binaryExtensions.has(file.slice(dot).toLowerCase())) continue;
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\0")) continue;
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    for (const [label, pattern] of signatures) {
      if (pattern.test(line)) findings.push({ file, line: index + 1, label });
    }
    const match = line.match(assignment);
    const assignmentValue = match?.[2].replace(/^['"]|['"]$/g, "") ?? "";
    if (
      match &&
      !safeExample.test(assignmentValue) &&
      !(file.endsWith(".example") && /replace-with/i.test(assignmentValue))
    ) {
      findings.push({ file, line: index + 1, label: `${match[1]} assignment` });
    }
  }
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}: possible ${finding.label}`);
  }
  console.error(`Secret scan failed with ${findings.length} possible finding(s).`);
  process.exitCode = 1;
} else {
  console.log(`Secret scan passed for ${files.length} tracked and untracked source files.`);
}
