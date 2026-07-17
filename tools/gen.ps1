param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("system", "bridge", "config", "config_check", "config_pack", "check")]
    [string]$Command,

    [string]$ProjectRoot = "",

    [string]$GeneratorProject = "",

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
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    (Resolve-Path $ProjectRoot).Path
}

$ConfiguredGeneratorProject = Get-FwTomlValue -ProjectRoot $ResolvedProjectRoot -Section "dotnet" -Key "fwgen"
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
