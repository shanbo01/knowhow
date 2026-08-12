import assert from "node:assert/strict";
import test from "node:test";
import {
  decryptNotificationCredential as decryptInApplication,
  encryptNotificationCredential,
} from "../lib/server/notification-secrets";
import {
  decryptNotificationCredential as decryptInWorker,
  scrubNotificationCredential,
} from "../functions/operations/src/main.js";

const secret = "notification-secret-with-at-least-thirty-two-random-bytes";
const context = {
  kind: "invitation.created",
  subjectId: "invite_1234567890123456789012345678",
  email: "Person@Example.com",
};

test("one-time notification credentials are encrypted and context-bound", async () => {
  const credential = "signed.one-time.credential";
  const envelope = await encryptNotificationCredential(
    credential,
    context,
    secret,
  );
  assert.equal(envelope.version, 1);
  assert.equal(envelope.keyId, "test");
  assert.doesNotMatch(JSON.stringify(envelope), /signed\.one-time\.credential/);
  assert.equal(
    await decryptInApplication(envelope, context, secret),
    credential,
  );
  await assert.rejects(
    decryptInApplication(
      envelope,
      { ...context, email: "other@example.com" },
      secret,
    ),
  );
});

test("the operations worker decrypts the shared envelope and terminal records scrub it", async () => {
  const previousKeys = process.env.KNOWHOW_TOKEN_KEYS_JSON;
  const previousKid = process.env.KNOWHOW_TOKEN_ACTIVE_KID;
  process.env.KNOWHOW_TOKEN_KEYS_JSON = JSON.stringify({ test: secret });
  process.env.KNOWHOW_TOKEN_ACTIVE_KID = "test";
  try {
    const credential = "signed.one-time.credential";
    const envelope = await encryptNotificationCredential(
      credential,
      context,
      secret,
    );
    assert.equal(
      await decryptInWorker(envelope, {
        kind: context.kind,
        subject_id: context.subjectId,
        email: context.email,
      }),
      credential,
    );
    assert.deepEqual(
      scrubNotificationCredential({
        credential,
        credentialEnvelope: envelope,
        attempts: 5,
      }),
      { attempts: 5 },
    );
  } finally {
    if (previousKeys === undefined) delete process.env.KNOWHOW_TOKEN_KEYS_JSON;
    else process.env.KNOWHOW_TOKEN_KEYS_JSON = previousKeys;
    if (previousKid === undefined) delete process.env.KNOWHOW_TOKEN_ACTIVE_KID;
    else process.env.KNOWHOW_TOKEN_ACTIVE_KID = previousKid;
  }
});
