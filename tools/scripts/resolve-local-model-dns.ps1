$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$modelHosts = @('api.deepseek.com', 'sub.wanzhao.top')
$hostMappings = @{}
foreach ($modelHost in $modelHosts) {
    try {
        $addresses = @([System.Net.Dns]::GetHostAddresses($modelHost) | ForEach-Object { $_.ToString() })
        $usesFakeIP = @($addresses | Where-Object { $_ -match '^198\.(18|19)\.' -or $_ -match '^2001:2:' }).Count -gt 0
        if (-not $usesFakeIP) { continue }
        $answer = Invoke-RestMethod "https://dns.google/resolve?name=$modelHost&type=A" -TimeoutSec 10
        $publicAddress = $answer.Answer |
            Where-Object { $_.type -eq 1 -and $_.data -notmatch '^198\.(18|19)\.' } |
            Select-Object -First 1 -ExpandProperty data
        if (-not $publicAddress) { throw 'No public address returned.' }
        $hostMappings[$modelHost] = $publicAddress
    } catch {
        Write-Warning "Could not resolve $modelHost outside the local proxy: $($_.Exception.Message)"
    }
}
if ($hostMappings.Count -gt 0) {
    $overridePath = Join-Path $projectRoot '.run\compose.model-dns.json'
    @{ services = @{ 'ragflow-cpu' = @{ extra_hosts = $hostMappings } } } |
        ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $overridePath -Encoding utf8
    Write-Output $overridePath
}
