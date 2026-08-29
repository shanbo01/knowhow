// Pure-logic regression tests for the parts of capture that decide whether an
// author's click is recorded at all. Everything under test here is free of
// `chrome.*` APIs, so it runs under plain Node.
import assert from "node:assert/strict";
import test from "node:test";

import {
  createScreenshotQueue,
  ScreenshotPriority,
} from "../src/background/screenshot-queue.js";
import {
  CaptureEntryStatus,
  captureEntry,
  captureEntryIsRetakeable,
  clickEntryNeedsSettledFrame,
  markCaptureEntryReady,
  initializeCaptureCoordinator,
  reserveCaptureEntry,
  resetCaptureEntryForRetry,
  unconfirmedClickEntryAt,
  unresolvedCaptureEntries,
  updateCaptureEntry,
} from "../src/core/capture-coordinator.js";
import { capturedStepHasValidImageShape } from "../src/core/capture-store.js";
import { applyWorkspaceContext, mergePolicy } from "../src/core/policy.js";
import { newestSameTabPreparedFrame } from "../src/core/prepared-frame.js";
import { captureFeedSteps, stepCopy } from "../src/popup/step-feed.js";
import "../src/content/typed-fields.js";

const { classifyField, typedStepCopy, classifyShortcut } =
  globalThis.__KNOWHOW_TYPED_FIELDS__;

function field(overrides = {}) {
  return { tag: "INPUT", inputType: "text", ...overrides };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolveTask) => {
    resolve = resolveTask;
  });
  return { promise, resolve };
}

test("capture storage accepts only explicit screenshot-free steps", () => {
  for (const step of [
    { sourceEvent: "navigation" },
    { sourceEvent: "type", textOnly: true },
    { sourceEvent: "click", screenshotMissing: true },
    { sourceEvent: "click", imageBlob: new Blob(["redacted"]) },
  ]) {
    assert.equal(
      capturedStepHasValidImageShape(step),
      true,
      "an intentional screenshot-free shape must pass validation",
    );
  }

  assert.equal(
    capturedStepHasValidImageShape({ sourceEvent: "click" }),
    false,
    "an ordinary illustrated step must still require a locally redacted raster",
  );
});

test("a click takes the next screenshot slot ahead of speculative pre-warming", async () => {
  const started = [];
  const queue = createScreenshotQueue({ minimumIntervalMs: 0 });
  const blocker = deferred();

  // Occupy the queue so the next two tasks are both waiting when the click lands.
  const held = queue(
    async (reserveSlot) => {
      started.push("held");
      await reserveSlot();
      await blocker.promise;
      return "held";
    },
    { priority: ScreenshotPriority.PREPARED },
  );
  const prepared = queue(
    async (reserveSlot) => {
      started.push("prepared");
      await reserveSlot();
      return "prepared";
    },
    { priority: ScreenshotPriority.PREPARED },
  );
  const navigation = queue(
    async (reserveSlot) => {
      started.push("navigation");
      await reserveSlot();
      return "navigation";
    },
    { priority: ScreenshotPriority.NAVIGATION },
  );
  const interaction = queue(
    async (reserveSlot) => {
      started.push("interaction");
      await reserveSlot();
      return "interaction";
    },
    { priority: ScreenshotPriority.INTERACTION },
  );

  blocker.resolve();
  await Promise.all([held, prepared, navigation, interaction]);
  assert.deepEqual(started, ["held", "interaction", "navigation", "prepared"]);
});

