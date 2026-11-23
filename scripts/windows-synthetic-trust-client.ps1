[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('acquire','release')][string]$Action)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($env:RUNNER_ENVIRONMENT -ceq 'github-hosted') {
    # GitHub-hosted Windows is a fresh VM per job and the job itself is an administrator, so the
    # SYSTEM task the retired self-hosted builder used is not needed: add / remove the job's own
    # synthetic publisher leaf in LocalMachine\TrustedPeople here, with the same identity and readback.
    $store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
    $store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    try {
        if ($Action -eq 'acquire') {
            $publisher = [Security.Cryptography.X509Certificates.X509Certificate2]::new($env:BIZHUB_WINDOWS_CERTIFICATE_FILE, $env:BIZHUB_WINDOWS_CERTIFICATE_PASSWORD)
            try { $bytes = $publisher.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert) }
            finally { $publisher.Dispose() }
            $leaf = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
            if ($leaf.HasPrivateKey -or $leaf.Subject -cne 'CN=BizHub Desktop D3 Synthetic CI' -or $leaf.Issuer -cne $leaf.Subject -or
                $leaf.Thumbprint -cne $env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT) { throw 'synthetic_trust_acquire_response_invalid' }
            $store.Add($leaf)
            if (-not @($store.Certificates | Where-Object Thumbprint -CEQ $leaf.Thumbprint).Count) { throw 'synthetic_trust_acquire_response_invalid' }
            Write-Output 'synthetic_trust_acquired'
        }
        else {
            foreach ($leaf in @($store.Certificates | Where-Object Thumbprint -CEQ $env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT)) { $store.Remove($leaf) }
            if (Test-Path "Cert:\LocalMachine\TrustedPeople\$env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT") { throw 'synthetic_trust_release_readback_failed' }
            Write-Output 'synthetic_trust_released'
        }
    }
    finally { $store.Close() }
    return
}
$root = 'C:\ProgramData\BizHubInstallerSyntheticTrust'
$worker = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
while ($worker -and $worker.ExecutablePath -ine 'D:\actions-runner-bizhub-installer\bin\Runner.Worker.exe') {
    $worker = Get-CimInstance Win32_Process -Filter "ProcessId = $($worker.ParentProcessId)"
}
if (-not $worker -or $env:GITHUB_REPOSITORY -cne 'kingcharleslzy-ai/bizhub-installer' -or
    $env:GITHUB_RUN_ID -cnotmatch '\A[1-9][0-9]*\z' -or $env:GITHUB_RUN_ATTEMPT -cnotmatch '\A[1-9][0-9]*\z') { throw 'synthetic_trust_dedicated_worker_required' }
$certificate = ''
if ($Action -eq 'acquire') {
    $publisher = [Security.Cryptography.X509Certificates.X509Certificate2]::new($env:BIZHUB_WINDOWS_CERTIFICATE_FILE, $env:BIZHUB_WINDOWS_CERTIFICATE_PASSWORD)
    try { $certificate = [Convert]::ToBase64String($publisher.Export([Security.Cryptography.X509Certificates.X509ContentType]::Cert)) }
    finally { $publisher.Dispose() }
}
$id = [Guid]::NewGuid().ToString('N')
$request = @{id=$id; action=$Action; run_id=$env:GITHUB_RUN_ID; attempt=$env:GITHUB_RUN_ATTEMPT; certificate=$certificate;
    worker_pid=[int]$worker.ProcessId; worker_start_ticks=[string]$worker.CreationDate.ToUniversalTime().Ticks}
$temporary = "$root\requests\$id.new"
try {
    [IO.File]::WriteAllText($temporary, ($request | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination "$root\requests\request.json" -Force
    Start-ScheduledTask -TaskName 'BizHub Installer Synthetic Trust'
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        $json = $null
        try { $json = Get-Content -LiteralPath "$root\response.json" -Raw }
        # Move-Item -Force can briefly remove the old response before replacing it.
        catch [System.Management.Automation.ItemNotFoundException] {}
        if ($null -ne $json) {
            $response = $json | ConvertFrom-Json
            if ($response.id -ceq $id) {
                if ($response.status -eq 'rejected') { throw "synthetic_trust_rejected:$($response.error)" }
                if ($Action -eq 'release') {
                    if ($response.status -ne 'released') { throw 'synthetic_trust_release_response_invalid' }
                    if ($env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT -and (Test-Path "Cert:\LocalMachine\TrustedPeople\$env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT")) { throw 'synthetic_trust_release_readback_failed' }
                }
                elseif ($response.status -ne 'acquired' -or $response.thumbprint -cne $env:BIZHUB_WINDOWS_EXPECTED_THUMBPRINT) { throw 'synthetic_trust_acquire_response_invalid' }
                Write-Output "synthetic_trust_$($response.status)"
                return
            }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'synthetic_trust_response_timeout'
}
finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
