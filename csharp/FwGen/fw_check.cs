using System.Text;
using System.Text.Json;

static class FwCheck
{
    internal static bool IsUnderPath(string path, string parent)
    {
        string fullPath = Path.GetFullPath(path);
        string fullParent = Path.TrimEndingDirectorySeparator(Path.GetFullPath(parent));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        string parentPrefix = Path.EndsInDirectorySeparator(fullParent)
            ? fullParent
            : fullParent + Path.DirectorySeparatorChar;
        return fullPath.Equals(fullParent, comparison)
            || fullPath.StartsWith(parentPrefix, comparison);
    }

    private static readonly string[] GdSuffixes =
    [
        "_app",
        "_mode",
        "_context",
        "_system",
        "_logic",
        "_vm",
        "_vm_builder",
        "_actor",
        "_view",
        "_fx",
        "_form",
        "_widget",
        "_tool",
    ];

    private static readonly string[] CSharpSuffixes =
    [
        "_app",
        "_bridge",
        "_codec",
        "_runtime",
        "_context",
        "_config",
        "_core",
        "_system",
        "_state",
        "_rules",
        "_const",
        "_intent",
        "_event",
        "_compat",
    ];

    private static readonly string[] TextExtensions =
    [
        ".cs",
        ".csproj",
        ".gd",
        ".godot",
        ".toml",
        ".tres",
        ".tscn",
        ".tpl",
    ];

    private static readonly string[] ForbiddenReferenceTexts =
    [
        "res://prefabs/ui",
        "prefabs/ui",
        "res://scenes/main.tscn",
        "csharp/core/authority",
        "csharp/core/run",
        "csharp/core/domain",
        "core/authority",
        "core/run",
        "core/domain",
        "&\"presentation\"",
        "phase = \"presentation\"",
    ];

    public static void Run(string root, FwConfig config)
    {
        var checker = new Checker(root, config);
        checker.Run();
    }

    private sealed class Checker
    {
        private readonly string _root;
        private readonly FwConfig _config;
        private readonly List<string> _errors = [];
        private readonly List<string> _warnings = [];

        public Checker(string root, FwConfig config)
        {
            _root = Path.GetFullPath(root);
            _config = config;
        }

        public void Run()
        {
            CheckFwToml();
            CheckProjectGodot();
            CheckToolchain();
            CheckRequiredLayout();
            CheckSchemas();
            CheckForbiddenDirs();
            CheckRoleDirs();
            CheckPrefabRoleScripts();
            CheckGeneratedFiles();
            CheckGeneratedManifest();
            CheckFileSuffixes();
            CheckCSharpBridgeEntries();
            CheckForbiddenReferences();

            foreach (string warning in _warnings)
            {
                Console.WriteLine($"[warn] {warning}");
            }

            if (_errors.Count > 0)
            {
                foreach (string error in _errors)
                {
                    Console.Error.WriteLine($"[error] {error}");
                }
                throw new InvalidOperationException($"fw check failed: {_errors.Count} error(s)");
            }

            Console.WriteLine("fw check passed.");
        }

        private void CheckGeneratedManifest()
        {
            try
            {
                GenerationManifest.Verify(_root, _config);
            }
            catch (Exception ex)
            {
                Error(ex.Message);
            }
        }

        private void CheckSchemas()
        {
            try
            {
                string systems = _config.SystemsSchemaPath(_root);
                if (File.Exists(systems))
                {
                    SystemSchemaParser.Parse(_root, systems);
                }
            }
            catch (Exception ex)
            {
                Error($"invalid system schema: {ex.Message}");
            }

            CheckBridgeSchema(_config.BridgeSchemaDir(_root));
            CheckProtoSchema(_config.ConfigSchemaDir(_root), "config");
        }

        private void CheckBridgeSchema(string dir)
        {
            try
            {
                var schema = ProtoSchema.ParseFiles(BridgeSchema.SchemaFiles(dir));
                if (string.IsNullOrWhiteSpace(schema.Package))
                {
                    Error("bridge schema must declare one shared package");
                }
            }
            catch (Exception ex)
            {
                Error($"invalid bridge schema: {ex.Message}");
            }
        }