test("superseded pre-warming is abandoned instead of photographing a stale page", async () => {
  const started = [];
  const queue = createScreenshotQueue({ minimumIntervalMs: 0 });
  const blocker = deferred();

  const held = queue(async (reserveSlot) => {
    await reserveSlot();
    await blocker.promise;
    return "held";
  });
  const stale = queue(
    async () => {
      started.push("stale");
      return "stale";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:7" },
  );
  const fresh = queue(
    async () => {
      started.push("fresh");
      return "fresh";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:7" },
  );
  // A pre-warm for a different tab is untouched by the newer one.
  const other = queue(
    async () => {
      started.push("other");
      return "other";
    },
    { priority: ScreenshotPriority.PREPARED, supersedes: "prepared:9" },
  );

  blocker.resolve();
  await held;
  assert.equal(await stale, null, "the superseded pre-warm must not capture");
  assert.equal(await fresh, "fresh");
  assert.equal(await other, "other");
  assert.deepEqual(started, ["fresh", "other"]);
});

test("work that would miss its deadline gives up rather than storing a stale frame", async () => {
  const queue = createScreenshotQueue({ minimumIntervalMs: 500 });
  const first = await queue(async (reserveSlot) => reserveSlot());
  assert.equal(first, true);
  const second = await queue(async (reserveSlot) => reserveSlot(), {
    deadlineMs: 50,
  });
  assert.equal(second, false, "a frame that arrives too late is not worth taking");
});

test("a click that navigates before its commit lands is still recoverable", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    {
      id: "interaction-1",
      stepId: "step-1",
      kind: "click",
      sourceEvent: "click",
      tabId: 42,
    },
    now,
  );

  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 42, now: now + 200 })?.id,
    "interaction-1",
  );
  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 43, now: now + 200 }),
    null,
    "another tab's navigation must not adopt this click",
  );
  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 42, now: now + 30_000 }),
    null,
    "a long-abandoned pointer press is not a click",
  );

  const committed = updateCaptureEntry(state, "interaction-1", {
    committed: true,
  });
  assert.equal(
    unconfirmedClickEntryAt(committed, { tabId: 42, now: now + 200 }),
    null,
    "a click that already committed must not be adopted twice",
  );

  const ready = updateCaptureEntry(state, "interaction-1", {
    status: CaptureEntryStatus.READY,
  });
  assert.equal(
    unconfirmedClickEntryAt(ready, { tabId: 42, now: now + 200 }),
    null,
  );
});

test("pressing Enter in a field is followed to its destination like a click", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    {
      id: "interaction-1",
      stepId: "step-1",
      kind: "type",
      sourceEvent: "type",
      tabId: 42,
    },
    now,
  );

  assert.equal(
    unconfirmedClickEntryAt(state, { tabId: 42, now: now + 200 })?.id,
    "interaction-1",
    "a typed step whose submit destroyed the page must still be adoptable",
  );
  assert.equal(
    clickEntryNeedsSettledFrame(state, { tabId: 42 }),
    true,
    "the page the typing navigated to is worth a settled screenshot",
  );
});

test("typed-text capture is on by default and only a workspace can switch it off", () => {
  assert.equal(mergePolicy({}).captureTypedText, true);
  assert.equal(
    mergePolicy({ captureTypedText: false }).captureTypedText,
    false,
    "an author's own choice survives a policy merge",
  );

  const workspace = { workspaceId: "w", policyVersion: "v1" };
  assert.equal(
    applyWorkspaceContext({}, workspace).captureTypedText,
    true,
    "a workspace that says nothing leaves the default alone",
  );
  assert.equal(
    applyWorkspaceContext({}, { ...workspace, captureTypedText: false })
      .captureTypedText,
    false,
    "a workspace can switch typed-text capture off for everyone",
  );
  assert.equal(
    applyWorkspaceContext(
      { captureTypedText: false },
      { ...workspace, captureTypedText: true },
    ).captureTypedText,
    false,
    "a workspace cannot switch it back on for an author who turned it off",
  );
});

test("Free browser capture keeps Auto Blur and every detector off", () => {
  const selected = {
    schemaVersion: 5,
    smartBlurEnabled: true,
    redactEmails: true,
    redactAllNumbers: true,
    redactImages: true,
    redactTableRows: true,
    redactLongText: true,
  };
  const free = applyWorkspaceContext(selected, {
    workspaceId: "free-workspace",
    policyVersion: "v1",
    privacyToolsEnabled: false,
  });
  assert.equal(free.privacyToolsEnabled, false);
  assert.equal(free.smartBlurEnabled, false);
  assert.equal(free.redactEmails, false);
  assert.equal(free.redactAllNumbers, false);
  assert.equal(free.redactImages, false);
  assert.equal(free.redactTableRows, false);
  assert.equal(free.redactLongText, false);

  const pro = applyWorkspaceContext(selected, {
    workspaceId: "pro-workspace",
    policyVersion: "v1",
    privacyToolsEnabled: true,
  });
  assert.equal(pro.privacyToolsEnabled, true);
  assert.equal(pro.smartBlurEnabled, true);
  assert.equal(pro.redactEmails, true);
  assert.equal(pro.redactAllNumbers, true);
});

