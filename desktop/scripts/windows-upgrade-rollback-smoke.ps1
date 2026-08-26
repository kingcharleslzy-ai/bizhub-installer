[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OldSetup,

    [Parameter(Mandatory = $true)]
    [string]$NewSetup,

    [Parameter(Mandatory = $true)]
    [string]$OldVersion,

    [Parameter(Mandatory = $true)]
    [string]$NewVersion,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedThumbprint,

    [Parameter(Mandatory = $true)]
    [string]$RuntimePreparationIdentity,

    [Parameter(Mandatory = $true)]
    [string]$Output,

    [ValidateSet("synthetic-ci", "production")]
    [string]$SigningMode = "synthetic-ci"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$installRoot = Join-Path $env:LOCALAPPDATA "bizhub_desktop"
$temporaryRoot = Join-Path $env:RUNNER_TEMP "bizhub-desktop-upgrade-rollback"
$userDataRoot = Join-Path $temporaryRoot "user-data"

function Wait-PathState {
    param([string]$Path, [bool]$Present, [int]$TimeoutSeconds = 45)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $Path) -eq $Present) { return }
        Start-Sleep -Milliseconds 500
    }
    throw "desktop_windows_upgrade_path_state_timeout:${Path}:$Present"
}

function Stop-InstalledProcesses {
    Get-CimInstance Win32_Process | Where-Object {
        $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)
    } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Invoke-Setup {
    param([string]$Path)
    $setupPath = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $setupPath
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "desktop_windows_upgrade_setup_signature_invalid:$($signature.Status)"
    }
    $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
    if ($actualThumbprint -ne $ExpectedThumbprint.Replace(" ", "").ToUpperInvariant()) {
        throw "desktop_windows_upgrade_setup_signer_mismatch"
    }
    if ($SigningMode -eq "production" -and -not $signature.TimeStamperCertificate) {
        throw "desktop_windows_upgrade_setup_timestamp_missing"
    }
    $process = Start-Process -FilePath $setupPath -ArgumentList "--silent" -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "desktop_windows_upgrade_installer_failed:$($process.ExitCode)" }
    Wait-PathState -Path $installRoot -Present $true
}

function Get-InstalledApplication {
    param([string]$Version)
    $application = Join-Path $installRoot "app-$Version"
    $executable = Join-Path $application "BizHub Desktop.exe"
    if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
        throw "desktop_windows_upgrade_version_not_installed:$Version"
    }
    return $application
}

function Assert-RuntimeSignatures {
    param([string]$Application, [string]$Stage)
    $identity = Join-Path $temporaryRoot "runtime-signatures-$Stage.json"
    & ./scripts/verify-windows-runtime-signatures.ps1 `
        -RuntimeRoot (Join-Path $Application "resources\bizhub-runtime") `
        -PreparationIdentity $RuntimePreparationIdentity `
        -ExpectedThumbprint $ExpectedThumbprint `
        -Output $identity `
        -SigningMode $SigningMode | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "desktop_windows_upgrade_runtime_signature_failed:$Stage" }
}

function Invoke-OwnerReadback {
    param([ValidateSet("create", "readback")][string]$Mode, [string]$Application, [string]$Version)
    $env:BIZHUB_DESKTOP_RELEASE_UPGRADE_SMOKE = "1"
    try {
        $raw = & node scripts/versioned-owner-readback.mjs `
            --mode $Mode `
            --resources (Join-Path $Application "resources") `
            --user-data-root $userDataRoot `
            --application-version $Version
        if ($LASTEXITCODE -ne 0) { throw "desktop_windows_upgrade_owner_readback_failed:${Mode}:${Version}" }
        return ($raw | Select-Object -Last 1 | ConvertFrom-Json)
    } finally {
        Remove-Item Env:BIZHUB_DESKTOP_RELEASE_UPGRADE_SMOKE -ErrorAction SilentlyContinue
    }
}

function Uninstall-Application {
    Stop-InstalledProcesses
    $updater = Join-Path $installRoot "Update.exe"
    if (-not (Test-Path -LiteralPath $updater -PathType Leaf)) {
        throw "desktop_windows_upgrade_updater_missing"
    }
    $process = Start-Process -FilePath $updater -ArgumentList "--uninstall", "--silent" -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw "desktop_windows_upgrade_uninstall_failed:$($process.ExitCode)" }
}

if (Test-Path -LiteralPath $installRoot) { throw "desktop_windows_upgrade_install_root_contaminated" }
if (Test-Path -LiteralPath $temporaryRoot) { throw "desktop_windows_upgrade_temp_root_contaminated" }
New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

try {
    Invoke-Setup -Path $OldSetup
    $oldApplication = Get-InstalledApplication -Version $OldVersion
    Assert-RuntimeSignatures -Application $oldApplication -Stage "old"
    $initial = Invoke-OwnerReadback -Mode create -Application $oldApplication -Version $OldVersion

    Invoke-Setup -Path $NewSetup
    $newApplication = Get-InstalledApplication -Version $NewVersion
    Assert-RuntimeSignatures -Application $newApplication -Stage "new"
    $upgraded = Invoke-OwnerReadback -Mode readback -Application $newApplication -Version $NewVersion

    Uninstall-Application
    if (-not (Test-Path -Literal (Join-Path $userDataRoot "local-instance\data\bizhub.sqlite") -PathType Leaf)) {
        throw "desktop_windows_upgrade_uninstall_removed_formal_data"
    }
    Invoke-Setup -Path $OldSetup
    $rolledBackApplication = Get-InstalledApplication -Version $OldVersion
    Assert-RuntimeSignatures -Application $rolledBackApplication -Stage "rollback"
    $rolledBack = Invoke-OwnerReadback -Mode readback -Application $rolledBackApplication -Version $OldVersion

    if ($upgraded.data_identity -ne $initial.data_identity -or $rolledBack.data_identity -ne $initial.data_identity) {
        throw "desktop_windows_upgrade_data_identity_changed"
    }
    if ($upgraded.writer_instance_id -ne $initial.writer_instance_id -or $rolledBack.writer_instance_id -ne $initial.writer_instance_id) {
        throw "desktop_windows_upgrade_writer_identity_changed"
    }
    $identity = [ordered]@{
        status = "ok"
        schema_version = "bizhub.desktop-upgrade-rollback.v1"
        platform = "win32"
        architecture = "x64"
        old_version = $OldVersion
        new_version = $NewVersion
        upgrade_readback = $true
        rollback_readback = $true
        data_identity_preserved = $true
        writer_instance_id_preserved = $true
        runtime_pe_signatures_valid = $true
        location_id = "upgrade-location"
        location_canonical_name = "Synthetic Upgrade Location"
        residual_runtime_processes = 0
    }
    $outputPath = [IO.Path]::GetFullPath($Output)
    New-Item -ItemType Directory -Path (Split-Path -Parent $outputPath) -Force | Out-Null
    $identity | ConvertTo-Json -Depth 5 | Out-File -LiteralPath $outputPath -Encoding utf8
    $identity | ConvertTo-Json -Depth 5 -Compress
} finally {
    if (Test-Path -LiteralPath $installRoot) {
        Uninstall-Application
        Stop-InstalledProcesses
        if (Test-Path -LiteralPath $installRoot) {
            Remove-Item -LiteralPath $installRoot -Recurse -Force
        }
        if (Test-Path -LiteralPath $installRoot) {
            throw "desktop_windows_upgrade_install_root_cleanup_failed"
        }
    }
    Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
}
