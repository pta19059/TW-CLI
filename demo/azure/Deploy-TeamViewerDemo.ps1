#requires -Version 5.1
<#
.SYNOPSIS
    Provisions the twc-cli demo: an Ubuntu VM in Azure that acts as a remote
    TeamViewer endpoint, enrolled into your TeamViewer account.

.DESCRIPTION
    The twc CLI runs on YOUR LAPTOP, not on this VM. The VM only hosts a
    TeamViewer Host daemon that registers into your TeamViewer account via an
    assignment token. From the laptop, `twc` (with TEAMVIEWER_API_TOKEN set)
    then sees this VM through the WebAPI auth-policy specialist.

    Idempotent-ish: re-running with the same names reuses the resource group.

.PARAMETER AssignmentToken
    TeamViewer *assignment* token from Management Console ->
    Design & Deploy / Assignment. Enrolls the VM into your account.

.PARAMETER ResourceGroup
    Target resource group (default: TW).

.PARAMETER Location
    Azure region (default: swedencentral).

.EXAMPLE
    ./Deploy-TeamViewerDemo.ps1 -AssignmentToken "00000000-aaaa-bbbb-cccc-1234567890ab"
#>
[CmdletBinding()]
param(
    [string]$AssignmentToken = "",

    [string]$ResourceGroup = "TW",
    [string]$Location       = "swedencentral",
    [string]$VmName         = "vm-twc-demo",
    [string]$AdminUsername  = "twcadmin",
    [string]$VmSize         = "Standard_B2s",
    [string]$Image          = "Canonical:0001-com-ubuntu-server-jammy:22_04-lts-gen2:latest"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# --- preflight ------------------------------------------------------------
Write-Host "==> Checking Azure CLI login..." -ForegroundColor Cyan
$null = az account show 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Not logged in. Run 'az login' first." -ForegroundColor Yellow
    exit 1
}

# --- render cloud-init with the assignment token --------------------------
$template = Get-Content (Join-Path $scriptDir "cloud-init.yaml") -Raw
if ([string]::IsNullOrWhiteSpace($AssignmentToken)) {
    # No secret handled here: skip enrollment, leave a clear manual instruction.
    $cloudInit = $template.Replace(
        'teamviewer assignment --id "__ASSIGNMENT_TOKEN__"',
        'echo "[twc-demo] No assignment token baked in. Enroll manually: sudo teamviewer assignment --id <token>"')
    Write-Host "==> No -AssignmentToken provided: VM will install TeamViewer Host but NOT auto-enroll." -ForegroundColor Yellow
} else {
    $cloudInit = $template.Replace("__ASSIGNMENT_TOKEN__", $AssignmentToken)
}
$tmpFile = New-TemporaryFile
Set-Content -Path $tmpFile -Value $cloudInit -Encoding UTF8

try {
    # --- resource group ---------------------------------------------------
    Write-Host "==> Ensuring resource group '$ResourceGroup' in $Location..." -ForegroundColor Cyan
    az group create --name $ResourceGroup --location $Location --only-show-errors | Out-Null

    # --- VM ---------------------------------------------------------------
    Write-Host "==> Creating VM '$VmName' ($VmSize, $Image)..." -ForegroundColor Cyan
    az vm create `
        --resource-group $ResourceGroup `
        --name $VmName `
        --image $Image `
        --size $VmSize `
        --admin-username $AdminUsername `
        --generate-ssh-keys `
        --custom-data $tmpFile `
        --public-ip-sku Standard `
        --only-show-errors | Out-Null

    $ip = az vm show -d -g $ResourceGroup -n $VmName --query publicIps -o tsv

    Write-Host ""
    Write-Host "==> VM ready." -ForegroundColor Green
    Write-Host "    Public IP : $ip"
    Write-Host "    SSH       : ssh $AdminUsername@$ip"
    Write-Host ""
    Write-Host "TeamViewer Host installs + enrolls via cloud-init (~2-3 min after boot)." -ForegroundColor Yellow
    Write-Host "Then, ON YOUR LAPTOP, run the demo (see README 'Azure Demo')." -ForegroundColor Yellow
    Write-Host ""
    if ([string]::IsNullOrWhiteSpace($AssignmentToken)) {
        Write-Host "Enroll the VM into your TeamViewer account (run on the VM via SSH):" -ForegroundColor Cyan
        Write-Host "    sudo teamviewer assignment --id <your-assignment-token>" -ForegroundColor Gray
        Write-Host ""
    }
    Write-Host "Cleanup when done:  az group delete --name $ResourceGroup --yes --no-wait" -ForegroundColor DarkGray
}
finally {
    Remove-Item $tmpFile -ErrorAction SilentlyContinue
}
