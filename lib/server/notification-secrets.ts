import { HttpError } from "./http-security";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type NotificationCredentialEnvelope = {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
};

export type NotificationCredentialContext = {
  kind: string;
  subjectId: string;
  email?: string | null;
};

type Keyring = { activeKeyId: string; keys: ReadonlyMap<string, string> };

function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function keyring(overrideSecret?: string): Keyring {
  if (overrideSecret !== undefined) {
    if (encoder.encode(overrideSecret).byteLength < 32) throw new Error("test key too short");
    return { activeKeyId: "test", keys: new Map([["test", overrideSecret]]) };
  }
  try {
    const parsed = JSON.parse(
      process.env.KNOWHOW_TOKEN_KEYS_JSON?.trim() || "{}",
    ) as Record<string, unknown>;
    const entries = Object.entries(parsed);
    if (
      !entries.length ||
      entries.some(
        ([keyId, value]) =>
          !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) ||
          typeof value !== "string" ||
          encoder.encode(value).byteLength < 32,
      )
    ) {
      throw new Error("invalid keyring");
    }
    const keys = new Map(entries as Array<[string, string]>);
    const activeKeyId = process.env.KNOWHOW_TOKEN_ACTIVE_KID?.trim() ?? "";
    if (!keys.has(activeKeyId)) throw new Error("active key missing");
    return { activeKeyId, keys };
  } catch (error) {
    throw new HttpError(
      500,
      "NOTIFICATION_KEYRING_INVALID",
      "Notification delivery is unavailable.",
      { expose: false, cause: error },
    );
  }
}

function additionalData(context: NotificationCredentialContext) {
  return encoder.encode(
    JSON.stringify([
      context.kind,
      context.subjectId,
      context.email?.trim().toLowerCase() ?? "",
    ]),
  );
}

async function encryptionKey(secret: string) {
  const material = encoder.encode(`knowhow.notification.v1\0${secret}`);
  const digest = await crypto.subtle.digest("SHA-256", material);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptNotificationCredential(
  credential: string,
  context: NotificationCredentialContext,
  overrideSecret?: string,
): Promise<NotificationCredentialEnvelope> {
  if (!credential || credential.length > 8_192) {
    throw new HttpError(500, "NOTIFICATION_CREDENTIAL_INVALID", "Notification delivery is unavailable.", {
      expose: false,
    });
  }
  const keys = keyring(overrideSecret);
  const secret = keys.keys.get(keys.activeKeyId)!;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: additionalData(context), tagLength: 128 },
    await encryptionKey(secret),
    encoder.encode(credential),
  );
  return {
    version: 1,
    keyId: keys.activeKeyId,
    iv: base64Url(iv),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptNotificationCredential(
  envelope: NotificationCredentialEnvelope,
  context: NotificationCredentialContext,
  overrideSecret?: string,
) {
  try {
    if (
      envelope.version !== 1 ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(envelope.keyId)
    ) {
      throw new Error("invalid envelope");
    }
    const keys = keyring(overrideSecret);
    const secret = keys.keys.get(envelope.keyId);
    if (!secret) throw new Error("unknown key");
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(envelope.iv),
        additionalData: additionalData(context),
        tagLength: 128,
      },
      await encryptionKey(secret),
      fromBase64Url(envelope.ciphertext),
    );
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      500,
      "NOTIFICATION_CREDENTIAL_DECRYPT_FAILED",
      "Notification delivery is unavailable.",
      { expose: false, cause: error },
    );
  }
}
