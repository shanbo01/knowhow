import "server-only";

import * as Sentry from "@sentry/nextjs";

type FailureFields = {
  requestId?: string;
  errorCode: string;
  status: number;
  operation?: string;
};

function errorType(error: unknown) {
  return error instanceof Error ? error.name.slice(0, 80) : typeof error;
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
  if (fields.status >= 500) console.error(JSON.stringify(entry));
  else if (fields.status === 429 || fields.status === 401 || fields.status === 403) {
    console.warn(JSON.stringify(entry));
  }
  if (fields.status >= 500) {
    Sentry.captureException(error, {
      tags: {
        error_code: fields.errorCode,
        status: String(fields.status),
        ...(fields.operation ? { operation: fields.operation } : {}),
      },
      extra: {
        ...(fields.requestId ? { requestId: fields.requestId } : {}),
        errorCode: fields.errorCode,
        status: fields.status,
        ...(fields.operation ? { operation: fields.operation } : {}),
      },
    });
  }
}
