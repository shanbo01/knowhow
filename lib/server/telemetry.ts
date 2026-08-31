import "server-only";

type FailureFields = {
  requestId?: string;
  errorCode: string;
  status: number;
  operation?: string;
};

/** How far to walk `cause` when an error wraps another. */
const MAX_CAUSE_DEPTH = 4;
const MAX_MESSAGE_LENGTH = 512;
const MAX_STACK_LENGTH = 4_000;

/**
 * Masks anything in a log line that looks like credential material.
 *
 * Stack traces are ours, but messages are not: an SDK failure, a JSON parse
 * error over a key ring, or a URL carrying a token can all put a secret into
 * text that is about to be written to disk and possibly shipped off the host.
 * The patterns are deliberately broad — a redacted log line is still useful,
 * and a leaked key is not recoverable.
 */
function redactSecrets(value: string) {
  return value
    .replace(/\b[a-f0-9]{32,}\b/gi, "[redacted]")
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]")
    .replace(
      /((?:api[_-]?key|key|token|secret|password|authorization|pepper)["'\s]*[:=]["'\s]*)[^\s,;&"']+/gi,
      "$1[redacted]",
    );
}

function clamp(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function errorType(error: unknown) {
  return error instanceof Error ? error.name.slice(0, 80) : typeof error;
}

/**
 * The error and everything it wraps, flattened.
 *
 * A 500 usually surfaces as a generic wrapper, so the wrapper alone says
 * nothing: the useful detail is in its cause. Without this, a production
 * failure reads as "InternalError" and the investigation stops there.
 */
function errorChain(error: unknown) {
  const chain: Array<{ type: string; message: string; stack?: string }> = [];
  let current = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && current; depth += 1) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current instanceof Error) {
      chain.push({
        type: current.name.slice(0, 80),
        message: clamp(redactSecrets(current.message), MAX_MESSAGE_LENGTH),
        ...(current.stack
          ? { stack: clamp(redactSecrets(current.stack), MAX_STACK_LENGTH) }
          : {}),
      });
      current = current.cause;
    } else {
      chain.push({
        type: typeof current,
        message: clamp(redactSecrets(String(current)), MAX_MESSAGE_LENGTH),
      });
      break;
    }
  }
  return chain;
}

export function recordHttpFailure(error: unknown, fields: FailureFields) {
  const entry = {
    timestamp: new Date().toISOString(),
    level: fields.status >= 500 ? "error" : "warning",
    event: "http.request.failed",
    requestId: fields.requestId,
    errorCode: fields.errorCode,
    status: fields.status,
    operation: fields.operation,
    errorType: errorType(error),
  };
  if (fields.status >= 500) {
    // Only server faults carry a stack. A 4xx is the client being told no,
    // which is not a defect and would bury the real failures in noise. The
    // response body is unchanged either way: this detail stays on the host.
    console.error(JSON.stringify({ ...entry, error: errorChain(error) }));
  } else if (
    fields.status === 429 ||
    fields.status === 401 ||
    fields.status === 403
  ) {
    console.warn(JSON.stringify(entry));
  }
}

export { redactSecrets };
