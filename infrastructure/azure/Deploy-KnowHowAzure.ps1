[CmdletBinding()]
param(
    [string]$SubscriptionName = 'Azure subscription 1',
    [string]$Location = 'qatarcentral',
    [string]$NamePrefix = 'knowhowbeta',
    [string]$OperatorEmail = 'yousefmshanableh@gmail.com',
    [string]$VmSize = 'Standard_B2s',
    [string]$AppwriteVersion = '1.9.6',
    [switch]$ValidateOnly
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$subscriptionTemplate = Join-Path $PSScriptRoot 'subscription.bicep'
$bootstrapPath = Join-Path $PSScriptRoot 'bootstrap-appwrite.sh'
$temporaryDirectory = Join-Path (Split-Path -Parent $root) '.tmp\azure'
$privateKeyPath = Join-Path $temporaryDirectory 'knowhow_beta_ed25519'
$publicKeyPath = "$privateKeyPath.pub"

function Invoke-AzJson {
    param([Parameter(Mandatory)][string[]]$Arguments)
    $result = & az @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed: az $($Arguments -join ' ')"
    }
    return ($result | ConvertFrom-Json)
}

$account = Invoke-AzJson @('account', 'show', '--output', 'json')
if ($account.name -ne $SubscriptionName -or $account.state -ne 'Enabled') {
    throw "Expected enabled subscription '$SubscriptionName'; active subscription is '$($account.name)' ($($account.state))."
}

$requiredProviders = @(
    'Microsoft.Compute',
    'Microsoft.Insights',
    'Microsoft.KeyVault',
    'Microsoft.ManagedIdentity',
    'Microsoft.Network',
    'Microsoft.OperationalInsights',
    'Microsoft.RecoveryServices',
    'Microsoft.Storage'
)
foreach ($provider in $requiredProviders) {
    $state = (& az provider show --namespace $provider --query registrationState --output tsv).Trim()
    if ($state -ne 'Registered') {
        throw "Provider '$provider' is '$state'. Wait for registration and rerun."
    }
}

$deployerObjectId = (& az ad signed-in-user show --query id --output tsv).Trim()
if (-not $deployerObjectId) {
    throw 'Could not resolve the signed-in Azure user object ID.'
}

New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $publicKeyPath)) {
    & ssh-keygen -q -t ed25519 -N '""' -C 'knowhow-azure-emergency' -f $privateKeyPath
    if ($LASTEXITCODE -ne 0) {
        throw 'ssh-keygen failed.'
    }
}
$sshPublicKey = (Get-Content -LiteralPath $publicKeyPath -Raw).Trim()

$deploymentName = "knowhow-private-beta-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))"
$commonArguments = @(
    '--location', $Location,
    '--template-file', $subscriptionTemplate,
    '--parameters',
    "location=$Location",
    "namePrefix=$NamePrefix",
    "deployerObjectId=$deployerObjectId",
    "operatorEmail=$OperatorEmail",
    "sshPublicKey=$sshPublicKey",
    "vmSize=$VmSize",
    "appwriteVersion=$AppwriteVersion",
    '--only-show-errors',
    '--output', 'json'
)

if ($ValidateOnly) {
    & az deployment sub validate --name $deploymentName @commonArguments | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Azure subscription deployment validation failed.'
    }
    Write-Host 'Azure Bicep validation passed; no resources were created.'
    exit 0
}

$deployment = Invoke-AzJson (@('deployment', 'sub', 'create', '--name', $deploymentName) + $commonArguments)
$outputs = $deployment.properties.outputs
$resourceGroup = $outputs.resourceGroupName.value
$vmName = $outputs.vmName.value
$apiFqdn = $outputs.apiFqdn.value
$publicIp = $outputs.publicIpAddress.value
$operatorIp = (Invoke-RestMethod -Uri 'https://api.ipify.org').Trim()
$managedIdentityClientId = (& az identity show --resource-group $resourceGroup --name "$NamePrefix-vm-mi" --query clientId --output tsv).Trim()

$bootstrap = Get-Content -LiteralPath $bootstrapPath -Raw
$preamble = @"
export APPWRITE_DOMAIN='$apiFqdn'
export PUBLIC_IP='$publicIp'
export OPERATOR_EMAIL='$OperatorEmail'
export OPERATOR_IP='$operatorIp'
export KEY_VAULT_NAME='$($outputs.keyVaultName.value)'
export STORAGE_ACCOUNT='$($outputs.backupStorageAccountName.value)'
export BACKUP_CONTAINER='$($outputs.backupContainerName.value)'
export MANAGED_IDENTITY_CLIENT_ID='$managedIdentityClientId'
export APPWRITE_VERSION='$AppwriteVersion'
"@
$script = "$preamble`n$bootstrap"

& az vm run-command invoke `
    --resource-group $resourceGroup `
    --name $vmName `
    --command-id RunShellScript `
    --scripts $script `
    --only-show-errors `
    --output json | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw 'The VM exists, but Appwrite bootstrap failed. Inspect Azure Run Command output before retrying.'
}

[PSCustomObject]@{
    ResourceGroup = $resourceGroup
    VmName = $vmName
    AppwriteConsole = "https://$apiFqdn/console"
    AppwriteApi = "https://$apiFqdn/v1"
    ProductionSite = "https://$($outputs.productionSiteFqdn.value)"
    StagingSite = "https://$($outputs.stagingSiteFqdn.value)"
    KeyVault = $outputs.keyVaultName.value
    BackupStorage = $outputs.backupStorageAccountName.value
    RecoveryServicesVault = $outputs.recoveryServicesVaultName.value
    EmergencyPrivateKey = $privateKeyPath
} | Format-List
