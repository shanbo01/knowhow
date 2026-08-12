[CmdletBinding()]
param(
    [string]$SubscriptionName = 'Azure subscription 1',
    [string]$Location = 'southindia',
    [string]$NamePrefix = 'knowhowbeta',
    [string]$OperatorEmail = 'yousefmshanableh@gmail.com',
    [string]$VmSize = 'Standard_B2ls_v2',
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

$sku = Invoke-AzJson @(
    'vm', 'list-skus',
    '--location', $Location,
    '--resource-type', 'virtualMachines',
    '--size', $VmSize,
    '--all',
    '--output', 'json'
)
$availableSku = @($sku) | Where-Object {
    $_.name -eq $VmSize -and
    @($_.restrictions | Where-Object { $_.type -ne 'Zone' }).Count -eq 0
} | Select-Object -First 1
if (-not $availableSku) {
    throw "VM SKU '$VmSize' is unavailable to this subscription in '$Location'."
}
$vCpus = [int](@($availableSku.capabilities | Where-Object name -eq 'vCPUs').value | Select-Object -First 1)
$memoryGb = [double](@($availableSku.capabilities | Where-Object name -eq 'MemoryGB').value | Select-Object -First 1)
if ($vCpus -lt 2 -or $memoryGb -lt 4) {
    throw "VM SKU '$VmSize' has $vCpus vCPU and $memoryGb GiB RAM; KnowHow requires at least 2 vCPU and 4 GiB."
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
$scriptBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($script)
$compressedStream = [System.IO.MemoryStream]::new()
$gzipStream = [System.IO.Compression.GZipStream]::new($compressedStream, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$gzipStream.Write($scriptBytes, 0, $scriptBytes.Length)
$gzipStream.Dispose()
$bootstrapPayload = [Convert]::ToBase64String($compressedStream.ToArray())
$compressedStream.Dispose()
$payloadPath = '/tmp/knowhow-bootstrap.b64'
& az vm run-command invoke --resource-group $resourceGroup --name $vmName --command-id RunShellScript --scripts "rm -f $payloadPath /var/lib/knowhow/bootstrap-complete" --only-show-errors --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize the Appwrite bootstrap upload.' }
for ($offset = 0; $offset -lt $bootstrapPayload.Length; $offset += 6000) {
    $length = [Math]::Min(6000, $bootstrapPayload.Length - $offset)
    $chunk = $bootstrapPayload.Substring($offset, $length)
    & az vm run-command invoke --resource-group $resourceGroup --name $vmName --command-id RunShellScript --scripts "printf '%s' '$chunk' >> $payloadPath" --only-show-errors --output none
    if ($LASTEXITCODE -ne 0) { throw 'The Appwrite bootstrap upload was interrupted.' }
}
$bootstrapCommand = "base64 -d $payloadPath | gzip -d > /tmp/knowhow-bootstrap.sh && chmod 700 /tmp/knowhow-bootstrap.sh && bash /tmp/knowhow-bootstrap.sh && mkdir -p /var/lib/knowhow && touch /var/lib/knowhow/bootstrap-complete"
$bootstrapResult = Invoke-AzJson @('vm', 'run-command', 'invoke', '--resource-group', $resourceGroup, '--name', $vmName, '--command-id', 'RunShellScript', '--scripts', $bootstrapCommand, '--only-show-errors', '--output', 'json')
$verification = Invoke-AzJson @('vm', 'run-command', 'invoke', '--resource-group', $resourceGroup, '--name', $vmName, '--command-id', 'RunShellScript', '--scripts', 'test -f /var/lib/knowhow/bootstrap-complete && docker ps --format "{{.Names}}" | grep -qx appwrite && echo KNOWHOW_BOOTSTRAP_OK', '--only-show-errors', '--output', 'json')
if ($verification.value[0].message -notmatch 'KNOWHOW_BOOTSTRAP_OK') {
    throw "The VM exists, but Appwrite bootstrap verification failed: $($bootstrapResult.value[0].message)"
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
