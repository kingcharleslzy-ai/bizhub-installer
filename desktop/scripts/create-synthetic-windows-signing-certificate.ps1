[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPfx,

    [Parameter(Mandatory = $true)]
    [securestring]$Password
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$certificate = $null
$publicCertificate = $null
$passwordPointer = [IntPtr]::Zero
try {
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
    $certificate = $request.CreateSelfSigned(
        [DateTimeOffset]::UtcNow.AddMinutes(-5),
        [DateTimeOffset]::UtcNow.AddDays(2)
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
    $publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
        $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
    )
    foreach ($storeName in @(
        [System.Security.Cryptography.X509Certificates.StoreName]::Root,
        [System.Security.Cryptography.X509Certificates.StoreName]::TrustedPublisher
    )) {
        $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
            $storeName,
            [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
        )
        try {
            $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
            $store.Add($publicCertificate)
        }
        finally {
            $store.Close()
        }
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
    if ($publicCertificate) {
        $publicCertificate.Dispose()
    }
    if ($certificate) {
        $certificate.Dispose()
    }
    $rsa.Dispose()
}
