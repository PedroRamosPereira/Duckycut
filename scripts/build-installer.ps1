$ErrorActionPreference = "Stop"

$ProjectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$InstallerScript = Join-Path $ProjectRoot "installer\duckycut.iss"
$ExpectedExe = Join-Path $ProjectRoot "dist\installer\DuckycutSetup.exe"

function Find-InnoCompiler {
    $command = Get-Command "ISCC.exe" -ErrorAction SilentlyContinue
    if ($command) {
        return $command.Source
    }

    $knownPaths = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    )

    foreach ($path in $knownPaths) {
        if ($path -and (Test-Path -LiteralPath $path)) {
            return $path
        }
    }

    return $null
}

Write-Host "Preparing Duckycut release payload..."
node (Join-Path $ProjectRoot "scripts\prepare-release.js")
if ($LASTEXITCODE -ne 0) {
    throw "Release payload preparation failed (exit code $LASTEXITCODE)."
}

$iscc = Find-InnoCompiler
if (-not $iscc) {
    Write-Host ""
    Write-Host "Inno Setup compiler (ISCC.exe) was not found."
    Write-Host "Install it with one of these options, then run this command again:"
    Write-Host "  winget install JRSoftware.InnoSetup"
    Write-Host "  https://jrsoftware.org/isdl.php"
    Write-Host ""
    Write-Host "Payload was prepared, but the installer .exe was not built."
    exit 1
}

Write-Host "Building installer with Inno Setup..."
& $iscc $InstallerScript

if (Test-Path -LiteralPath $ExpectedExe) {
    Write-Host "Installer created: dist\installer\DuckycutSetup.exe"
} else {
    throw "Inno Setup finished but dist\installer\DuckycutSetup.exe was not found."
}
