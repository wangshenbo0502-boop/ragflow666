param([string]$Root = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$out = Join-Path $Root '05-review\successor-visual'
[void][IO.Directory]::CreateDirectory($out)
$word = $null
$document = $null
$records = @()
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    foreach ($id in @('S0033', 'S0034', 'S0035', 'S0036')) {
        $ext = if ($id -eq 'S0036') { 'doc' } else { 'docx' }
        $inputPath = Join-Path $Root ('01-originals\attachments\' + $id + '-1.' + $ext)
        $pdfPath = Join-Path $out ($id + '-original.pdf')
        $before = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
        $document = $word.Documents.Open($inputPath, $false, $true, $false)
        $tables = @()
        for ($i = 1; $i -le $document.Tables.Count; $i++) {
            $range = $document.Tables.Item($i).Range.Duplicate
            $first = $range.Duplicate
            $first.Collapse(1)
            $last = $range.Duplicate
            $last.Collapse(0)
            $tables += [ordered]@{
                table_id = $id + '-T' + $i.ToString('00')
                first_page = $first.Information(3)
                last_page = $last.Information(3)
            }
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($first)
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($last)
            [void][Runtime.InteropServices.Marshal]::ReleaseComObject($range)
        }
        if (-not (Test-Path -LiteralPath $pdfPath)) { $document.ExportAsFixedFormat($pdfPath, 17) }
        $pages = $document.ComputeStatistics(2)
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)
        $document = $null
        $after = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($before -ne $after) { throw ('Original changed: ' + $id) }
        $records += [ordered]@{
            source_id = $id; original_sha256 = $before; original_unchanged = $true
            pdf_path = $pdfPath; pdf_sha256 = (Get-FileHash -LiteralPath $pdfPath -Algorithm SHA256).Hash.ToLowerInvariant()
            pages = $pages; tables = $tables; visual_review_status = 'rendered only; not yet reviewed'
        }
        Write-Output ($id + ': ' + $pages + ' pages rendered; original unchanged')
    }
    $manifest = [ordered]@{ checked_at = [DateTime]::UtcNow.ToString('o'); documents = $records }
    [IO.File]::WriteAllText((Join-Path $out 'render-manifest.json'), ($manifest | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
}
finally {
    if ($null -ne $document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) }
    if ($null -ne $word) { $word.Quit(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
}
