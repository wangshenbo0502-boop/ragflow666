$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$compose = @('compose', '--env-file', (Join-Path $projectRoot 'docker\.env'),
    '-f', (Join-Path $projectRoot 'docker\docker-compose.yml'),
    '-f', (Join-Path $projectRoot '.cache\compose.local-startup.yml'),
    '--profile', 'cpu')
& docker @compose stop
if ($LASTEXITCODE -ne 0) { throw 'Project stop failed.' }
$stateFile = Join-Path $projectRoot '.run\qwen3tts\process.json'
if (Test-Path -LiteralPath $stateFile) {
    $state = Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    $ownedProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    $expectedPath = Join-Path $projectRoot '.run\qwen3tts\speech\speech.exe'
    if ($ownedProcess -and $ownedProcess.Path -eq $expectedPath -and
        $ownedProcess.StartTime.ToUniversalTime() -eq ([datetime]$state.startedAt).ToUniversalTime()) {
        Stop-Process -Id $ownedProcess.Id -Force
    }
}
$musicStateFile = Join-Path $projectRoot '.run\music\process.json'
if (Test-Path -LiteralPath $musicStateFile) {
    $state = Get-Content -LiteralPath $musicStateFile -Raw | ConvertFrom-Json
    $ownedProcess = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    $expectedPath = Join-Path $projectRoot '.run\music\bin\ace-server.exe'
    if ($ownedProcess -and $ownedProcess.Path -eq $expectedPath -and
        $ownedProcess.StartTime.ToUniversalTime() -eq ([datetime]$state.startedAt).ToUniversalTime()) {
        Stop-Process -Id $ownedProcess.Id -Force
    }
}
& (Join-Path $PSScriptRoot 'start-local-reranker.ps1') -Stop
Write-Output 'Project, speech, singing and reranker stopped. Data volumes retained.'
