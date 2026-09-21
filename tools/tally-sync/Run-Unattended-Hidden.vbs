Option Explicit
Dim shell, fso, folder, book, ps1, command
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
folder = fso.GetParentFolderName(WScript.ScriptFullName)
If WScript.Arguments.Count <> 1 Then WScript.Quit 2
book = LCase(WScript.Arguments(0))
If book <> "us" And book <> "india" Then WScript.Quit 2
ps1 = fso.BuildPath(folder, "unattended-cycle.ps1")
command = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & ps1 & """ -Book " & book
WScript.Quit shell.Run(command, 0, True)
