[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BinaryPath,

  [Parameter(Mandatory = $true)]
  [string]$OutputDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$sourcePath = [IO.Path]::GetFullPath($BinaryPath)
$resolvedOutput = [IO.Path]::GetFullPath($OutputDirectory)
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "The compiled KnowHow Capture binary does not exist."
}
if (-not (Test-Path -LiteralPath $resolvedOutput)) {
  New-Item -ItemType Directory -Path $resolvedOutput | Out-Null
}

$encoding = [Text.Encoding]::ASCII
$placeholder = $encoding.GetBytes("__TAURI_BUNDLE_TYPE_VAR_UNK")
$source = [IO.File]::ReadAllBytes($sourcePath)

function New-BundleBinary([string]$BundleCode, [string]$FileName) {
  $replacement = $encoding.GetBytes("__TAURI_BUNDLE_TYPE_VAR_$BundleCode")
  if ($replacement.Length -ne $placeholder.Length) {
    throw "The Tauri bundle marker replacement changed length."
  }
  $output = [byte[]]$source.Clone()
  $matches = 0
  for ($index = 0; $index -le $output.Length - $placeholder.Length; $index++) {
    $equal = $true
    for ($offset = 0; $offset -lt $placeholder.Length; $offset++) {
      if ($output[$index + $offset] -ne $placeholder[$offset]) {
        $equal = $false
        break
      }
    }
    if (-not $equal) { continue }
    [Array]::Copy($replacement, 0, $output, $index, $replacement.Length)
    $matches += 1
    $index += $placeholder.Length - 1
  }
  if ($matches -ne 1) {
    throw "Expected exactly one unpatched Tauri bundle marker; found $matches."
  }
  $path = Join-Path $resolvedOutput $FileName
  [IO.File]::WriteAllBytes($path, $output)
  return $path
}

New-BundleBinary "NSS" "knowhow-capture-nsis.exe"
New-BundleBinary "MSI" "knowhow-capture-msi.exe"
