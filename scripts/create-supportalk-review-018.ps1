Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$baseDir = "C:\Users\koko\Desktop\classaid-reaction-ai"
$zipPath = "C:\Users\koko\Desktop\supportalk-review-018.zip"

Write-Host "Creating review ZIP: $zipPath"

if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
    Write-Host "Removed existing zip file."
}

$excludeRegexes = @(
    '\\\.git(\\.*)?$',
    '\\\.next(\\.*)?$',
    '\\node_modules(\\.*)?$',
    '\\dist(\\.*)?$',
    '\\\.env(\..*)?$',
    '\\review-current.*',
    '\\reaction-ai-current-review.*',
    'review-current-v2-manifest\.txt$',
    'tsconfig\.tsbuildinfo$',
    '\.patch$',
    '\.zip$'
)

# Use [System.IO.Directory]::EnumerateFiles to ensure literal paths with brackets are not mangled
$allFiles = [System.IO.Directory]::EnumerateFiles($baseDir, "*", [System.IO.SearchOption]::AllDirectories)

$filesToZip = [System.Collections.Generic.List[string]]::new()

foreach ($filePath in $allFiles) {
    $shouldExclude = $false
    foreach ($regex in $excludeRegexes) {
        if ($filePath -match $regex) {
            $shouldExclude = $true
            break
        }
    }
    if (-not $shouldExclude) {
        $filesToZip.Add($filePath)
    }
}

Write-Host "Total files to compress: $($filesToZip.Count)"

$zip = [System.IO.Compression.ZipFile]::Open($zipPath, [System.IO.Compression.ZipArchiveMode]::Create)

try {
    foreach ($file in $filesToZip) {
        $relPath = $file.Substring($baseDir.Length + 1)
        # Normalize to forward slashes for cross-platform zip format
        $entryName = $relPath -replace '\\', '/'
        
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file, $entryName, [System.IO.Compression.CompressionLevel]::Optimal)
    }
}
finally {
    $zip.Dispose()
}

$fileInfo = Get-Item $zipPath
Write-Host "Successfully created $zipPath ($([math]::Round($fileInfo.Length / 1MB, 2)) MB)"

# Verification phase
Write-Host "`n=== Verifying ZIP contents ==="
$verifyZip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)

try {
    Write-Host "Total entries in archive: $($verifyZip.Entries.Count)"

    # 1. Check square brackets paths
    Write-Host "`n--- Paths with square brackets (dynamic routes) ---"
    $bracketEntries = $verifyZip.Entries | Where-Object { $_.FullName -match '\[.+\]' }
    Write-Host "Found $($bracketEntries.Count) bracketed entries:"
    foreach ($b in $bracketEntries) {
        Write-Host "  $($b.FullName)"
    }
    if ($bracketEntries.Count -lt 5) {
        throw "Warning: Expected at least 5 bracketed entries, found $($bracketEntries.Count)"
    }

    # 2. Check forbidden files
    Write-Host "`n--- Checking for forbidden files ---"
    $forbidden = $verifyZip.Entries | Where-Object {
        $_.FullName -match '(\.env($|\..*)|\.git/|node_modules/|\.next/|review-current|reaction-ai-current|\.patch$|\.zip$|dist/)'
    }
    if ($forbidden) {
        Write-Host "ERROR: Found forbidden entries:"
        foreach ($f in $forbidden) {
            Write-Host "  $($f.FullName)"
        }
        throw "Archive contains forbidden entries!"
    } else {
        Write-Host "PASS: Zero forbidden files (.env, node_modules, .next, .git, patch, zip, dist) found."
    }

    # 3. Check key specification files
    Write-Host "`n--- Checking key required files ---"
    $keyChecks = @(
        "supabase/migrations/20261025_018_supportalk_controls_and_views.sql",
        "supabase/migrations/20261025_017_name_based_entry_and_context.sql",
        "supabase/migrations/20261025_016_atomic_participation_and_controls.sql",
        "supabase/migrations/20261025_015_participant_recovery_codes.sql",
        "supabase/migrations/20261025_014_reaction_ai_reliability.sql",
        "supabase/migrations/20261025_013_reaction_ai_foundation.sql",
        "overlay/control.html",
        "overlay/control.js",
        "overlay/main.cjs",
        "overlay/preload.cjs",
        "overlay/qr.html",
        "overlay/README.md",
        "tests/supportalk-full-flow.mjs",
        "tests/real-ai-stub-and-reaction-job.mjs",
        "tests/real-ai-and-context.mjs",
        "tests/participation-controls-sql.mjs",
        "tests/reaction-sql.mjs",
        "docs/reaction-ai-agreed-requirements.md",
        "docs/participant-and-admin-requirements-status.md",
        "docs/new_db_setup.md",
        "package.json",
        "package-lock.json",
        "app/teacher/page.tsx",
        "app/admin/page.tsx",
        "app/admin/AdminSessionControl.tsx",
        "app/enter/[entrySlug]/page.tsx",
        "app/room/[roomSlug]/page.tsx",
        "app/screen/[screenSlug]/page.tsx",
        "app/api/screen/latest/route.ts",
        "app/api/admin/research-views/route.ts",
        "app/api/teacher/lecture-context/route.ts",
        "lib/reaction-ai/generator.ts",
        "lib/reaction-ai/context.ts",
        "lib/reaction-ai/control.ts",
        "lib/reaction-ai/service.ts",
        "lib/reaction-ai/replies.ts",
        "lib/reaction-ai/pdf.ts"
    )

    $allPassed = $true
    foreach ($kc in $keyChecks) {
        $entry = $verifyZip.Entries | Where-Object { $_.FullName -eq $kc }
        if ($entry) {
            Write-Host "  [OK] $kc ($($entry.Length) bytes)"
        } else {
            Write-Host "  [MISSING] $kc"
            $allPassed = $false
        }
    }

    if (-not $allPassed) {
        throw "Some key required files are missing from archive!"
    }
    Write-Host "`nALL VERIFICATION CHECKS PASSED FOR $zipPath"
}
finally {
    $verifyZip.Dispose()
}
