# HQ installer for Windows 10 and 11, in PowerShell:
#   irm https://raw.githubusercontent.com/FimeV1/byte-hq/main/install.ps1 | iex
#
# 1. checks Git for Windows and Node.js 22+ (it never installs those: they need an installer and your admin rights)
# 2. installs OpenCode 2 if it's missing, with OpenCode's own installer run in Git Bash (asks before replacing OpenCode 1)
# 3. downloads HQ to %USERPROFILE%\hq ($env:HQ_DIR to choose), or updates it if it's already there
# 4. starts an OpenCode server on this computer (run_opencode.ps1) and runs HQ's setup with its address and password
# 5. builds HQ and offers to start it
# Never asks for admin rights and never changes your PowerShell settings. Run it again any time to update.
& {
  $ErrorActionPreference = 'Stop'
  $Repo = if ($env:HQ_REPO) { $env:HQ_REPO } else { 'https://github.com/FimeV1/byte-hq.git' }
  $UserHome = $env:USERPROFILE
  $Dir = if ($env:HQ_DIR) { $env:HQ_DIR } else { Join-Path $UserHome 'hq' }
  $Config = if ($env:HQ_CONFIG) { $env:HQ_CONFIG } else { Join-Path $UserHome '.config\hq-app\config.json' }

  function Step([string]$t) { Write-Host ''; Write-Host $t -ForegroundColor Cyan }
  # Pasted into an open PowerShell window, a plain `exit` would close it: stop by throwing instead.
  function Stop-Install([string]$m) { throw (New-Object System.Exception ("HQ-STOP:" + $m)) }
  function Ask-YesNo([string]$q, [string]$def = 'y') {
    $a = Read-Host ("$q " + $(if ($def -eq 'y') { '[Y/n]' } else { '[y/N]' }))
    if (-not $a) { $a = $def }
    return ($a -match '^[yY]')
  }
  function Get-Major([string]$exe) {
    $ErrorActionPreference = 'Continue'
    try { $v = (& $exe --version 2>&1 | Select-Object -First 1) } catch { return 0 }
    if ("$v" -match '(\d+)\.') { return [int]$Matches[1] } else { return 0 }
  }
  # Output of a program whose errors are expected (it may print to stderr): never stops the script.
  function Get-Out([scriptblock]$sb) { $ErrorActionPreference = 'Continue'; try { "$(& $sb 2>$null)" } catch { '' } }
  function Get-Version([string]$exe) { $ErrorActionPreference = 'Continue'; try { "$(& $exe --version 2>&1 | Select-Object -First 1)" } catch { '?' } }
  # Run a program; stop with a clear message when it fails (PowerShell itself doesn't stop on a failing program).
  function Run([string]$what, [scriptblock]$sb) {
    & $sb
    if ($LASTEXITCODE -ne 0) { Stop-Install "$what failed (exit code $LASTEXITCODE; see the messages above)." }
  }
  # Scripts in the HQ folder run with ExecutionPolicy Bypass for that one process: Windows blocks .ps1 files by default.
  # Started without capturing its output: the server it leaves running would inherit that pipe, and this installer
  # would wait for the pipe to close, i.e. forever (found testing on Windows 11).
  function Run-Script([string]$file) {
    $p = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"" -NoNewWindow -PassThru
    $null = $p.Handle   # Windows PowerShell 5.1 loses the exit code unless the handle is read while the process runs
    $p.WaitForExit()
    return $p.ExitCode
  }

  try {
    Step 'Checking this computer'
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Stop-Install "Git is missing. Install Git for Windows from https://git-scm.com/download/win (keep the default options), open a new PowerShell window and run this again." }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Install "Node.js is missing. Install Node.js 22 or newer from https://nodejs.org, open a new PowerShell window and run this again." }
    if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Stop-Install "npm is missing (it comes with Node.js from https://nodejs.org)." }
    $nodeMajor = [int]((& node -p "process.versions.node.split('.')[0]") | Select-Object -First 1)
    if ($nodeMajor -lt 22) { Stop-Install "HQ needs Node.js 22 or newer; this is $(& node --version). Update it from https://nodejs.org." }
    $gitExe = (Get-Command git).Source
    $bash = @((Join-Path (Split-Path (Split-Path $gitExe)) 'bin\bash.exe'), (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')) |
      Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    Write-Host "Git, Node.js $(& node --version): ok"

    Step 'OpenCode'
    $OC = $null; $Old = $null
    $cands = @(Get-Command opencode -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source }) + @(Join-Path $UserHome '.opencode\bin\opencode.exe')
    foreach ($c in $cands) {
      if (-not $c -or -not (Test-Path $c)) { continue }
      if ((Get-Major $c) -ge 2) { $OC = $c; break }
      if (-not $Old) { $Old = $c }
    }
    if ($OC) {
      Write-Host "Found $(Get-Version $OC) at $OC"
    } else {
      if ($Old) {
        Write-Host "Found $(Get-Version $Old) at $Old, but HQ needs OpenCode 2."
        Write-Host "Installing OpenCode 2 puts it in $UserHome\.opencode\bin, replacing OpenCode 1 there if that's where it is."
        Write-Host "If you rely on your OpenCode 1 setup, read https://opencode.ai/v2/docs first."
        if (-not (Ask-YesNo 'Install OpenCode 2 now?' 'n')) { Stop-Install "OpenCode 2 is needed. See https://opencode.ai/v2/docs to install it yourself." }
      } else {
        Write-Host "OpenCode isn't installed: installing OpenCode 2 with its own installer (https://opencode.ai/v2/install), in Git Bash."
      }
      if (-not $bash) { Stop-Install "Git Bash wasn't found (it comes with Git for Windows). Reinstall Git for Windows with its default options, then run this again." }
      $oldHome = $env:HOME
      $env:HOME = $UserHome
      try { Run 'Installing OpenCode 2' { & $bash -c 'curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path' } }
      finally { $env:HOME = $oldHome }
      $OC = Join-Path $UserHome '.opencode\bin\opencode.exe'
      if (-not (Test-Path $OC) -or (Get-Major $OC) -lt 2) { Stop-Install "OpenCode 2 didn't install. See https://opencode.ai/v2/docs" }
      Write-Host "Installed $(Get-Version $OC) at $OC (HQ starts it by its full path; add $UserHome\.opencode\bin to your PATH to type 'opencode' yourself)."
    }
    $env:HQ_OPENCODE_BIN = $OC

    Step 'HQ'
    if (Test-Path (Join-Path $Dir '.git')) {
      $origin = Get-Out { & git -C $Dir remote get-url origin }
      if ($origin -notlike '*byte-hq*' -and $origin -ne $Repo) { Stop-Install "$Dir is a different git repository. Choose another folder: `$env:HQ_DIR = 'C:\somewhere'; then run this again." }
      if (Get-Out { & git -C $Dir status --porcelain --untracked-files=no }) { Stop-Install "$Dir has local changes; commit or stash them, then run this again." }
      Write-Host "Updating $Dir"
      Run "Updating HQ (if you changed files there, move them aside)" { & git -C $Dir pull --ff-only }
    } elseif ((Test-Path $Dir) -and (Get-ChildItem -Force $Dir | Select-Object -First 1)) {
      Stop-Install "$Dir already exists and isn't HQ. Choose another folder: `$env:HQ_DIR = 'C:\somewhere'; then run this again."
    } else {
      Write-Host "Downloading HQ to $Dir"
      Run 'Downloading HQ' { & git clone $Repo $Dir }
    }
    Set-Location $Dir
    Run 'Installing packages (npm ci)' { & npm.cmd ci --no-fund --no-audit }

    Step 'Starting an OpenCode server for HQ'
    if ((Run-Script (Join-Path $Dir 'run_opencode.ps1')) -ne 0) { Stop-Install "the OpenCode server didn't start (see the message above)." }
    $ocPort = if ($env:OPENCODE_PORT) { $env:OPENCODE_PORT } else { '4096' }
    $ocEnv = if ($env:HQ_OPENCODE_ENV) { $env:HQ_OPENCODE_ENV } else { Join-Path $UserHome '.config\hq-app\opencode.env' }

    Step 'Setup'
    $runSetup = $true
    if (Test-Path $Config) {
      Write-Host "HQ is already set up ($Config)."
      $runSetup = Ask-YesNo 'Run setup again? (your current settings are backed up first)' 'n'
    }
    if ($runSetup) {
      Write-Host 'Answer a few questions; pressing Enter takes the suggestion in [brackets].'
      # The server's address and password go to setup through the environment, so you don't have to type them.
      $env:HQ_SETUP_OPENCODE_URL = "http://127.0.0.1:$ocPort"
      $env:HQ_SETUP_OPENCODE_PASSWORD = ((Get-Content $ocEnv | Where-Object { $_ -like 'OPENCODE_SERVER_PASSWORD=*' } | Select-Object -First 1) -replace '^OPENCODE_SERVER_PASSWORD=', '').Trim()
      try { & npm.cmd run --silent setup }
      finally { Remove-Item Env:HQ_SETUP_OPENCODE_URL, Env:HQ_SETUP_OPENCODE_PASSWORD -ErrorAction SilentlyContinue }
      if (-not (Test-Path $Config)) { Stop-Install "setup didn't write a config. Run it again with: cd $Dir; npm.cmd run setup" }
    }

    Step 'Building'
    Run 'Building HQ' { & npm.cmd run --silent build }

    $cfg = Get-Content $Config -Raw | ConvertFrom-Json
    $l = @($cfg.listen)[0]
    $url = "http://$(if ($l.host) { $l.host } else { '127.0.0.1' }):$(if ($l.port) { $l.port } else { 4110 })"
    Step 'Done'
    if (Ask-YesNo 'Start HQ now?' 'y') {
      Run-Script (Join-Path $Dir 'run_hq.ps1') | Out-Null
      Start-Sleep 2
      Write-Host "HQ is running: open $url and sign in (the login is the one from setup). Closing this window doesn't stop it."
    } else {
      Write-Host "Start it later with: powershell -ExecutionPolicy Bypass -File `"$Dir\run_hq.ps1`"   then open $url"
    }
    Write-Host 'Then: New Project, pick the folder of a git repository, and start a chat. Add your own models in Settings > Models.'
    Write-Host ''
    Write-Host 'After a restart, start both again:'
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$Dir\run_opencode.ps1`""
    Write-Host "  powershell -ExecutionPolicy Bypass -File `"$Dir\run_hq.ps1`""
    Write-Host "To start them when you log in, see the README's `"Keep it running`". Logs: $UserHome\hq-opencode.log and $UserHome\hq-app.log"
    Write-Host 'To update HQ later, run this installer again.'
  } catch {
    $m = $_.Exception.Message
    if ($m -like 'HQ-STOP:*') { $m = $m.Substring(8) }
    Write-Host ''
    Write-Host "HQ install stopped: $m" -ForegroundColor Red
  }
}
