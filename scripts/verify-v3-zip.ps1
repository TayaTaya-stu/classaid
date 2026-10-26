Add-Type -AssemblyName System.IO.Compression.FileSystem

$zipPath = "C:\Users\koko\Desktop\classaid-reaction-ai\review-current-v3.zip"
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)

Write-Host "Total entries in zip: $($zip.Entries.Count)"

Write-Host "`n=== Bracketed paths in zip ==="
$bracketed = $zip.Entries | Where-Object { $_.FullName -match '\[.+\]' }
foreach ($b in $bracketed) {
    Write-Host "  $($b.FullName)"
}

Write-Host "`n=== Checking forbidden items ==="
$forbidden = $zip.Entries | Where-Object {
    $_.FullName -match '(\.env($|\..*)|\.git/|node_modules/|\.next/|review-current|reaction-ai-current|\.patch$|\.zip$)'
}

if ($forbidden) {
    Write-Host "Found forbidden files:"
    foreach ($f in $forbidden) {
        Write-Host "  $($f.FullName)"
    }
} else {
    Write-Host "SUCCESS: No forbidden files found in archive."
}

Write-Host "`n=== Key modified / added files check ==="
$keyFiles = @(
    "supabase/migrations/20261025_017_name_based_entry_and_context.sql",
    "lib/reaction-ai/generator.ts",
    "lib/reaction-ai/context.ts",
    "lib/reaction-ai/pdf.ts",
    "lib/reaction-ai/service.ts",
    "app/enter/[entrySlug]/page.tsx",
    "app/api/enter/route.ts",
    "app/admin/AdminSessionControl.tsx",
    "app/admin/page.tsx",
    "app/teacher/page.tsx",
    "app/api/teacher/lecture-context/route.ts",
    "docs/reaction-ai-agreed-requirements.md",
    "docs/participant-and-admin-requirements-status.md",
    "docs/new_db_setup.md",
    "tests/real-ai-and-context.mjs"
)

foreach ($kf in $keyFiles) {
    $found = $zip.Entries | Where-Object { $_.FullName -eq $kf }
    if ($found) {
        Write-Host "  [OK] $kf ($($found.Length) bytes)"
    } else {
        Write-Host "  [MISSING] $kf"
    }
}

$zip.Dispose()
