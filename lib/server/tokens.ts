import type { WorkspaceRole } from "../rivet-types";
import { HttpError } from "./http-security";

const TOKEN_VERSION = 1 as const;
const MAX_TOKEN_LENGTH = 8_192;
const SAFE_CLAIM_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type DeviceScope = "capture:write" | "media:write";

interface ClaimsBase {
  version: typeof TOKEN_VERSION;
  jti: string;
  workspaceId: string;
  issuedAt: number;
  expiresAt: number;
}

export interface InviteTokenClaims extends ClaimsBase {
  type: "invite";
  role: Exclude<WorkspaceRole, "administrator">;
  email?: string;
}

export interface DeviceTokenClaims extends ClaimsBase {
  type: "device";
  userId: string;
  deviceId: string;
  scopes: readonly DeviceScope[];
}

export interface AppointmentTokenClaims extends ClaimsBase {
  type: "admin-appointment";
  email: string;
}

export type RivetTokenClaims =
  | InviteTokenClaims
  | DeviceTokenClaims
  | AppointmentTokenClaims;

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
    Math.ceil(value.length / 4) * 4,
    "=",
  );
  try {
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch (error) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.", { cause: error });
  }
}

function ownedBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer;
}

function signingSecret(override?: string): string {
  const secret = override ?? process.env.RIVET_TOKEN_SIGNING_KEY ?? "";
  if (encoder.encode(secret).byteLength < 32) {
    throw new HttpError(500, "TOKEN_KEY_MISSING", "Token signing is unavailable.", {
      expose: false,
    });
  }
  return secret;
}

async function hmacKey(secret?: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(signingSecret(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
    .join(",")}}`;
}

async function signClaims(
  claims: RivetTokenClaims,
  secret?: string,
): Promise<string> {
  assertBaseClaims(claims);
  const payload = bytesToBase64Url(encoder.encode(stableJson(claims)));
  const message = encoder.encode(`rivet.v1.${payload}`);
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), message);
  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function assertBaseClaims(value: unknown): asserts value is RivetTokenClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
  const claims = value as Partial<RivetTokenClaims>;
  if (
    claims.version !== TOKEN_VERSION ||
    (claims.type !== "invite" &&
      claims.type !== "device" &&
      claims.type !== "admin-appointment") ||
    typeof claims.jti !== "string" ||
    typeof claims.workspaceId !== "string" ||
    typeof claims.issuedAt !== "number" ||
    typeof claims.expiresAt !== "number" ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.jti.length < 16 ||
    !SAFE_CLAIM_ID.test(claims.jti) ||
    !SAFE_CLAIM_ID.test(claims.workspaceId)
  ) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
}

async function verifyClaims(
  token: string,
  expectedType: RivetTokenClaims["type"],
  secret?: string,
): Promise<RivetTokenClaims> {
  if (!token || token.length > MAX_TOKEN_LENGTH) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
  const payloadBytes = base64UrlToBytes(payload);
  const signatureBytes = base64UrlToBytes(signature);
  if (
    bytesToBase64Url(payloadBytes) !== payload ||
    bytesToBase64Url(signatureBytes) !== signature
  ) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");
  }
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    ownedBuffer(signatureBytes),
    encoder.encode(`rivet.v1.${payload}`),
  );
  if (!valid) throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.");

  let claims: unknown;
  try {
    claims = JSON.parse(decoder.decode(payloadBytes));
  } catch (error) {
    throw new HttpError(401, "TOKEN_INVALID", "The token is invalid.", { cause: error });
  }
  assertBaseClaims(claims);
  if (claims.type !== expectedType) {
    throw new HttpError(401, "TOKEN_TYPE_INVALID", "The token is invalid for this action.");
  }
  const now = Math.floor(Date.now() / 1000);
  if (claims.expiresAt <= now) {
    throw new HttpError(401, "TOKEN_EXPIRED", "The token has expired.");
  }
  if (claims.issuedAt > now + 60 || claims.expiresAt <= claims.issuedAt) {
    throw new HttpError(401, "TOKEN_TIME_INVALID", "The token is invalid.");
  }
  return claims;
}

export function randomTokenId(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, "");
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const comparedLength = Math.max(leftBytes.length, rightBytes.length);
  let mismatch = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < comparedLength; index += 1) {
    mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return mismatch === 0;
}

export function signInviteToken(
  input: Omit<InviteTokenClaims, "version" | "type" | "issuedAt"> & {
    issuedAt?: number;
  },
  secret?: string,
): Promise<string> {
  return signClaims(
    {
      ...input,
      ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
      version: TOKEN_VERSION,
      type: "invite",
      issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
    },
    secret,
  );
}

export async function verifyInviteToken(
  token: string,
  secret?: string,
): Promise<InviteTokenClaims> {
  const claims = await verifyClaims(token, "invite", secret);
  if (
    claims.type !== "invite" ||
    !["creator", "reviewer", "publisher", "viewer"].includes(claims.role) ||
    (claims.email !== undefined &&
      (typeof claims.email !== "string" ||
        claims.email.length > 320 ||
        claims.email !== claims.email.trim().toLowerCase() ||
        !claims.email.includes("@")))
  ) {
    throw new HttpError(401, "TOKEN_INVALID", "The invitation token is invalid.");
  }
  return claims;
}

export function signDeviceToken(
  input: Omit<DeviceTokenClaims, "version" | "type" | "issuedAt"> & {
    issuedAt?: number;
  },
  secret?: string,
): Promise<string> {
  return signClaims(
    {
      ...input,
      version: TOKEN_VERSION,
      type: "device",
      issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
    },
    secret,
  );
}

export async function verifyDeviceToken(
  token: string,
  secret?: string,
): Promise<DeviceTokenClaims> {
  const claims = await verifyClaims(token, "device", secret);
  if (
    claims.type !== "device" ||
    typeof claims.userId !== "string" ||
    typeof claims.deviceId !== "string" ||
    !SAFE_CLAIM_ID.test(claims.userId) ||
    !SAFE_CLAIM_ID.test(claims.deviceId) ||
    !Array.isArray(claims.scopes) ||
    claims.scopes.length === 0 ||
    new Set(claims.scopes).size !== claims.scopes.length ||
    claims.scopes.some(
      (scope) => scope !== "capture:write" && scope !== "media:write",
    )
  ) {
    throw new HttpError(401, "TOKEN_INVALID", "The device token is invalid.");
  }
  return claims;
}

export function signAppointmentToken(
  input: Omit<AppointmentTokenClaims, "version" | "type" | "issuedAt" | "email"> & {
    email: string;
    issuedAt?: number;
  },
  secret?: string,
): Promise<string> {
  return signClaims(
    {
      ...input,
      email: input.email.trim().toLowerCase(),
      version: TOKEN_VERSION,
      type: "admin-appointment",
      issuedAt: input.issuedAt ?? Math.floor(Date.now() / 1000),
    },
    secret,
  );
}

export async function verifyAppointmentToken(
  token: string,
  secret?: string,
): Promise<AppointmentTokenClaims> {
  const claims = await verifyClaims(token, "admin-appointment", secret);
  if (
    claims.type !== "admin-appointment" ||
    typeof claims.email !== "string" ||
    claims.email.length > 320 ||
    claims.email !== claims.email.trim().toLowerCase() ||
    !claims.email.includes("@")
  ) {
    throw new HttpError(401, "TOKEN_INVALID", "The appointment token is invalid.");
  }
  return claims;
}
