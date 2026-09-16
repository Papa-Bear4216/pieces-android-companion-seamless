# Runs every 2 minutes (PiecesAndroidProxyWatchdog scheduled task).
#
# The proxy's own server.ts installs a process-wide uncaughtException handler
# that swallows every error to "stay alive". Under real phone traffic (flaky
# wifi, app backgrounding, half-open sockets) this trades a clean crash for a
# wedged process: still LISTENING on 8787, Node event loop stalled, every
# request - even the no-op /mobile/health - hangs until the client times out.
# The scheduled task's RestartCount only fires when the process EXITS, which a
# wedged process never does. This watchdog is the missing piece: detect the
# wedge from outside and force a restart.
#
# Deliberately dumb and self-contained: two short health probes, and only if
# BOTH fail does it recycle the proxy. One transient failure (PiecesOS
# restarting, a GC pause) is ignored.

$ErrorActionPreference = 'Continue'

$HealthUrl = 'http://127.0.0.1:8787/mobile/health'
$TaskName  = 'PiecesAndroidProxy'
$LogFile   = Join-Path $env:USERPROFILE '.claude\pieces-proxy-watchdog.log'

function Log($msg) {
    try { "$(Get-Date -Format o)  $msg" | Out-File -FilePath $LogFile -Append -Encoding utf8 } catch {}
}

function Test-ProxyHealthy {
    try {
        $r = Invoke-WebRequest -Uri $HealthUrl -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -eq 200 -and $r.Content -match '"ok"\s*:\s*true')
    } catch {
        return $false
    }
}

$PiecesHealthUrl = 'http://127.0.0.1:39300/.well-known/health'
$PiecesAppId    = 'com.MeshIntelligentTechnologi.PiecesOS_84gz00a5z79wr!osserver'

function Test-PiecesHealthy {
    try {
        $r = Invoke-WebRequest -Uri $PiecesHealthUrl -TimeoutSec 5 -UseBasicParsing
        return ($r.StatusCode -eq 200 -and $r.Content -match 'ok')
    } catch {
        return $false
    }
}

# --- 1. Pieces OS Check ---
$piecesOk = Test-PiecesHealthy
if (-not $piecesOk) {
    Start-Sleep -Seconds 5
    $piecesOk = Test-PiecesHealthy
}

if (-not $piecesOk) {
    Log "PiecesOS unhealthy on port 39300"
    $osProc = Get-Process -Name "os_server" -ErrorAction SilentlyContinue | Select-Object -First 1
    $shouldRelaunch = $true
    if ($osProc) {
        try {
            $uptime = (Get-Date) - $osProc.StartTime
            # PiecesOS has a known 20-30s slow-bind bug after launch; allow 75s grace period under load
            if ($uptime.TotalSeconds -lt 75) {
                Log "os_server PID $($osProc.Id) started $([int]$uptime.TotalSeconds)s ago (within 75s boot grace) - waiting"
                $shouldRelaunch = $false
            } else {
                Log "killing wedged os_server PID $($osProc.Id) (running $([int]$uptime.TotalSeconds)s without binding port)"
                Stop-Process -Id $osProc.Id -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        } catch {
            Log "error inspecting os_server process: $($_.Exception.Message)"
        }
    }
    if ($shouldRelaunch) {
        $aliasPath = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\com.MeshIntelligentTechnologi.PiecesOS_84gz00a5z79wr\os_server.exe'
        if (Test-Path $aliasPath) {
            Log "launching Pieces OS via AppExecutionAlias: $aliasPath"
            try {
                Start-Process $aliasPath
                Log "Pieces OS alias launch command issued"
            } catch {
                Log "failed to launch Pieces OS via alias: $($_.Exception.Message)"
            }
        } else {
            Log "launching Pieces OS Store package via explorer"
            try {
                Start-Process "explorer.exe" "shell:AppsFolder\$PiecesAppId"
                Log "Pieces OS launch command issued"
            } catch {
                Log "failed to launch Pieces OS: $($_.Exception.Message)"
            }
        }
    }
}

# --- 2. Proxy Check ---
$proxyOk = Test-ProxyHealthy
if (-not $proxyOk) {
    Start-Sleep -Seconds 5
    $proxyOk = Test-ProxyHealthy
}

if (-not $proxyOk) {
    Log "proxy unhealthy on both probes - recycling"

    # Stop the task, then hard-kill anything still holding 8787 (the wedged process
    # will not exit on Stop-ScheduledTask alone).
    try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue } catch {}
    Start-Sleep -Seconds 2

    try {
        $lines = & netstat -ano -p TCP | Select-String ':8787\s+.*LISTENING'
        foreach ($ln in $lines) {
            $stalePid = ($ln.ToString() -split '\s+')[-1]
            if ($stalePid -match '^\d+$') {
                Log "killing pid $stalePid holding :8787"
                & taskkill /F /T /PID $stalePid 2>&1 | Out-Null
            }
        }
    } catch { Log "port cleanup error: $($_.Exception.Message)" }

    Start-Sleep -Seconds 2
    try { Start-ScheduledTask -TaskName $TaskName -ErrorAction Stop; Log "restart issued" }
    catch { Log "FAILED to start task: $($_.Exception.Message)"; exit 1 }

    # Give it time to come back and record the outcome.
    Start-Sleep -Seconds 25
    if (Test-ProxyHealthy) { Log "recovered" } else { Log "still unhealthy after restart - will retry next run" }
}

exit 0
