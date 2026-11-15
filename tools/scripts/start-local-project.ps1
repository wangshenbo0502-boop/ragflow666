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

& docker @compose up -d
if ($LASTEXITCODE -ne 0) { throw 'Project startup failed.' }

$ready = $false
$stateFile = Join-Path $runtime 'process.json'
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $ownedProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    $ownedSupervisor = Get-Process -Id $state.supervisorId -ErrorAction SilentlyContinue
    if ($ownedProcess -and $ownedSupervisor -and
        $ownedProcess.Path -eq (Join-Path $runtime 'speech\speech.exe') -and
        $ownedProcess.StartTime.ToUniversalTime() -eq ([datetime]$state.startedAt).ToUniversalTime()) {
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
        $projectHealth = Invoke-RestMethod 'http://localhost/api/v1/system/healthz' -TimeoutSec 2
        if ($health.status -eq 'ok' -and $musicHealth.status -eq 'ok' -and $projectHealth.status -eq 'ok') {
            Write-Output 'Project: http://localhost/ ; speech and singing ready (stop with project).'
            return
        }
    } catch { }
    Start-Sleep -Seconds 2
}
throw 'Project or Qwen did not become ready. Check the container and .run/qwen3tts logs.'
