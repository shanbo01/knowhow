import { createHmac } from "node:crypto";
import {
  expect,
  test,
  type Browser,
  type Page,
} from "@playwright/test";

const required = process.env.KNOWHOW_REQUIRE_LOCAL_REHEARSAL === "1";
const ownerEmail = process.env.KNOWHOW_LOCAL_REHEARSAL_OWNER_EMAIL;
const ownerPassword = process.env.KNOWHOW_LOCAL_REHEARSAL_OWNER_PASSWORD;
const memberEmail = process.env.KNOWHOW_LOCAL_REHEARSAL_MEMBER_EMAIL;
const memberPassword = process.env.KNOWHOW_LOCAL_REHEARSAL_MEMBER_PASSWORD;
const betaCode = process.env.KNOWHOW_LOCAL_BETA_CODE;
const mailpitOrigin = "http://127.0.0.1:8025";

function requiredValue(value: string | undefined, name: string) {
  expect(value, `${name} is required for the local rehearsal`).toBeTruthy();
  return value!;
}

function base32Bytes(secret: string) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = secret.toUpperCase().replace(/[=\s-]/g, "");
  let bits = "";
  for (const character of normalized) {
    const value = alphabet.indexOf(character);
    if (value < 0) throw new Error("The local TOTP secret is not valid base32.");
    bits += value.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

function currentTotp(input: string) {
  const secret = input.startsWith("otpauth://")
    ? new URL(input).searchParams.get("secret")
    : input;
  if (!secret) throw new Error("The local TOTP URI has no secret.");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", base32Bytes(secret))
    .update(counter)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

async function freshTotp(secret: string, previous?: string) {
  const deadline = Date.now() + 35_000;
  while (Date.now() < deadline) {
    const code = currentTotp(secret);
    const secondsIntoWindow = Math.floor(Date.now() / 1_000) % 30;
    const remaining = 30 - secondsIntoWindow;
    // Docker Desktop can lag the host clock slightly. Avoid sending a code
    // during either edge of the TOTP window so Appwrite sees the same counter.
    if (
      code !== previous &&
      secondsIntoWindow >= 4 &&
      remaining > 4
    ) {
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error("A fresh local TOTP window did not become available.");
}

type MailpitMessage = {
  ID: string;
  Subject: string;
  Created: string;
  To: Array<{ Address: string }>;
};

function htmlDecode(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&#x3D;/gi, "=")
    .replace(/&#x2F;/gi, "/")
    .replace(/&quot;/g, '"');
}

async function waitForMailLink(input: {
  email: string;
  subject: RegExp;
  href: RegExp;
  since: number;
}) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const response = await fetch(`${mailpitOrigin}/api/v1/messages`, {
      cache: "no-store",
    });
    if (!response.ok) throw new Error("Mailpit message listing failed.");
    const body = (await response.json()) as { messages?: MailpitMessage[] };
    const message = (body.messages ?? []).find(
      (candidate) =>
        candidate.To.some(
          (recipient) =>
            recipient.Address.toLowerCase() === input.email.toLowerCase(),
        ) &&
        input.subject.test(candidate.Subject) &&
        Date.parse(candidate.Created) >= input.since - 5_000,
    );
    if (message) {
      const detailResponse = await fetch(
        `${mailpitOrigin}/api/v1/message/${encodeURIComponent(message.ID)}`,
        { cache: "no-store" },
      );
      if (!detailResponse.ok) throw new Error("Mailpit message read failed.");
      const detail = (await detailResponse.json()) as { HTML?: string };
      const links = Array.from(
        (detail.HTML ?? "").matchAll(/href="([^"]+)"/g),
        (match) => htmlDecode(match[1]),
      );
      const link = links.find((candidate) => input.href.test(candidate));
      if (link) return link;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`Timed out waiting for ${input.subject} email to ${input.email}.`);
}

async function verifyEmail(page: Page, email: string, since: number) {
  await expect(
    page.getByRole("heading", { name: /verify your work email/i }),
  ).toBeVisible({ timeout: 30_000 });
  const verificationLink = await waitForMailLink({
    email,
    subject: /Account Verification for KnowHow Local/i,
    href: /\/verify\?userId=/,
    since,
  });
  await page.goto(verificationLink);
  await expect(
    page.getByRole("heading", { name: "Email verified" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("link", { name: "Continue to KnowHow" }).click();
}

async function enrollMfa(page: Page) {
  await expect(
    page.getByRole("heading", { name: "Add an authenticator app" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Begin secure setup" }).click();
  const secretInput = page.getByLabel("Manual setup key");
  await expect(secretInput).toBeVisible({ timeout: 30_000 });
  const secret = await secretInput.inputValue();
  expect(secret.length).toBeGreaterThanOrEqual(16);

  const enrollmentCode = await freshTotp(secret);
  await page.getByLabel("Six-digit code").fill(enrollmentCode);
  await page.getByRole("button", { name: "Verify authenticator" }).click();
  await expect(
    page.getByRole("heading", { name: "Save your recovery codes" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("I saved these codes securely").check();
  await page.getByRole("button", { name: "Continue and verify" }).click();

  await expect(
    page.getByRole("heading", { name: "Enter your authenticator code" }),
  ).toBeVisible({ timeout: 30_000 });
  const challengeCode = await freshTotp(secret, enrollmentCode);
  await page.getByLabel("Authentication code").fill(challengeCode);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  return { secret, lastCode: challengeCode };
}

async function completeReauthentication(
  page: Page,
  secret: string,
  previousCode: string,
) {
  await expect(
    page.getByRole("heading", { name: "Enter your authenticator code" }),
  ).toBeVisible({ timeout: 30_000 });
  const code = await freshTotp(secret, previousCode);
  await page.getByLabel("Authentication code").fill(code);
  await page.getByRole("button", { name: "Verify", exact: true }).click();
  return code;
}

async function finishSelfServiceCreation(
  page: Page,
  secret: string,
  previousCode: string,
) {
  const mfaHeading = page.getByRole("heading", {
    name: "Enter your authenticator code",
  });
  const dashboardHeading = page.getByRole("heading", { name: "Dashboard" });
  const outcome = await Promise.race([
    mfaHeading
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "mfa" as const),
    dashboardHeading
      .waitFor({ state: "visible", timeout: 60_000 })
      .then(() => "dashboard" as const),
  ]);
  return outcome === "mfa"
    ? completeReauthentication(page, secret, previousCode)
    : previousCode;
}

async function signUpWithCredential(input: {
  page: Page;
  url: string;
  name: string;
  email: string;
  password: string;
  accountTab?: string;
}) {
  await input.page.goto(input.url);
  if (input.accountTab) {
    await input.page
      .getByRole("button", { name: input.accountTab, exact: true })
      .click();
  }
  await input.page.getByLabel("Your name").fill(input.name);
  await input.page.getByLabel("Work email").fill(input.email);
  await input.page.getByLabel("Password").fill(input.password);
  await input.page.getByRole("button", { name: "Create account" }).click();
}

async function createAndPublishManualGuide(
  page: Page,
  workspaceSlug: string,
  title: string,
) {
  await page.goto(`/w/${workspaceSlug}/guides/new`);
  await expect(page.getByLabel("Guide title")).toBeVisible({
    timeout: 30_000,
  });
  await page.getByLabel("Guide title").fill(title);
  await page
    .getByLabel("Purpose and expected outcome")
    .fill("Help every teammate complete the local private-beta access check.");
  await page
    .locator(".step-title-input")
    .first()
    .fill("Open the KnowHow workspace and confirm access");
  await page.getByRole("button", { name: "Request review" }).first().click();

  await expect(page.getByRole("heading", { name: "Guides" })).toBeVisible({
    timeout: 30_000,
  });
  let card = page.locator(".guide-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Review approved")).toBeVisible({
    timeout: 20_000,
  });
  card = page.locator(".guide-card").filter({ hasText: title });
  await card.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("New revision published")).toBeVisible({
    timeout: 20_000,
  });
  await expect(card.getByText("Published")).toBeVisible({ timeout: 20_000 });
}

async function openPublishedGuide(
  page: Page,
  workspaceSlug: string,
  title: string,
) {
  await page.goto(`/w/${workspaceSlug}/guides`);
  const card = page.locator(".guide-card").filter({ hasText: title });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.locator(".guide-card-main").click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({
    timeout: 30_000,
  });
}

test.describe("real local private-beta journey", () => {
  test.skip(
    !required,
    "Enabled only for the explicitly seeded disposable Docker rehearsal.",
  );
  test.describe.configure({ mode: "serial" });
  test.setTimeout(300_000);

  test("signup through teammate completion and support uses the live local stack", async ({
    page,
    browser,
    request,
    baseURL,
  }: {
    page: Page;
    browser: Browser;
    request: import("@playwright/test").APIRequestContext;
    baseURL?: string;
  }) => {
    expect(baseURL).toBe("http://localhost:3001");
    const readiness = await request.get("/api/health?ready=1");
    expect(readiness.status()).toBe(200);
    expect((await readiness.json()).status).toBe("ready");

    const owner = requiredValue(
      ownerEmail,
      "KNOWHOW_LOCAL_REHEARSAL_OWNER_EMAIL",
    );
    const ownerPass = requiredValue(
      ownerPassword,
      "KNOWHOW_LOCAL_REHEARSAL_OWNER_PASSWORD",
    );
    const member = requiredValue(
      memberEmail,
      "KNOWHOW_LOCAL_REHEARSAL_MEMBER_EMAIL",
    );
    const memberPass = requiredValue(
      memberPassword,
      "KNOWHOW_LOCAL_REHEARSAL_MEMBER_PASSWORD",
    );
    const admission = requiredValue(betaCode, "KNOWHOW_LOCAL_BETA_CODE");
    const startedAt = Date.now();

    await signUpWithCredential({
      page,
      url: `/register?beta=${encodeURIComponent(admission)}`,
      name: "Local Beta Owner",
      email: owner,
      password: ownerPass,
    });
    await verifyEmail(page, owner, startedAt);
    const mfa = await enrollMfa(page);

    await expect(
      page.getByRole("heading", {
        name: "Tell us about your organization",
      }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByLabel("Organization name").fill("Rehearsal Operations");
    await page.getByLabel("Legal name Optional").fill("Rehearsal Operations LLC");
    await page.getByLabel("Country code Optional").fill("QA");
    await page.getByRole("button", { name: "Save & continue" }).click();

    await expect(
      page.getByRole("heading", { name: "Name your first workspace" }),
    ).toBeVisible();
    await page.getByLabel("Workspace name").fill("Rehearsal Playbooks");
    await page.getByRole("button", { name: "Save & continue" }).click();

    await expect(
      page.getByRole("heading", { name: /Bring one teammate/i }),
    ).toBeVisible();
    await page.getByLabel("Teammate email Optional").fill(member);
    await page.getByRole("button", { name: "Save & continue" }).click();
    await expect(
      page.getByRole("heading", { name: "Ready to create your workspace" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Create organization" }).click();
    mfa.lastCode = await finishSelfServiceCreation(
      page,
      mfa.secret,
      mfa.lastCode,
    );

    await expect(page.getByRole("heading", { name: "Dashboard" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Rehearsal Playbooks").first()).toBeVisible();
    await expect(page.getByText("Getting started")).toBeVisible();
    await page.getByLabel("Ordinary business-process data only").check();
    await page.getByLabel("Workspace policies reviewed").check();
    await page.getByRole("button", { name: "Confirm readiness" }).click();
    await expect(page.getByText("Workspace readiness confirmed")).toBeVisible({
      timeout: 20_000,
    });
    const workspaceMatch = page.url().match(/\/w\/([^/?#]+)/);
    expect(workspaceMatch).toBeTruthy();
    const workspaceSlug = decodeURIComponent(workspaceMatch![1]);

    const guideTitle = `Local access check ${Date.now()}`;
    await createAndPublishManualGuide(page, workspaceSlug, guideTitle);

    const invitationLink = await waitForMailLink({
      email: member,
      subject: /Invitation to your KnowHow workspace/i,
      href: /\/app\?invite=/,
      since: startedAt,
    });
    const memberContext = await browser.newContext({ baseURL });
    try {
      const memberPage = await memberContext.newPage();
      const memberSignupAt = Date.now();
      await signUpWithCredential({
        page: memberPage,
        url: invitationLink,
        name: "Local Beta Teammate",
        email: member,
        password: memberPass,
        accountTab: "Create invited account",
      });
      await verifyEmail(memberPage, member, memberSignupAt);
      await expect(
        memberPage.getByRole("heading", { name: "Dashboard" }),
      ).toBeVisible({ timeout: 60_000 });

      await openPublishedGuide(memberPage, workspaceSlug, guideTitle);
      await memberPage.getByRole("button", { name: "Mark complete" }).click();
      await expect(memberPage.getByText("Guide marked complete")).toBeVisible({
        timeout: 20_000,
      });

      await memberPage.goto(`/w/${workspaceSlug}/support`);
      await expect(
        memberPage.getByRole("heading", { name: "Support" }),
      ).toBeVisible({ timeout: 30_000 });
      await memberPage.getByLabel("Subject").fill("Local rehearsal question");
      await memberPage
        .getByLabel("Message")
        .fill("Please confirm this private support thread is working locally.");
      await memberPage.getByRole("button", { name: "Send securely" }).click();
      await expect(
        memberPage.getByRole("heading", {
          name: "Local rehearsal question",
        }),
      ).toBeVisible({ timeout: 30_000 });
      await memberPage
        .getByLabel("Reply")
        .fill("Adding a second content-minimized message for the rehearsal.");
      await memberPage.getByRole("button", { name: "Reply" }).click();
      await expect(
        memberPage.getByText(
          "Adding a second content-minimized message for the rehearsal.",
        ),
      ).toBeVisible({ timeout: 20_000 });
      await memberPage.getByRole("button", { name: "Close ticket" }).click();
      await expect(memberPage.getByText("Support ticket closed")).toBeVisible({
        timeout: 20_000,
      });
    } finally {
      await memberContext.close();
    }

    await page.goto(`/w/${workspaceSlug}`);
    const teammateMilestone = page
      .locator(".onboarding-checklist li")
      .filter({ hasText: "Have a teammate complete it" });
    await expect(teammateMilestone).toHaveClass(/complete/, {
      timeout: 30_000,
    });
  });
});
