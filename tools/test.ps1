param(
    [switch]$SkipGodot
)

$ErrorActionPreference = "Stop"
$GodotEditorTimeoutSeconds = if ($env:FW_GODOT_EDITOR_TIMEOUT_SECONDS) {
    [int]$env:FW_GODOT_EDITOR_TIMEOUT_SECONDS
} else {
    90
}
$GodotRunTimeoutSeconds = if ($env:FW_GODOT_RUN_TIMEOUT_SECONDS) {
    [int]$env:FW_GODOT_RUN_TIMEOUT_SECONDS
} else {
    30
}
if ($GodotEditorTimeoutSeconds -le 0 -or $GodotRunTimeoutSeconds -le 0) {
    throw "Godot test timeouts must be positive seconds."
}
$FwRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$TempBase = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) "fw template tests"))
$TestRoot = [IO.Path]::GetFullPath((Join-Path $TempBase ([Guid]::NewGuid().ToString("N"))))
$FwLink = Join-Path $TestRoot "fw"
$Succeeded = $false

if (-not $TestRoot.StartsWith($TempBase + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "unsafe test root: $TestRoot"
}

function Assert-GodotLog {
    param(
        [string]$Path,
        [string]$Label,
        [switch]$AllowFaultInjection
    )

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "$Label did not create a Godot log."
    }
    $Content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ($AllowFaultInjection) {
        $Content = $Content.Replace("ERROR: System 'second' init must return true; initialization failed.", "EXPECTED: system init failure")
        $Content = $Content.Replace("ERROR: FUI can only open scenes whose root extends FForm.", "EXPECTED: invalid form rejection")
    }
    $ProjectErrorPattern = '(?im)(SCRIPT ERROR|Parse Error|Compile Error|Can''t run project|^ERROR:)'
    if ($Content -match $ProjectErrorPattern) {
        throw "$Label reported a Godot error:`n$Content"
    }
}

function Resolve-GodotDotNet {
    $Candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:GODOT_BIN)) {
        $Candidates += $env:GODOT_BIN
    }
    foreach ($Name in @("godot_mono", "godot4_mono", "godot_console", "godot", "godot4")) {
        $Command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue
        if ($null -ne $Command) {
            $Candidates += $Command.Source
        }
    }

    foreach ($Candidate in $Candidates | Select-Object -Unique) {
        if (-not (Test-Path -LiteralPath $Candidate -PathType Leaf)) {
            continue
        }
        $Executable = Get-Item -LiteralPath $Candidate
        if ($null -ne $Executable.LinkType -and $null -ne $Executable.Target) {
            $TargetPath = @($Executable.Target)[0]
            if (-not [IO.Path]::IsPathRooted($TargetPath)) {
                $TargetPath = Join-Path $Executable.DirectoryName $TargetPath
            }
            if (Test-Path -LiteralPath $TargetPath -PathType Leaf) {
                $Executable = Get-Item -LiteralPath $TargetPath
            }
        }
        $GodotSharp = Join-Path $Executable.DirectoryName "GodotSharp"
        if ($Executable.Name -match '(?i)mono' -or (Test-Path -LiteralPath $GodotSharp -PathType Container)) {
            return $Executable.FullName
        }
    }
    return $null
}

