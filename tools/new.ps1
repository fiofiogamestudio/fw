param(
    [string]$Name = "",

    [string]$ProjectRoot = "",

    [string]$GeneratorProject = "",

    [switch]$Force
)

$ErrorActionPreference = "Stop"

function Install-FwHooks {
    $FwRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
    $HookRoot = Join-Path $FwRoot "hooks"
    if ((Test-Path $HookRoot) -and (Test-Path (Join-Path $FwRoot ".git"))) {
        $PreviousErrorActionPreference = $ErrorActionPreference
        try {
            $ErrorActionPreference = "Continue"
            & git -C $FwRoot config core.hooksPath hooks 2>$null | Out-Null
        }
        catch {
        }
        finally {
            $ErrorActionPreference = $PreviousErrorActionPreference
        }
    }
}

Install-FwHooks

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
