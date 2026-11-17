$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $projectRoot '.run\qwen3tts'
$watchScript = Join-Path $PSScriptRoot 'watch-local-qwen.ps1'
$compose = @('compose', '--env-file', (Join-Path $projectRoot 'docker\.env'),
    '-f', (Join-Path $projectRoot 'docker\docker-compose.yml'),
    '-f', (Join-Path $projectRoot '.cache\compose.local-startup.yml'),
    '--profile', 'cpu')
$modelDnsOverride = & (Join-Path $PSScriptRoot 'resolve-local-model-dns.ps1')
if ($modelDnsOverride) {
    $compose += @('-f', $modelDnsOverride)
}

& (Join-Path $PSScriptRoot 'start-local-reranker.ps1')
& docker @compose up -d
if ($LASTEXITCODE -ne 0) { throw 'Project startup failed.' }

$ready = $false
$lockFile = Join-Path $runtime 'watch.lock'
if (Test-Path -LiteralPath $lockFile) {
    try {
        $probe = [IO.File]::Open($lockFile, 'Open', 'ReadWrite', 'None')
        $probe.Dispose()
    } catch [IO.IOException] {
        $ready = $true
    }
}
if (-not $ready) {
    $shellExecutable = (Get-Process -Id $PID).Path
    Start-Process -FilePath $shellExecutable -WorkingDirectory $projectRoot `
        -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$watchScript`"") `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $runtime 'watch.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'watch.stderr.log') | Out-Null
}
for ($attempt = 0; $attempt -lt 60; $attempt++) {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:18880/health' -TimeoutSec 2
        $musicHealth = Invoke-RestMethod 'http://127.0.0.1:18881/health' -TimeoutSec 2
        $rerankHealth = Invoke-RestMethod 'http://127.0.0.1:8082/health' -TimeoutSec 2
        $projectHealth = Invoke-RestMethod 'http://localhost/api/v1/system/healthz' -TimeoutSec 2
        if ($health.status -eq 'ok' -and $musicHealth.status -eq 'ok' -and
            $rerankHealth.status -eq 'ok' -and $projectHealth.status -eq 'ok') {
            Write-Output 'Project: http://localhost/ ; speech, singing and reranker ready (stop with project).'
            return
        }
    } catch { }
    Start-Sleep -Seconds 2
}
throw 'Project, speech, music or reranker did not become ready. Check container, .run/qwen3tts, .run/music and .cache/reranker logs.'
