param(
    [string]$InstallDir = "$env:APPDATA\Adobe\CEP\extensions\com.duckycut.panel",
    [string]$ReportPath = ""
)

$ErrorActionPreference = "Continue"

$results = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

function Add-Result {
    param(
        [string]$Status,
        [string]$Message
    )
    $results.Add("[$Status] $Message") | Out-Null
    if ($Status -eq "WARN" -or $Status -eq "MISSING") {
        $warnings.Add($Message) | Out-Null
    }
}

function Test-CommandOnPath {
    param(
        [string]$Name,
        [string]$FriendlyName
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($command) {
        Add-Result "OK" "$FriendlyName found on PATH: $($command.Source)"
    } else {
        Add-Result "MISSING" "$FriendlyName was not found on PATH. Install it and restart Premiere before using Duckycut."
    }
}

Test-CommandOnPath "ffmpeg" "FFmpeg"
Test-CommandOnPath "node" "Node.js"

$cepFolder = Join-Path $env:APPDATA "Adobe\CEP\extensions"
if (Test-Path -LiteralPath $cepFolder) {
    Add-Result "OK" "CEP extensions folder exists: $cepFolder"
} else {
    Add-Result "WARN" "CEP extensions folder is not available yet: $cepFolder. It is normally created by Adobe apps or this installer."
}

$debugKeys = Get-ChildItem "HKCU:\SOFTWARE\Adobe" -ErrorAction SilentlyContinue |
    Where-Object { $_.PSChildName -like "CSXS.*" -and $_.PSChildName -match "^CSXS\.\d+$" }

if ($debugKeys) {
    foreach ($key in $debugKeys) {
        $value = (Get-ItemProperty -LiteralPath $key.PSPath -Name "PlayerDebugMode" -ErrorAction SilentlyContinue).PlayerDebugMode
        if ($value -eq "1") {
            Add-Result "OK" "$($key.PSChildName) PlayerDebugMode=1"
        } else {
            Add-Result "WARN" "$($key.PSChildName) exists but PlayerDebugMode is not 1"
        }
    }
} else {
    Add-Result "WARN" "No HKCU:\SOFTWARE\Adobe\CSXS.* keys were found before enabling CEP debug mode."
}

$requiredPayloadFiles = @(
    "client\index.html",
    "host\index.jsx",
    "CSXS\manifest.xml",
    "preset\Duckycut_Silero_Analysis.epr",
    "server\silenceDetector.js",
    "server\vadDetector.js",
    "server\vadWorker.js",
    "server\models\silero_vad.onnx",
    "package.json",
    "package-lock.json"
)

foreach ($relativePath in $requiredPayloadFiles) {
    $fullPath = Join-Path $InstallDir $relativePath
    if (Test-Path -LiteralPath $fullPath) {
        Add-Result "OK" "Required file present: $relativePath"
    } else {
        Add-Result "MISSING" "Required file missing from Duckycut install: $relativePath"
    }
}

if (Test-Path -LiteralPath (Join-Path $InstallDir "node_modules\onnxruntime-node")) {
    Add-Result "OK" "onnxruntime-node dependency is present in the installed payload."
} else {
    Add-Result "WARN" "onnxruntime-node was not found in the installed payload. VAD may require running npm install in the extension folder."
}

$summary = if ($warnings.Count -gt 0) {
    "Duckycut dependency check completed with warnings."
} else {
    "Duckycut dependency check completed successfully."
}

$output = @($summary, "") + $results
$text = $output -join [Environment]::NewLine

if ($ReportPath) {
    $reportDir = Split-Path -Parent $ReportPath
    if ($reportDir -and -not (Test-Path -LiteralPath $reportDir)) {
        New-Item -ItemType Directory -Path $reportDir -Force | Out-Null
    }
    Set-Content -LiteralPath $ReportPath -Value $text -Encoding UTF8
}

Write-Output $text

if ($warnings.Count -gt 0) {
    exit 2
}

exit 0
