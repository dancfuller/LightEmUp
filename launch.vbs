' LightEmUp - Silent Launcher
' Double-click this (or point a shortcut at it) to start LightEmUp
' without any console window flashing.

Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
shell.Run "powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\launch.ps1""", 0, False
