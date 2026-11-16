' =====================================================================
' Unattend.vbs — the HIDDEN first-boot launcher (S4).
'
' WHY THIS EXISTS
' ---------------
' FirstLogonCommands and SetupComplete.cmd both need to run
' cua-firstboot.ps1 without showing a console window on the user's
' desktop. A bare `powershell.exe` from FirstLogonCommands flashes a
' console and returns immediately under some media; dockur/windows
' wraps the call in a VBScript launcher instead, which is what this is.
'
' WScript.Shell.Run's third argument asks it to WAIT, and its return
' value is the launched process's exit code — that is the passthrough.
' Window style 0 = hidden. The script is run by both SetupComplete.cmd
' (SYSTEM, end of Setup) and the oobeSystem FirstLogonCommand; the
' PowerShell script is idempotent through C:\cua-provision.json.
' =====================================================================
Option Explicit

Dim shell, exitCode
Set shell = CreateObject("WScript.Shell")

On Error Resume Next
exitCode = shell.Run( _
  "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""C:\Windows\Setup\Scripts\cua-firstboot.ps1""", _
  0, _
  True)
If Err.Number <> 0 Then
  ' A launcher failure must be visible as a NON-ZERO exit, never as
  ' success: SetupComplete.cmd logs the code, and a silent 0 would make
  ' a broken first boot read as a finished one.
  WScript.Echo "cua: first-boot launcher failed: " & Err.Description
  WScript.Quit 1
End If
On Error GoTo 0

WScript.Quit exitCode
