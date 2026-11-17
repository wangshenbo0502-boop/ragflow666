param(
    [switch]$Stop,
    [ValidateRange(5, 300)]
    [int]$ReadyTimeoutSeconds = 60
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $projectRoot '.cache'
$executable = Join-Path $runtime 'llama-windows\llama-server.exe'
$model = Join-Path $runtime 'models\bge-reranker-v2-m3-FP16.gguf'
$keyFile = Join-Path $runtime 'reranker.api-key'
$stateFile = Join-Path $runtime 'reranker.process.json'
$modelName = 'bge-reranker-v2-m3'

function Get-OwnedProcess($state) {
    $candidate = Get-Process -Id $state.processId -ErrorAction SilentlyContinue
    if ($candidate -and $candidate.Path -eq $executable -and
        $candidate.StartTime.ToUniversalTime() -eq ([datetime]$state.startedAt).ToUniversalTime()) {
        return $candidate
    }
}

$lock = [IO.File]::Open((Join-Path $runtime 'reranker.lock'), 'OpenOrCreate', 'ReadWrite', 'None')
try {
    $ownedProcess = $null
    if (Test-Path -LiteralPath $stateFile) {
        $ownedProcess = Get-OwnedProcess (Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json)
    }
    if ($Stop) {
        if ($ownedProcess) {
            Stop-Process -Id $ownedProcess.Id -Force
            if (-not $ownedProcess.WaitForExit(10000)) { throw 'Local reranker did not stop.' }
        } elseif (Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue) {
            throw 'Port 8082 has no matching owned process; refusing to stop it.'
        }
        Remove-Item -LiteralPath $stateFile -ErrorAction SilentlyContinue
        Write-Output 'Local reranker stopped. Model and credentials retained.'
        return
    }

    foreach ($requiredPath in @($executable, $model, $keyFile)) {
        if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
            throw "Required local reranker file is missing: $requiredPath"
        }
    }
    $apiKey = (Get-Content -LiteralPath $keyFile -Raw).Trim()
    if (-not $apiKey) { throw 'Local reranker credential file is empty.' }

    if (-not $ownedProcess) {
        $listeners = @(Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue)
        if ($listeners.Count -gt 0) {
            $listenerIDs = @($listeners.OwningProcess | Select-Object -Unique)
            if ($listenerIDs.Count -ne 1) { throw 'Port 8082 has ambiguous ownership.' }
            $candidate = Get-Process -Id $listenerIDs[0] -ErrorAction Stop
            $command = (Get-CimInstance Win32_Process -Filter "ProcessId = $($candidate.Id)").CommandLine
            # Only adopt the existing local launcher with the same model, key and endpoint.
            $expectedArguments = @('-m', $model, '--alias', $modelName, '--host', '0.0.0.0',
                '--port', '8082', '--reranking', '--api-key-file', $keyFile)
            $commandArguments = @([regex]::Matches($command, '"([^"]*)"|(\S+)') | ForEach-Object {
                if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
            })
            if ($candidate.Path -ne $executable) { throw 'Port 8082 belongs to a different executable.' }
            for ($index = 0; $index -lt $expectedArguments.Count; $index++) {
                $argument = $expectedArguments[$index]
                if ($argument -eq '--reranking') {
                    if ($commandArguments -notcontains $argument) { throw 'Port 8082 is not the expected reranker.' }
                    continue
                }
                $argumentIndex = [Array]::IndexOf($commandArguments, $argument)
                $expectedValue = $expectedArguments[++$index]
                if ($argumentIndex -lt 0 -or $argumentIndex + 1 -ge $commandArguments.Count -or
                    $commandArguments[$argumentIndex + 1] -ne $expectedValue) {
                    throw 'Port 8082 has different reranker arguments; refusing to replace it.'
                }
            }
            $ownedProcess = $candidate
        } else {
            $arguments = @('-m', "`"$model`"", '--alias', $modelName,
                '--host', '0.0.0.0', '--port', '8082', '--reranking',
                '-c', '8192', '-b', '8192', '-ub', '8192', '-t', '8', '--parallel', '1',
                '--api-key-file', "`"$keyFile`"")
            $ownedProcess = Start-Process -FilePath $executable -ArgumentList $arguments `
                -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru `
                -RedirectStandardOutput (Join-Path $runtime 'reranker.stdout.log') `
                -RedirectStandardError (Join-Path $runtime 'reranker.stderr.log')
        }
        @{
            processId = $ownedProcess.Id
            startedAt = $ownedProcess.StartTime.ToUniversalTime().ToString('o')
        } | ConvertTo-Json | Set-Content -LiteralPath $stateFile -Encoding utf8
    }

    $deadline = [datetime]::UtcNow.AddSeconds($ReadyTimeoutSeconds)
    while ([datetime]::UtcNow -lt $deadline) {
        $ownedProcess.Refresh()
        if ($ownedProcess.HasExited) {
            throw 'Local reranker exited before readiness. Check .cache/reranker.stderr.log.'
        }
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:8082/health' -TimeoutSec 2
            $models = Invoke-RestMethod 'http://127.0.0.1:8082/v1/models' `
                -Headers @{ Authorization = "Bearer $apiKey" } -TimeoutSec 2
            $listeners = @(Get-NetTCPConnection -LocalPort 8082 -State Listen -ErrorAction SilentlyContinue)
            if ($health.status -eq 'ok' -and @($models.data.id) -contains $modelName -and
                $listeners.Count -gt 0 -and
                @($listeners | Where-Object { $_.OwningProcess -ne $ownedProcess.Id }).Count -eq 0) {
                Write-Output "Local reranker ready, process $($ownedProcess.Id), at http://127.0.0.1:8082"
                return
            }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'Local reranker readiness timed out. Check .cache/reranker.stderr.log; reranking is required.'
} finally {
    $lock.Dispose()
}
