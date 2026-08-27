param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath,

    [Parameter(Mandatory = $true)]
    [string]$DestinationPath
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$maximumEntries = 4096
$maximumEntryBytes = 256MB
$maximumTotalBytes = 512MB

$resolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$destinationRoot = [IO.Path]::GetFullPath($DestinationPath)
[IO.Directory]::CreateDirectory($destinationRoot) | Out-Null
if (@(Get-ChildItem -LiteralPath $destinationRoot -Force).Count -ne 0) {
    throw "desktop_runtime_extract_destination_not_empty"
}
$destinationPrefix = $destinationRoot.TrimEnd(
    [IO.Path]::DirectorySeparatorChar,
    [IO.Path]::AltDirectorySeparatorChar
) + [IO.Path]::DirectorySeparatorChar

Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($resolvedArchive)
try {
    if ($archive.Entries.Count -lt 1 -or $archive.Entries.Count -gt $maximumEntries) {
        throw "desktop_runtime_archive_entry_count_invalid:$($archive.Entries.Count)"
    }
    $seen = [Collections.Generic.HashSet[string]]::new(
        [StringComparer]::OrdinalIgnoreCase
    )
    [long]$totalBytes = 0
    foreach ($entry in $archive.Entries) {
        $name = $entry.FullName
        if (
            [string]::IsNullOrWhiteSpace($name) -or
            $name.Length -gt 1024 -or
            $name.Contains("\") -or
            $name.Contains(":") -or
            $name.StartsWith("/")
        ) {
            throw "desktop_runtime_archive_path_invalid:$name"
        }
        $segments = @($name.TrimEnd("/").Split("/"))
        if ($segments.Count -lt 1 -or @($segments | Where-Object { $_ -in "", ".", ".." }).Count -ne 0) {
            throw "desktop_runtime_archive_path_invalid:$name"
        }
        if (-not $seen.Add($name)) {
            throw "desktop_runtime_archive_duplicate_path:$name"
        }
        $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
        if ($unixType -eq 0xA000) {
            throw "desktop_runtime_archive_symlink_rejected:$name"
        }
        $target = [IO.Path]::GetFullPath((Join-Path $destinationRoot $name))
        if (-not $target.StartsWith($destinationPrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw "desktop_runtime_archive_path_escape:$name"
        }
        if ($name.EndsWith("/")) {
            [IO.Directory]::CreateDirectory($target) | Out-Null
            continue
        }
        if ($entry.Length -lt 0 -or $entry.Length -gt $maximumEntryBytes) {
            throw "desktop_runtime_archive_entry_size_invalid:$name"
        }
        $totalBytes += $entry.Length
        if ($totalBytes -gt $maximumTotalBytes) {
            throw "desktop_runtime_archive_total_size_invalid"
        }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        $inputStream = $entry.Open()
        $outputStream = [IO.File]::Open($target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
        try {
            $inputStream.CopyTo($outputStream)
        }
        finally {
            $outputStream.Dispose()
            $inputStream.Dispose()
        }
        if ((Get-Item -LiteralPath $target).Length -ne $entry.Length) {
            throw "desktop_runtime_archive_entry_length_mismatch:$name"
        }
    }
}
finally {
    $archive.Dispose()
}

[ordered]@{
    status = "expanded"
    entries = $seen.Count
    total_bytes = $totalBytes
} | ConvertTo-Json -Compress
