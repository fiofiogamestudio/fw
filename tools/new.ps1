param(
    [string]$Name = "",

    [string]$ProjectRoot = "",

    [string]$GeneratorProject = "",

    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ResolvedProjectRoot = if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
} else {
    (Resolve-Path $ProjectRoot).Path
}

$ResolvedGeneratorProject = if ([string]::IsNullOrWhiteSpace($GeneratorProject)) {
    Join-Path $ResolvedProjectRoot "fw\csharp\FwGen\FwGen.csproj"
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
        "craft",
        "fw-new"
    )
    if (-not [string]::IsNullOrWhiteSpace($Name)) {
        $DotnetArgs += @("--name", $Name)
    }
    if ($Force) {
        $DotnetArgs += "--force"
    }
    & dotnet @DotnetArgs
    if ($LASTEXITCODE -ne 0) {
        exit $LASTEXITCODE
    }
}
finally {
    Pop-Location
}
