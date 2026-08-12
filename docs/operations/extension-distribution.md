# Browser-extension distribution and rollback

KnowHow Capture is distributed to pilot users through unlisted Chrome Web Store and Microsoft Edge Add-ons listings or an approved managed-browser policy referencing those listings. Direct public ZIP distribution is prohibited for controlled environments.

## Stable identity and permissions

- The checked-in public manifest key pins development/Chrome identity to `phbofjenfnnnnndghhinoldlfbpaedpo`. Never regenerate or replace it during an ordinary release.
- Record the final Chrome and Edge listing IDs. Configure their exact `chrome-extension://<id>` origins on the Site and list both HTTPS store URLs.
- Store artifacts contain one exact HTTPS KnowHow origin in required `host_permissions` and `externally_connectable`.
- `<all_urls>` remains optional, is requested only when capture starts, and is used only for the active policy-allowed foreground tab. Incognito and static content scripts remain disabled.
- The extension never receives Appwrite credentials or cookies. Device access is short-lived, workspace-scoped, rotating, minimum-version enforced, inventory-visible, and revocable.

## Build and review

From the release SHA:

```text
npm --prefix extension test
KNOWHOW_EXTENSION_ORIGIN=https://<exact-origin> npm run extension:build:store
```

On Windows PowerShell, set `KNOWHOW_EXTENSION_ORIGIN` for the process before running the second command. The ignored artifact is `outputs/extension/knowhow-capture-<version>-store.zip`.

Before upload, independently inspect the ZIP and record:

- SHA-256, size, version, release SHA, builder, and UTC build time.
- Derived extension ID and exact application origin.
- Required and optional permissions, incognito policy, CSP, service worker, and absence of remote executable code.
- Passing 85-test extension suite and deterministic second-build hash.
- Privacy disclosure matching actual capture behavior and current prohibited-data policy.

## Listing settings

- Visibility: unlisted/private as supported by the store and pilot enrollment plan.
- Automatic updates: enabled; no off-store update URL.
- Minimum browser: Chrome/Edge 116 or newer.
- Support/privacy links: canonical KnowHow pages and approved support contact.
- Description/screenshots: no customer data and no claims of regulated-data support, full DR, SLA, or GA readiness.
- Managed-browser guide: store ID, update policy, optional-host-permission behavior, allowed origin, minimum version, uninstall/revoke steps, and emergency block procedure.

Store review and propagation can take time. Do not schedule pilot onboarding until both approved listings are installable by the intended accounts/policies.

## Release rollout

1. Publish to internal testers and run install/update, pairing, viewer, redacted capture, pause/resume, commit, revoke, and stale-version tests in Staging.
2. Set the server minimum version no higher than the version demonstrably available to all pilot channels.
3. Roll out to the first design partner, watch device versions and capture failures, then expand.
4. Retain the previous accepted package/hash and listing release notes for rollback evidence. Do not redistribute its ZIP publicly.

## Rollback and emergency response

- Server-side kill switch: revoke affected devices and raise minimum-version enforcement only after a fixed version is available, unless continued use presents a P0 risk.
- Store rollback: submit the last known-good source as a new higher semantic version; stores generally update forward rather than reinstalling an older version.
- Origin/credential compromise: revoke device refresh credentials, rotate token keys under the versioned-key procedure, remove compromised origins, and publish an emergency build.
- Capture privacy defect: disable new capture, preserve authorized guide viewing if safe, quarantine suspect media, and invoke incident response.

Every rollback records affected versions, decision owner, timestamps, store status, device counts, test evidence, and customer communication.
