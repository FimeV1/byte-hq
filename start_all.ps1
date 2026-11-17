# Windows: start OpenCode and then HQ in the background, e.g. from a Task Scheduler "At log on" task
# (README › Keep it running). Each one keeps running after this script ends.
#   powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\Users\<you>\hq\start_all.ps1"
foreach ($s in 'run_opencode.ps1', 'run_hq.ps1') {
  $p = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSScriptRoot\$s`"" -NoNewWindow -PassThru
  $null = $p.Handle   # Windows PowerShell 5.1 loses the exit code unless the handle is read while the process runs
  $p.WaitForExit()
  if ($p.ExitCode -ne 0) { Write-Host "$s failed (exit code $($p.ExitCode))"; exit $p.ExitCode }
}
