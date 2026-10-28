' HuChuan desktop launcher: start the LAN server silently if needed, then open the web UI.
' Keep this file ASCII-only - WSH reads .vbs as ANSI. The .lnk carries the Chinese name.
Dim sh, dir, ps
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
ps = dir & "\huchuan-start.ps1"
' window style 0 = no console flash, waitOnReturn False = double click returns at once
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps & """", 0, False
