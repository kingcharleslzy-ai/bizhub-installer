[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SetupExe,

    [Parameter(Mandatory = $true)]
    [string]$PackagedDirectory,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedThumbprint,

    [ValidateSet("synthetic-ci", "production")]
    [string]$SigningMode = "synthetic-ci"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-AuthenticodeSignature {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Expected
    )

    $resolved = (Resolve-Path -LiteralPath $Path).Path
    $signature = Get-AuthenticodeSignature -LiteralPath $resolved
    if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
        throw "desktop_windows_signature_invalid:${resolved}:$($signature.Status)"
    }
    $actualThumbprint = $signature.SignerCertificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
    $wantedThumbprint = $Expected.Replace(" ", "").ToUpperInvariant()
    if ($actualThumbprint -ne $wantedThumbprint) {
        throw "desktop_windows_signer_mismatch:$resolved"
    }
    return [ordered]@{
        path = $resolved
        status = $signature.Status.ToString()
        subject = $signature.SignerCertificate.Subject
        thumbprint = $actualThumbprint
    }
}

function Wait-PathState {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [bool]$Present,

        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if ((Test-Path -LiteralPath $Path) -eq $Present) {
            return
        }
        Start-Sleep -Milliseconds 500
    }
    throw "desktop_windows_path_state_timeout:${Path}:$Present"
}

$setupPath = (Resolve-Path -LiteralPath $SetupExe).Path
$packagedRoot = (Resolve-Path -LiteralPath $PackagedDirectory).Path
$packagedExecutable = Join-Path $packagedRoot "BizHub Desktop.exe"
$packagedResources = Join-Path $packagedRoot "resources"
$installRoot = Join-Path $env:LOCALAPPDATA "bizhub_desktop"
$defaultUserData = Join-Path $env:APPDATA "BizHub Desktop"
$syntheticUserData = Join-Path $env:RUNNER_TEMP "bizhub-d3-installed-user-data"

if (Test-Path -LiteralPath $installRoot) {
    throw "desktop_windows_install_root_contaminated:$installRoot"
}
if (Test-Path -LiteralPath $syntheticUserData) {
    throw "desktop_windows_synthetic_data_contaminated:$syntheticUserData"
}

$setupSignature = Assert-AuthenticodeSignature -Path $setupPath -Expected $ExpectedThumbprint
$packagedSignature = Assert-AuthenticodeSignature -Path $packagedExecutable -Expected $ExpectedThumbprint

$setupProcess = Start-Process -FilePath $setupPath -ArgumentList "--silent" -PassThru -Wait
if ($setupProcess.ExitCode -ne 0) {
    throw "desktop_windows_installer_failed:$($setupProcess.ExitCode)"
}
Wait-PathState -Path $installRoot -Present $true

$installedExecutable = Get-ChildItem -LiteralPath $installRoot -Directory -Filter "app-*" |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName "BizHub Desktop.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
if (-not $installedExecutable) {
    throw "desktop_windows_installed_executable_missing"
}

Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($installRoot, [System.StringComparison]::OrdinalIgnoreCase)
} | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}

$unexpectedLocalInstance = Join-Path $defaultUserData "local-instance"
if (Test-Path -LiteralPath $unexpectedLocalInstance) {
    throw "desktop_windows_install_created_local_instance:$unexpectedLocalInstance"
}

$installedSignature = Assert-AuthenticodeSignature -Path $installedExecutable -Expected $ExpectedThumbprint
$installedResources = Join-Path (Split-Path -Parent $installedExecutable) "resources"
& node scripts/local-shell-smoke.mjs `
    --packaged-executable $installedExecutable `
    --packaged-resources $installedResources `
    --user-data-root $syntheticUserData `
    --keep-user-data
if ($LASTEXITCODE -ne 0) {
    throw "desktop_windows_installed_local_smoke_failed:$LASTEXITCODE"
}

$formalDatabase = Join-Path $syntheticUserData "local-instance\data\bizhub.sqlite"
if (-not (Test-Path -LiteralPath $formalDatabase -PathType Leaf)) {
    throw "desktop_windows_formal_database_missing"
}

$updateExecutable = Join-Path $installRoot "Update.exe"
$uninstallProcess = Start-Process -FilePath $updateExecutable -ArgumentList "--uninstall", "--silent" -PassThru -Wait
if ($uninstallProcess.ExitCode -ne 0) {
    throw "desktop_windows_uninstall_failed:$($uninstallProcess.ExitCode)"
}
Wait-PathState -Path $installedExecutable -Present $false
if (-not (Test-Path -LiteralPath $formalDatabase -PathType Leaf)) {
    throw "desktop_windows_uninstall_removed_formal_data"
}

$sidecarExecutable = Join-Path $packagedResources "bizhub-runtime\bizhub-runtime.exe"
$sidecarSignature = Get-AuthenticodeSignature -LiteralPath $sidecarExecutable
$result = [ordered]@{
    status = "ok"
    signing_mode = $SigningMode
    setup_signature = $setupSignature
    packaged_signature = $packagedSignature
    installed_signature = $installedSignature
    sidecar_signature_status = $sidecarSignature.Status.ToString()
    install_root_removed = -not (Test-Path -LiteralPath $installedExecutable)
    install_created_database = $false
    owner_local_smoke = "passed"
    uninstall_preserved_formal_data = $true
}
$result | ConvertTo-Json -Depth 5 -Compress

Remove-Item -LiteralPath $syntheticUserData -Recurse -Force
