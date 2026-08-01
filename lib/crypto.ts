import type { EncryptedSecretEnvelope } from "./domain";
import { isEncryptedSecretEnvelope } from "./domain";

export const PBKDF2_ITERATIONS = 600_000;
const MIN_PBKDF2_ITERATIONS = 210_000;
const MAX_PBKDF2_ITERATIONS = 2_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const ADDITIONAL_DATA = new TextEncoder().encode("rivet:secret:v1");

export type SecretCryptoErrorCode =
  | "UNAVAILABLE"
  | "INVALID_ENVELOPE"
  | "INVALID_PASSPHRASE";

export class SecretCryptoError extends Error {
  readonly code: SecretCryptoErrorCode;
  readonly cause?: unknown;

  constructor(
    code: SecretCryptoErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "SecretCryptoError";
    this.code = code;
    this.cause = cause;
  }
}

function webCrypto(): Crypto {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle || !cryptoApi.getRandomValues) {
    throw new SecretCryptoError(
      "UNAVAILABLE",
      "Secure secret storage requires Web Crypto in a secure browser context.",
    );
  }
  return cryptoApi;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch (error) {
    throw new SecretCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted secret contains invalid base64 data.",
      error,
    );
  }
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
  usages: KeyUsage[],
): Promise<CryptoKey> {
  if (!passphrase) {
    throw new SecretCryptoError(
      "INVALID_PASSPHRASE",
      "A vault passphrase is required.",
    );
  }

  const cryptoApi = webCrypto();
  const material = await cryptoApi.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return cryptoApi.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt,
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function validateEnvelope(
  envelope: EncryptedSecretEnvelope,
): EncryptedSecretEnvelope {
  if (
    !isEncryptedSecretEnvelope(envelope) ||
    envelope.iterations < MIN_PBKDF2_ITERATIONS ||
    envelope.iterations > MAX_PBKDF2_ITERATIONS
  ) {
    throw new SecretCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted secret envelope is invalid or unsupported.",
    );
  }

  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);
  if (
    salt.byteLength < SALT_BYTES ||
    iv.byteLength !== IV_BYTES ||
    ciphertext.byteLength < 16
  ) {
    throw new SecretCryptoError(
      "INVALID_ENVELOPE",
      "The encrypted secret envelope is incomplete.",
    );
  }
  return envelope;
}

export async function encryptSecretValue(
  plaintext: string,
  passphrase: string,
): Promise<EncryptedSecretEnvelope> {
  const cryptoApi = webCrypto();
  const salt = cryptoApi.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = cryptoApi.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey(
    passphrase,
    salt,
    PBKDF2_ITERATIONS,
    ["encrypt"],
  );
  const ciphertext = await cryptoApi.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: ADDITIONAL_DATA,
      tagLength: 128,
    },
    key,
    new TextEncoder().encode(plaintext),
  );

  return {
    version: 1,
    algorithm: "AES-GCM",
    keyDerivation: "PBKDF2-SHA-256",
    iterations: PBKDF2_ITERATIONS,
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext)),
  };
}

export async function decryptSecretValue(
  envelope: EncryptedSecretEnvelope,
  passphrase: string,
): Promise<string> {
  validateEnvelope(envelope);
  const cryptoApi = webCrypto();
  const salt = base64ToBytes(envelope.salt);
  const iv = base64ToBytes(envelope.iv);
  const ciphertext = base64ToBytes(envelope.ciphertext);

  try {
    const key = await deriveKey(passphrase, salt, envelope.iterations, [
      "decrypt",
    ]);
    const plaintext = await cryptoApi.subtle.decrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: ADDITIONAL_DATA,
        tagLength: 128,
      },
      key,
      ciphertext,
    );
    return new TextDecoder().decode(plaintext);
  } catch (error) {
    if (error instanceof SecretCryptoError) {
      throw error;
    }
    throw new SecretCryptoError(
      "INVALID_PASSPHRASE",
      "The vault passphrase is incorrect or the secret is corrupted.",
      error,
    );
  }
}
