Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$baseDir = "C:\Users\koko\Desktop\classaid-reaction-ai"
$zipPath = Join-Path $baseDir "review-current-v3.zip"

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

$excludeRegexes = @(
    '\\\.git(\\.*)?$',
    '\\\.next(\\.*)?$',
    '\\node_modules(\\.*)?$',
    '\\\.env(\..*)?$',
    '\\review-current.*',
    '\\reaction-ai-current-review.*',
    '\.patch$',
    '\.zip$'
)

$files = Get-ChildItem -Path $baseDir -Recurse -File | Where-Object {
    $itemPath = $_.FullName
    $relPath = $itemPath.Substring($baseDir.Length + 1)
    
    $shouldExclude = $false
    foreach ($regex in $excludeRegexes) {
        if ($itemPath -match $regex) {
            $shouldExclude = $true
            break
        }
    }
    
    if ($relPath -eq "scripts\create-v3-zip.ps1") {
        $shouldExclude = $true
    }
    
    -not $shouldExclude
}

Write-Host "Total files to compress: $($files.Count)"

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

try {
    foreach ($file in $files) {
        $relPath = $file.FullName.Substring($baseDir.Length + 1)
        # Normalize to forward slashes for zip entries
        $entryName = $relPath -replace '\\', '/'
        
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.FullName, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $zip.Dispose()
}

Write-Host "Successfully created $zipPath"
