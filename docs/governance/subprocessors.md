# Third-party service list

Status: draft inventory. Legal/privacy must verify every enabled integration before real data is used.

The Appwrite database, Auth service, and private Storage run on operator-controlled local infrastructure. The Appwrite software vendor does not receive KnowHow data through this architecture. If the operator later places the machine, backups, or network under another provider, that provider must be reviewed and added here before use.

| Provider | Purpose | Intended data | Limitation |
| --- | --- | --- | --- |
| Resend, when enabled | Account, invitation, support, and operational email | Recipient address, minimized template content, delivery metadata | Optional; leave credentials blank to keep delivery in local Mailpit |
| Sentry, when enabled | Error and performance monitoring | Scrubbed route shapes, error codes, request IDs, aggregate timing | Optional; PII disabled and the event scrubber remains enforced |

## Distribution platforms

Google Chrome Web Store and Microsoft Edge Add-ons may distribute extension packages. The local unpacked-extension workflow does not send guide content, screenshots, Appwrite sessions, or device credentials to a store operator.

## Change process

1. Review purpose, data minimization, location, access, retention, deletion, and breach terms.
2. Update this inventory and the privacy/DPA drafts.
3. Test the integration with disposable data.
4. Do not enable a new provider for real data until the required approvals are complete.
