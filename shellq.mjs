// Quoting and wrapping for the commands HQ runs on a machine through OpenCode's shell API.
//
// Mac / Linux: the user's POSIX shell. Single quotes expand nothing (double quotes still run `...` and $(...)).
//
// Windows: OpenCode runs commands through cmd.exe in a way that hands quoted arguments to programs WITH their quotes
// (tested 2026-11-17 on OpenCode 2.2.7 and 2.3.0: `node -p "1+1"` prints 1+1, and `git diff --output "C:\x.patch"`
// fails on a file name with quotes in it). So HQ's own commands go to Windows PowerShell as -EncodedCommand instead:
// the encoded text is only letters, digits, + / and =, which cmd passes through untouched, and inside it arguments
// use PowerShell single quotes, which are literal (nothing in a path or a commit message can run as code).
// Commands the user wrote (a project's test command, release commands) are NOT wrapped: they run as typed, in cmd.

export const isWindows = (dir) => /^[A-Za-z]:[\\/]/.test(String(dir || ""));
export const qPosix = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
export const qPs = (s) => `'${String(s).replace(/'/g, "''")}'`;
/** The quoting for arguments in HQ's own commands run in `dir` (wrap the command with forShell). */
export const quoter = (dir) => (isWindows(dir) ? qPs : qPosix);

/**
 * The command to send for `dir`'s machine: unchanged on Mac / Linux; on Windows, the PowerShell command wrapped so
 * cmd can't mangle it. Native stderr lines come out as plain text (not PowerShell error records), output is UTF-8,
 * and the exit code is the last program's.
 */
export function forShell(dir, command) {
  if (!isWindows(dir)) return command;
  const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; $global:LASTEXITCODE = 0; " +
    `& { ${command} } 2>&1 | ForEach-Object { "$_" }; exit $LASTEXITCODE`;
  return `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(ps, "utf16le").toString("base64")}`;
}