test("a reused pre-click frame can be pinned to the scroll position of the click", () => {
  const now = 100_000;
  const frames = [
    {
      id: "scrolled-away",
      sessionId: "session",
      tabId: 7,
      documentId: "doc-1",
      navigationKey: "document:7:doc-1:0:https://mail.example/inbox",
      viewportKey: "1280:800:0:900:1.00",
      visualEpoch: 4,
      capturedAtMs: now - 3_000,
    },
    {
      id: "same-view",
      sessionId: "session",
      tabId: 7,
      documentId: "doc-1",
      navigationKey: "document:7:doc-1:0:https://mail.example/inbox",
      viewportKey: "1280:800:0:0:1.00",
      visualEpoch: 6,
      capturedAtMs: now - 5_000,
    },
  ];
  // The click was staged on a page that has since navigated: the destination
  // has a different navigation key and document, and the frame that matters is
  // the older one taken at the same scroll offset.
  const candidate = {
    sessionId: "session",
    tabId: 7,
    documentId: "doc-2",
    navigationKey: "history:7:doc-2:1:https://mail.example/message",
    viewportKey: "1280:800:0:0:1.00",
    visualEpoch: 9,
  };

  assert.equal(
    newestSameTabPreparedFrame(frames, candidate, {
      now,
      ignoreViewportKey: false,
    })?.id,
    "same-view",
    "pinning the viewport must reject a frame taken further down the page",
  );
  assert.equal(
    newestSameTabPreparedFrame(frames, candidate, { now })?.id,
    "scrolled-away",
    "without a pinned viewport the newest frame from this tab still wins",
  );
  assert.equal(
    newestSameTabPreparedFrame(frames, { ...candidate, tabId: 8 }, { now }),
    null,
    "another tab's frames are never reusable",
  );
});

test("a credential field is never read, however the page spells it", () => {
  assert.equal(classifyField(field({ inputType: "password" })), "password");
  assert.equal(
    classifyField(field({ autocomplete: "new-password" })),
    "password",
  );
  assert.equal(
    classifyField(field({ autocomplete: "current-password" })),
    "password",
  );
  assert.equal(classifyField(field({ autocomplete: "username" })), "username");
  assert.equal(
    classifyField(field({ autocomplete: "one-time-code" })),
    "protected",
  );
  assert.equal(classifyField(field({ autocomplete: "cc-number" })), "protected");
  assert.equal(classifyField(field({ redactAttribute: true })), "protected");
  assert.equal(
    classifyField(field({ hint: "Card number" })),
    "protected",
    "a field the page only names in its label is still a card number",
  );
  assert.equal(classifyField(field({ hint: "CVV" })), "protected");
  assert.equal(classifyField(field({ hint: "user_name" })), "username");
});

test("a form that asks for a password does not silence every other field", () => {
  // The sign-in box: one text field beside the password is the account.
  assert.equal(
    classifyField(field({ inCredentialForm: true, formTextFieldCount: 1 })),
    "username",
  );

  // The sign-up page: six fields beside the password. Only the one that names
  // the account is withheld; the rest are the typing the guide exists for.
  const signUp = { inCredentialForm: true, formTextFieldCount: 6 };
  assert.equal(
    classifyField(field({ ...signUp, hint: "Full name" })),
    "text",
    "a name field on a sign-up form must still be recorded",
  );
  assert.equal(classifyField(field({ ...signUp, hint: "Company" })), "text");
  assert.equal(
    classifyField(field({ ...signUp, inputType: "tel", hint: "Phone" })),
    "text",
  );
  assert.equal(
    classifyField(field({ ...signUp, inputType: "email", hint: "Email" })),
    "username",
  );
  assert.equal(
    classifyField(field({ ...signUp, hint: "Work e-mail" })),
    "username",
  );
});

