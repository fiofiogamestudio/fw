param(
    [switch]$Release,

    [string]$ProjectRoot = "",

    [string]$CargoManifest = "",

    [string]$GeneratorManifest = "",

    [string]$GeneratorPackage = "fw_gen",

    [string]$LibraryPackage = "bridge",

    [string]$LibraryName = "bridge",

    [string]$BinDir = "",

    [string[]]$GenCommands = @("system", "bridge", "config"),

    [string[]]$ReleaseGenCommands = @("pak-config")
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
$ConfiguredGeneratorPackage = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "generator_package"
$ConfiguredLibraryPackage = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "library_package"
$ConfiguredLibraryName = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "library_name"
$ConfiguredBinDir = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "rust" -Key "bin_dir"

$ResolvedGeneratorManifest = if ([string]::IsNullOrWhiteSpace($GeneratorManifest)) {
    if (-not [string]::IsNullOrWhiteSpace($ConfiguredGeneratorManifest)) {
        Join-Path $ResolvedProjectRoot $ConfiguredGeneratorManifest
    } elseif ([string]::IsNullOrWhiteSpace($ConfiguredCargoManifest)) {
        Join-Path $ResolvedProjectRoot "rust\\Cargo.toml"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredCargoManifest
    }
} else {
    $GeneratorManifest
}

$ResolvedCargoManifest = if ([string]::IsNullOrWhiteSpace($CargoManifest)) {
    if ([string]::IsNullOrWhiteSpace($ConfiguredCargoManifest)) {
        Join-Path $ResolvedProjectRoot "rust\Cargo.toml"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredCargoManifest
    }
} else {
    $CargoManifest
}

$ResolvedBinDir = if ([string]::IsNullOrWhiteSpace($BinDir)) {
    if ([string]::IsNullOrWhiteSpace($ConfiguredBinDir)) {
        Join-Path $ResolvedProjectRoot "bin"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredBinDir
    }
} else {
    $BinDir
}

if ($GeneratorPackage -eq "fw_gen" -and -not [string]::IsNullOrWhiteSpace($ConfiguredGeneratorPackage)) {
    $GeneratorPackage = $ConfiguredGeneratorPackage
}
if ($LibraryPackage -eq "bridge" -and -not [string]::IsNullOrWhiteSpace($ConfiguredLibraryPackage)) {
    $LibraryPackage = $ConfiguredLibraryPackage
}
if ($LibraryName -eq "bridge" -and -not [string]::IsNullOrWhiteSpace($ConfiguredLibraryName)) {
    $LibraryName = $ConfiguredLibraryName
}

$RustRoot = Split-Path -Parent $ResolvedCargoManifest
$Profile = if ($Release) { "release" } else { "debug" }

Push-Location $ResolvedProjectRoot
try {
    $GenScript = Join-Path $PSScriptRoot "gen.ps1"
    foreach ($Command in $GenCommands) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $GenScript $Command `
            -ProjectRoot $ResolvedProjectRoot `
            -GeneratorManifest $ResolvedGeneratorManifest `
            -Package $GeneratorPackage
    }

    if ($Release) {
        foreach ($Command in $ReleaseGenCommands) {
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $GenScript $Command `
                -ProjectRoot $ResolvedProjectRoot `
                -GeneratorManifest $ResolvedGeneratorManifest `
                -Package $GeneratorPackage
        }
    }

    $CargoArgs = @(
        "build",
        "--manifest-path", $ResolvedCargoManifest,
        "-p", $LibraryPackage
    )
    if ($Release) {
        $CargoArgs += "--release"
    }
    & cargo @CargoArgs

    New-Item -ItemType Directory -Force $ResolvedBinDir | Out-Null

    $DllSource = Join-Path $RustRoot "target\$Profile\$LibraryName.dll"
    if (-not (Test-Path $DllSource)) {
        throw "Built library not found: $DllSource"
    }

    Copy-Item $DllSource (Join-Path $ResolvedBinDir "$LibraryName.dll") -Force

    $PdbSource = Join-Path $RustRoot "target\$Profile\$LibraryName.pdb"
    if (Test-Path $PdbSource) {
        Copy-Item $PdbSource (Join-Path $ResolvedBinDir "$LibraryName.pdb") -Force
    }
}
finally {
    Pop-Location
}
