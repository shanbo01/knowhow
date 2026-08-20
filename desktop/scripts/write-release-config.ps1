[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Get-RequiredEnvironmentValue([string]$Name) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ([string]::IsNullOrWhiteSpace($value)) {
    throw "Required release value $Name is missing."
  }
  return $value.Trim()
}

function Get-HttpsUri([string]$Name, [string]$Value) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
    throw "$Name must be an absolute URL."
  }
  if (
    $uri.Scheme -ne "https" -or
    -not [string]::IsNullOrEmpty($uri.UserInfo) -or
    -not [string]::IsNullOrEmpty($uri.Fragment)
  ) {
    throw "$Name must be an HTTPS URL without credentials or a fragment."
  }
  return $uri
}

$publicOrigin = Get-HttpsUri `
  "KNOWHOW_PUBLIC_APP_ORIGIN" `
  (Get-RequiredEnvironmentValue "KNOWHOW_PUBLIC_APP_ORIGIN")
if ($publicOrigin.AbsolutePath -ne "/" -or $publicOrigin.Query) {
  throw "KNOWHOW_PUBLIC_APP_ORIGIN must contain only the HTTPS origin."
}

$updateEndpoint = Get-HttpsUri `
  "KNOWHOW_DESKTOP_UPDATE_ENDPOINT" `
  (Get-RequiredEnvironmentValue "KNOWHOW_DESKTOP_UPDATE_ENDPOINT")
$updaterPublicKey = Get-RequiredEnvironmentValue "KNOWHOW_DESKTOP_UPDATER_PUBKEY"
if ($updaterPublicKey.Length -lt 32) {
  throw "KNOWHOW_DESKTOP_UPDATER_PUBKEY is not a valid updater public key."
}

$configuration = [ordered]@{
  bundle = [ordered]@{
    # Authenticode signing is intentionally interleaved around bundling in CI.
    # Tauri updater signatures are generated from the final signed installers.
    createUpdaterArtifacts = $false
  }
  plugins = [ordered]@{
    updater = [ordered]@{
      active = $true
      endpoints = @($updateEndpoint.AbsoluteUri)
      pubkey = $updaterPublicKey
      windows = [ordered]@{
        installMode = "passive"
      }
    }
  }
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
$parent = Split-Path -Parent $resolvedOutput
if (-not (Test-Path -LiteralPath $parent)) {
  New-Item -ItemType Directory -Path $parent | Out-Null
}
$configuration |
  ConvertTo-Json -Depth 8 |
  Set-Content -LiteralPath $resolvedOutput -Encoding utf8NoBOM
Write-Output $resolvedOutput
