# Run this once, in an ELEVATED PowerShell window (Run as Administrator).
# Registers the Plan A proxy as a Windows scheduled task.
#
# Three modes, controlled by the $Mode variable below:
#
#   "LogonOnly" (previous default) - "run only when logged on", mirrors the
#   tool-registry heartbeat's -AtLogOn pattern. No stored credentials needed.
#   Trade-off: proxy is unavailable whenever you are logged out or the PC
#   is at the sign-in screen after a reboot.
#
#   "S4U" (current default) - runs at boot AND at logon, using Windows'
#   Service-For-User logon type. No stored password needed - Windows mints
#   a token for the account instead of authenticating with a password. This
#   is the mode to use given the account is intentionally passwordless.
#   Caveat: has not been proven to survive an unattended reboot yet: if the
#   proxy directory ever becomes a OneDrive Files-On-Demand placeholder
#   (cloud-only, not hydrated), node/npx will fail to read it at pre-login
#   boot. Verified hydrated as of 2026-07-26 (Attributes: Archive, no
#   Offline/reparse flag) - re-check if this ever moves or OneDrive frees
#   space. See docs/ACCEPTANCE.md for the actual reboot-without-login test.
#
#   "LoggedOutWithPassword" - "run whether user is logged on or not" using a
#   real stored password. Not used here - the Microsoft account is
#   deliberately passwordless (a prior unauthorized-access incident is why),
#   and adding a password back just to satisfy this would undo that. Kept
#   only for reference in case that decision changes later.
#
# Switching modes later is safe: change $Mode and re-run this script.
# Register-ScheduledTask -Force overwrites the existing task definition in
# place - no need to unregister first, no effect on the proxy code itself.

$Mode = "S4U"

# $PSScriptRoot is this file's own directory (apps/proxy/scripts) - deriving
# ProxyDir from it instead of a hardcoded absolute path ensures portability.
$ProxyDir = Split-Path -Parent $PSScriptRoot
$TokenFile = Join-Path $ProxyDir ".bearer-token"

if (-not (Test-Path $TokenFile)) {
    Write-Output "No token file found at $TokenFile - generating one now."
    $token = node (Join-Path $ProxyDir "scripts\generate-token.mjs")
    Set-Content -Path $TokenFile -Value $token -NoNewline
    Write-Output "Token generated and saved. This is the value to enter in the phone's Setup screen:"
    Write-Output $token
} else {
    Write-Output "Using existing token at $TokenFile (delete it first if you want a fresh one)."
}

$wrapperPath = Join-Path $ProxyDir "scripts\service-wrapper.ps1"
$argumentString = '-ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $wrapperPath + '"'

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argumentString
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

if ($Mode -eq "LoggedOutWithPassword") {
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $cred = Get-Credential -Message "Enter your Windows account password - needed so this task can run even when you are logged out"
    Register-ScheduledTask -TaskName "PiecesAndroidProxy" -Action $action -Trigger $trigger -Settings $settings -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Description "Runs the pieces-android LAN proxy (port 8787) continuously, including while logged out. Required for Plan B (remote gateway) to reach it." -Force
} elseif ($Mode -eq "S4U") {
    $triggerBoot = New-ScheduledTaskTrigger -AtStartup
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
    $principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType S4U -RunLevel Highest
    Register-ScheduledTask -TaskName "PiecesAndroidProxy" -Action $action -Trigger @($triggerBoot, $triggerLogon) -Settings $settings -Principal $principal -Description "Runs the pieces-android LAN proxy (port 8787) at boot and at logon, no stored password (S4U). Verify with the reboot-without-login test in docs/ACCEPTANCE.md." -Force
} else {
    $trigger = New-ScheduledTaskTrigger -AtLogOn
    Register-ScheduledTask -TaskName "PiecesAndroidProxy" -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Description "Runs the pieces-android LAN proxy (port 8787) while logged on." -Force
}

Write-Output ""
Write-Output "Task registered: PiecesAndroidProxy (mode: $Mode)."
Write-Output "Starting it immediately..."
Start-ScheduledTask -TaskName "PiecesAndroidProxy"

Write-Output "To check status, run: Get-ScheduledTask -TaskName PiecesAndroidProxy | Get-ScheduledTaskInfo"
Write-Output "To check principal, run: (Get-ScheduledTask -TaskName PiecesAndroidProxy).Principal | Format-List"
Write-Output "To remove it later, run: Unregister-ScheduledTask -TaskName PiecesAndroidProxy -Confirm:0"
