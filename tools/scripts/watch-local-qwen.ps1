$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $projectRoot '.run\qwen3tts'
$executable = Join-Path $runtime 'speech\speech.exe'
$stateFile = Join-Path $runtime 'process.json'
$modelDirectory = Join-Path $runtime 'models'
$containerName = 'docker-ragflow-cpu-1'
$musicRuntime = Join-Path $projectRoot '.run\music'
$musicExecutable = Join-Path $musicRuntime 'bin\ace-server.exe'
$musicStateFile = Join-Path $musicRuntime 'process.json'
$forwarders = @(
    @{
        name = 'tts-forwarder'; script = Join-Path $projectRoot '.run\chat-tts-forwarder.cjs'
        port = 19980; stateFile = Join-Path $projectRoot '.run\chat-tts-forwarder-process.json'
        stdout = Join-Path $projectRoot '.run\chat-tts-forwarder-supervised.stdout.log'
        stderr = Join-Path $projectRoot '.run\chat-tts-forwarder-supervised.stderr.log'
    },
    @{
        name = 'image-forwarder'; script = Join-Path $projectRoot '.run\chat-image-forwarder.cjs'
        port = 19982; stateFile = Join-Path $projectRoot '.run\chat-image-forwarder-process.json'
        stdout = Join-Path $projectRoot '.run\chat-image-forwarder-supervised.stdout.log'
        stderr = Join-Path $projectRoot '.run\chat-image-forwarder-supervised.stderr.log'
    }
)
$lock = $null
$projectStopped = $false

function Start-MediaForwarder($forwarder) {
    if (-not (Test-Path -LiteralPath $forwarder.script)) {
        throw "$($forwarder.name) script is missing."
    }
    $existing = @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$($forwarder.script)*"
    })
    if ($existing.Count -gt 1) { throw "Multiple $($forwarder.name) processes need inspection." }
    $listener = @(Get-NetTCPConnection -LocalPort $forwarder.port -State Listen -ErrorAction SilentlyContinue)
    if ($existing.Count -eq 1) {
        if (@($listener | Where-Object { $_.OwningProcess -ne $existing[0].ProcessId }).Count) {
            throw "Port $($forwarder.port) belongs to another process."
        }
        $process = Get-Process -Id $existing[0].ProcessId -ErrorAction Stop
        $forwarder.executable = $existing[0].ExecutablePath
        Write-Output "Reusing $($forwarder.name) process $($process.Id)."
    } else {
        if ($listener.Count) { throw "Port $($forwarder.port) belongs to another process." }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        $forwarder.executable = $node
        $process = Start-Process -FilePath $node -WorkingDirectory $projectRoot `
            -ArgumentList "`"$($forwarder.script)`"" -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $forwarder.stdout -RedirectStandardError $forwarder.stderr
        Write-Output "Started $($forwarder.name) process $($process.Id)."
    }
    $forwarder.process = $process
    $forwarder.startedAt = $process.StartTime.ToUniversalTime()
    @{
        processId = $process.Id
        supervisorId = $PID
        script = $forwarder.script
        startedAt = $forwarder.startedAt.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $forwarder.stateFile
}

function Start-MediaEngine($engine) {
    $existing = @(Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -eq $engine.executable
    })
    if ($existing.Count -gt 1) { throw "Multiple $($engine.name) processes need inspection." }
    $listener = @(Get-NetTCPConnection -LocalPort $engine.port -State Listen -ErrorAction SilentlyContinue)
    if ($existing.Count -eq 1) {
        foreach ($required in $engine.requiredArguments) {
            if ($existing[0].CommandLine -notmatch $required) {
                throw "Existing $($engine.name) process has different arguments."
            }
        }
        if (@($listener | Where-Object { $_.OwningProcess -ne $existing[0].ProcessId }).Count) {
            throw "Port $($engine.port) belongs to another process."
        }
        $process = Get-Process -Id $existing[0].ProcessId -ErrorAction Stop
        Write-Output "Reusing $($engine.name) process $($process.Id)."
    } else {
        if ($listener.Count) { throw "Port $($engine.port) belongs to another process." }
        $process = Start-Process -FilePath $engine.executable -WorkingDirectory $engine.runtime `
            -ArgumentList $engine.arguments -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput (Join-Path $engine.runtime 'server.stdout.log') `
            -RedirectStandardError (Join-Path $engine.runtime 'server.stderr.log')
        Write-Output "Started $($engine.name) process $($process.Id)."
    }
    $engine.process = $process
    $engine.startedAt = $process.StartTime.ToUniversalTime()
    @{
        processId = $process.Id
        supervisorId = $PID
        executable = $engine.executable
        startedAt = $engine.startedAt.ToString('o')
    } | ConvertTo-Json | Set-Content -LiteralPath $engine.stateFile
}

