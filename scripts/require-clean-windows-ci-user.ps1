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
