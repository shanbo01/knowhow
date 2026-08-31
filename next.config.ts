import type { NextConfig } from "next";

function configuredOrigin(value: string | undefined) {
  try {
    return value ? new URL(value).origin : null;
  } catch {
    return null;
  }
}

function boundedCpus(value: string | undefined) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 16 ? parsed : 1;
}

const buildCpus = boundedCpus(process.env.KNOWHOW_BUILD_CPUS);

const connectSources = [
  "'self'",
  configuredOrigin(process.env.APPWRITE_ENDPOINT),
].filter((value): value is string => Boolean(value));

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src ${connectSources.join(" ")}`,
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "media-src 'self' blob:",
  ...(process.env.NODE_ENV === "production" ? ["upgrade-insecure-requests"] : []),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Permitted-Cross-Domain-Policies", value: "none" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "Origin-Agent-Cluster", value: "?1" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), browsing-topics=()",
  },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  // Trace the server's real imports into .next/standalone so the deployed image
  // carries a runtime instead of the whole dependency tree.
  output: "standalone",
  poweredByHeader: false,
  reactStrictMode: true,
  compress: true,
  productionBrowserSourceMaps: false,
  enablePrerenderSourceMaps: false,
  experimental: {
    // Build fan-out. The single-worker settings below existed for a 1 GB
    // Appwrite Free Sites container; a VPS builder has more room, so
    // KNOWHOW_BUILD_CPUS raises the ceiling without pinning it to one host.
    cpus: buildCpus,
    staticGenerationMaxConcurrency: buildCpus,
    staticGenerationMinPagesPerWorker: 100,
    serverSourceMaps: false,
  },
  // The unpacked local KnowHow extension has a stable Chrome origin.
  allowedDevOrigins: ["phbofjenfnnnnndghhinoldlfbpaedpo"],
  async redirects() {
    return [
      { source: "/product", destination: "/#product", permanent: false },
      { source: "/how-it-works", destination: "/#how", permanent: false },
      { source: "/pricing", destination: "/#pricing", permanent: false },
      { source: "/use-cases", destination: "/", permanent: false },
      { source: "/internal-it", destination: "/", permanent: false },
      { source: "/employee-onboarding", destination: "/", permanent: false },
      { source: "/operational-procedures", destination: "/", permanent: false },
      { source: "/compliance-evidence", destination: "/", permanent: false },
      { source: "/customer-service-desk-procedures", destination: "/", permanent: false },
      { source: "/software-training", destination: "/", permanent: false },
      { source: "/request-demo", destination: "/contact", permanent: false },
      { source: "/request-pilot", destination: "/contact", permanent: false },
    ];
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
