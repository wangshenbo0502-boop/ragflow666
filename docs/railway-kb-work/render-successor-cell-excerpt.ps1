param([string]$Root = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$native = Get-Content -LiteralPath (Join-Path $Root '05-review\successor-structure\S0035-native-tables-v2.json') -Raw | ConvertFrom-Json
$sourcePath = Join-Path $Root $native.original_path
$cell = $native.tables[2].rows[87].cells | Where-Object cell_id -eq 'S0035-T03-R88C3'
$paragraph = $cell.paragraphs[0]
$output = Join-Path $Root '05-review\successor-visual\S0035-T03-R88C3-excerpt.pdf'
if (Test-Path -LiteralPath $output) { throw 'Excerpt already exists; reuse its evidence instead of overwriting it.' }
$before = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
$word = $null
$source = $null
$excerpt = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $word.AutomationSecurity = 3
    $source = $word.Documents.Open($sourcePath, $false, $true, $false)
    $range = $source.Range($paragraph.word_start, $paragraph.word_start + $cell.text.Length)
    if ($range.Text -cne $cell.text) { throw 'Word range does not match the native source cell.' }
    $excerpt = $word.Documents.Add()
    $excerpt.Content.FormattedText = $range.FormattedText
    if ($excerpt.Content.Text.Trim([char]13, [char]7) -cne $cell.text) {
        throw 'Excerpt differs from the original source range.'
    }
    $excerpt.ExportAsFixedFormat($output, 17)
    $record = [ordered]@{
        checked_at = [DateTime]::UtcNow.ToString('o')
        purpose = 'Display-only excerpt of an original cell clipped in the full-document PDF; not an official replacement.'
        doc_id = 'DOC0027'; cell_id = $cell.cell_id
        source_path = $native.original_path; source_sha256 = $before
        original_pdf_page = 26
        source_range_start = $range.Start; source_range_end = $range.End
        source_text = $range.Text; source_text_matches_native = $true
        excerpt_text_matches_source = $true; source_opened_read_only = [bool]$source.ReadOnly
        pdf_path = $output
        pdf_sha256 = (Get-FileHash -LiteralPath $output -Algorithm SHA256).Hash.ToLowerInvariant()
        visual_review_status = 'Rendered; awaiting image inspection.'
    }
    [IO.File]::WriteAllText(
        (Join-Path $Root '05-review\successor-visual\S0035-T03-R88C3-excerpt.json'),
        ($record | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Output ($record | ConvertTo-Json -Depth 6)
} finally {
    if ($null -ne $excerpt) { $excerpt.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($excerpt) }
    if ($null -ne $source) { $source.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($source) }
    if ($null -ne $word) { $word.Quit(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word) }
    $after = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($before -ne $after) { throw 'Original changed during excerpt rendering.' }
}
