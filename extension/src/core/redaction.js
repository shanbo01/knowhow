const EMAIL_PATTERN =
  /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const PHONE_PATTERN =
  /(?:\+?\d[\d\s().-]{7,}\d)/g;
const FINANCIAL_PATTERN =
  /(?:\b\d[ -]*?){13,19}\b/g;
const LONG_ID_PATTERN =
  /\b(?=[A-Z0-9-]{8,}\b)(?=(?:[A-Z0-9-]*\d){2,})[A-Z0-9][A-Z0-9-]{7,}\b/gi;
const ANY_NUMBER_PATTERN = /\d+/g;

export function detectSensitiveRanges(text, options = {}) {
  const input = String(text || "");
  const findings = [];
  const detectors = [
    // Every detector is opt-in. Nothing is covered or rewritten unless the
    // author switched that category on for the session, so what they see in the
    // live preview is exactly what the guide will contain.
    [options.redactEmails === true, "email", EMAIL_PATTERN],
    [options.redactPhoneNumbers === true, "phone", PHONE_PATTERN],
    [
      options.redactFinancialNumbers === true,
      "financial-number",
      FINANCIAL_PATTERN,
    ],
    [options.redactIds === true, "identifier", LONG_ID_PATTERN],
    [options.redactAllNumbers === true, "number", ANY_NUMBER_PATTERN],
  ];

  for (const [enabled, reason, pattern] of detectors) {
    if (!enabled) continue;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(input))) {
      findings.push({
        start: match.index,
        end: match.index + match[0].length,
        reason,
      });
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }

  return findings.sort((left, right) => left.start - right.start);
}

export function isSensitivePathSegment(segment, policy = {}) {
  const input = String(segment || "");
  if (!input) return false;
  return (
    detectSensitiveRanges(input, {
      redactEmails: policy.redactEmails === true,
      redactPhoneNumbers: policy.redactPhoneNumbers === true,
      redactFinancialNumbers: policy.redactFinancialNumbers === true,
    }).length > 0
  );
}

export function sanitizeCapturedText(text, options = {}, maxLength = 500) {
  const input = String(text || "").replace(/\s+/g, " ").trim();
  if (!input) return "";
  const findings = detectSensitiveRanges(input, options);
  if (!findings.length) return input.slice(0, maxLength);

  let output = "";
  let cursor = 0;
  for (const finding of findings) {
    if (finding.start < cursor) continue;
    output += input.slice(cursor, finding.start);
    output += "[redacted]";
    cursor = finding.end;
  }
  output += input.slice(cursor);
  return output.replace(/\s+/g, " ").trim().slice(0, maxLength);
}
