Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appRoot = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = appRoot
command = "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & appRoot & "\Start-WorkTimeTracker.ps1"""
shell.Run command, 0, False
