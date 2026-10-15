# Installed once under protected ProgramData. A SYSTEM scheduled task invokes
# only this file through Windows' built-in PowerShell; it accepts no arguments.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$env:PSModulePath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\Modules"
. "$PSScriptRoot/windows-ci-protected-input.ps1"
$root = 'C:\ProgramData\BizHubInstallerSyntheticTrust'
$statePath = "$root\state.json"
$requestPath = "$root\requests\request.json"
$responsePath = "$root\response.json"
$workerPath = 'D:\actions-runner-bizhub-installer\bin\Runner.Worker.exe'
if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne 'S-1-5-18') { throw 'synthetic_trust_system_task_required' }

function Write-JsonAtomic($path, $data) {
    $temporary = "$path.new"
    [IO.File]::WriteAllText($temporary, ($data | ConvertTo-Json -Compress -Depth 5), [Text.UTF8Encoding]::new($false))
    if ($path -eq $responsePath) {
        & "$env:SystemRoot\System32\icacls.exe" $temporary /grant '1:R' /Q | Out-Null
        if ($LASTEXITCODE) { throw 'synthetic_trust_response_acl_failed' }
    }
    Move-Item -LiteralPath $temporary -Destination $path -Force
}
function Worker-Alive($lease) {
    $worker = Get-CimInstance Win32_Process -Filter "ProcessId = $([int]$lease.worker_pid)"
    return $worker -and $worker.ExecutablePath -ieq $workerPath -and $worker.CreationDate.ToUniversalTime().Ticks -eq [long]$lease.worker_start_ticks
}
function Remove-OwnedLeaf($lease) {
    # State was persisted before Add. Never enumerate/remove unrelated entries.
    $leaf = $store.Certificates | Where-Object Thumbprint -CEQ $lease.thumbprint
    if ($leaf) {
        if ([Convert]::ToBase64String($leaf.RawData) -cne $lease.certificate) { throw 'synthetic_trust_owned_leaf_changed' }
        $store.Remove($leaf)
    }
    if (@($store.Certificates | Where-Object Thumbprint -CEQ $lease.thumbprint).Count) { throw 'synthetic_trust_release_not_verified' }
    Remove-Item -LiteralPath $statePath
}
function Validate-Leaf([byte[]]$bytes) {
    if ($bytes.Length -gt 16384) { throw 'synthetic_trust_certificate_too_large' }
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes)
    try {
        $now = [DateTime]::UtcNow
        if ([Convert]::ToBase64String($certificate.RawData) -cne [Convert]::ToBase64String($bytes) -or $certificate.HasPrivateKey -or $certificate.Subject -cne 'CN=BizHub Desktop D3 Synthetic CI' -or $certificate.Issuer -cne $certificate.Subject -or
            $certificate.SignatureAlgorithm.Value -ne '1.2.840.113549.1.1.11' -or $certificate.PublicKey.Oid.Value -ne '1.2.840.113549.1.1.1' -or
            $certificate.PublicKey.Key.KeySize -ne 2048 -or -not [BizHubCiInput]::SelfSigned($certificate)) { throw 'synthetic_trust_certificate_identity_invalid' }
        $before = $certificate.NotBefore.ToUniversalTime(); $after = $certificate.NotAfter.ToUniversalTime()
        if ($before -gt $now.AddMinutes(5) -or $before -lt $now.AddDays(-14) -or $after -le $now.AddMinutes(5) -or $after -gt $now.AddDays(14) -or
            ($after-$before).TotalMinutes -gt (14*24*60+5)) { throw 'synthetic_trust_certificate_validity_invalid' }
        $extensions = @($certificate.Extensions)
        $eku = @($extensions | Where-Object {$_.Oid.Value -eq '2.5.29.37'})
        $basic = @($extensions | Where-Object {$_.Oid.Value -eq '2.5.29.19'})
        $usage = @($extensions | Where-Object {$_.Oid.Value -eq '2.5.29.15'})
        if ($extensions.Count -ne 3 -or $eku.Count -ne 1 -or $basic.Count -ne 1 -or $usage.Count -ne 1 -or
            $basic[0].CertificateAuthority -or $basic[0].HasPathLengthConstraint -or $usage[0].KeyUsages -ne [Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -or
            $eku[0].EnhancedKeyUsages.Count -ne 1 -or $eku[0].EnhancedKeyUsages[0].Value -ne '1.3.6.1.5.5.7.3.3' -or
            -not $eku[0].Critical -or -not $basic[0].Critical -or -not $usage[0].Critical) { throw 'synthetic_trust_certificate_extensions_invalid' }
        return $certificate
    }
    catch { $certificate.Dispose(); throw }
}

