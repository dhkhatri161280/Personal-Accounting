' Routes through run-scheduled.ps1 (not run-excel-updater.ps1 directly) so the sync-log.txt
' and last-sync-status.json wrapper still runs -- calling the raw updater skipped both.
Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & _
    "C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\excel-sync\run-scheduled.ps1""", _
    0, False
Set shell = Nothing
