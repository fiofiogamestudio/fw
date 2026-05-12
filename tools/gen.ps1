param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("system", "bridge", "config", "check-config", "pak-config")]
    [string]$Command,

    [string]$ProjectRoot = "",

    [string]$GeneratorProject = "",

    [string]$GeneratorManifest = "",

    [string]$Package = "",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

function Install-FwHooks {
    $FwRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $HookRoot = Join-Path $FwRoot "hooks"
    if ((Test-Path $HookRoot) -and (Test-Path (Join-Path $FwRoot ".git"))) {
        & git -C $FwRoot config core.hooksPath hooks | Out-Null
    }
}

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

Install-FwHooks

$ResolvedProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    (Resolve-Path $ProjectRoot).Path
}

$ConfiguredGeneratorProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "dotnet" -Key "generator"
if ([string]::IsNullOrWhiteSpace($ConfiguredGeneratorProject)) {
    $ConfiguredGeneratorProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "build" -Key "generator"
}
if ([string]::IsNullOrWhiteSpace($ConfiguredGeneratorProject)) {
    $ConfiguredGeneratorProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "generator" -Key "project"
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

Push-Location $ResolvedProjectRoot
try {
    $DotnetArgs = @(
        "run",
        "--project", $ResolvedGeneratorProject,
        "--",
        "--root", $ResolvedProjectRoot,
        $Command
    )
    if ($RemainingArgs) {
        $DotnetArgs += $RemainingArgs
    }
    & dotnet @DotnetArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
