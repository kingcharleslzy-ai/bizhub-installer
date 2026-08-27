[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RuntimeRoot,

    [Parameter(Mandatory = $true)]
    [string]$PreparationIdentity,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedThumbprint,

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [ValidateSet("synthetic-ci", "production")]
    [string]$SigningMode = "synthetic-ci"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Test-PortableExecutable {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -lt 64) { return $false }
        $reader = [IO.BinaryReader]::new($stream)
        return $reader.ReadUInt16() -eq 0x5A4D
    } finally {
        $stream.Dispose()
    }
}

$root = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$preparation = Get-Content -LiteralPath $PreparationIdentity -Raw | ConvertFrom-Json
if ($preparation.schema_version -ne "bizhub.desktop-windows-runtime-preparation.v1") {
    throw "desktop_windows_runtime_preparation_identity_invalid"
}
$wantedThumbprint = $ExpectedThumbprint.Replace(" ", "").ToUpperInvariant()
$publisherFiles = @($preparation.publisher_signed_files)
$peFiles = @(Get-ChildItem -LiteralPath $root -File -Recurse | Where-Object {
    Test-PortableExecutable -Path $_.FullName
})
if ($peFiles.Count -ne [int]$preparation.pe_file_count) {
    throw "desktop_windows_runtime_pe_count_mismatch:$($peFiles.Count)"
}

$mainSignature = $null
foreach ($file in $peFiles) {
    $relative = [IO.Path]::GetRelativePath($root, $file.FullName).Replace("\", "/")
    $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "desktop_windows_runtime_signature_invalid:${relative}:$($signature.Status)"
    }
    if ($publisherFiles -contains $relative) {
        $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
        if ($actualThumbprint -ne $wantedThumbprint) {
            throw "desktop_windows_runtime_signer_mismatch:${relative}"
        }
        if ($SigningMode -eq "production" -and -not $signature.TimeStamperCertificate) {
            throw "desktop_windows_runtime_timestamp_missing:${relative}"
        }
    }
    if ($relative -eq $preparation.main_executable) { $mainSignature = $signature }
}
if (-not $mainSignature) { throw "desktop_windows_runtime_main_signature_missing" }
$mainThumbprint = $mainSignature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
if ($mainThumbprint -ne $wantedThumbprint) { throw "desktop_windows_runtime_main_signer_mismatch" }

$identity = [ordered]@{
    status = "ok"
    schema_version = "bizhub.desktop-windows-runtime-signing.v1"
    signing_mode = $SigningMode
    baseline_manifest_sha256 = $preparation.baseline_manifest_sha256
    baseline_pack_tree_digest = $preparation.baseline_pack_tree_digest
    signed_manifest_sha256 = $preparation.signed_manifest_sha256
    signed_pack_tree_digest = $preparation.signed_pack_tree_digest
    signed_pack_file_count = $preparation.signed_pack_file_count
    runtime_source_tree_digest = $preparation.runtime_source_tree_digest
    core_artifact_digest = $preparation.core_artifact_digest
    signed_runtime_trust_sha256 = $preparation.signed_runtime_trust_sha256
    pe_file_count = $peFiles.Count
    all_pe_signatures_valid = $true
    publisher_signed_file_count = $publisherFiles.Count
    publisher_signed_files = $publisherFiles
    main_executable = $preparation.main_executable
    main_signer_subject = $mainSignature.SignerCertificate.Subject
    main_signer_thumbprint = $mainThumbprint
    main_timestamp_subject = if ($mainSignature.TimeStamperCertificate) { $mainSignature.TimeStamperCertificate.Subject } else { $null }
}
$outputPath = [IO.Path]::GetFullPath($Output)
New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
$identity | ConvertTo-Json -Depth 6 | Out-File -LiteralPath $outputPath -Encoding utf8
$identity | ConvertTo-Json -Depth 6 -Compress
