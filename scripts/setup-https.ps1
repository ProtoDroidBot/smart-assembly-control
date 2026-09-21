#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) '.certs'),
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$targetDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
$keyPath = Join-Path $targetDirectory 'localhost-key.pem'
$certPath = Join-Path $targetDirectory 'localhost.pem'

if (-not $Force -and ((Test-Path -LiteralPath $keyPath) -or (Test-Path -LiteralPath $certPath))) {
    throw 'A TLS certificate or key already exists. Use -Force explicitly to replace both files.'
}

$rsa = [System.Security.Cryptography.RSA]::Create(3072)
$certificate = $null
try {
    $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
        'CN=localhost',
        $rsa,
        [System.Security.Cryptography.HashAlgorithmName]::SHA256,
        [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
    )
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true)
    )
    $keyUsage = [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor
        [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new($keyUsage, $true)
    )
    $serverAuth = [System.Security.Cryptography.OidCollection]::new()
    [void]$serverAuth.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1', 'Server Authentication'))
    $request.CertificateExtensions.Add(
        [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($serverAuth, $false)
    )
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddDnsName('localhost')
    $san.AddDnsName('dev.dapps.evefrontier.com')
    $san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
    $san.AddIpAddress([System.Net.IPAddress]::Parse('::1'))
    $request.CertificateExtensions.Add($san.Build())

    $validFrom = [System.DateTimeOffset]::UtcNow.AddMinutes(-5)
    $certificate = $request.CreateSelfSigned($validFrom, $validFrom.AddDays(365))
    [void][System.IO.Directory]::CreateDirectory($targetDirectory)
    $mode = if ($Force) { [System.IO.FileMode]::Create } else { [System.IO.FileMode]::CreateNew }
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $files = @(
        @{ Path = $keyPath; Pem = $rsa.ExportPkcs8PrivateKeyPem() },
        @{ Path = $certPath; Pem = $certificate.ExportCertificatePem() }
    )
    foreach ($file in $files) {
        $stream = [System.IO.FileStream]::new($file.Path, $mode, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $bytes = $encoding.GetBytes($file.Pem + [System.Environment]::NewLine)
            $stream.Write($bytes, 0, $bytes.Length)
        }
        finally {
            $stream.Dispose()
        }
    }
    Write-Output "Created local TLS certificate: $certPath"
    Write-Output ('SHA-256 fingerprint: ' + $certificate.GetCertHashString([System.Security.Cryptography.HashAlgorithmName]::SHA256))
    Write-Output ('Expires (UTC): ' + $certificate.NotAfter.ToUniversalTime().ToString('u'))
    Write-Output 'Certificate covers dev.dapps.evefrontier.com, localhost, 127.0.0.1 and ::1. No certificate store or trust settings were changed.'
}
finally {
    if ($null -ne $certificate) { $certificate.Dispose() }
    $rsa.Dispose()
}
