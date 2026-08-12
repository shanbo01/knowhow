import * as Sentry from "@sentry/nextjs";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "./lib/telemetry-scrubber";

const dsn = process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.KNOWHOW_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.KNOWHOW_RELEASE,
  sendDefaultPii: false,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.05"),
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});
