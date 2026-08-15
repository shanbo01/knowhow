# KnowHow Capture Extension

KnowHow Capture is a dependency-free Chromium Manifest V3 extension for
capturing the visible foreground tab as an editable, privacy-reviewed guide.
It can run as an unpacked Chrome or Edge extension.

## Build and test

Node.js 22 or newer is sufficient; there are no package dependencies.

    cd extension
    npm test
    npm run build

The build validates the privacy-sensitive manifest, writes an unpacked
extension to `extension/dist`, and creates a deterministic development archive
under ignored `outputs/extension`. No extension package is publicly served by
the application.

## Load in Chrome

1. Run npm run build.
2. Open chrome://extensions.
3. Enable Developer mode.
4. Choose Load unpacked.
5. Select the extension/dist directory.
6. Pin KnowHow Capture to the toolbar.

For Edge, use edge://extensions and the same extension/dist directory.

## Connecting

There is nothing to pair. Open KnowHow while signed in with the extension
installed and the app hands this browser a scoped device credential by itself,
then keeps the side panel's guide library and theme in sync on every visit. The
extension dialog only reports the connection and offers a retry; the Revoke
browser access action ends every credential your account holds in the
workspace, and the next KnowHow visit connects the browser again.

If a credential is revoked or expires, the extension drops it as soon as the
server rejects it, so no one is left with a browser that silently fails to
upload.

## Capture workflow

1. Open the page to document and select the KnowHow toolbar action.
2. Search the Guides tab to open an authorized guide in the side panel and
   follow it beside the current page. The library and the walkthrough scroll as
   one page, each step shows its screenshot framed to the author's crop with
   click markers and blur regions intact, and Next keeps the current step in
   view. Or stay in Capture to record a new guide.
3. Enter a guide title and choose Start capturing. The first capture
   asks you to allow KnowHow to access websites; this runtime permission is what
   lets Chrome capture the foreground tab from its persistent side panel.
4. Smart Blur appears only after recording starts, and both the feature and every
   detector category are off until you switch them on. Categories the workspace
   suggests are labelled Suggested in the panel and stay off. When a category is
   on, feathered frosted regions appear live over the detected text only — rectangles from
   one line merge into a single calm panel, and separate lines stay separate so a
   cover never spreads across blank page — and the pill reports how many areas
   are covered before the screenshot is taken. Choose other elements opens a
   multi-select picker with Undo, Clear all, and Done. Live covers reveal on hover;
   stored screenshots never do.
5. Keep KnowHow docked in Chrome's native side panel while the captured page
   remains usable beside it. Numbered step previews appear in the panel as you
   click, double-click, switch tabs, and navigate, each zoomed to the control you
   used. Use the trash action on a preview to remove a mistaken step immediately.
6. Use Pause and Resume from the native side panel.
7. Choose Finish & review to open the full post-capture editor.
8. Reorder or remove steps, edit the generated copy, zoom or pan the contextual
   crop, add or remove manual blur regions, draw freehand, and move or remove
   the click target. Undo and redo operate on these editable layers.
9. Confirm the privacy review and submit a private KnowHow draft. The selected
   crop and editable layers are flattened once into the upload raster.

## How a step is photographed

KnowHow continuously prepares a small rolling set of locally privacy-rasterized
frames for the active document. Pointer-down reserves an exactly-once interaction
and claims the newest frame whose document, route, viewport, scroll position,
visual epoch, and age still match. The image therefore shows the interface before
the action: a dropdown trigger is photographed closed, while choosing an option
is photographed with the menu already open. The click itself is never delayed,
cancelled, or replayed.

A drag, cancelled press, or mismatched release cancels its reserved interaction.
If no eligible pre-action frame exists, KnowHow attempts an immediate capture and
rejects it when the page mutates during that attempt. The side panel marks the
entry as needing attention with Retry and Delete instead of saving a misleading
post-action image. Rapid clicks remain independent; two clicks on the same control
upgrade idempotently into one double-click step.

Capture follows the regular, policy-allowed page you are working in, wherever it
goes. Opening a link in a new tab, opening a tab yourself and typing a URL into
it, switching to another capturable tab, moving to another browser window, and
    navigating to another site in the same tab all continue the same session. A
  click-triggered navigation produces an ordered click step followed by a destination
  step, and both have screenshots. Background-created tabs are never focused by
  KnowHow; they join the capture only when the author activates them. Excluded sites,
  browser-internal pages,
