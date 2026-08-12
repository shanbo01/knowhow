import { createHash, createHmac } from "node:crypto";
import { Account, AppwriteException, Client } from "node-appwrite";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

const required = process.env.KNOWHOW_REQUIRE_CONTROLLED_REHEARSAL === "1";
const ownerEmail = process.env.KNOWHOW_E2E_OWNER_EMAIL;
const ownerPassword = process.env.KNOWHOW_E2E_OWNER_PASSWORD;
const ownerTotpSecret = process.env.KNOWHOW_E2E_OWNER_TOTP_SECRET;
const memberEmail = process.env.KNOWHOW_E2E_MEMBER_EMAIL;
const memberPassword = process.env.KNOWHOW_E2E_MEMBER_PASSWORD;
const memberTotpSecret = process.env.KNOWHOW_E2E_MEMBER_TOTP_SECRET;
const workspaceSlug = process.env.KNOWHOW_E2E_WORKSPACE_SLUG;
const publishedGuideId = process.env.KNOWHOW_E2E_PUBLISHED_GUIDE_ID;
const expectedEnvironment = process.env.KNOWHOW_E2E_EXPECTED_ENVIRONMENT;
const expectedProjectId = process.env.KNOWHOW_E2E_EXPECTED_PROJECT_ID;
const expectedRelease = process.env.KNOWHOW_E2E_EXPECTED_RELEASE;
const appwriteEndpoint = process.env.APPWRITE_ENDPOINT;

function requiredValue(value: string | undefined, name: string) {
  expect(value, `${name} must be set for the controlled rehearsal`).toBeTruthy();
  return value!;
}

function base32Bytes(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = "";
  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("The controlled-rehearsal TOTP secret is not valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

async function totpCode(input: string) {
  const secret = input.startsWith("otpauth://")
    ? new URL(input).searchParams.get("secret")
    : input;
  if (!secret) throw new Error("The controlled-rehearsal TOTP URI has no secret.");
  const remainder = 30 - (Math.floor(Date.now() / 1_000) % 30);
  if (remainder <= 2) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_500));
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32Bytes(secret)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function assertControlledDeployment(request: APIRequestContext) {
  const environment = requiredValue(
    expectedEnvironment,
    "KNOWHOW_E2E_EXPECTED_ENVIRONMENT",
  );
  expect(["staging", "production"]).toContain(environment);
  const projectId = requiredValue(
    expectedProjectId,
    "KNOWHOW_E2E_EXPECTED_PROJECT_ID",
  );
  expect(projectId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,35}$/);
  expect(
    requiredValue(appwriteEndpoint, "APPWRITE_ENDPOINT"),
  ).toBe("https://fra.cloud.appwrite.io/v1");
  const release = requiredValue(
    expectedRelease,
    "KNOWHOW_E2E_EXPECTED_RELEASE",
  );
  expect(release).toMatch(/^[a-f0-9]{40}$/);
  const response = await request.get("/api/health?ready=1");
  expect(response.status(), "controlled readiness status").toBe(200);
  expect(response.headers()["x-request-id"], "controlled readiness request ID").toBeTruthy();
  const body = (await response.json()) as {
    status?: string;
    deployment?: {
      environment?: string;
      release?: string;
      projectFingerprint?: string;
    };
  };
  expect(body.status).toBe("ready");
  expect(body.deployment).toEqual({
    environment,
    release,
    projectFingerprint: createHash("sha256")
      .update(`project\0${projectId}`)
      .digest("hex"),
  });
}

async function signIn(
  page: Page,
  email: string,
  password: string,
  totpSecret: string | undefined,
) {
  await page.goto("/app");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.locator("form").getByRole("button", { name: /^sign in$/i }).click();

  const dashboard = page.getByRole("heading", { name: "Dashboard" });
  const mfa = page.getByRole("heading", { name: "Enter your authenticator code" });
  const enrollment = page.getByRole("heading", { name: "Add an authenticator app" });
  const verification = page.getByRole("heading", { name: /verify your work email/i });
  await expect(dashboard.or(mfa).or(enrollment).or(verification).first()).toBeVisible({
    timeout: 30_000,
  });

  if (await verification.isVisible()) {
    throw new Error(`Controlled-rehearsal account ${email} is not email verified.`);
  }
  if (await enrollment.isVisible()) {
    throw new Error(
      `Controlled-rehearsal account ${email} must finish and record MFA enrollment before the release gate.`,
    );
  }
  if (!(await mfa.isVisible())) {
    throw new Error(
      `Controlled-rehearsal account ${email} did not require a fresh MFA challenge.`,
    );
  }
  const secret = requiredValue(
    totpSecret,
    email === ownerEmail
      ? "KNOWHOW_E2E_OWNER_TOTP_SECRET"
      : "KNOWHOW_E2E_MEMBER_TOTP_SECRET",
  );
  await page.getByLabel("Authentication code").fill(await totpCode(secret));
  await page.getByRole("button", { name: "Verify", exact: true }).click();

  await expect(dashboard).toBeVisible({ timeout: 30_000 });
}

