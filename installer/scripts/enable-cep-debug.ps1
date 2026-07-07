$ErrorActionPreference = "Stop"

$versions = @("9", "10", "11", "12", "13")

foreach ($version in $versions) {
    $path = "HKCU:\SOFTWARE\Adobe\CSXS.$version"
    if (-not (Test-Path -LiteralPath $path)) {
        New-Item -Path $path -Force | Out-Null
    }

    New-ItemProperty `
        -Path $path `
        -Name "PlayerDebugMode" `
        -Value "1" `
        -PropertyType String `
        -Force | Out-Null
}

Write-Host "CEP unsigned extensions enabled for CSXS.9, CSXS.10, CSXS.11, CSXS.12, and CSXS.13."
