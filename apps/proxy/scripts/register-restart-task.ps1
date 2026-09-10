# Run this ONCE, in an ELEVATED PowerShell window (Run as Administrator).
# After this, restarting the proxy after a code change never needs elevation
# again - trigger it with the unprivileged `Start-ScheduledTask -TaskName
# "PiecesAndroidProxyRestart"`, and Task Scheduler (which already holds an
# elevated S4U token for this account) does the actual process kill.
#
# On-demand only - no recurring trigger. Registered with a trigger so it has
# one (Task Scheduler requires at least one), but that trigger fires far in
# the past and never recurs; the task is meant to be started manually/by us.

# $PSScriptRoot is this file's own directory (apps/proxy/scripts) - deriving
# ProxyDir from it instead of a hardcoded absolute path ensures portability.
$ProxyDir = Split-Path -Parent $PSScriptRoot
$scriptPath = Join-Path $ProxyDir "scripts\restart-proxy.ps1"
$argumentString = '-ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $scriptPath + '"'

$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $argumentString
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date -Year 2020 -Month 1 -Day 1)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId "$env:COMPUTERNAME\$env:USERNAME" -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName "PiecesAndroidProxyRestart" -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description "On-demand elevated restart of PiecesAndroidProxy. Trigger with Start-ScheduledTask (no elevation needed to trigger it - only the task's own execution is elevated)." -Force

Write-Output "Registered PiecesAndroidProxyRestart."
Write-Output "From now on, restart the proxy from any shell (no elevation needed) with:"
Write-Output '  Start-ScheduledTask -TaskName "PiecesAndroidProxyRestart"'
Write-Output "Wait ~3 seconds after triggering, then check with:"
Write-Output '  Get-ScheduledTask -TaskName "PiecesAndroidProxy" | Select-Object State'