test("ordinary fields are recorded, and non-text controls are not fields at all", () => {
  assert.equal(classifyField(field()), "text");
  assert.equal(classifyField(field({ inputType: "search" })), "text");
  assert.equal(classifyField(field({ tag: "TEXTAREA" })), "text");
  assert.equal(
    classifyField({ tag: "DIV", contentEditable: true }),
    "text",
    "a rich-text editor is a field",
  );
  assert.equal(
    classifyField(field({ hint: "Secretary" })),
    "text",
    '"secretary" is not "secret"',
  );
  assert.equal(classifyField(field({ inputType: "checkbox" })), null);
  assert.equal(classifyField(field({ inputType: "file" })), null);
  assert.equal(classifyField(field({ inputType: "submit" })), null);
  assert.equal(classifyField({ tag: "DIV" }), null);
});

test("step copy quotes the typed value and never invents one it does not have", () => {
  assert.equal(
    typedStepCopy("text", "acme-invoices", '"Search"').title,
    'Type "acme-invoices" into "Search"',
  );
  assert.equal(
    typedStepCopy("text", "", '"Search"').title,
    "Type into \"Search\"",
    "a cleared field still reads as an instruction",
  );
  assert.equal(
    typedStepCopy("password", "", '"Password"').title,
    "Enter your password",
  );
  assert.equal(
    typedStepCopy("username", "", '"Email"').title,
    "Enter your username",
  );
  assert.equal(
    typedStepCopy("protected", "", '"One-time code"').title,
    'Type into "One-time code"',
  );
});

test("a step kept without a screenshot is finished, and retakeable", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    {
      id: "interaction-1",
      stepId: "step-1",
      kind: "click",
      sourceEvent: "click",
      tabId: 42,
    },
    now,
  );
  // What the worker does when no screenshot could be taken: the step is ready,
  // it counts, and it carries the flag that offers a retake.
  state = updateCaptureEntry(
    markCaptureEntryReady(state, "interaction-1", now),
    "interaction-1",
    { screenshotMissing: true, context: { title: 'Click "Search"' } },
    now,
  );

  assert.equal(
    state.stepIds.includes("step-1"),
    true,
    "the action the author performed has to reach the guide",
  );
  assert.equal(state.stepCount, 1);
  assert.equal(
    unresolvedCaptureEntries(state).length,
    0,
    "nothing is left blocking the end of the capture",
  );
  assert.equal(captureEntryIsRetakeable(captureEntry(state, "interaction-1")), true);

  const retaking = resetCaptureEntryForRetry(
    state,
    "interaction-1",
    { screenshotMissing: false },
    now + 1_000,
  );
  assert.equal(
    captureEntry(retaking, "interaction-1").status,
    CaptureEntryStatus.CAPTURING,
    "a retake puts the step back in line for a screenshot",
  );
  assert.equal(
    captureEntry(retaking, "interaction-1").context.title,
    'Click "Search"',
    "the retake rebuilds the same step, so its wording has to survive",
  );
});

test("a step that already has its screenshot is never offered a retake", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    { id: "interaction-1", stepId: "step-1", sourceEvent: "click", tabId: 42 },
    now,
  );
  state = markCaptureEntryReady(state, "interaction-1", now);

  assert.equal(
    captureEntryIsRetakeable(captureEntry(state, "interaction-1")),
    false,
  );
  assert.equal(
    resetCaptureEntryForRetry(state, "interaction-1", {}, now),
    state,
    "a complete step is left exactly as it is",
  );
});

test("a keyboard shortcut is recorded; ordinary typing never is", () => {
  const press = (over = {}) => classifyShortcut({ key: "c", ...over });

  assert.equal(press({ ctrlKey: true })?.label, "Ctrl + C");
  assert.deepEqual(press({ ctrlKey: true })?.keys, ["Ctrl", "C"]);
  assert.equal(
    press({ metaKey: true, isMac: true })?.label,
    "Cmd + C",
    "the same chord is named the way the author's keyboard names it",
  );
  assert.equal(
    classifyShortcut({ key: "k", ctrlKey: true, shiftKey: true })?.label,
    "Ctrl + Shift + K",
  );
  assert.equal(classifyShortcut({ key: "F5" })?.label, "F5");
  assert.equal(
    classifyShortcut({ key: "Escape" })?.label,
    "Esc",
    "an action key is a step of its own outside a field",
  );

  // Nothing below is a shortcut, and none of it may be recorded.
  assert.equal(press(), null, "a bare letter is somebody typing");
  assert.equal(
    classifyShortcut({ key: "A", shiftKey: true }),
    null,
    "shift and a letter is still typing",
  );
  assert.equal(
    press({ ctrlKey: true, fieldKind: "password" }),
    null,
    "a password field is never watched, chord or not",
  );
  assert.equal(
    press({ ctrlKey: true, repeat: true }),
    null,
    "a held key repeats; the step happened once",
  );
  assert.equal(classifyShortcut({ key: "Control", ctrlKey: true }), null);
  assert.equal(
    classifyShortcut({ key: "Enter", inEditableField: true }),
    null,
    "Enter inside a field is how you leave it, not a step",
  );
  assert.equal(classifyShortcut({ key: "Enter" })?.label, "Enter");
});

