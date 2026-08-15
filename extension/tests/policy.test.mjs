import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPTURE_POLICY_SCHEMA_VERSION,
  DEFAULT_CAPTURE_POLICY,
  applyWorkspaceContext,
  evaluateCaptureUrl,
  hostnameMatchesPattern,
  mergePolicy,
  normalizeSitePattern,
  sanitizeCaptureUrl,
} from "../src/core/policy.js";

test("every detector is opt-in; workspace categories only recommend", () => {
  assert.equal(DEFAULT_CAPTURE_POLICY.smartBlurEnabled, false);
  for (const key of [
    "redactEmails",
    "redactPhoneNumbers",
    "redactFinancialNumbers",
    "redactIds",
    "redactFormFields",
    "redactAllNumbers",
    "redactImages",
    "redactTableRows",
    "redactLongText",
    "redactCommonNames",
  ]) {
    assert.equal(DEFAULT_CAPTURE_POLICY[key], false, key);
  }

  const policy = applyWorkspaceContext({}, {
    policyVersion: "privacy-v1",
    privacy: { automatic: ["email", "form-field"] },
  });
  assert.equal(policy.smartBlurEnabled, false);
  assert.equal(policy.redactEmails, false);
  assert.equal(policy.redactFormFields, false);
  // The workspace's advice survives as a label the on-page panel can show.
  assert.deepEqual(policy.recommendedRedactions, ["email", "form-field"]);

  const chosen = applyWorkspaceContext(
    {
      schemaVersion: CAPTURE_POLICY_SCHEMA_VERSION,
      smartBlurEnabled: true,
      redactEmails: true,
    },
    { privacy: { automatic: [] } },
  );
  assert.equal(chosen.smartBlurEnabled, true);
  assert.equal(chosen.redactEmails, true);
});

test("a policy stored before recommendations stopped enabling detectors is reset", () => {
  const migrated = mergePolicy({
    schemaVersion: 3,
    redactEmails: true,
    redactFormFields: true,
    clickTargetColor: "#123456",
  });
  assert.equal(migrated.redactEmails, false);
  assert.equal(migrated.redactFormFields, false);
  assert.equal(migrated.clickTargetColor, "#123456");
});

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

test("sanitized URLs remove queries and fragments; emails in the path redact while route slugs stay visible", () => {
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
    "https://example.com/users/[redacted]/orders/12345678",
  );
  assert.equal(sanitized.includes("secret"), false);
});

test("route slugs, ports, and numeric IDs stay in URL labels even when on-page ID detectors are on", () => {
  assert.equal(
    sanitizeCaptureUrl("http://localhost:3001/w/helpdesk-ac3fe", {
      redactIds: true,
      redactAllNumbers: true,
      redactCommonNames: true,
    }),
    "http://localhost:3001/w/helpdesk-ac3fe",
  );
  assert.equal(
    sanitizeCaptureUrl(
      "https://example.com/tokens/0123456789abcdef0123456789abcdef",
    ),
    "https://example.com/tokens/0123456789abcdef0123456789abcdef",
  );
  assert.equal(
    sanitizeCaptureUrl("http://localhost:3001/w/helpdesk-ac3fe?x=1#y"),
    "http://localhost:3001/w/helpdesk-ac3fe",
  );
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

test("workspace context enforces server exclusions and keeps author choices", () => {
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
  assert.equal(policy.redactEmails, false);
  assert.equal(policy.redactFormFields, false);
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
