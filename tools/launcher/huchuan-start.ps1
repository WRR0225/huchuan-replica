# 互传（自用版）桌面启动器：服务没在跑就后台静默拉起，然后在默认浏览器里打开网页端。
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$run  = Join-Path $root 'run'
$port = 8787
$url  = "http://localhost:$port/"

function Test-Port {
    $c = New-Object Net.Sockets.TcpClient
    try { $c.Connect('127.0.0.1', $port); $true } catch { $false } finally { $c.Close() }
}

function Notify($text) {
    # 双击快捷方式时没有控制台，只能弹框；在终端里跑就直接打印，方便调试
    if ([Console]::IsOutputRedirected) { Write-Host $text; return }
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($text, '互传（自用版）') | Out-Null
}

# 整个脚本是隐藏窗口跑的，异常没人看得见，所以兜底成一句人话
try {
    if (-not (Test-Port)) {
        $node = (Get-Command node -ErrorAction SilentlyContinue).Source
        if (-not $node) { $node = 'C:\Program Files\nodejs\node.exe' }
        if (-not (Test-Path $node)) { throw '找不到 node.exe，请先安装 Node.js。' }

        New-Item -ItemType Directory -Force -Path $run | Out-Null
        $log = Join-Path $run 'server.log'
        $errlog = Join-Path $run 'server.err.log'
        $p = Start-Process -FilePath $node -ArgumentList 'index.js' `
            -WorkingDirectory (Join-Path $root 'server') -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $log -RedirectStandardError $errlog
        Set-Content -Path (Join-Path $run 'server.pid') -Value $p.Id

        for ($i = 0; $i -lt 30 -and -not (Test-Port); $i++) { Start-Sleep -Milliseconds 200 }
        if (-not (Test-Port)) {
            $tail = if ((Get-Item $errlog -ErrorAction SilentlyContinue).Length -gt 0) {
                (Get-Content $errlog -Tail 5) -join "`n"
            } else { '（服务没有输出任何日志）' }
            throw "端口 $port 没有监听。`n`n$tail"
        }
    }
    Start-Process $url
} catch {
    Notify "互传服务没能启动：$($_.Exception.Message)"
    exit 1
}
