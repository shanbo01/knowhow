import * as Sentry from "@sentry/nextjs";
import {
  scrubSentryBreadcrumb,
  scrubSentryEvent,
} from "./lib/telemetry-scrubber";

const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: process.env.NEXT_PUBLIC_KNOWHOW_ENVIRONMENT || process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_KNOWHOW_RELEASE,
  sendDefaultPii: false,
  tracesSampleRate: Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE || "0.01"),
  beforeSend: scrubSentryEvent,
  beforeSendTransaction: scrubSentryEvent,
  beforeBreadcrumb: scrubSentryBreadcrumb,
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
