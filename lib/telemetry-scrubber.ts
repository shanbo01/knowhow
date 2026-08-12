import type { Breadcrumb, Event } from "@sentry/nextjs";

const ALLOWED_EXTRA = new Set([
  "requestId",
  "errorCode",
  "operation",
  "route",
  "status",
]);
const ALLOWED_TAGS = new Set([
  "environment",
  "error_code",
  "operation",
  "runtime",
  "status",
]);

function routeShape(value: string | undefined) {
  if (!value) return undefined;
  try {
    const parsed = new URL(value, "https://telemetry.invalid");
    return parsed.pathname
      .replace(/\/w\/[^/]+/g, "/w/:workspace")
      .replace(/\/(guides|media|captures)\/[^/]+/g, "/$1/:id")
      .replace(/\/[A-Za-z0-9._:-]{20,}/g, "/:id")
      .slice(0, 240);
  } catch {
    return undefined;
  }
}

function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    timestamp: breadcrumb.timestamp,
    type: breadcrumb.type,
    category: breadcrumb.category?.slice(0, 80),
    level: breadcrumb.level,
    ...(breadcrumb.category === "navigation"
      ? { data: { from: routeShape(String(breadcrumb.data?.from ?? "")), to: routeShape(String(breadcrumb.data?.to ?? "")) } }
      : {}),
  };
}

export function scrubSentryEvent<T extends Event>(event: T): T {
  event.user = undefined;
  event.fingerprint = undefined;
  event.message = event.message ? "Application event" : undefined;
  event.transaction = routeShape(event.transaction);
  if (event.request) {
    event.request.url = routeShape(event.request.url);
    event.request.cookies = undefined;
    event.request.data = undefined;
    event.request.env = undefined;
    event.request.headers = undefined;
    event.request.query_string = undefined;
  }
  if (event.exception?.values) {
    event.exception.values = event.exception.values.map((exception) => ({
      ...exception,
      value: exception.type ? `${exception.type} captured` : "Error captured",
    }));
  }
  if (event.extra) {
    event.extra = Object.fromEntries(
      Object.entries(event.extra).filter(
        ([key, value]) =>
          ALLOWED_EXTRA.has(key) &&
          (typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"),
      ),
    );
  }
  if (event.tags) {
    event.tags = Object.fromEntries(
      Object.entries(event.tags).filter(([key]) => ALLOWED_TAGS.has(key)),
    );
  }
  event.breadcrumbs = event.breadcrumbs?.map(scrubBreadcrumb).slice(-30);
  return event;
}

export function scrubSentryBreadcrumb(breadcrumb: Breadcrumb) {
  return scrubBreadcrumb(breadcrumb);
}