        private void CheckProtoSchema(string dir, string label)
        {
            if (!Directory.Exists(dir))
            {
                return;
            }
            try
            {
                ProtoSchema.ParseFiles(Directory.GetFiles(dir, "*.proto").OrderBy(item => item, StringComparer.Ordinal));
            }
            catch (Exception ex)
            {
                Error($"invalid {label} schema: {ex.Message}");
            }
        }

        private void CheckFwToml()
        {
            RequireFile(Path.Combine(_root, "fw.toml"), "fw.toml");

            RequireConfigValue("project", "name");
            RequireConfigValue("schema", "system");
            RequireConfigValue("schema", "bridge");
            RequireConfigValue("schema", "config");
            RequireConfigValue("gen", "gdscript");
            RequireConfigValue("gen", "csharp");
            RequireConfigValue("data", "config");
            RequireConfigValue("pack", "config");
            RequireConfigValue("script", "gdscript");
            RequireConfigValue("script", "csharp");
            RequireConfigValue("dotnet", "game");
            RequireConfigValue("dotnet", "fwgen");
            try
            {
                Craft.ValidateProjectName(_config.ProjectName());
            }
            catch (Exception ex)
            {
                Error($"invalid [project].name: {ex.Message}");
            }
        }

        private void CheckProjectGodot()
        {
            string path = Path.Combine(_root, "project.godot");
            RequireFile(path, "project.godot");
            if (!File.Exists(path))
            {
                return;
            }

            string text = File.ReadAllText(path, Encoding.UTF8);
            var match = System.Text.RegularExpressions.Regex.Match(
                text,
                "(?m)^\\s*project/assembly_name\\s*=\\s*\"([^\"]+)\"\\s*$"
            );
            if (!match.Success)
            {
                Error("project.godot must define [dotnet] project/assembly_name");
                return;
            }

            string expected = _config.ProjectName();
            string actual = match.Groups[1].Value;
            if (!string.Equals(actual, expected, StringComparison.Ordinal))
            {
                Error($"project.godot assembly name `{actual}` must match [project].name `{expected}`");
            }
        }

