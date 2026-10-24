$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$source = Get-Content "$PSScriptRoot/../scripts/windows-synthetic-trust-client.ps1" -Raw
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory "$fixture/requests" | Out-Null
$savedEnvironment = @{}
foreach ($name in @('GITHUB_REPOSITORY','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','BIZHUB_WINDOWS_EXPECTED_THUMBPRINT')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name)
}
$env:GITHUB_REPOSITORY = 'kingcharleslzy-ai/bizhub-installer'
$env:GITHUB_RUN_ID = '123'
$env:GITHUB_RUN_ATTEMPT = '1'
$env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT = ''
function Get-CimInstance { [pscustomobject]@{ExecutablePath='D:\actions-runner-bizhub-installer\bin\Runner.Worker.exe'; ProcessId=42; CreationDate=[DateTime]::UtcNow} }
function Start-ScheduledTask {}
function Start-Sleep { $script:polls++ }
function Get-Content {
    param($LiteralPath, [switch]$Raw)
    $script:reads++
    $request = [IO.File]::ReadAllText("$fixture/requests/request.json") | ConvertFrom-Json
    if ($scenario -eq 'missing' -or ($scenario -eq 'replacement' -and $reads -eq 1)) {
        throw [System.Management.Automation.ItemNotFoundException]::new('replacement gap')
    }
    if ($scenario -eq 'denied') { throw [UnauthorizedAccessException]::new('denied') }
    if ($scenario -eq 'malformed') { return '{' }
    $responseId = if (($scenario -eq 'replacement' -and $reads -eq 2) -or $scenario -eq 'stale') { 'old-request' } else { $request.id }
    $status = if ($scenario -eq 'rejected') { 'rejected' } elseif ($scenario -eq 'invalid') { 'acquired' } else { 'released' }
    @{id=$responseId; status=$status; error='fixture_rejection'} | ConvertTo-Json -Compress
}
try {
    foreach ($scenario in @('replacement','success','missing','stale','rejected','invalid','denied','malformed')) {
        $script:reads = 0
        $script:polls = 0
        # Run the real client with only its fixed host path and timeout clock replaced.
        $code = $source.Replace("'C:\ProgramData\BizHubInstallerSyntheticTrust'", "'$fixture'")
        $code = $code.Replace('$root\', '$root/').Replace('requests\', 'requests/')
        if ($scenario -in @('missing','stale')) { $code = $code.Replace('AddSeconds(30)', 'AddSeconds(-1)') }
        $errorMessage = ''
        try { $output = & ([scriptblock]::Create($code)) -Action release }
        catch { $errorMessage = $_.Exception.Message }
        switch ($scenario) {
            'replacement' { if ($errorMessage -or $output -ne 'synthetic_trust_released' -or $reads -ne 3 -or $polls -ne 2) { throw "replacement: $errorMessage" } }
            'success' { if ($errorMessage -or $output -ne 'synthetic_trust_released' -or $polls) { throw "success: $errorMessage" } }
            { $_ -in @('missing','stale') } { if ($errorMessage -ne 'synthetic_trust_response_timeout' -or $reads -ne 1) { throw "timeout: $errorMessage" } }
            'rejected' { if ($errorMessage -ne 'synthetic_trust_rejected:fixture_rejection') { throw "rejected: $errorMessage" } }
            'invalid' { if ($errorMessage -ne 'synthetic_trust_release_response_invalid') { throw "invalid: $errorMessage" } }
            'denied' { if ($errorMessage -ne 'denied') { throw "denied: $errorMessage" } }
            'malformed' { if (-not $errorMessage -or $errorMessage -eq 'synthetic_trust_response_timeout') { throw 'malformed JSON was swallowed' } }
        }
        if (@(Get-ChildItem "$fixture/requests" -Filter '*.new').Count) { throw 'temporary request leaked' }
        Write-Output "$scenario passed"
    }
}
finally {
    Remove-Item $fixture -Recurse -Force
    foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name]) }
}
