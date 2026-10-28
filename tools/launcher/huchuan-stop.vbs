' HuChuan desktop stopper: kill the silently-started node server.
' Keep this file ASCII-only - WSH reads .vbs as ANSI.
Dim sh, dir, ps
Set sh = CreateObject("WScript.Shell")
dir = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\") - 1)
ps = dir & "\huchuan-stop.ps1"
sh.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps & """", 0, False
