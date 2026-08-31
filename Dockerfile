# syntax=docker/dockerfile:1
#
# KnowHow web application.
#
# Three stages: dependencies, build, runtime. The runtime image carries the
# traced standalone server and the prebuilt capture extension archive, and
# nothing else — no source, no toolchain, no development dependencies.
#
# Build-time versus runtime configuration matters here. Next.js inlines every
# NEXT_PUBLIC_* value into the client bundle and freezes the response headers
# (including the Content-Security-Policy built from APPWRITE_ENDPOINT) into the
# routes manifest. Those must be build arguments; an image is therefore specific
# to one environment. Secrets are never build arguments — they arrive at run
# time, where they can be rotated without a rebuild.

ARG NODE_VERSION=22.13-alpine

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder
RUN apk add --no-cache libc6-compat
WORKDIR /app

ARG KNOWHOW_ENVIRONMENT=production
ARG KNOWHOW_RELEASE
ARG KNOWHOW_REGISTRATION_MODE=private_beta
ARG KNOWHOW_SITE_ORIGIN
ARG APPWRITE_ENDPOINT
ARG KNOWHOW_BUILD_CPUS=2
ARG NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL=
ARG NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL=
ARG NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_X64_URL=
ARG NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_X64_URL=
ARG NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_ARM64_URL=
ARG NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_ARM64_URL=

# The release identity has to agree across the server and the client bundle, or
# deploymentConfigurationIssues() reports public_deployment_identity.
ENV KNOWHOW_ENVIRONMENT=${KNOWHOW_ENVIRONMENT} \
    NEXT_PUBLIC_KNOWHOW_ENVIRONMENT=${KNOWHOW_ENVIRONMENT} \
    KNOWHOW_RELEASE=${KNOWHOW_RELEASE} \
    NEXT_PUBLIC_KNOWHOW_RELEASE=${KNOWHOW_RELEASE} \
    KNOWHOW_REGISTRATION_MODE=${KNOWHOW_REGISTRATION_MODE} \
    NEXT_PUBLIC_KNOWHOW_REGISTRATION_MODE=${KNOWHOW_REGISTRATION_MODE} \
    KNOWHOW_PUBLIC_APP_ORIGIN=${KNOWHOW_SITE_ORIGIN} \
    APPWRITE_ENDPOINT=${APPWRITE_ENDPOINT} \
    KNOWHOW_BUILD_CPUS=${KNOWHOW_BUILD_CPUS} \
    NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL=${NEXT_PUBLIC_KNOWHOW_CHROME_EXTENSION_URL} \
    NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL=${NEXT_PUBLIC_KNOWHOW_EDGE_EXTENSION_URL} \
    NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_X64_URL=${NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_X64_URL} \
    NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_X64_URL=${NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_X64_URL} \
    NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_ARM64_URL=${NEXT_PUBLIC_KNOWHOW_DESKTOP_EXE_ARM64_URL} \
    NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_ARM64_URL=${NEXT_PUBLIC_KNOWHOW_DESKTOP_MSI_ARM64_URL} \
    NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN test -n "${KNOWHOW_RELEASE}" || \
      (echo "KNOWHOW_RELEASE is required: pass --build-arg KNOWHOW_RELEASE=<git sha or tag>." && exit 1)
RUN test -n "${KNOWHOW_SITE_ORIGIN}" || \
      (echo "KNOWHOW_SITE_ORIGIN is required: it is baked into the capture extension." && exit 1)

# The capture extension is distributed as a downloadable archive, so it is built
# during the release with the deployment's own origin compiled in. Doing this in
# the image keeps the download deterministic and removes any need for the
# extension source, or a build toolchain, at run time.
RUN KNOWHOW_EXTENSION_ORIGIN="${KNOWHOW_SITE_ORIGIN}" npm run extension:build:store \
    && mkdir -p /extension-package \
    && cp outputs/extension/*.zip /extension-package/

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runner
RUN apk add --no-cache libc6-compat wget
WORKDIR /app

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    KNOWHOW_EXTENSION_PACKAGE_DIR=/app/extension-package

# The published port is reachable only on the Docker network; the reverse proxy
# is the sole route in from outside. Run unprivileged regardless.
RUN addgroup --system --gid 1001 knowhow \
    && adduser --system --uid 1001 --ingroup knowhow knowhow

COPY --from=builder --chown=knowhow:knowhow /app/public ./public
COPY --from=builder --chown=knowhow:knowhow /app/.next/standalone ./
COPY --from=builder --chown=knowhow:knowhow /app/.next/static ./.next/static
COPY --from=builder --chown=knowhow:knowhow /extension-package ./extension-package

USER knowhow
EXPOSE 3000

# Liveness only. The deep readiness probe (/api/health?ready=1) reaches Appwrite
# and the worker queue, so a transient dependency failure there must not cause
# Docker to restart an otherwise healthy application.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/api/health || exit 1

CMD ["node", "server.js"]