        private void CheckToolchain()
        {
            string globalPath = Path.Combine(_root, "global.json");
            string propsPath = Path.Combine(_root, "Directory.Build.props");
            string gameProject = _config.CSharpProjectPath(_root);
            string generatorProject = _config.GeneratorProjectPath(_root);
            RequireFile(globalPath, "global.json");
            RequireFile(propsPath, "Directory.Build.props");
            RequireFile(gameProject, "[dotnet].game");
            RequireFile(generatorProject, "[dotnet].fwgen");

            string pinnedGodotSdk = "";

            if (File.Exists(globalPath))
            {
                try
                {
                    using JsonDocument document = JsonDocument.Parse(File.ReadAllText(globalPath, Encoding.UTF8));
                    JsonElement root = document.RootElement;
                    bool hasSdk = root.TryGetProperty("sdk", out JsonElement sdk)
                        && sdk.TryGetProperty("version", out JsonElement sdkVersion)
                        && !string.IsNullOrWhiteSpace(sdkVersion.GetString());
                    string? godotSdk = null;
                    if (
                        root.TryGetProperty("msbuild-sdks", out JsonElement sdks)
                        && sdks.TryGetProperty("Godot.NET.Sdk", out JsonElement godotVersion)
                    )
                    {
                        godotSdk = godotVersion.GetString();
                    }
                    bool hasGodot = !string.IsNullOrWhiteSpace(godotSdk);
                    pinnedGodotSdk = godotSdk ?? "";
                    if (!hasSdk || !hasGodot)
                    {
                        Error("global.json must pin sdk.version and msbuild-sdks/Godot.NET.Sdk");
                    }
                }
                catch (Exception ex) when (ex is JsonException or IOException)
                {
                    Error($"invalid global.json: {ex.Message}");
                }
            }

            string targetFramework = "";
            if (File.Exists(propsPath))
            {
                string props = File.ReadAllText(propsPath, Encoding.UTF8);
                var targetMatch = System.Text.RegularExpressions.Regex.Match(
                    props,
                    "<TargetFramework>\\s*([^<]+?)\\s*</TargetFramework>"
                );
                if (!targetMatch.Success)
                {
                    Error("Directory.Build.props must define TargetFramework");
                }
                else
                {
                    targetFramework = targetMatch.Groups[1].Value;
                }
            }

            if (File.Exists(gameProject))
            {
                string project = File.ReadAllText(gameProject, Encoding.UTF8);
                var sdkMatch = System.Text.RegularExpressions.Regex.Match(
                    project,
                    "<Project\\b[^>]*\\bSdk=[\"']Godot\\.NET\\.Sdk(?:/([^\"']+))?[\"']"
                );
                if (!sdkMatch.Success)
                {
                    Error($"{Rel(gameProject)} must use Godot.NET.Sdk");
                }
                else if (
                    sdkMatch.Groups[1].Success
                    && pinnedGodotSdk.Length > 0
                    && !string.Equals(sdkMatch.Groups[1].Value, pinnedGodotSdk, StringComparison.Ordinal)
                )
                {
                    Error($"{Rel(gameProject)} Godot.NET.Sdk must match global.json ({pinnedGodotSdk})");
                }

                var projectTargetMatch = System.Text.RegularExpressions.Regex.Match(
                    project,
                    "<TargetFramework>\\s*([^<]+?)\\s*</TargetFramework>"
                );
                if (
                    projectTargetMatch.Success
                    && targetFramework.Length > 0
                    && !string.Equals(projectTargetMatch.Groups[1].Value, targetFramework, StringComparison.Ordinal)
                )
                {
                    Error($"{Rel(gameProject)} TargetFramework must match Directory.Build.props ({targetFramework})");
                }
            }

            string? generatorDir = Path.GetDirectoryName(generatorProject);
            string? frameworkCSharpDir = generatorDir == null ? null : Directory.GetParent(generatorDir)?.FullName;
            string frameworkPropsPath = frameworkCSharpDir == null
                ? ""
                : Path.Combine(frameworkCSharpDir, "Directory.Build.props");
            if (frameworkPropsPath.Length > 0 && File.Exists(frameworkPropsPath) && targetFramework.Length > 0)
            {
                string frameworkProps = File.ReadAllText(frameworkPropsPath, Encoding.UTF8);
                var frameworkTargetMatch = System.Text.RegularExpressions.Regex.Match(
                    frameworkProps,
                    "<TargetFramework>\\s*([^<]+?)\\s*</TargetFramework>"
                );
                if (
                    !frameworkTargetMatch.Success
                    || !string.Equals(frameworkTargetMatch.Groups[1].Value, targetFramework, StringComparison.Ordinal)
                )
                {
                    Error($"{Rel(frameworkPropsPath)} TargetFramework must match Directory.Build.props ({targetFramework})");
                }
            }
        }

        private void CheckRequiredLayout()
        {
            RequireFile(_config.SystemsSchemaPath(_root), "[schema].system");
            RequireDir(_config.BridgeSchemaDir(_root), "[schema].bridge");
            RequireDir(_config.ConfigSchemaDir(_root), "[schema].config");
            RequireDir(_config.ConfigDataDir(_root), "[data].config");

            string gdRoot = _config.PathValue(_root, "script", "gdscript", "scripts");
            string csharpRoot = _config.PathValue(_root, "script", "csharp", "csharp");
            string gdGen = _config.GodotGenDir(_root);
            string csharpGen = Path.GetDirectoryName(_config.CoreSystemsCsPath(_root)) ?? Path.Combine(_root, "csharp", "_gen");

            RequireDir(gdRoot, "[script].gdscript");
            RequireDir(csharpRoot, "[script].csharp");
            RequireDir(gdGen, "[gen].gdscript");
            RequireDir(csharpGen, "[gen].csharp");

            RequireDir(Path.Combine(csharpRoot, "bridge"), "csharp/bridge");
            RequireDir(Path.Combine(csharpRoot, "core"), "csharp/core");
            RequireDir(Path.Combine(csharpRoot, "core", "system"), "csharp/core/system");
        }

