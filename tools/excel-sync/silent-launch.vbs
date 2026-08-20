Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "powershell.exe -ExecutionPolicy Bypass -File """ & _
    "C:\Users\dikhatri\Documents\Codex\personal-accounting-app\tools\run-excel-updater.ps1""", _
    0, False
Set shell = Nothing