try {
    $lock = [IO.File]::Open((Join-Path $runtime 'watch.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
    if (-not (Test-Path -LiteralPath $executable)) { throw 'Qwen speech runtime is missing.' }
    if (-not (Test-Path -LiteralPath $modelDirectory)) { throw 'Qwen model directory is missing.' }
    if ((docker inspect --format '{{.State.Running}}' $containerName 2>$null) -ne 'true') {
        throw 'Start the project container before Qwen.'
    }
    if (-not (Test-Path -LiteralPath $musicExecutable)) { throw 'Music runtime is missing.' }
    $env:SPEECH_MODEL_DIR = $modelDirectory
    $engines = @(
        @{
            name = 'speech'; executable = $executable; runtime = $runtime; port = 18880
            stateFile = $stateFile; process = $null; startedAt = $null
            arguments = @('serve', 'qwen3-tts-1.7b:q6_k', '--host', '127.0.0.1', '--port', '18880',
                '--device', 'Vulkan0', '--voice', 'serena', '--language', 'zh', '--no-warmup')
            requiredArguments = @('\bserve\s+qwen3-tts-1\.7b:q6_k\b', '--host\s+127\.0\.0\.1\b',
                '--port\s+18880\b', '--voice\s+serena\b', '--language\s+zh\b', '--device\s+Vulkan0\b')
        },
        @{
            name = 'music'; executable = $musicExecutable; runtime = $musicRuntime; port = 18881
            stateFile = $musicStateFile; process = $null; startedAt = $null
            arguments = @('--models', "`"$(Join-Path $musicRuntime 'models')`"", '--host', '127.0.0.1',
                '--port', '18881', '--device', 'Vulkan0', '--vae-chunk', '256', '--vae-overlap', '32',
                '--max-seq', '4096')
            requiredArguments = @('--models\s+"?' + [regex]::Escape((Join-Path $musicRuntime 'models')) + '"?(?:\s|$)',
                '--host\s+127\.0\.0\.1\b', '--port\s+18881\b', '--device\s+Vulkan0\b',
                '--vae-chunk\s+256\b', '--vae-overlap\s+32\b', '--max-seq\s+4096\b')
        }
    )
    $unavailableSince = $null
    while ($true) {
        $running = docker inspect --format '{{.State.Running}}' $containerName 2>$null
        if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
            # Container recreation briefly removes the named container during deployment.
            if ($null -eq $unavailableSince) { $unavailableSince = [datetime]::UtcNow }
            if (([datetime]::UtcNow - $unavailableSince).TotalSeconds -ge 60) {
                $projectStopped = $true
                break
            }
            Start-Sleep -Seconds 3
            continue
        }
        $unavailableSince = $null
        foreach ($forwarder in $forwarders) {
            if ($forwarder.process) { $forwarder.process.Refresh() }
            if (-not $forwarder.process -or $forwarder.process.HasExited) {
                try {
                    Start-MediaForwarder $forwarder
                } catch {
                    Write-Warning "$($forwarder.name): $($_.Exception.Message)"
                }
            }
        }
        foreach ($engine in $engines) {
            if ($engine.process) { $engine.process.Refresh() }
            if (-not $engine.process -or $engine.process.HasExited) {
                try {
                    Start-MediaEngine $engine
                } catch {
                    Write-Warning "$($engine.name): $($_.Exception.Message)"
                }
            }
        }
        Start-Sleep -Seconds 3
    }
} finally {
    if ($null -ne $lock) {
        if ($projectStopped) {
            foreach ($forwarder in $forwarders) {
                if (-not $forwarder.process) { continue }
                $process = Get-Process -Id $forwarder.process.Id -ErrorAction SilentlyContinue
                if ($process -and $process.Path -eq $forwarder.executable -and
                    $process.StartTime.ToUniversalTime() -eq $forwarder.startedAt) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath $forwarder.stateFile -ErrorAction SilentlyContinue
            }
            foreach ($engine in $engines) {
                if (-not $engine.process) { continue }
                $process = Get-Process -Id $engine.process.Id -ErrorAction SilentlyContinue
                if ($process -and $process.Path -eq $engine.executable -and
                    $process.StartTime.ToUniversalTime() -eq $engine.startedAt) {
                    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
                }
                Remove-Item -LiteralPath $engine.stateFile -ErrorAction SilentlyContinue
            }
        }
        $lock.Dispose()
    }
}
