param(
    [string]$Name = "",

    [string]$ProjectRoot = "",

    [string]$GeneratorManifest = "",

    [string]$Package = "fw_gen",

    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ResolvedProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    (Resolve-Path $ProjectRoot).Path
}

$ResolvedGeneratorManifest = if ([string]::IsNullOrWhiteSpace($GeneratorManifest)) {
    (Join-Path $ResolvedProjectRoot "fw\rust\Cargo.toml")
} else {
    $GeneratorManifest
}

Push-Location $ResolvedProjectRoot
try {
    $CargoArgs = @(
        "run",
        "--manifest-path", $ResolvedGeneratorManifest,
        "-p", $Package,
        "--",
        "--root", $ResolvedProjectRoot,
        "craft",
        "fw-new"
    )
    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        $CargoArgs += @("--name", $Name)
    }
    if ($Force) {
        $CargoArgs += "--force"
    }
    & cargo @CargoArgs
}
finally {
    Pop-Location
}
