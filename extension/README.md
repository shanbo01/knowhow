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
extension to extension/dist, and deterministically refreshes the installable
public/knowhow-extension.zip archive. The generated dist directory is
intentionally ignored by Git.

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
   follow it beside the current page — each step shows its screenshot, framed to
   the author's crop with click markers and blur regions intact — or stay in
   Capture to record a new guide.
3. Enter a guide title and choose Start capturing. The first capture
   asks you to allow KnowHow to access websites; this runtime permission is what
   lets Chrome capture the foreground tab from its persistent side panel.
4. Smart Blur appears only after recording starts and is off by default. When
   enabled, merged frosted regions appear live on the page, and the pill reports
   how many areas are covered, so you see what will be protected before the
   screenshot is taken.
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

The screenshot is taken when the pointer goes down, not after the click has been
handled, so the image shows the interface the way it looked at the moment of the
click and the marker lands on the control that was actually pressed — even when
the click navigates, closes a menu, or replaces the page. The click itself is
never intercepted, cancelled, or replayed.

A drag, a cancelled press, or a press that lands somewhere else releases the
reserved screenshot. Chrome allows only two screenshots per second, so during
very fast clicking a step falls back to photographing the painted result instead
of waiting for a frame that would no longer be the right one. Step titles quote
the control's own label, so a step reads `Click "Encrypted vault access"`.

Capture follows regular, policy-allowed foreground tabs in the recording
window. Opening a link in a new tab or switching to another capturable tab adds
a navigation step and continues the same session. Same-origin navigation also
continues automatically. A same-tab cross-origin navigation still pauses and
requires an explicit Resume action on the destination origin.

## Privacy properties

- Incognito operation is disabled in the manifest and checked again at runtime.
- No static all-site content script is used. All-site host access is optional
  and requested only when the user starts capture; it is required by Chrome's
  visible-tab screenshot API for reliable capture from a persistent side panel.
- KnowHow attaches only to the active, policy-allowed foreground tab in the
  recording window. Workspace allowlists, excluded hosts,
  browser-internal-page, and incognito checks remain enforced at runtime.
- Password fields and embedded frames are always redacted.
- The extension does not request clipboard, tab-capture, desktop-capture, or
  raw keyboard access.
- It records click events and navigation only; it never installs keyboard
  listeners or reads form-field values.
- The offscreen document rasterizes and compresses the screenshot locally.
  IndexedDB receives that private raster plus normalized Smart Blur regions;
  the live feed and guide viewer render those regions as blur immediately.
- Smart Blur, manual blur, drawing, contextual crop, and click-target edits
  remain layered and reversible while the capture is a private draft. The
  first review submission flattens the reviewed layers into the private image.
- Pause increments the capture generation before acknowledging the action.
  Queued or in-flight work from an older generation is discarded.
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

Production distribution should use a stable Chrome Web Store or enterprise
extension ID. The extension uses bearer device credentials, never cookies or
the user’s Appwrite session.

When a production KnowHow origin is selected, update both src/core/config.js and
the exact manifest host_permissions entry before building.

## Current limits

- Visible viewport screenshots only
- Foreground tabs in the recording window only
- At most 100 captured steps per session
- At most two screenshot attempts per second
- Redacted image target of 2 MB per step
- Chrome/Edge 116 or newer
- No native desktop, browser chrome, file picker, context menu, or OS-dialog
  capture
