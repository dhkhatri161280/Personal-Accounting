' Routes through run-scheduled.ps1 (not auto-capture.mjs directly) so sync-log.txt and
' last-sync-status.json stay current -- same pattern as ../excel-sync/silent-launch.vbs.
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
    "C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\costco-receipts\run-scheduled.ps1""", _
    0, False
Set shell = Nothing
