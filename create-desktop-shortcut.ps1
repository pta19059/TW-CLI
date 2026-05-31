$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$exePath = Join-Path $root "bin\twc.exe"

if (-not (Test-Path $exePath)) {
  Write-Host "twc.exe non trovato in bin. Esegui prima: npm run build:exe" -ForegroundColor Yellow
  exit 1
}

$desktop = [Environment]::GetFolderPath("Desktop")
$linkPath = Join-Path $desktop "TeamViewer CLI.lnk"

$wsh = New-Object -ComObject WScript.Shell
$shortcut = $wsh.CreateShortcut($linkPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$exePath,0"
$shortcut.Description = "TeamViewer CLI"
$shortcut.Save()

Write-Host "Collegamento creato: $linkPath" -ForegroundColor Green