        private void CheckForbiddenDirs()
        {
            ForbidPath("prefabs/ui", "use prefabs/form or prefabs/widget");
            ForbidPath("scenes/main.tscn", "use scenes/app/main.tscn");
            ForbidPath("scripts/gen", "use scripts/_gen");
            ForbidPath("csharp/gen", "use csharp/_gen");
            ForbidPath("csharp/core/authority", "use csharp/core");
            ForbidPath("csharp/core/run", "use csharp/core directly");
            ForbidPath("csharp/core/domain", "use csharp/core/{state,rules,config,const}");
            ForbidPath("data/_gen", "use pack/config for packed config");
        }

        private void CheckRoleDirs()
        {
            CheckAllowedSubdirs("prefabs", ["actor", "form", "fx", "widget"]);
            CheckNoRootFiles("prefabs", "put prefab resources into prefabs/actor, prefabs/form, prefabs/widget or prefabs/fx");

            CheckAllowedSubdirs("scenes", ["app", "env"]);
            CheckNoRootFiles("scenes", "put scenes into scenes/app or scenes/env");

            CheckAllowedSubdirs(Path.Combine("csharp", "core"), ["config", "const", "rules", "state", "system"]);

            string docsRoot = Path.Combine(_root, "docs");
            if (Directory.Exists(docsRoot))
            {
                foreach (string file in Directory.GetFiles(docsRoot, "*.md", SearchOption.TopDirectoryOnly))
                {
                    Error($"{Rel(file)} is not allowed; project docs must live under docs/<domain>/");
                }
            }
        }

        private void CheckPrefabRoleScripts()
        {
            CheckPrefabRoleScript("prefabs/actor", "_actor.gd", []);
            CheckPrefabRoleScript("prefabs/fx", "_fx.gd", ["res://fw/scripts/fw/vu/fx/_fx.gd"]);
            CheckPrefabRoleScript("prefabs/form", "_form.gd", ["res://fw/scripts/fw/vu/ui/form/_form.gd"]);
            CheckPrefabRoleScript("prefabs/widget", "_widget.gd", ["res://fw/scripts/fw/vu/ui/widget/_widget.gd"]);
        }

        private void CheckPrefabRoleScript(string relativeDir, string scriptSuffix, IReadOnlyCollection<string> allowedScripts)
        {
            string dir = Path.Combine(_root, relativeDir);
            if (!Directory.Exists(dir))
            {
                return;
            }

            foreach (string file in Directory.GetFiles(dir, "*.tscn", SearchOption.AllDirectories))
            {
                string? scriptPath = ReadRootScriptPath(file);
                if (scriptPath == null)
                {
                    Error($"{Rel(file)} root node must have a script");
                    continue;
                }
                if (scriptPath.EndsWith(scriptSuffix, StringComparison.Ordinal) || allowedScripts.Contains(scriptPath))
                {
                    continue;
                }
                Error($"{Rel(file)} root script must end with {scriptSuffix}; got {scriptPath}");
            }
        }

        private string? ReadRootScriptPath(string file)
        {
            var scriptsById = new Dictionary<string, string>(StringComparer.Ordinal);
            bool inRootNode = false;
            bool sawRootNode = false;

            foreach (string line in File.ReadLines(file, Encoding.UTF8))
            {
                if (line.StartsWith("[ext_resource", StringComparison.Ordinal)
                    && line.Contains("type=\"Script\"", StringComparison.Ordinal))
                {
                    string? path = ExtractQuotedAttribute(line, "path");
                    string? id = ExtractQuotedAttribute(line, "id");
                    if (path != null && id != null)
                    {
                        scriptsById[id] = path;
                    }
                    continue;
                }

                if (line.StartsWith("[node ", StringComparison.Ordinal))
                {
                    if (sawRootNode)
                    {
                        inRootNode = false;
                        continue;
                    }
                    sawRootNode = true;
                    inRootNode = true;
                    continue;
                }

                if (!inRootNode || !line.StartsWith("script = ExtResource(", StringComparison.Ordinal))
                {
                    continue;
                }

                string? scriptId = ExtractExtResourceId(line);
                if (scriptId == null)
                {
                    return null;
                }
                return scriptsById.TryGetValue(scriptId, out string? scriptPath) ? scriptPath : null;
            }

            return null;
        }

        private static string? ExtractQuotedAttribute(string line, string name)
        {
            string marker = $"{name}=\"";
            int start = line.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0)
            {
                return null;
            }
            start += marker.Length;
            int end = line.IndexOf('"', start);
            return end < 0 ? null : line[start..end];
        }

