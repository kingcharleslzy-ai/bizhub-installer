# Only directories created by this invocation may be reclaimed. The random
# marker is bound to the canonical path; an existing profile is never adopted.
function New-SmokeOwnedDirectory {
    param([Parameter(Mandatory = $true)][string]$Path)
    $canonical = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    if (Test-Path -LiteralPath $canonical) { throw "desktop_windows_owned_directory_contaminated:$canonical" }
    $token = [Guid]::NewGuid().ToString('D')
    New-Item -ItemType Directory -Path $canonical -ErrorAction Stop | Out-Null
    $marker = Join-Path $canonical '.bizhub-smoke-owner.json'
    [ordered]@{ path = $canonical; token = $token } | ConvertTo-Json -Compress |
        Set-Content -LiteralPath $marker -Encoding UTF8 -ErrorAction Stop
    return [PSCustomObject]@{ Path = $canonical; Token = $token }
}

function Remove-SmokeOwnedDirectory {
    param([Parameter(Mandatory = $true)]$Owner)
    if (-not (Test-Path -LiteralPath $Owner.Path)) { return }
    $directory = Get-Item -LiteralPath $Owner.Path -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "desktop_windows_owned_directory_reparse_or_not_directory:$($Owner.Path)"
    }
    $markerPath = Join-Path $Owner.Path '.bizhub-smoke-owner.json'
    $marker = Get-Item -LiteralPath $markerPath -Force -ErrorAction Stop
    if ($marker.PSIsContainer -or ($marker.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
        throw "desktop_windows_owned_directory_marker_invalid:$($Owner.Path)"
    }
    $record = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json
    if ($record.path -cne $Owner.Path -or $record.token -cne $Owner.Token) {
        throw "desktop_windows_owned_directory_marker_mismatch:$($Owner.Path)"
    }
    if (Get-ChildItem -LiteralPath $Owner.Path -Recurse -Force | Where-Object {
        $_.Attributes -band [IO.FileAttributes]::ReparsePoint
    }) { throw "desktop_windows_owned_directory_child_reparse:$($Owner.Path)" }
    Remove-Item -LiteralPath $Owner.Path -Recurse -Force -ErrorAction Stop
    if (Test-Path -LiteralPath $Owner.Path) { throw "desktop_windows_owned_directory_cleanup_failed:$($Owner.Path)" }
}