test("a step card never repeats its own title as its description", () => {
  assert.equal(
    stepCopy({
      title: 'Click "Support"',
      instructions: 'Click "Support".',
      sourceEvent: "click",
    }).detail,
    "",
    "the instruction is the title with a full stop, so there is nothing to add",
  );
  assert.equal(
    stepCopy({
      title: "Open the billing page",
      instructions: "Scroll to the invoices table first.",
      sourceEvent: "click",
    }).detail,
    "Scroll to the invoices table first.",
    "an instruction that says something new is kept",
  );
  assert.equal(
    stepCopy({
      title: "Open Settings",
      instructions: "Open Settings",
      sourceEvent: "navigation",
    }).detail,
    "",
    "navigation steps dedupe the same way",
  );
});

test("a typed value is a note: no screenshot, and nothing to retake", () => {
  const now = 10_000;
  let state = initializeCaptureCoordinator(
    { sessionId: "session", captureEntries: [] },
    now,
  );
  state = reserveCaptureEntry(
    state,
    {
      id: "interaction-1",
      stepId: "step-1",
      kind: "type",
      sourceEvent: "type",
      tabId: 42,
      textOnly: true,
      capturePending: false,
    },
    now,
  );
  state = updateCaptureEntry(
    markCaptureEntryReady(state, "interaction-1", now),
    "interaction-1",
    { textOnly: true },
    now,
  );

  const entry = captureEntry(state, "interaction-1");
  assert.equal(state.stepIds.includes("step-1"), true, "the note is a step");
  assert.equal(
    captureEntryIsRetakeable(entry),
    false,
    "offering to retake a picture it never wanted would only break it",
  );
  assert.equal(
    resetCaptureEntryForRetry(state, "interaction-1", {}, now),
    state,
    "and a retake request leaves it exactly as written",
  );
});

test("a note never sits under \"Saving screenshot…\"", () => {
  const noteEntry = {
    id: "interaction-1",
    stepId: "step-1",
    order: 0,
    kind: "type",
    sourceEvent: "type",
    status: "ready",
    textOnly: true,
    context: {
      title: 'Type "test" into "Name"',
      instructions: 'Type "test" into "Name".',
    },
  };

  // The stored copy has not been read back yet — the exact moment the feed
  // used to fall through to the spinner and stay there.
  const [pending] = captureFeedSteps(
    { sessionId: "session", captureEntries: [noteEntry] },
    [],
  );
  assert.equal(pending.captureStatus, "ready");
  assert.equal(pending.textOnly, true);
  assert.equal(stepCopy(pending).title, 'Type "test" into "Name"');

  // And a note that is somehow still mid-flight reads as itself, not as a
  // screenshot that is being saved.
  const [inFlight] = captureFeedSteps(
    {
      sessionId: "session",
      captureEntries: [{ ...noteEntry, status: "capturing" }],
    },
    [],
  );
  assert.notEqual(stepCopy(inFlight).title, "Saving screenshot…");
  assert.equal(stepCopy(inFlight).title, 'Type "test" into "Name"');

  // A real click still shows its progress while its screenshot is saving.
  const [click] = captureFeedSteps(
    {
      sessionId: "session",
      captureEntries: [
        {
          id: "interaction-2",
          stepId: "step-2",
          order: 1,
          sourceEvent: "click",
          status: "capturing",
          context: { title: 'Click "Name"' },
        },
      ],
    },
    [],
  );
  assert.equal(stepCopy(click).title, "Saving screenshot…");
});
