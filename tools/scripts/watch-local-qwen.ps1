$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $projectRoot '.run\qwen3tts'
$executable = Join-Path $runtime 'speech\speech.exe'
$stateFile = Join-Path $runtime 'process.json'
$modelDirectory = Join-Path $runtime 'models'
$containerName = 'docker-ragflow-cpu-1'
$speechProcess = $null
$musicProcess = $null
$musicRuntime = Join-Path $projectRoot '.run\music'
$musicExecutable = Join-Path $musicRuntime 'bin\ace-server.exe'
$musicStateFile = Join-Path $musicRuntime 'process.json'
$lock = $null

try {
    $lock = [IO.File]::Open((Join-Path $runtime 'watch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if (-not (Test-Path -LiteralPath $executable)) { throw 'Qwen speech runtime is missing.' }
    if (-not (Test-Path -LiteralPath $modelDirectory)) { throw 'Qwen model directory is missing.' }
    if ((docker inspect --format '{{.State.Running}}' $containerName 2>$null) -ne 'true') {
        throw 'Start the project container before Qwen.'
    }
    if (Get-NetTCPConnection -LocalPort 18880 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Port 18880 is already in use.'
    }
    if (-not (Test-Path -LiteralPath $musicExecutable)) { throw 'Music runtime is missing.' }
    if (Get-NetTCPConnection -LocalPort 18881 -State Listen -ErrorAction SilentlyContinue) {
        throw 'Port 18881 is already in use.'
    }
    $env:SPEECH_MODEL_DIR = $modelDirectory
    $speechProcess = Start-Process -FilePath $executable -WorkingDirectory $runtime `
        -ArgumentList @('serve', 'qwen3-tts-1.7b:q6_k', '--host', '127.0.0.1', '--port', '18880',
            '--device', 'Vulkan0', '--voice', 'serena', '--language', 'zh', '--no-warmup') `
        -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') `
        -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
    @{
        processId = $speechProcess.Id
        supervisorId = $PID
        executable = $executable
        startedAt = $speechProcess.StartTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $stateFile
    $musicProcess = Start-Process -FilePath $musicExecutable -WorkingDirectory $musicRuntime `
        -ArgumentList @('--models', (Join-Path $musicRuntime 'models'), '--host', '127.0.0.1',
            '--port', '18881', '--device', 'Vulkan0', '--vae-chunk', '256', '--vae-overlap', '32',
            '--max-seq', '4096') -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $musicRuntime 'server.stdout.log') `
        -RedirectStandardError (Join-Path $musicRuntime 'server.stderr.log')
    @{
        processId = $musicProcess.Id
        supervisorId = $PID
        executable = $musicExecutable
        startedAt = $musicProcess.StartTime.ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $musicStateFile
    while (-not $speechProcess.HasExited -and -not $musicProcess.HasExited) {
        Start-Sleep -Seconds 3
        $running = docker inspect --format '{{.State.Running}}' $containerName 2>$null
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') { break }
    }
} finally {
    if ($null -ne $speechProcess -and -not $speechProcess.HasExited) {
        Stop-Process -Id $speechProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $musicProcess -and -not $musicProcess.HasExited) {
        Stop-Process -Id $musicProcess.Id -Force -ErrorAction SilentlyContinue
    }
    if ($null -ne $lock) {
        Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $musicStateFile -ErrorAction SilentlyContinue
        $lock.Dispose()
    }
}