        private static string? ExtractExtResourceId(string line)
        {
            const string Marker = "ExtResource(\"";
            int start = line.IndexOf(Marker, StringComparison.Ordinal);
            if (start < 0)
            {
                return null;
            }
            start += Marker.Length;
            int end = line.IndexOf('"', start);
            return end < 0 ? null : line[start..end];
        }

        private void CheckGeneratedFiles()
        {
            CheckGeneratedDir(_config.GodotGenDir(_root));
            CheckGeneratedDir(Path.GetDirectoryName(_config.CoreSystemsCsPath(_root)) ?? Path.Combine(_root, "csharp", "_gen"));
        }

        private void CheckFileSuffixes()
        {
            string gdRoot = _config.PathValue(_root, "script", "gdscript", "scripts");
            string gdGen = _config.GodotGenDir(_root);
            if (Directory.Exists(gdRoot))
            {
                foreach (string file in Directory.GetFiles(gdRoot, "*.gd", SearchOption.AllDirectories))
                {
                    if (IsUnder(file, gdGen))
                    {
                        continue;
                    }
                    CheckSuffix(file, GdSuffixes);
                }
            }

            string toolsRoot = Path.Combine(_root, "tools");
            if (Directory.Exists(toolsRoot))
            {
                foreach (string file in Directory.GetFiles(toolsRoot, "*.gd", SearchOption.AllDirectories))
                {
                    CheckSuffix(file, ["_tool"]);
                }
            }

            string csharpRoot = _config.PathValue(_root, "script", "csharp", "csharp");
            string csharpGen = Path.GetDirectoryName(_config.CoreSystemsCsPath(_root)) ?? Path.Combine(_root, "csharp", "_gen");
            if (Directory.Exists(csharpRoot))
            {
                foreach (string file in Directory.GetFiles(csharpRoot, "*.cs", SearchOption.AllDirectories))
                {
                    if (IsUnder(file, csharpGen))
                    {
                        continue;
                    }
                    CheckSuffix(file, CSharpSuffixes);
                }
            }

            string dsRoot = Path.Combine(_root, "ds");
            if (Directory.Exists(dsRoot))
            {
                foreach (string file in Directory.GetFiles(dsRoot, "*.cs", SearchOption.AllDirectories))
                {
                    if (IsUnder(file, Path.Combine(dsRoot, "bin")) || IsUnder(file, Path.Combine(dsRoot, "obj")))
                    {
                        continue;
                    }
                    CheckSuffix(file, CSharpSuffixes);
                }
            }
        }

        private void CheckCSharpBridgeEntries()
        {
            string csharpRoot = _config.PathValue(_root, "script", "csharp", "csharp");
            string bridgeDir = Path.Combine(csharpRoot, "bridge");
            if (!Directory.Exists(bridgeDir))
            {
                return;
            }

            foreach (string file in Directory.GetFiles(bridgeDir, "*_bridge.cs", SearchOption.TopDirectoryOnly))
            {
                string expected = Path.GetFileNameWithoutExtension(file);
                string text = File.ReadAllText(file, Encoding.UTF8);
                var matches = System.Text.RegularExpressions.Regex.Matches(
                    text,
                    @"\bpublic\s+(?:sealed\s+)?partial\s+class\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(?:Godot\.)?Node\b"
                );
                if (matches.Count != 1)
                {
                    Error($"{Rel(file)} must expose exactly one public partial Godot.Node bridge entry");
                    continue;
                }
                var match = matches[0];
                if (!string.Equals(match.Groups[1].Value, expected, StringComparison.Ordinal))
                {
                    Error($"{Rel(file)} class `{match.Groups[1].Value}` must exactly match filename `{expected}`");
                }
            }
        }

