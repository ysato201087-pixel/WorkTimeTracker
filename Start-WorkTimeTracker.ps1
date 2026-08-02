$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeCandidates = @(
  (Join-Path $AppRoot "node.exe"),
  "C:\Program Files\nodejs\node.exe",
  "node.exe"
)

$Node = $NodeCandidates | Where-Object {
  try { Get-Command $_ -ErrorAction Stop | Out-Null; $true } catch { $false }
} | Select-Object -First 1

if (-not $Node) {
  [System.Windows.Forms.MessageBox]::Show("Node.js 24 or later is required.", "Work Time Tracker")
  exit 1
}

$Port = if ($env:PORT) { [int]$env:PORT } else { 47831 }
$BaseUrl = "http://127.0.0.1:$Port"
$ServerOut = Join-Path $AppRoot "data\server.out.log"
$ServerErr = Join-Path $AppRoot "data\server.err.log"
$BrowserProfile = Join-Path $AppRoot "data\browser-profile"

if (-not (Test-Path $BrowserProfile)) {
  New-Item -ItemType Directory -Force -Path $BrowserProfile | Out-Null
}

$proc = Start-Process -FilePath $Node `
  -ArgumentList @("--no-warnings", (Join-Path $AppRoot "server.mjs")) `
  -WorkingDirectory $AppRoot `
  -RedirectStandardOutput $ServerOut `
  -RedirectStandardError $ServerErr `
  -PassThru `
  -WindowStyle Hidden

function Invoke-AppApi {
  param([string]$Path, [string]$Method = "POST")
  try {
    Invoke-RestMethod -Method $Method -Uri "$BaseUrl$Path" -TimeoutSec 4 | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "Work Time Tracker")
  }
}

function Get-AppState {
  try {
    return Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/state" -TimeoutSec 4
  } catch {
    return $null
  }
}

function Open-AppWindow {
  $edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
  $chrome = "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe"
  $browserArgs = @(
    "--app=$BaseUrl",
    "--window-size=410,455",
    "--window-position=120,120",
    "--user-data-dir=$BrowserProfile",
    "--no-first-run"
  )
  if (Test-Path $edge) {
    Start-Process -FilePath $edge -ArgumentList $browserArgs
  } elseif (Test-Path $chrome) {
    Start-Process -FilePath $chrome -ArgumentList $browserArgs
  } else {
    Start-Process $BaseUrl
  }
}

for ($i = 0; $i -lt 40; $i++) {
  try {
    Invoke-RestMethod -Method GET -Uri "$BaseUrl/api/health" -TimeoutSec 1 | Out-Null
    break
  } catch {
    Start-Sleep -Milliseconds 250
  }
}

Open-AppWindow

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = $menu.Items.Add("Open app")
$pauseItem = $menu.Items.Add("Pause")
$resumeItem = $menu.Items.Add("Resume")
$stopItem = $menu.Items.Add("Stop")
$menu.Items.Add("-") | Out-Null
$exitItem = $menu.Items.Add("Exit")

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Application
$notify.Text = "Work Time Tracker"
$notify.ContextMenuStrip = $menu
$notify.Visible = $true

$openItem.add_Click({ Open-AppWindow })
$notify.add_DoubleClick({ Open-AppWindow })
$pauseItem.add_Click({ Invoke-AppApi "/api/timer/pause" })
$resumeItem.add_Click({ Invoke-AppApi "/api/timer/resume" })
$stopItem.add_Click({ Invoke-AppApi "/api/timer/stop" })

$exitItem.add_Click({
  $state = Get-AppState
  if ($state -and $state.activeTimer.status -ne "IDLE") {
    $choice = [System.Windows.Forms.MessageBox]::Show(
      "A timer is currently active.`r`n`r`nYes: close and keep timing`r`nNo: stop and save`r`nCancel: return",
      "Work Time Tracker",
      [System.Windows.Forms.MessageBoxButtons]::YesNoCancel,
      [System.Windows.Forms.MessageBoxIcon]::Question
    )

    if ($choice -eq [System.Windows.Forms.DialogResult]::Cancel) { return }
    if ($choice -eq [System.Windows.Forms.DialogResult]::No) { Invoke-AppApi "/api/timer/stop" }
  }

  $notify.Visible = $false
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force }
  [System.Windows.Forms.Application]::Exit()
})

[System.Windows.Forms.Application]::Run()
