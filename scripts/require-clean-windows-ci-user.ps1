$ErrorActionPreference = "Stop"
# A shared Windows login may also be used interactively. Never let the Desktop
# lifecycle smoke overwrite a real user's installation, registration, or data.
$paths = @(
    (Join-Path $env:LOCALAPPDATA "bizhub_desktop"),
    (Join-Path $env:APPDATA "BizHub Desktop")
)
$existing = @($paths | Where-Object { Test-Path -LiteralPath $_ })
$registration = @(Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
    Where-Object { $_.DisplayName -like "*BizHub*" })
$processes = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match "BizHub" })
if ($existing.Count -or $registration.Count -or $processes.Count) {
    throw "desktop_windows_existing_user_state_requires_review"
}

# Git for Windows already supplies OpenSSL used by the HTTPS smoke fixture.
# Add it only to this job's PATH; no host installation or user PATH mutation.
if (-not (Get-Command openssl -ErrorAction SilentlyContinue)) {
    $gitDirectory = Split-Path (Get-Command git -ErrorAction Stop).Source -Parent
    $openSslDirectory = [IO.Path]::GetFullPath((Join-Path $gitDirectory "../usr/bin"))
    if (-not (Test-Path (Join-Path $openSslDirectory "openssl.exe"))) {
        throw "desktop_windows_existing_openssl_missing"
    }
    $openSslDirectory | Out-File $env:GITHUB_PATH -Encoding utf8 -Append
}
