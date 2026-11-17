param([string]$Root = $PSScriptRoot)

$ErrorActionPreference = 'Stop'
$output = Join-Path $Root '05-review\successor-structure'
$sources = @(
    @{ Id = 'S0033'; File = 'S0033-1.docx' },
    @{ Id = 'S0034'; File = 'S0034-1.docx' },
    @{ Id = 'S0035'; File = 'S0035-1.docx' },
    @{ Id = 'S0036'; File = 'S0036-1.doc' }
)
$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    [void][IO.Directory]::CreateDirectory($output)
    foreach ($source in $sources) {
        $original = Join-Path $Root ('01-originals\attachments\' + $source.File)
        $before = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant()
        try {
            $document = $word.Documents.Open($original, $false, $true, $false)
            $xml = $document.WordOpenXML
            $paragraphs = @()
            foreach ($paragraph in $document.Paragraphs) {
                $paragraphs += [ordered]@{
                    label = $paragraph.Range.ListFormat.ListString
                    text = $paragraph.Range.Text.Trim([char]13, [char]7)
                    start = $paragraph.Range.Start
                }
                [void][Runtime.InteropServices.Marshal]::ReleaseComObject($paragraph)
            }
            $metadata = [ordered]@{
                source_id = $source.Id
                checked_at = [DateTime]::UtcNow.ToString('o')
                original_path = '01-originals/attachments/' + $source.File
                original_sha256 = $before
                read_only = [bool]$document.ReadOnly
                pages = $document.ComputeStatistics(2)
                table_count = $document.Tables.Count
                paragraphs = $paragraphs
                purpose = 'Read-only Word structural export; not an accepted master or an import.'
            }
            [IO.File]::WriteAllText((Join-Path $output ($source.Id + '-word-package.xml')), $xml, [Text.UTF8Encoding]::new($false))
            [IO.File]::WriteAllText((Join-Path $output ($source.Id + '-word-metadata.json')), ($metadata | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
            [pscustomobject]$metadata | Select-Object source_id, original_sha256, read_only, pages, table_count | ConvertTo-Json -Compress
        }
        finally {
            if ($null -ne $document) {
                $document.Close(0)
                [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)
                $document = $null
            }
            $after = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($before -ne $after) { throw ('Original changed during read-only inspection: ' + $source.Id) }
        }
    }
}
finally {
    if ($null -ne $document) {
        $document.Close(0)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document)
    }
    if ($null -ne $word) {
        $word.Quit(0)
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
}
