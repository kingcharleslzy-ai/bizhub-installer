# One-time owner-authorized host setup, from the reviewed repository commit.
# Never called by a workflow; the runner stays Interactive/Limited.
$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\BizHubInstallerSyntheticTrust'
$taskName = 'BizHub Installer Synthetic Trust'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = [Security.Principal.WindowsPrincipal]::new($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'synthetic_trust_admin_setup_required' }
if (Test-Path -LiteralPath $root) { throw 'synthetic_trust_existing_setup_requires_review' }
$user = Get-LocalUser -Name '1'
New-Item -ItemType Directory -Path "$root\requests" -Force | Out-Null
& icacls $root /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' '1:RX' | Out-Null
if ($LASTEXITCODE) { throw 'synthetic_trust_root_acl_failed' }
& icacls "$root\requests" /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' '1:(RX,WD)' '1:(OI)(CI)(IO)M' | Out-Null
if ($LASTEXITCODE) { throw 'synthetic_trust_request_acl_failed' }
foreach ($name in @('windows-synthetic-trust-task.ps1','windows-ci-protected-input.ps1')) {
    Copy-Item -LiteralPath "$PSScriptRoot\$name" -Destination "$root\$name"
}
& icacls $root /setowner SYSTEM /T /Q | Out-Null
if ($LASTEXITCODE) { throw 'synthetic_trust_owner_failed' }
$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$action = New-ScheduledTaskAction -Execute $powerShell -Argument "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$root\windows-synthetic-trust-task.ps1`""
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 30) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $triggers -Settings $settings -User SYSTEM -RunLevel Highest | Out-Null
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$task = $scheduler.GetFolder('\').GetTask($taskName)
$task.SetSecurityDescriptor("O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGX;;;$($user.SID.Value))", 0)
Write-Output 'synthetic_trust_protected_task_installed'
