import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { emailTransportConfigured } from "./appwrite-config";

const TOUCHED = [
  "RESEND_API_KEY",
  "RESEND_FROM",
  "KNOWHOW_SMTP_HOST",
  "KNOWHOW_SMTP_FROM",
];

afterEach(() => {
  for (const key of TOUCHED) delete process.env[key];
});

describe("emailTransportConfigured", () => {
  it("reports no transport when nothing is set", () => {
    assert.equal(emailTransportConfigured(), false);
  });

  it("accepts a complete Resend configuration", () => {
    process.env.RESEND_API_KEY = "re_live_key";
    process.env.RESEND_FROM = "KnowHow <notifications@example.com>";
    assert.equal(emailTransportConfigured(), true);
  });

  it("accepts a complete SMTP configuration", () => {
    process.env.KNOWHOW_SMTP_HOST = "smtp.example.com";
    process.env.KNOWHOW_SMTP_FROM = "KnowHow <notifications@example.com>";
    assert.equal(emailTransportConfigured(), true);
  });

  // sendViaResend throws RESEND_NOT_CONFIGURED without a sender address, so a
  // key on its own delivers nothing. Accepting it reported a healthy
  // deployment whose every invitation failed.
  it("rejects a Resend key with no sender address", () => {
    process.env.RESEND_API_KEY = "re_live_key";
    assert.equal(emailTransportConfigured(), false);
  });

  it("rejects an SMTP host with no sender address", () => {
    process.env.KNOWHOW_SMTP_HOST = "smtp.example.com";
    assert.equal(emailTransportConfigured(), false);
  });

  it("ignores values that are only whitespace", () => {
    process.env.RESEND_API_KEY = "   ";
    process.env.RESEND_FROM = "   ";
    assert.equal(emailTransportConfigured(), false);
  });

  it("accepts one complete pair even when the other is half-set", () => {
    process.env.KNOWHOW_SMTP_HOST = "smtp.example.com";
    process.env.KNOWHOW_SMTP_FROM = "KnowHow <notifications@example.com>";
    process.env.RESEND_API_KEY = "re_live_key";
    assert.equal(emailTransportConfigured(), true);
  });
});