and incognito windows still stop capture rather than following it.

## Privacy properties

- Incognito operation is disabled in the manifest and checked again at runtime.
- No static all-site content script is used. All-site host access is optional
  and requested only when the user starts capture; it is required by Chrome's
  visible-tab screenshot API for reliable capture from a persistent side panel.
- KnowHow attaches only to the active, policy-allowed foreground tab it is
  recording. When capture follows you to another tab or window, that tab becomes
  the recorded one and the checks run again: excluded
  hosts, browser-internal-page, and incognito checks are enforced at runtime.
- Password fields and embedded frames are always redacted.
- Every other detector is opt-in. Workspace privacy categories are advice the
  panel labels; they never switch a detector on, and captured step text is only
  rewritten for categories the author enabled.
- The extension does not request clipboard, tab-capture, desktop-capture, or
  raw keyboard access.
- It never records keystrokes and never reads form-field values. The only key
  listener is a scoped Escape handler that exits the element picker.
- The offscreen document permanently rasterizes Smart Blur with aggressive local
  downsampling, smoothed upscaling, and feathering before a prepared frame becomes
  eligible. Unredacted data URLs and canvases are destroyed after processing and
  never enter IndexedDB, extension storage, uploads, logs, or thumbnails.
- Automatic and manually chosen blur pixels are irreversible in every captured
  screenshot. Authors may add more blur later, but cannot reveal pixels already
  covered. Crop, drawing, additional blur, and click-target presentation remain
  editable on top of that private raster.
- Pause and Finish stop accepting events first, then drain accepted work for up
  to ten seconds. Finish stays blocked until entries needing attention are retried
  or deleted.
- Discard removes every redacted screenshot for the local capture session.

DOM-assisted Smart Blur cannot reliably detect text rendered into canvas,
WebGL, video, images, native browser UI, or closed shadow roots. Images and
table rows can be masked as complete regions. Mandatory human review remains
the final privacy control.

## KnowHow API

The development build points to `http://localhost:3001` in src/core/config.js
and declares only localhost in manifest host_permissions. The signed-in website
uses `externally_connectable` messaging to perform a short-lived, one-time
credential exchange internally; the user never sees or enters a pairing code:

    POST /api/extension/pair
    POST /api/extension/token/refresh
    GET /api/extension/context
    GET /api/extension/media/:mediaId

Guide screenshots are private objects. The side panel asks the service worker,
which is the only context holding the device credential, and the server repeats
the same per-guide read check the app performs, so a restricted guide stays
invisible in the panel too.

Private draft submission expects:

    POST /api/extension/captures
    PATCH /api/extension/captures/:captureId
    POST /api/extension/captures/:captureId/pause
    POST /api/extension/captures/:captureId/resume
    DELETE /api/extension/captures/:captureId
    PUT /api/extension/captures/:captureId/steps/:stepId/screenshot
    POST /api/extension/captures/:captureId/commit

The server derives the user and workspace from the scoped device token,
rechecks membership, ignores client-supplied permissions, accepts only locally
redacted and rasterized image bytes, and always creates a private draft.

Pilot distribution uses approved unlisted Chrome Web Store and Microsoft Edge
Add-ons listings (or managed-browser policy referencing those listings), never
a public ZIP. The checked-in manifest key pins the Chrome identity to
`phbofjenfnnnnndghhinoldlfbpaedpo`; the final Edge listing ID must be recorded
after store creation. The extension uses bearer device credentials, never
cookies or the user’s Appwrite session.

Build a store artifact from the release SHA with an exact HTTPS application
origin:

    KNOWHOW_EXTENSION_ORIGIN=https://staging.example.com npm run build:store

PowerShell users should set `KNOWHOW_EXTENSION_ORIGIN` for the process before
running `npm run build:store`. The build injects that one origin into the
packaged manifest and runtime configuration without changing development
source, and writes `outputs/extension/knowhow-capture-<version>-store.zip`.
Inspect and hash the artifact before uploading. See
`../docs/operations/extension-distribution.md` for release, managed-install, and
rollback policy.

## Current limits

- Visible viewport screenshots only
- The foreground tab of the window capture is currently following
- At most 100 captured steps per session
- At most two screenshot attempts per second
- Redacted image target of 2 MB per step
- Chrome/Edge 116 or newer
- No native desktop, browser chrome, file picker, context menu, or OS-dialog
  capture
