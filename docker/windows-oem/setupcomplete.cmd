@echo off
REM =====================================================================
REM setupcomplete.cmd — runs ONCE as SYSTEM at the end of Windows Setup.
REM
REM It only hands over to Unattend.vbs — the SAME hidden launcher the
REM oobeSystem FirstLogonCommand uses (S4). Batch is a bad place for
REM capability installs and downloads, and a failing line here must be
REM visible in C:\Windows\Setup\Scripts\cua-setup.log rather than in a
REM console that nobody sees.
REM =====================================================================
set LOG=C:\Windows\Setup\Scripts\cua-setup.log
echo === setupcomplete %DATE% %TIME% === >> "%LOG%"
REM No arguments: the script is idempotent through C:\cua-provision.json, so the
REM run at first logon skips whatever this SYSTEM pass already finished.
REM wscript (not cscript) keeps the window hidden; Unattend.vbs waits and
REM returns cua-firstboot.ps1's exit code, which is logged and passed through.
wscript //nologo "C:\Windows\Setup\Scripts\Unattend.vbs" >> "%LOG%" 2>&1
set CUA_EXIT=%ERRORLEVEL%
echo === setupcomplete exit %CUA_EXIT% === >> "%LOG%"
REM EXIT PASSTHROUGH. SetupComplete.cmd runs once and Setup ignores a non-zero
REM exit, but the log and the first-logon launcher must still see the truth.
exit /b %CUA_EXIT%