function Invoke-Godot {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$Label,
        [int]$TimeoutSeconds
    )

    $ArgumentLine = ($Arguments | ForEach-Object { ConvertTo-NativeArgument $_ }) -join " "
    $Process = Start-Process -FilePath $Executable `
        -ArgumentList $ArgumentLine `
        -WindowStyle Hidden `
        -PassThru
    if (-not $Process.WaitForExit($TimeoutSeconds * 1000)) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit()
        throw "$Label timed out after $TimeoutSeconds seconds."
    }
    if ($Process.ExitCode -ne 0) {
        throw "$Label exited with code $($Process.ExitCode)."
    }
}

function ConvertTo-NativeArgument {
    param([string]$Value)

    if ($Value -notmatch '[\s"]') {
        return $Value
    }

    $Builder = [Text.StringBuilder]::new()
    [void]$Builder.Append('"')
    $Backslashes = 0
    foreach ($Character in $Value.ToCharArray()) {
        if ($Character -eq '\') {
            $Backslashes++
            continue
        }
        if ($Character -eq '"') {
            for ($Index = 0; $Index -lt ($Backslashes * 2 + 1); $Index++) {
                [void]$Builder.Append('\')
            }
            [void]$Builder.Append('"')
            $Backslashes = 0
            continue
        }
        for ($Index = 0; $Index -lt $Backslashes; $Index++) {
            [void]$Builder.Append('\')
        }
        $Backslashes = 0
        [void]$Builder.Append($Character)
    }
    for ($Index = 0; $Index -lt ($Backslashes * 2); $Index++) {
        [void]$Builder.Append('\')
    }
    [void]$Builder.Append('"')
    return $Builder.ToString()
}

function Get-TreeSnapshot {
    param(
        [string]$Root,
        [string[]]$RelativeRoots
    )

    $RootPath = [IO.Path]::GetFullPath($Root).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $Entries = foreach ($RelativeRoot in $RelativeRoots) {
        $Path = Join-Path $Root $RelativeRoot
        if (-not (Test-Path -LiteralPath $Path)) {
            continue
        }
        foreach ($File in Get-ChildItem -LiteralPath $Path -Recurse -File) {
            $Relative = $File.FullName.Substring($RootPath.Length).TrimStart('\', '/').Replace('\', '/')
            "$Relative=$((Get-FileHash -LiteralPath $File.FullName -Algorithm SHA256).Hash)"
        }
    }
    return ($Entries | Sort-Object) -join "`n"
}

