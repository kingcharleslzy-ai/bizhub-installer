$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/windows-ci-protected-input.ps1"
$request = $env:SSH_ORIGINAL_COMMAND
if ($request -cnotmatch '\Aread ([0-9a-f]{40}) ([1-9][0-9]*) ([1-9][0-9]*) (internal-windows|signed-windows) ([0-9a-f]{64})\z') {
    throw 'ci_record_read_request_invalid'
}
$commit, $runId, $attempt, $name, $expectedDigest = $Matches[1..5]
$directory = "D:\bizhub-installer-ci-records\$commit\$runId-$attempt\$name"
$handles = [Collections.Generic.List[IDisposable]]::new()
$stage = $null
function Hash-Stream($stream) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = $sha.ComputeHash($stream); return ([BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Position = 0 }
}
try {
    $manifest = [BizHubCiInput]::Open("$directory\ci-record.json", 1048576)
    $handles.Add($manifest)
    if ((Hash-Stream $manifest) -cne $expectedDigest) { throw 'ci_record_manifest_digest_mismatch' }
    $reader = [IO.StreamReader]::new($manifest, [Text.Encoding]::UTF8, $true, 4096, $true)
    try { $data = $reader.ReadToEnd() | ConvertFrom-Json }
    finally { $reader.Dispose() }
    $identity = @{schema_version='bizhub.ci-record.v1'; repository='kingcharleslzy-ai/bizhub-installer'; commit=$commit; run_id=$runId; attempt=$attempt; name=$name}
    foreach ($key in $identity.Keys) {
        if ($data.$key -cne $identity[$key]) { throw "ci_record_identity_mismatch:$key" }
    }
    $names = [Collections.Generic.List[string]]::new()
    $names.Add('ci-record.json')
    if (@($data.files).Count -eq 0) { throw 'ci_record_inputs_empty' }
    foreach ($file in $data.files) {
        if ($file.name -cnotmatch '\A[A-Za-z0-9][A-Za-z0-9 ._-]{0,199}\z' -or $names.Contains($file.name)) { throw 'ci_record_file_name_invalid' }
        $names.Add($file.name)
        $stream = [BizHubCiInput]::Open("$directory\$($file.name)", 2147483648)
        $handles.Add($stream)
        if ($stream.Length -ne $file.bytes -or (Hash-Stream $stream) -cne $file.sha256) { throw 'ci_record_file_digest_mismatch' }
    }
    $actual = @(Get-ChildItem -LiteralPath $directory -Force)
    if ($actual.Count -ne $names.Count -or @($actual | Where-Object { -not $names.Contains($_.Name) }).Count) { throw 'ci_record_file_set_mismatch' }
    # Tar must not reopen the runner-writable source tree after verification.
    # Copy only the pinned handles into this reader's private, protected staging
    # parent. An ancestor rename/replacement cannot redirect any archive read.
    $stage = "$PSScriptRoot\staging\$([Guid]::NewGuid().ToString('N'))"
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($sid)
    foreach ($identity in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    [IO.Directory]::CreateDirectory($stage, $acl) | Out-Null
    for ($index = 0; $index -lt $names.Count; $index++) {
        $source = $handles[$index]
        $source.Position = 0
        $target = [IO.File]::Open("$stage\$($names[$index])", 'CreateNew', 'Write', 'None')
        try { $source.CopyTo($target) }
        finally { $target.Dispose() }
    }
    # Only Windows' protected tar binary executes; no client command/path enters
    # an executable string. Tar only sees the immutable private snapshot.
    $process = [Diagnostics.Process]::new()
    $process.StartInfo.FileName = "$env:SystemRoot\System32\tar.exe"
    $process.StartInfo.UseShellExecute = $false
    $process.StartInfo.RedirectStandardOutput = $true
    $quotedNames = @($names | ForEach-Object { '"' + $_ + '"' }) -join ' '
    $process.StartInfo.Arguments = '-cf - -C "' + $stage + '" -- ' + $quotedNames
    $started = $false
    try {
        if (-not $process.Start()) { throw 'ci_record_tar_start_failed' }
        $started = $true
        $process.StandardOutput.BaseStream.CopyTo([Console]::OpenStandardOutput())
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw 'ci_record_tar_failed' }
    }
    finally {
        if ($started -and -not $process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
finally {
    foreach ($handle in $handles) { $handle.Dispose() }
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
