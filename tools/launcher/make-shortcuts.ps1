# 在桌面创建/刷新两个快捷方式。项目文件夹挪走之后重跑一次这个就行。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$desktop = [Environment]::GetFolderPath('Desktop')
$ico = Join-Path $root 'huchuan.ico'
$shell = New-Object -ComObject WScript.Shell

function Make([string]$name, [string]$vbs, [string]$desc) {
    $lnk = $shell.CreateShortcut((Join-Path $desktop ($name + '.lnk')))
    # 指向 wscript 而不是 powershell：只有它能让双击后一个黑框都不闪
    $lnk.TargetPath = Join-Path $env:windir 'System32\wscript.exe'
    $lnk.Arguments = '"' + (Join-Path $PSScriptRoot $vbs) + '"'
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$ico,0"
    $lnk.Description = $desc
    $lnk.WindowStyle = 7
    $lnk.Save()
    Write-Host "桌面已生成：$name"
}

Make '互传（自用版）' 'huchuan-launch.vbs' '启动互传服务，并在默认浏览器打开网页端'
Make '停止互传服务' 'huchuan-stop.vbs' '关闭后台运行的互传服务'