try {
    foreach ($Pair in @(
        @{ Source = "docs\rule.md"; Mirror = "templates\fw_new\default\docs\fw\rule.md.tpl" },
        @{ Source = "docs\spec.md"; Mirror = "templates\fw_new\default\docs\fw\spec.md.tpl" },
        @{ Source = "docs\use.md"; Mirror = "templates\fw_new\default\docs\fw\use.md.tpl" },
        @{ Source = ".codex\skills\fw\SKILL.md"; Mirror = "templates\fw_new\default\.codex\skills\fw\SKILL.md.tpl" }
    )) {
        $Source = Join-Path $FwRoot $Pair.Source
        $Mirror = Join-Path $FwRoot $Pair.Mirror
        if (-not (Test-Path -LiteralPath $Source) -or -not (Test-Path -LiteralPath $Mirror)) {
            throw "framework mirror is missing: $($Pair.Source) -> $($Pair.Mirror)"
        }
        if ((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $Mirror -Algorithm SHA256).Hash) {
            throw "framework mirror is stale: $($Pair.Source) -> $($Pair.Mirror)"
        }
    }

    & dotnet build (Join-Path $FwRoot "csharp\FwRuntime\FwRuntime.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & dotnet build (Join-Path $FwRoot "csharp\FwGen\FwGen.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & dotnet run --project (Join-Path $FwRoot "csharp\FwGenTests\FwGenTests.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null
    New-Item -ItemType Junction -Path $FwLink -Target $FwRoot | Out-Null
    $Generator = Join-Path $FwRoot "csharp\FwGen\FwGen.csproj"
    & dotnet run --project $Generator -c Release -- --root $TestRoot craft fw-new --name fw_audit
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & dotnet run --project $Generator -c Release -- --root $TestRoot check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $GeneratedBefore = Get-TreeSnapshot -Root $TestRoot -RelativeRoots @("scripts\_gen", "csharp\_gen")
    foreach ($Command in @("system", "bridge", "config")) {
        & dotnet run --project $Generator -c Release -- --root $TestRoot $Command
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    }
    $GeneratedAfter = Get-TreeSnapshot -Root $TestRoot -RelativeRoots @("scripts\_gen", "csharp\_gen")
    if ($GeneratedBefore -ne $GeneratedAfter) {
        throw "repeated generation is not deterministic."
    }
    Add-Content -LiteralPath (Join-Path $TestRoot "csharp\_gen\_core_systems.cs") -Value "// tampered"
    & dotnet run --project $Generator -c Release -- --root $TestRoot check
    if ($LASTEXITCODE -eq 0) { throw "fw check accepted a modified generated file." }
    & dotnet run --project $Generator -c Release -- --root $TestRoot system
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & dotnet run --project $Generator -c Release -- --root $TestRoot check
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    & dotnet run --project $Generator -c Release -- --root $TestRoot config_pack
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $PackBefore = Get-TreeSnapshot -Root $TestRoot -RelativeRoots @("pack\config")
    & dotnet run --project $Generator -c Release -- --root $TestRoot config_pack
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    $PackAfter = Get-TreeSnapshot -Root $TestRoot -RelativeRoots @("pack\config")
    if ($PackBefore -ne $PackAfter) {
        throw "repeated config packing is not deterministic."
    }
    & dotnet build (Join-Path $TestRoot "fw_audit.csproj") -c Release
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

    if (-not $SkipGodot) {
        $Godot = Resolve-GodotDotNet
        if ($null -ne $Godot) {
            & dotnet build (Join-Path $TestRoot "fw_audit.csproj") -c Debug
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $EditorLog = Join-Path $TestRoot "godot_editor.log"
            Invoke-Godot `
                -Executable $Godot `
                -Arguments @("--headless", "--editor", "--path", $TestRoot, "--log-file", $EditorLog, "--quit") `
                -Label "Godot editor check" `
                -TimeoutSeconds $GodotEditorTimeoutSeconds
            Assert-GodotLog -Path $EditorLog -Label "Godot editor check"
            & dotnet run --project $Generator -c Release -- --root $TestRoot check
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            & dotnet build (Join-Path $TestRoot "fw_audit.csproj") -c Debug
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
            $ClassCache = Join-Path $TestRoot ".godot\global_script_class_cache.cfg"
            if (-not (Test-Path -LiteralPath $ClassCache)) {
                throw "Godot headless check did not create the script class cache."
            }
            $RuntimeLog = Join-Path $TestRoot "godot_runtime.log"
            Invoke-Godot `
                -Executable $Godot `
                -Arguments @("--headless", "--path", $TestRoot, "--log-file", $RuntimeLog, "--script", "res://fw/tests/runtime_test.gd") `
                -Label "Godot runtime check" `
                -TimeoutSeconds $GodotRunTimeoutSeconds
            Assert-GodotLog -Path $RuntimeLog -Label "Godot runtime check" -AllowFaultInjection
            $GameLog = Join-Path $TestRoot "godot_game.log"
            Invoke-Godot `
                -Executable $Godot `
                -Arguments @("--headless", "--path", $TestRoot, "--log-file", $GameLog, "--quit-after", "3") `
                -Label "Godot game check" `
                -TimeoutSeconds $GodotRunTimeoutSeconds
            Assert-GodotLog -Path $GameLog -Label "Godot game check"
        }
        else {
            Write-Host "Godot .NET not found; headless C# template check skipped. Set GODOT_BIN to enable it."
        }
    }

    $Succeeded = $true
}
finally {
    if (-not $Succeeded -and (Test-Path -LiteralPath $TestRoot)) {
        foreach ($Log in Get-ChildItem -LiteralPath $TestRoot -Filter "godot_*.log" -File -ErrorAction SilentlyContinue) {
            Write-Host "--- $($Log.Name) ---"
            Get-Content -LiteralPath $Log.FullName -Encoding UTF8
        }
    }
    if ([IO.Directory]::Exists($FwLink)) {
        [IO.Directory]::Delete($FwLink, $false)
    }
    if (Test-Path -LiteralPath $TestRoot) {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
    if ((Test-Path -LiteralPath $TempBase) -and -not (Get-ChildItem -LiteralPath $TempBase -Force | Select-Object -First 1)) {
        Remove-Item -LiteralPath $TempBase -Force
    }
}

if ($Succeeded) {
    Write-Host "fw tests passed."
}
