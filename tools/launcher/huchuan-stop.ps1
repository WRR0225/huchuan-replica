# 停掉由桌面快捷方式后台拉起的那个 node 服务。
# 用「启动互传.bat」起的不要走这里 —— 那种直接关掉它的黑窗口就行。
$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$pidFile = Join-Path $root 'run\server.pid'

function Notify($text) {
    if ([Console]::IsOutputRedirected) { Write-Host $text; return }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($text, '互传（自用版）') | Out-Null
}

$stopped = $false
$id = (Get-Content $pidFile | Select-Object -First 1)
if ($id) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$id"
    # PID 可能已被系统回收给别的进程，只认 node.exe
    if ($proc -and $proc.Name -eq 'node.exe') { Stop-Process -Id $id -Force; $stopped = $true }
}
Remove-Item $pidFile -Force

if ($stopped) { Notify '互传服务已停止。' }
else { Notify '后台没有正在运行的互传服务。' }
