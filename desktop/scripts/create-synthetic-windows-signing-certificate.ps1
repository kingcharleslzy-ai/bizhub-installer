[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Create")]
    [string]$OutputPfx,

    [Parameter(Mandatory = $true, ParameterSetName = "Import")]
    [string]$InputPfx,

    [Parameter(Mandatory = $true)]
    [securestring]$Password
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$rsa = $null
$certificate = $null
$passwordPointer = [IntPtr]::Zero
try {
    if ($PSCmdlet.ParameterSetName -eq "Import") {
        # CI caches the signed old installer together with the synthetic
        # publisher PFX so upgrade smoke can keep verifying one consistent
        # signing identity; this branch rehydrates that cached certificate.
        $certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($InputPfx, $Password)
    } else {
        $rsa = [System.Security.Cryptography.RSA]::Create(2048)
        $subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new(
            "CN=BizHub Desktop D3 Synthetic CI"
        )
        $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
            $subject,
            $rsa,
            [System.Security.Cryptography.HashAlgorithmName]::SHA256,
            [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
        )
        $enhancedKeyUsages = [System.Security.Cryptography.OidCollection]::new()
        $enhancedKeyUsages.Add([System.Security.Cryptography.Oid]::new("1.3.6.1.5.5.7.3.3")) | Out-Null
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new(
                $enhancedKeyUsages,
                $true
            )
        )
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new(
                $false,
                $false,
                0,
                $true
            )
        )
        $request.CertificateExtensions.Add(
            [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
                [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature,
                $true
            )
        )
        $now = [DateTimeOffset]::UtcNow
        $certificate = $request.CreateSelfSigned(
            $now.AddMinutes(-5),
            # Long enough to cover the ISO-week cache window in which CI may
            # reuse this certificate together with the cached old installer.
            $now.AddDays(14)
        )
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Password)
        $plainTextPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        [IO.File]::WriteAllBytes(
            $OutputPfx,
            $certificate.Export(
                [System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx,
                $plainTextPassword
            )
        )
    }
    [ordered]@{
        subject = $certificate.Subject
        thumbprint = $certificate.Thumbprint.Replace(" ", "").ToUpperInvariant()
    } | ConvertTo-Json -Compress
}
finally {
    if ($passwordPointer -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
    }
    if ($certificate) {
        $certificate.Dispose()
    }
    if ($rsa) {
        $rsa.Dispose()
    }
}
