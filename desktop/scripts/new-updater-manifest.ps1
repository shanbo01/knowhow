[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ReleaseDirectory,

  [Parameter(Mandatory = $true)]
  [string]$ReleaseBaseUrl
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$base = $null
if (-not [Uri]::TryCreate($ReleaseBaseUrl, [UriKind]::Absolute, [ref]$base)) {
  throw "ReleaseBaseUrl must be an absolute URL."
}
if ($base.Scheme -ne "https" -or $base.UserInfo -or $base.Fragment -or $base.Query) {
  throw "ReleaseBaseUrl must be an HTTPS URL without credentials, query, or fragment."
}

$releaseRoot = [IO.Path]::GetFullPath($ReleaseDirectory)
$fragments = @(
  Get-ChildItem -LiteralPath $releaseRoot -Filter "release-fragment-*.json" -File -Recurse |
    ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw | ConvertFrom-Json }
)
if ($fragments.Count -ne 2) {
  throw "A stable release requires exactly two architecture fragments."
}
$versions = @($fragments | ForEach-Object { [string]$_.version } | Select-Object -Unique)
if ($versions.Count -ne 1) {
  throw "All release fragments must use the same version."
}
$platforms = [ordered]@{}
foreach ($fragment in $fragments) {
  foreach ($updater in @($fragment.updaters)) {
    $file = [string]$updater.file
    $asset = Get-ChildItem -LiteralPath $releaseRoot -Filter $file -File -Recurse
    if (@($asset).Count -ne 1) {
      throw "Updater asset $file is missing or ambiguous."
    }
    $target = [string]$updater.target
    if ($platforms.Contains($target)) {
      throw "Updater target $target is duplicated."
    }
    $platforms[$target] = [ordered]@{
      signature = [string]$updater.signature
      url = "$($base.AbsoluteUri.TrimEnd('/'))/$([Uri]::EscapeDataString($file))"
    }
  }
}
$targets = @($platforms.Keys | Sort-Object)
$requiredTargets = @(
  "windows-aarch64-msi",
  "windows-aarch64-nsis",
  "windows-x86_64-msi",
  "windows-x86_64-nsis"
)
if (($targets -join ",") -ne ($requiredTargets -join ",")) {
  throw "The stable release must contain NSIS and MSI updater targets for x64 and ARM64."
}

$manifest = [ordered]@{
  version = $versions[0]
  notes = "Stable KnowHow Capture release $($versions[0])."
  pub_date = [DateTimeOffset]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ")
  platforms = $platforms
}
$manifest |
  ConvertTo-Json -Depth 7 |
  Set-Content -LiteralPath (Join-Path $releaseRoot "latest.json") -Encoding utf8NoBOM

$releaseFiles = Get-ChildItem -LiteralPath $releaseRoot -File -Recurse |
  Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
  Sort-Object Name
$releaseFiles |
  ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $($_.Name)"
  } |
  Set-Content -LiteralPath (Join-Path $releaseRoot "SHA256SUMS.txt") -Encoding utf8NoBOM
