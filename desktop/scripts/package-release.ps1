[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("x64", "arm64")]
  [string]$Architecture,

  [Parameter(Mandatory = $true)]
  [ValidateSet("x86_64-pc-windows-msvc", "aarch64-pc-windows-msvc")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$desktopRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$configuration = Get-Content `
  -LiteralPath (Join-Path $desktopRoot "src-tauri\tauri.conf.json") `
  -Raw |
  ConvertFrom-Json
$version = [string]$configuration.version
if ($version -notmatch '^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
  throw "The desktop version is not valid SemVer."
}

$bundleRoot = Join-Path $desktopRoot "src-tauri\target\$Target\release\bundle"
$nsis = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "nsis") -Filter "*.exe" -File)
$msi = @(Get-ChildItem -LiteralPath (Join-Path $bundleRoot "msi") -Filter "*.msi" -File)
if ($nsis.Count -ne 1 -or $msi.Count -ne 1) {
  throw "Expected exactly one NSIS installer and one MSI installer for $Target."
}

foreach ($installer in @($nsis[0], $msi[0])) {
  $signature = Get-AuthenticodeSignature -LiteralPath $installer.FullName
  if ($signature.Status -ne [Management.Automation.SignatureStatus]::Valid) {
    throw "Authenticode validation failed for $($installer.Name): $($signature.Status)."
  }
}

$tauri = Join-Path $desktopRoot "node_modules\.bin\tauri.cmd"
foreach ($installer in @($nsis[0], $msi[0])) {
  & $tauri signer sign $installer.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "Tauri updater signing failed for $($installer.Name)."
  }
  if (-not (Test-Path -LiteralPath "$($installer.FullName).sig")) {
    throw "Tauri did not produce an updater signature for $($installer.Name)."
  }
}

$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $resolvedOutput)) {
  New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}
$baseName = "KnowHow-Capture-$version-windows-$Architecture"
$exeName = "$baseName-setup.exe"
$msiName = "$baseName.msi"
$exePath = Join-Path $resolvedOutput $exeName
$msiPath = Join-Path $resolvedOutput $msiName
Copy-Item -LiteralPath $nsis[0].FullName -Destination $exePath -Force
Copy-Item -LiteralPath $msi[0].FullName -Destination $msiPath -Force
Copy-Item -LiteralPath "$($nsis[0].FullName).sig" -Destination "$exePath.sig" -Force
Copy-Item -LiteralPath "$($msi[0].FullName).sig" -Destination "$msiPath.sig" -Force

$targetPrefix = if ($Architecture -eq "x64") { "windows-x86_64" } else { "windows-aarch64" }
$fragment = [ordered]@{
  version = $version
  architecture = $Architecture
  updaters = @(
    [ordered]@{
      target = "$targetPrefix-nsis"
      file = $exeName
      signature = (Get-Content -LiteralPath "$exePath.sig" -Raw).Trim()
    },
    [ordered]@{
      target = "$targetPrefix-msi"
      file = $msiName
      signature = (Get-Content -LiteralPath "$msiPath.sig" -Raw).Trim()
    }
  )
  installers = @($exeName, $msiName)
}
$fragment |
  ConvertTo-Json -Depth 5 |
  Set-Content `
    -LiteralPath (Join-Path $resolvedOutput "release-fragment-$Architecture.json") `
    -Encoding utf8NoBOM

$hashLines = @($exePath, $msiPath, "$exePath.sig", "$msiPath.sig") |
  ForEach-Object {
    $hash = Get-FileHash -LiteralPath $_ -Algorithm SHA256
    "$($hash.Hash.ToLowerInvariant())  $([IO.Path]::GetFileName($_))"
  }
$hashLines |
  Set-Content `
    -LiteralPath (Join-Path $resolvedOutput "SHA256SUMS-$Architecture.txt") `
    -Encoding utf8NoBOM