async function revokeControlledSession(page: Page) {
  const projectId = expectedProjectId;
  if (!projectId) return;
  const cookies = await page.context().cookies();
  const encodedSession = cookies.find(
    (cookie) => cookie.name === `a_session_${projectId}`,
  )?.value;
  if (!encodedSession) return;
  const csrf = cookies.find((cookie) => cookie.name === "knowhow_csrf")?.value;
  expect(csrf, "controlled browser session CSRF cookie").toBeTruthy();
  const origin = new URL(page.url()).origin;
  const response = await page.request.post("/api/auth/sign-out", {
    headers: {
      origin,
      "x-csrf-token": csrf!,
    },
    data: {},
  });
  expect(response.status(), "controlled browser sign-out status").toBe(200);
  expect((await page.request.get("/api/auth/session")).status()).toBe(401);

  const account = new Account(
    new Client()
      .setEndpoint(requiredValue(appwriteEndpoint, "APPWRITE_ENDPOINT"))
      .setProject(projectId)
      .setSession(decodeURIComponent(encodedSession)),
  );
  let revoked = false;
  try {
    await account.get();
  } catch (error) {
    if (error instanceof AppwriteException && Number(error.code) === 401) {
      revoked = true;
    } else {
      throw error;
    }
  }
  expect(revoked, "controlled Appwrite server session revocation").toBe(true);
}

test.describe("controlled environment rehearsal", () => {
  test.skip(
    !required,
    "Enabled only for the credentialed Staging/Production release gate.",
  );

  test.beforeEach(async ({ request }) => {
    await assertControlledDeployment(request);
  });

  test.afterEach(async ({ page }) => {
    await revokeControlledSession(page);
  });

  test("owner enters through real identity and opens every critical control plane", async ({
    page,
  }) => {
    const slug = requiredValue(workspaceSlug, "KNOWHOW_E2E_WORKSPACE_SLUG");
    await signIn(
      page,
      requiredValue(ownerEmail, "KNOWHOW_E2E_OWNER_EMAIL"),
      requiredValue(ownerPassword, "KNOWHOW_E2E_OWNER_PASSWORD"),
      ownerTotpSecret,
    );

    for (const [path, heading] of [
      [`/w/${slug}`, "Dashboard"],
      [`/w/${slug}/capture`, "Capture a workflow"],
      [`/w/${slug}/guides`, "Guides"],
      [`/w/${slug}/members`, "Members & invitations"],
      [`/w/${slug}/support`, "Support"],
      [`/w/${slug}/settings`, "Settings & policies"],
      ["/platform", "Platform administration"],
    ] as const) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible({
        timeout: 20_000,
      });
      await expect(page.locator("body")).not.toContainText("Application error");
    }

    await expect(page.getByText("Self-service limit: 0")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Deletion approvals" })).toBeVisible();
  });

  test("second synthetic user views and completes a real published guide", async ({
    page,
  }) => {
    const slug = requiredValue(workspaceSlug, "KNOWHOW_E2E_WORKSPACE_SLUG");
    const guideId = requiredValue(
      publishedGuideId,
      "KNOWHOW_E2E_PUBLISHED_GUIDE_ID",
    );
    await signIn(
      page,
      requiredValue(memberEmail, "KNOWHOW_E2E_MEMBER_EMAIL"),
      requiredValue(memberPassword, "KNOWHOW_E2E_MEMBER_PASSWORD"),
      memberTotpSecret,
    );

    await page.goto(`/w/${slug}/guides/${encodeURIComponent(guideId)}?revision=published`);
    await expect(page.locator("main.guide-reader-page")).toBeVisible({ timeout: 20_000 });
    const completionResponse = page.waitForResponse((response) => {
      if (
        response.url() !== `${new URL(page.url()).origin}/api/knowhow` ||
        response.request().method() !== "POST"
      ) {
        return false;
      }
      try {
        return (
          (response.request().postDataJSON() as { action?: string }).action ===
          "recordGuideCompletion"
        );
      } catch {
        return false;
      }
    });
    await page.getByRole("button", { name: "Mark complete" }).click();
    expect((await completionResponse).ok()).toBe(true);
    await expect(page.getByText("Guide marked complete")).toBeVisible();

    await page.goto(`/w/${slug}/support`);
    await expect(page.getByRole("heading", { name: "Support" })).toBeVisible();
  });
});
