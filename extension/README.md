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

## Capture workflow

1. Pair the extension with the one-time code shown in a KnowHow workspace.
2. Open the page to document and select the KnowHow toolbar action.
3. Optionally configure Smart Blur and the click-target color.
4. Enter a guide title and choose Start capturing this tab. The first capture
   asks you to allow KnowHow to access websites; this runtime permission is what
   lets Chrome capture the foreground tab from its persistent side panel.
5. Keep KnowHow docked in Chrome's native side panel while the captured page
   remains usable beside it. Numbered, locally redacted step previews appear
   in the panel as you click and navigate.
6. Use Pause and Resume from the native side panel.
7. Choose Finish & review to open the full post-capture editor.
8. Reorder or remove steps, edit the generated copy, zoom or pan the contextual
   crop, add or remove manual blur regions, draw freehand, and move or remove
   the click target. Undo and redo operate on these editable layers.
9. Confirm the privacy review and submit a private KnowHow draft. The selected
   crop and editable layers are flattened once into the upload raster.

The default scope is one foreground tab. Same-origin navigation continues
automatically. A cross-origin navigation pauses capture and requires an
explicit Resume action on the destination origin.

## Privacy properties

- Incognito operation is disabled in the manifest and checked again at runtime.
- No static all-site content script is used. All-site host access is optional
  and requested only when the user starts capture; it is required by Chrome's
  visible-tab screenshot API for reliable capture from a persistent side panel.
- KnowHow still attaches only to the selected foreground tab, and the workspace
  allowlist, excluded hosts, browser-internal-page, and incognito checks remain
  enforced at runtime.
- Password fields and embedded frames are always redacted.
- The extension does not request clipboard, tab-capture, desktop-capture, or
  raw keyboard access.
- It records click events and navigation only; it never installs keyboard
  listeners or reads form-field values.
- A raw screenshot exists only in memory while the offscreen document applies
  local redaction. IndexedDB receives only the redacted image Blob.
- Automatic masks are burned into the locally retained base image and cannot
  be removed. Manual blur, drawing, crop, and click-target edits remain layered
  and reversible until submission. "Unblur" removes only a manual blur layer;
  it can never reveal content hidden by automatic Smart Blur.
- Pause increments the capture generation before acknowledging the action.
  Queued or in-flight work from an older generation is discarded.
- Discard removes every redacted screenshot for the local capture session.

DOM-assisted Smart Blur cannot reliably detect text rendered into canvas,
WebGL, video, images, native browser UI, or closed shadow roots. Images and
table rows can be masked as complete regions. Mandatory human review remains
the final privacy control.

## KnowHow API

The development build points to `http://localhost:3001` in src/core/config.js
and declares only localhost in manifest host_permissions. Pairing uses a signed,
short-lived one-time code generated inside an authenticated KnowHow workspace:

    POST /api/extension/pair
    POST /api/extension/token/refresh
    GET /api/extension/context

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

## MVP limits

- Visible viewport screenshots only
- Foreground captured tab only
- At most 100 captured steps per session
- At most two screenshot attempts per second
- Redacted image target of 2 MB per step
- Chrome/Edge 116 or newer
- No native desktop, browser chrome, file picker, context menu, or OS-dialog
  capture
