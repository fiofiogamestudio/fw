param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("system", "bridge", "config", "check-config", "pak-config")]
    [string]$Command,

    [string]$ProjectRoot = "",

    [string]$GeneratorManifest = "",

    [string]$Package = "fw_gen",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

function Get-FwTomlValue {
    param(
        [string]$ProjectRoot,
        [string]$Section,
        [string]$Key
    )

    $ConfigPath = Join-Path $ProjectRoot "fw.toml"
    if (-not (Test-Path $ConfigPath)) {
        return $null
    }

    $CurrentSection = ""
    foreach ($Line in Get-Content -Encoding UTF8 $ConfigPath) {
        $Trimmed = $Line.Trim()
        if ([string]::IsNullOrWhiteSpace($Trimmed) -or $Trimmed.StartsWith("#")) {
            continue
        }
        if ($Trimmed -match '^\[(.+)\]$') {
            $CurrentSection = $Matches[1]
            continue
        }
        if ($CurrentSection -ne $Section) {
            continue
        }
        if ($Trimmed -match '^([A-Za-z0-9_]+)\s*=\s*"(.*)"$' -and $Matches[1] -eq $Key) {
            return $Matches[2]
        }
    }

    return $null
}

$ResolvedProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    Resolve-Path (Join-Path $PSScriptRoot "..\..")
} else {
    Resolve-Path $ProjectRoot
}

$ConfiguredGeneratorManifest = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "generator_manifest"
$ConfiguredCargoManifest = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "workspace"
$ConfiguredPackage = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "generator_package"

$ResolvedGeneratorManifest = if ([string]::IsNullOrWhiteSpace($GeneratorManifest)) {
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredGeneratorManifest)) {
        Join-Path $ResolvedProjectRoot $ConfiguredGeneratorManifest
    } elseif ([string]::IsNullOrWhiteSpace($ConfiguredCargoManifest)) {
        Join-Path $ResolvedProjectRoot "rust\Cargo.toml"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredCargoManifest
    }
} else {
    $GeneratorManifest
}

if ($Package -eq "fw_gen" -and -not [string]::IsNullOrWhiteSpace($ConfiguredPackage)) {
    $Package = $ConfiguredPackage
}

$Subcommand = switch ($Command) {
    "system" { "system" }
    "bridge" { "bridge" }
    "config" { "config" }
    "check-config" { "check-config" }
    "pak-config" { "pak-config" }
    default { throw "Unsupported fw_gen command: $Command" }
}

Push-Location $ResolvedProjectRoot
try {
    $CargoArgs = @(
        "run",
        "--manifest-path", $ResolvedGeneratorManifest,
        "-p", $Package,
        "--",
        "--root", $ResolvedProjectRoot,
        $Subcommand
    )
    if ($RemainingArgs) {
        $CargoArgs += $RemainingArgs
    }
    & cargo @CargoArgs
}
finally {
    Pop-Location
}
