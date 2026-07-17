param(
    [switch]$Release,

    [string]$ProjectRoot = "",

    [string]$CSharpProject = "",

    [string]$GeneratorProject = "",

    [string[]]$GenCommands = @("system", "bridge", "config", "config_check", "check"),

    [string[]]$ReleaseGenCommands = @("config_pack")
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
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    (Resolve-Path $ProjectRoot).Path
}

$ConfiguredCSharpProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "dotnet" -Key "game"
$ConfiguredGeneratorProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "dotnet" -Key "fwgen"
$ConfiguredProjectName = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "project" -Key "name"

$ResolvedCSharpProject = if ([string]::IsNullOrWhiteSpace($CSharpProject)) {
    if ([string]::IsNullOrWhiteSpace($ConfiguredCSharpProject)) {
        $DefaultProjectName = if ([string]::IsNullOrWhiteSpace($ConfiguredProjectName)) { "Game" } else { $ConfiguredProjectName }
        Join-Path $ResolvedProjectRoot "${DefaultProjectName}.csproj"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredCSharpProject
    }
} else {
    $CSharpProject
}

$ResolvedGeneratorProject = if ([string]::IsNullOrWhiteSpace($GeneratorProject)) {
    if ([string]::IsNullOrWhiteSpace($ConfiguredGeneratorProject)) {
        Join-Path $ResolvedProjectRoot "fw\csharp\FwGen\FwGen.csproj"
    } else {
        Join-Path $ResolvedProjectRoot $ConfiguredGeneratorProject
    }
} else {
    $GeneratorProject
}

$Configuration = if ($Release) { "Release" } else { "Debug" }

Push-Location $ResolvedProjectRoot
try {
    $GenScript = Join-Path $PSScriptRoot "gen.ps1"
    foreach ($Command in $GenCommands) {
        & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $GenScript $Command `
            -ProjectRoot $ResolvedProjectRoot `
            -GeneratorProject $ResolvedGeneratorProject
        if ($LASTEXITCODE -ne 0) {
            exit $LASTEXITCODE
        }
    }

    if ($Release) {
        foreach ($Command in $ReleaseGenCommands) {
            & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $GenScript $Command `
                -ProjectRoot $ResolvedProjectRoot `
                -GeneratorProject $ResolvedGeneratorProject
            if ($LASTEXITCODE -ne 0) {
                exit $LASTEXITCODE
            }
        }
    }

    & dotnet build $ResolvedCSharpProject -c $Configuration
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
