param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$CliArgs
)

$ErrorActionPreference = "Stop"
$scriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Push-Location $scriptRoot

try {
  if (-not (Test-Path ".\dist\index.js")) {
    npm run build | Out-Host
  }

  if ($CliArgs.Count -eq 0) {
    node .\dist\index.js --help
  }
  else {
    node .\dist\index.js @CliArgs
  }
}
finally {
  Pop-Location
}
