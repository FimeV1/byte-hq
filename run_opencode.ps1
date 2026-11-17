# Windows: start an OpenCode server for HQ on this computer, in the background: http://127.0.0.1:4096 (or $env:OPENCODE_PORT).
# Its password lives in %USERPROFILE%\.config\hq-app\opencode.env (only your account can read it), made on the first
# run; HQ's setup needs it once. Log: %USERPROFILE%\hq-opencode.log. Run it again after a restart.
#   powershell -NoProfile -ExecutionPolicy Bypass -File run_opencode.ps1
# $env:HQ_OPENCODE_BIN = a specific OpenCode 2 binary.
$ErrorActionPreference = 'Stop'
$UserHome = $env:USERPROFILE
$Port = if ($env:OPENCODE_PORT) { [int]$env:OPENCODE_PORT } else { 4096 }
$EnvFile = if ($env:HQ_OPENCODE_ENV) { $env:HQ_OPENCODE_ENV } else { Join-Path $UserHome '.config\hq-app\opencode.env' }
$Log = if ($env:HQ_OPENCODE_LOG) { $env:HQ_OPENCODE_LOG } else { Join-Path $UserHome 'hq-opencode.log' }

function Get-Major([string]$exe) {
  $ErrorActionPreference = 'Continue'
  try { $v = (& $exe --version 2>&1 | Select-Object -First 1) } catch { return 0 }
  if ("$v" -match '(\d+)\.') { return [int]$Matches[1] } else { return 0 }
}

$OC = $env:HQ_OPENCODE_BIN
if (-not $OC) {
  $cands = @(Get-Command opencode -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) + @(Join-Path $UserHome '.opencode\bin\opencode.exe')
  foreach ($c in $cands) { if ($c -and (Test-Path $c) -and (Get-Major $c) -ge 2) { $OC = $c; break } }
}
if (-not $OC) { Write-Host "OpenCode 2 isn't installed. Install HQ with install.ps1 (it installs OpenCode 2), or see https://opencode.ai/v2/docs"; exit 1 }

if (-not (Test-Path $EnvFile) -or -not (Get-Content $EnvFile -ErrorAction SilentlyContinue)) {
  New-Item -ItemType Directory -Force (Split-Path $EnvFile) | Out-Null
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $pw = ([Convert]::ToBase64String($bytes) -replace '[^A-Za-z0-9]', '').Substring(0, 24)
  [IO.File]::WriteAllText($EnvFile, "OPENCODE_SERVER_PASSWORD=$pw`n")
  # Only this account (and the system) can read it.
  icacls $EnvFile /inheritance:r /grant:r "$($env:USERNAME):F" /grant:r 'SYSTEM:F' | Out-Null
}
$PW = ((Get-Content $EnvFile | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=', '').Trim()
if (-not $PW) { Write-Host "No password in ${EnvFile}: delete the file and run this again."; exit 1 }

# 200 = an OpenCode server that knows this password; 401 = something else is there; 0 = nothing.
$Auth = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$PW")) }
function Get-Status {
  try { return (Invoke-WebRequest -UseBasicParsing -Headers $Auth "http://127.0.0.1:$Port/api/info" -TimeoutSec 3).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { return 0 } }
}
$s = Get-Status
if ($s -eq 200) { Write-Host "OpenCode is already running on http://127.0.0.1:$Port"; exit 0 }
if ($s -ne 0) { Write-Host "Port $Port is taken by another program (or an OpenCode server with another password). Stop it, or set OPENCODE_PORT."; exit 1 }

# The password goes through the environment, never the command line (other programs can read command lines).
# Started through cmd, which writes the log itself: with PowerShell's own -RedirectStandardOutput the server would
# inherit this window's handles, and anything waiting on this script's output would wait as long as the server runs.
$env:OPENCODE_SERVER_PASSWORD = $PW
try {
  Start-Process -FilePath $env:ComSpec -ArgumentList "/d /s /c `"`"$OC`" serve --hostname 127.0.0.1 --port $Port >> `"$Log`" 2>&1`"" `
    -WindowStyle Hidden | Out-Null
} finally { Remove-Item Env:OPENCODE_SERVER_PASSWORD -ErrorAction SilentlyContinue }
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep 1
  if ((Get-Status) -eq 200) { Write-Host "OpenCode is running on http://127.0.0.1:$Port ($OC; log: $Log)"; exit 0 }
}
Write-Host "OpenCode didn't start within 30 seconds. See $Log"
exit 1
