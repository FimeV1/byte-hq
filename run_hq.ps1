# Windows: run HQ in the background with its config (%USERPROFILE%\.config\hq-app\config.json, or $env:HQ_CONFIG)
# until it is stopped or the computer restarts. Closing this window doesn't stop it. Log: %USERPROFILE%\hq-app.log
#   powershell -NoProfile -ExecutionPolicy Bypass -File run_hq.ps1
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$Log = if ($env:HQ_LOG) { $env:HQ_LOG } else { Join-Path $env:USERPROFILE 'hq-app.log' }
# Stop the previous HQ, but only if that process id still belongs to HQ: a stale id can be another program by now.
if (Test-Path hq.pid) {
  $old = (Get-Content hq.pid -ErrorAction SilentlyContinue | Select-Object -First 1)
  if ($old -match '^\d+$') {
    $p = Get-CimInstance Win32_Process -Filter "ProcessId=$old" -ErrorAction SilentlyContinue
    if ($p -and $p.CommandLine -like '*server.mjs*') { Stop-Process -Id $old -Force -ErrorAction SilentlyContinue; Start-Sleep -Milliseconds 500 }
  }
}
$node = (Get-Command node -ErrorAction Stop).Source
# Started through cmd, which writes the log itself: with PowerShell's own -RedirectStandardOutput, HQ would inherit
# this window's handles, and anything waiting on this script's output would wait as long as HQ runs.
$cmd = Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c `"`"$node`" server.mjs >> `"$Log`" 2>&1`"" `
  -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
# hq.pid is node's id (cmd only waits for it), so the next run stops HQ itself.
$hq = $null
for ($i = 0; $i -lt 40 -and -not $hq; $i++) {
  Start-Sleep -Milliseconds 250
  $hq = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($cmd.Id)" -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'node.exe' } | Select-Object -First 1
}
if ($hq) { Set-Content hq.pid $hq.ProcessId } else { Write-Host "HQ didn't start. See $Log"; exit 1 }
