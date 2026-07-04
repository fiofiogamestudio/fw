using System.Text;

static class FwCheck
{
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
        "res://scenes/battle_env.tscn",
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
            CheckRequiredLayout();
            CheckForbiddenDirs();
            CheckRoleDirs();
            CheckPrefabRoleScripts();
            CheckGeneratedFiles();
            CheckFileSuffixes();
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

            ForbidConfigValue("schema", "systems", "use [schema].system");
            ForbidConfigValue("schema", "data_config", "use [data].config");
            ForbidConfigValue("gen", "data", "use [pack].config");
            ForbidConfigValue("path._gen", "config", "use [pack].config");
            ForbidConfigValue("dotnet", "generator", "use [dotnet].fwgen");
            ForbidConfigValue("build", "csharp", "use [dotnet].game");
            ForbidConfigValue("build", "generator", "use [dotnet].fwgen");
            ForbidConfigValue("generator", "project", "use [dotnet].fwgen");
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
            RequireDir(Path.Combine(csharpRoot, "core", "state"), "csharp/core/state");
            RequireDir(Path.Combine(csharpRoot, "core", "rules"), "csharp/core/rules");
            RequireDir(Path.Combine(csharpRoot, "core", "config"), "csharp/core/config");
            RequireDir(Path.Combine(csharpRoot, "core", "const"), "csharp/core/const");
        }

        private void CheckForbiddenDirs()
        {
            ForbidPath("prefabs/ui", "use prefabs/form or prefabs/widget");
            ForbidPath("scenes/main.tscn", "use scenes/app/main.tscn");
            ForbidPath("scenes/battle_env.tscn", "use scenes/env/battle_env.tscn");
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

            foreach (string file in Directory.GetFiles(dir, "*.tscn", SearchOption.TopDirectoryOnly))
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
            }
        }

        private void ForbidConfigValue(string section, string key, string hint)
        {
            if (_config.HasValue(section, key))
            {
                Error($"fw.toml [{section}].{key} is deprecated; {hint}");
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
            string fullPath = Path.GetFullPath(path);
            string fullParent = Path.GetFullPath(parent).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            return fullPath.Equals(fullParent, StringComparison.OrdinalIgnoreCase)
                || fullPath.StartsWith(fullParent + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || fullPath.StartsWith(fullParent + Path.AltDirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);
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
