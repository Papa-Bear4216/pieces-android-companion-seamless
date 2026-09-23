# Plan A (LAN) one-shot installer for the pieces-android proxy.
#
# Run this once, in an ELEVATED PowerShell window (Right-click -> Run as
# Administrator). It performs every manual step README.md section 1 lists:
#   1. Verify Node.js is installed.
#   2. `npm install` at the repo root (npm workspaces - this also installs
#      apps/proxy, packages/allowlist, packages/pieces-api together).
#   3. Generate a bearer token if one doesn't already exist
#      (apps/proxy/scripts/register-service.ps1 does this itself).
#   4. Register the proxy as a Windows Scheduled Task (S4U: starts at boot
#      and logon, no stored password) via register-service.ps1.
#   5. Add the Windows Firewall rule restricting port 8787 to the Private
#      network profile via windows-firewall-rule.ps1.
#   6. Print the LAN address + token the phone's Setup screen needs, and
#      offer to show the "Scan to Connect" QR code.
#
# Safe to re-run: every step it wraps is itself idempotent (existing token
# is reused, Register-ScheduledTask -Force overwrites in place, the
# firewall rule create is the only non-idempotent one - see step 5 below).

#Requires -RunAsAdministrator

$ErrorActionPreference = "Stop"

function Write-Step($msg) {
    Write-Output ""
    Write-Output "==> $msg"
}

$RepoRoot = $PSScriptRoot
$ProxyDir = Join-Path $RepoRoot "apps\proxy"
$ScriptsDir = Join-Path $ProxyDir "scripts"

if (-not (Test-Path (Join-Path $ProxyDir "package.json"))) {
    Write-Error "Couldn't find apps\proxy next to this script. Run setup-plan-a.ps1 from the repo root."
    exit 1
}

Write-Step "Checking for Node.js..."
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Error "Node.js not found on PATH. Install Node.js 20+ from https://nodejs.org/ first, then re-run this script."
    exit 1
}
$nodeVersion = (node --version)
Write-Output "Found Node.js $nodeVersion at $($node.Source)"

Write-Step "Installing dependencies (npm install at repo root - this is a workspaces monorepo, one install covers apps/proxy and its local packages)..."
Push-Location $RepoRoot
try {
    npm install
    if ($LASTEXITCODE -ne 0) { throw "npm install failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

Write-Step "Registering the proxy as a Windows Scheduled Task (generates a bearer token first if none exists)..."
& (Join-Path $ScriptsDir "register-service.ps1")

Write-Step "Adding Windows Firewall rule (TCP 8787, Private network profile only)..."
$existingRule = Get-NetFirewallRule -DisplayName "pieces-android proxy (8787, private only)" -ErrorAction SilentlyContinue
if ($existingRule) {
    Write-Output "Firewall rule already exists - skipping (delete it first with Remove-NetFirewallRule if you want it recreated)."
} else {
    & (Join-Path $ScriptsDir "windows-firewall-rule.ps1")
}

Write-Step "Setup complete. Connection details for the phone's Setup screen:"

Start-Sleep -Seconds 2
$TokenFile = Join-Path $ProxyDir ".bearer-token"
$token = if (Test-Path $TokenFile) { (Get-Content $TokenFile -Raw).Trim() } else { "<token file missing - check the registration step above for errors>" }

$ip = (Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue |
    Where-Object { $_.PrefixOrigin -eq 'Dhcp' } | Select-Object -First 1).IPAddress
if (-not $ip) { $ip = "<Wi-Fi not connected - run 'ipconfig' manually and look for your LAN adapter's IPv4 address>" }

Write-Output ""
Write-Output "  Server address: http://${ip}:8787"
Write-Output "  Token:          $token"
Write-Output ""
Write-Output "Open the app -> Setup tab -> enter those two values -> Test & Save."
Write-Output ""
Write-Output "Optional: run apps\proxy\scripts\show-proxy-info.ps1 for a scannable QR code instead of typing these in by hand."
Write-Output "Optional: if you also want remote (Plan B) access away from your home Wi-Fi, see README.md section 2."
