import assert from "node:assert/strict";
import test from "node:test";

import {
  applyWorkspaceContext,
  evaluateCaptureUrl,
  hostnameMatchesPattern,
  mergePolicy,
  normalizeSitePattern,
  sanitizeCaptureUrl,
} from "../src/core/policy.js";

test("only regular HTTP and HTTPS pages are eligible", () => {
  for (const url of [
    "chrome://settings",
    "edge://extensions",
    "file:///private/report.html",
    "chrome-extension://abc/popup.html",
  ]) {
    assert.equal(evaluateCaptureUrl(url).allowed, false, url);
  }
  assert.equal(evaluateCaptureUrl("https://example.com/help").allowed, true);
});

test("default password vault hosts are blocked", () => {
  assert.equal(
    evaluateCaptureUrl("https://vault.bitwarden.com/#/vault").allowed,
    false,
  );
  assert.equal(
    evaluateCaptureUrl("https://passwords.google.com/").allowed,
    false,
  );
});

test("wildcard exclusions match a domain and its subdomains", () => {
  assert.equal(hostnameMatchesPattern("portal.example.com", "*.example.com"), true);
  assert.equal(hostnameMatchesPattern("example.com", "*.example.com"), true);
  assert.equal(hostnameMatchesPattern("notexample.com", "*.example.com"), false);
  assert.equal(normalizeSitePattern("*.Example.COM"), "*.example.com");

  const policy = mergePolicy({ excludedSites: ["*.example.com"] });
  assert.equal(
    evaluateCaptureUrl("https://finance.example.com/", policy).allowed,
    false,
  );
});

test("sanitized URLs remove queries and fragments; sensitive path segments redact when Smart Blur categories are enabled", () => {
  const url =
    "https://example.com/users/alice%40example.com/orders/12345678?token=secret#card";
  const withoutBlur = sanitizeCaptureUrl(url);
  assert.equal(withoutBlur.includes("secret"), false);
  assert.equal(withoutBlur.includes("token="), false);
  assert.equal(withoutBlur.includes("#card"), false);

  const sanitized = sanitizeCaptureUrl(url, {
    redactEmails: true,
    redactIds: true,
  });
  assert.equal(
    sanitized,
    "https://example.com/users/[redacted]/orders/[redacted]",
  );
  assert.equal(sanitized.includes("secret"), false);
});

test("allowlists use a default-deny decision", () => {
  const policy = mergePolicy({ allowedSites: ["docs.example.com"] });
  assert.equal(
    evaluateCaptureUrl("https://docs.example.com/guide", policy).allowed,
    true,
  );
  assert.equal(
    evaluateCaptureUrl("https://other.example.com/guide", policy).allowed,
    false,
  );
});

test("workspace context enforces server exclusions and automatic privacy rules", () => {
  const policy = applyWorkspaceContext(
    {
      redactEmails: false,
      redactFormFields: false,
      clickTargetColor: "#000000",
    },
    {
      policyVersion: "privacy-v1",
      excludedOrigins: ["https://finance.example.com"],
      clickTargetColor: "#ef6f47",
      privacy: { automatic: ["email", "form-field"] },
    },
  );
  assert.equal(policy.version, "privacy-v1");
  assert.equal(policy.redactEmails, true);
  assert.equal(policy.redactFormFields, true);
  assert.equal(policy.clickTargetColor, "#ef6f47");
  assert.equal(
    evaluateCaptureUrl("https://finance.example.com/payroll", policy).allowed,
    false,
  );
});

test("sanitized URLs redact formatted phone and financial path segments", () => {
  assert.equal(
    sanitizeCaptureUrl(
      "https://example.com/call/%2B974%205555%201234/card/4111-1111-1111-1111",
      { redactPhoneNumbers: true, redactFinancialNumbers: true },
    ),
    "https://example.com/call/[redacted]/card/[redacted]",
  );
});
