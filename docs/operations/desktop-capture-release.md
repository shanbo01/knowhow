# KnowHow Capture Windows release runbook

KnowHow Capture is a Windows-only Tauri 2 recorder. Production artifacts are per-user NSIS EXE installers and managed MSI installers for x64 and ARM64. Neither format enables launch at login. Closing the app hides it to the tray; uninstall removes the encrypted per-user capture store and therefore erases its DPAPI-wrapped session and device keys.

## Protected release setup

Create a GitHub environment named `desktop-production`, require designated reviewers, prevent self-review where the plan permits it, and restrict deployments to `desktop-v*` tags. Configure a Microsoft Entra federated credential whose subject exactly matches that GitHub environment. Grant its identity only the `Artifact Signing Certificate Profile Signer` role on the production Azure Artifact Signing profile.

Environment secrets:

- `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, and `AZURE_SUBSCRIPTION_ID` for `azure/login` workload identity; no Azure client secret is used.
- `TAURI_SIGNING_PRIVATE_KEY` and optional `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Generate the updater key offline with `desktop/node_modules/.bin/tauri signer generate --write-keys <protected-path>`, store the private key only in the protected secret store, and retain the public key as a variable.

Environment variables:

- `ARTIFACT_SIGNING_ENDPOINT`, `ARTIFACT_SIGNING_ACCOUNT`, and `ARTIFACT_SIGNING_PROFILE`.
- `KNOWHOW_PUBLIC_APP_ORIGIN`, the exact production HTTPS origin with no path.
- `KNOWHOW_DESKTOP_UPDATE_ENDPOINT`, the exact HTTPS stable `latest.json` endpoint compiled into the app.
- `KNOWHOW_DESKTOP_UPDATER_PUBKEY`, matching the protected updater private key.

Publication deliberately fails before building if any identity, profile, endpoint, or updater-key value is absent. The certificate private key remains non-exportable in Artifact Signing.

## Build and publish

1. Set the same SemVer in `desktop/package.json`, `desktop/src-tauri/Cargo.toml`, and `desktop/src-tauri/tauri.conf.json`.
2. Run `npm test`, `npm run desktop:check`, native format/clippy, dependency audits, and relevant Windows integration/soak tests.
3. Create and push the annotated tag `desktop-vX.Y.Z`, or dispatch `desktop-release.yml` against an existing matching tag.
4. Approve the protected environment. The workflow builds both MSVC targets on Windows 2025, creates correctly marked NSIS/MSI native binaries, signs those final inner bytes, bundles them separately, signs the outer EXE/MSI installers, generates Tauri updater signatures from the final installer bytes, verifies Authenticode, generates CycloneDX SBOMs and SHA-256 hashes, scans with Windows Defender, and publishes only after both architectures pass.
5. Confirm the release contains x64 and ARM64 EXE/MSI files, their `.sig` files, `latest.json`, SBOMs, and `SHA256SUMS.txt`. Compare the manifest URLs and embedded signatures with the uploaded assets.
6. Promote the four signed installer URLs into the web deployment variables and update `KNOWHOW_DESKTOP_MIN_VERSION` only after staged install/upgrade tests pass.

Never publish an unsigned installer, hand-edit `latest.json`, reuse a failed signing output, or expose the updater private key in artifacts/logs. The workflow is allowed to build evidence without publication; stable publication remains an explicit protected action.

## Acceptance matrix

Use clean Windows 10 22H2 and Windows 11 x64/ARM64 images. Exercise NSIS install/upgrade/uninstall and MSI install/upgrade/repair/uninstall; verify the signer chain and SHA-256 hashes first. Then test authorize, narrow/all-display capture, mixed DPI and negative coordinates, dialogs, text/password controls, pause/resume, offline finish/retry, crash recovery, display disconnect, lock/unlock, graphics loss, protected/elevated/private surfaces, 100-step ordering, and web-editor privacy blocking.

Measure an idle five-minute interval and typical 1080p recording: idle CPU must remain below 1%, typical recording below 8% CPU and 250 MB RAM. Inspect user storage, application/support/crash logs, and telemetry for absence of source frames, passwords, refresh tokens, screenshot bytes, and guide text outside the encrypted store.

## Rollback and incident recovery

Tauri is configured to reject downgrades. For a bad stable release, stop publication, mark the affected release non-latest, revoke affected device/minimum-version policy only when required, and ship the last known-good code as a new higher SemVer signed release. Rehearse this forward-rollback before general availability. A manual reinstall of an older build is an emergency operator procedure, not an automatic updater path.

If signing identity or updater-key compromise is suspected, freeze releases, remove the federated credential/Artifact Signing role, revoke the profile or key as applicable, preserve content-free CI evidence, rotate the updater key through a separately trusted installed release when possible, and follow the incident-response runbook.
