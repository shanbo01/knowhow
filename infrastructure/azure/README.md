# KnowHow Azure Qatar Central platform

This deployment creates the smallest Appwrite-supported private-beta platform in Qatar Central: one Trusted Launch `Standard_B2s` Ubuntu VM, one static public IP, a deny-by-default NSG, managed identity, Key Vault, Qatar-resident zone-redundant encrypted Blob backups, a locally redundant Recovery Services vault with daily VM protection, Azure Monitor Agent, Log Analytics, and an operator alert group. It deliberately does not use AKS.

Production and Staging are separate Appwrite projects on this control plane. They must have separate project IDs, API keys, database rows, Storage objects, Sites, Function deployments, users, and synthetic test data. Shared VM failure remains an explicitly accepted private-beta availability limitation; no customer SLA is promised.

Appwrite is pinned to `1.9.6`. Bootstrap downloads the official release `docker-compose.yml` and `.env` and rejects either artifact unless its SHA-256 digest matches the checked-in digest. Secrets are generated on the VM, written to the RBAC-enabled Key Vault, and retained locally only where the Appwrite Compose stack requires them. SSH is blocked at the NSG; normal maintenance uses Azure Run Command.

The Appwrite API receives the free Azure public-IP FQDN and a normal Let's Encrypt certificate. Until KnowHow owns a domain, the two exact Site domains are `knowhow-prod.<static-ip>.sslip.io` and `knowhow-staging.<static-ip>.sslip.io`. These contain no customer data and can later be replaced without moving Qatar-hosted storage. They are not a contractual production domain.

## Validate without spending

```powershell
.\infrastructure\azure\Deploy-KnowHowAzure.ps1 -ValidateOnly
```

## Deploy

```powershell
.\infrastructure\azure\Deploy-KnowHowAzure.ps1
```

The script refuses any subscription except `Azure subscription 1` by default, confirms every provider registration, creates an ignored emergency SSH key, deploys the Bicep, and bootstraps Appwrite through Azure Run Command. The deployment begins Azure billing for the VM, OS disk, public IP, backup vault, logs, Key Vault, and Blob storage.

After bootstrap, create the single Appwrite root console account with the operator email, require TOTP, and then create exactly two projects named `KnowHow Production` and `KnowHow Staging`. Do not delete Appwrite Cloud until the self-hosted contract smoke, two-user journey, encrypted backup, isolated restore, and Production/Staging configuration comparison all pass.

## Backups and recovery

The VM has two independent recovery layers:

- Azure Backup takes daily VM recovery points and retains 14 days.
- `knowhow-backup.timer` stops the stack briefly, captures every `appwrite-*` Docker volume plus a logical MongoDB dump and exact Compose configuration, encrypts the payload with age, and uploads it with managed identity to a private versioned geo-redundant container.

The age identity is also in Key Vault as `appwrite-backup-age-key`. A restore must target a fresh isolated VM. Copy `restore-appwrite.sh` to that VM and provide `BACKUP_BLOB` plus the exact confirmation `RESTORE_CONFIRM=fresh-instance-only:<blob>`. Never rehearse over the active VM.

Useful read-only checks:

```powershell
az backup item list --resource-group knowhowbeta-qc-rg --vault-name knowhowbeta-recovery --output table
az storage blob list --account-name <output-storage-name> --container-name appwrite-backups --auth-mode login --output table
az monitor log-analytics workspace show --resource-group knowhowbeta-qc-rg --workspace-name knowhowbeta-logs
```