$store = [Security.Cryptography.X509Certificates.X509Store]::new('TrustedPeople', 'LocalMachine')
$store.Open([Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
$request = $null
$ownsNewLease = $false
try {
    $lease = $null
    if (Test-Path -LiteralPath $statePath) {
        $lease = [Text.Encoding]::UTF8.GetString([BizHubCiInput]::Read($statePath, 32768)) | ConvertFrom-Json
        if ([DateTime]::UtcNow -ge [DateTime]::Parse($lease.expires_utc).ToUniversalTime() -or -not (Worker-Alive $lease)) {
            Remove-OwnedLeaf $lease
            $lease = $null
        }
    }
    if (-not (Test-Path -LiteralPath $requestPath)) { exit 0 }
    # The entire request is one immutable, bounded read; content is data only.
    $requestBytes = [BizHubCiInput]::Read($requestPath, 32768)
    Remove-Item -LiteralPath $requestPath
    $request = [Text.Encoding]::UTF8.GetString($requestBytes) | ConvertFrom-Json
    $keys = @($request.PSObject.Properties.Name | Sort-Object)
    if (($keys -join ',') -cne 'action,attempt,certificate,id,run_id,worker_pid,worker_start_ticks' -or
        $request.id -cnotmatch '\A[0-9a-f]{32}\z' -or $request.action -cnotmatch '\A(acquire|release)\z' -or
        $request.run_id -cnotmatch '\A[1-9][0-9]{0,19}\z' -or $request.attempt -cnotmatch '\A[1-9][0-9]{0,5}\z' -or
        $request.worker_pid -isnot [int] -or $request.worker_pid -le 0 -or $request.worker_start_ticks -cnotmatch '\A[1-9][0-9]{17}\z') { throw 'synthetic_trust_request_invalid' }
    if ($request.action -eq 'release') {
        if ($lease) {
            foreach ($key in @('run_id','attempt','worker_pid','worker_start_ticks')) {
                if ([string]$lease.$key -cne [string]$request.$key) { throw 'synthetic_trust_release_identity_mismatch' }
            }
            Remove-OwnedLeaf $lease
        }
        Write-JsonAtomic $responsePath @{id=$request.id; status='released'}
    }
    else {
        if ($lease) { throw 'synthetic_trust_lease_busy' }
        if (-not (Worker-Alive $request)) { throw 'synthetic_trust_worker_invalid' }
        $certificate = Validate-Leaf ([Convert]::FromBase64String($request.certificate))
        try {
            $thumbprint = $certificate.Thumbprint
            if (@($store.Certificates | Where-Object Thumbprint -CEQ $thumbprint).Count) { throw 'synthetic_trust_preexisting_leaf_refused' }
            $lease = @{run_id=$request.run_id; attempt=$request.attempt; worker_pid=$request.worker_pid; worker_start_ticks=$request.worker_start_ticks;
                thumbprint=$thumbprint; certificate=[Convert]::ToBase64String($certificate.RawData); expires_utc=[DateTime]::UtcNow.AddMinutes(60).ToString('o')}
            # Crash before/after Add leaves an exact recoverable owned identity.
            Write-JsonAtomic $statePath $lease
            $ownsNewLease = $true
            $store.Add($certificate)
            if (@($store.Certificates | Where-Object Thumbprint -CEQ $thumbprint).Count -ne 1) { throw 'synthetic_trust_add_not_verified' }
            Write-JsonAtomic $responsePath @{id=$request.id; status='acquired'; thumbprint=$thumbprint}
        }
        finally { $certificate.Dispose() }
    }
}
catch {
    if ($ownsNewLease) { Remove-OwnedLeaf $lease }
    if ($request -and $request.id -cmatch '\A[0-9a-f]{32}\z') {
        Write-JsonAtomic $responsePath @{id=$request.id; status='rejected'; error=$_.Exception.Message}
    }
    throw
}
finally { $store.Close() }
