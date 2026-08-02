$ErrorActionPreference = "Stop"

$AppRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Version = (Get-Content (Join-Path $AppRoot "VERSION") -Raw).Trim()
$DistDir = Join-Path $AppRoot "dist"
$StageDir = Join-Path $DistDir "work-time-tracker-v$Version"
$ZipPath = Join-Path $DistDir "work-time-tracker-v$Version.zip"

if (Test-Path $StageDir) {
  Remove-Item -Recurse -Force $StageDir
}
if (Test-Path $ZipPath) {
  Remove-Item -Force $ZipPath
}

New-Item -ItemType Directory -Force -Path $StageDir | Out-Null

$include = @(
  "package.json",
  "README.md",
  "RELEASE_NOTES.md",
  "VERSION",
  "server.mjs",
  "Start-WorkTimeTracker.cmd",
  "Start-WorkTimeTracker.ps1",
  "Start-WorkTimeTracker.vbs",
  "public"
)

foreach ($item in $include) {
  $source = Join-Path $AppRoot $item
  $target = Join-Path $StageDir $item
  if ((Get-Item $source).PSIsContainer) {
    Copy-Item -Recurse -Force $source $target
  } else {
    Copy-Item -Force $source $target
  }
}

New-Item -ItemType Directory -Force -Path (Join-Path $StageDir "data") | Out-Null
Compress-Archive -Path (Join-Path $StageDir "*") -DestinationPath $ZipPath -Force
Write-Output $ZipPath