        private void CheckForbiddenReferences()
        {
            var roots = new List<string>
            {
                Path.Combine(_root, "project.godot"),
                _config.PathValue(_root, "script", "gdscript", "scripts"),
                _config.PathValue(_root, "script", "csharp", "csharp"),
                Path.Combine(_root, "schema"),
                Path.Combine(_root, "prefabs"),
                Path.Combine(_root, "scenes"),
                Path.Combine(_root, "fw", "templates", "fw_new", "default"),
            };

            foreach (string root in roots)
            {
                if (File.Exists(root))
                {
                    CheckReferencesInFile(root);
                    continue;
                }
                if (!Directory.Exists(root))
                {
                    continue;
                }
                foreach (string file in Directory.GetFiles(root, "*", SearchOption.AllDirectories))
                {
                    if (IsUnder(file, Path.Combine(_root, "fw", "templates", "fw_new", "default", "docs")))
                    {
                        continue;
                    }
                    if (TextExtensions.Contains(Path.GetExtension(file), StringComparer.OrdinalIgnoreCase))
                    {
                        CheckReferencesInFile(file);
                    }
                }
            }
        }

        private void CheckGeneratedDir(string dir)
        {
            if (!Directory.Exists(dir))
            {
                return;
            }
            foreach (string file in Directory.GetFiles(dir, "*", SearchOption.AllDirectories))
            {
                string name = Path.GetFileName(file);
                if (!name.StartsWith("_", StringComparison.Ordinal))
                {
                    Error($"{Rel(file)} is generated output but does not start with '_'");
                }
            }
        }

        private void CheckReferencesInFile(string file)
        {
            string text;
            try
            {
                text = File.ReadAllText(file, Encoding.UTF8);
            }
            catch (Exception ex)
            {
                Warn($"cannot read {Rel(file)}: {ex.Message}");
                return;
            }

            foreach (string forbidden in ForbiddenReferenceTexts)
            {
                if (text.Contains(forbidden, StringComparison.Ordinal))
                {
                    Error($"{Rel(file)} contains forbidden reference '{forbidden}'");
                }
            }
        }

        private void CheckAllowedSubdirs(string relativePath, IReadOnlyCollection<string> allowed)
        {
            string dir = Path.Combine(_root, relativePath);
            if (!Directory.Exists(dir))
            {
                return;
            }
            foreach (string child in Directory.GetDirectories(dir))
            {
                string name = Path.GetFileName(child);
                if (!allowed.Contains(name))
                {
                    Error($"{Rel(child)} is not an allowed directory under {relativePath}");
                }
            }
        }

        private void CheckNoRootFiles(string relativePath, string hint)
        {
            string dir = Path.Combine(_root, relativePath);
            if (!Directory.Exists(dir))
            {
                return;
            }
            foreach (string file in Directory.GetFiles(dir, "*", SearchOption.TopDirectoryOnly))
            {
                Error($"{Rel(file)} is not allowed; {hint}");
            }
        }

        private void CheckSuffix(string file, IReadOnlyCollection<string> suffixes)
        {
            string name = Path.GetFileNameWithoutExtension(file);
            if (!suffixes.Any(suffix => name.EndsWith(suffix, StringComparison.Ordinal)))
            {
                Error($"{Rel(file)} must end with one of: {string.Join(", ", suffixes)}");
            }
        }

        private void RequireConfigValue(string section, string key)
        {
            if (!_config.HasValue(section, key))
            {
                Error($"fw.toml missing [{section}].{key}");
                return;
            }
            if (string.IsNullOrWhiteSpace(_config.Value(section, key, "")))
            {
                Error($"fw.toml [{section}].{key} cannot be empty");
            }
        }

        private void RequireDir(string path, string label)
        {
            if (!Directory.Exists(path))
            {
                Error($"{label} directory not found: {Rel(path)}");
            }
        }

        private void RequireFile(string path, string label)
        {
            if (!File.Exists(path))
            {
                Error($"{label} file not found: {Rel(path)}");
            }
        }

        private void ForbidPath(string relativePath, string hint)
        {
            string path = Path.Combine(_root, relativePath);
            if (Directory.Exists(path) || File.Exists(path))
            {
                Error($"{relativePath} is deprecated; {hint}");
            }
        }

        private bool IsUnder(string path, string parent)
        {
            return IsUnderPath(path, parent);
        }

        private string Rel(string path)
        {
            return Path.GetRelativePath(_root, path).Replace(Path.DirectorySeparatorChar, '/');
        }

        private void Error(string message)
        {
            _errors.Add(message);
        }

        private void Warn(string message)
        {
            _warnings.Add(message);
        }
    }
}
