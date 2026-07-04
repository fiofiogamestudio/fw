param(
    [string]$ProjectRoot = "",

    [string]$GeneratorProject = "",

    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

$GenScript = Join-Path $PSScriptRoot "gen.ps1"
$Args = @("check")
if (-not [string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $Args += @("-ProjectRoot", $ProjectRoot)
}
if (-not [string]::IsNullOrWhiteSpace($GeneratorProject)) {
    $Args += @("-GeneratorProject", $GeneratorProject)
}
if ($RemainingArgs) {
    $Args += $RemainingArgs
}

& powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $GenScript @Args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
