@echo off
REM =====================================================================
REM setupcomplete.cmd — runs ONCE as SYSTEM at the end of Windows Setup.
REM
REM It only hands over to PowerShell: batch is a bad place for capability
REM installs and downloads, and a failing line here must be visible in
REM C:\Windows\Setup\Scripts\cua-setup.log rather than in a console that
REM nobody sees.
REM =====================================================================
set LOG=C:\Windows\Setup\Scripts\cua-setup.log
echo === setupcomplete %DATE% %TIME% === >> "%LOG%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "& 'C:\Windows\Setup\Scripts\cua-firstboot.ps1' -Mode Setup *>> '%LOG%'"
echo === setupcomplete exit %ERRORLEVEL% === >> "%LOG%"
exit /b 0
