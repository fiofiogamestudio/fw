using System.Text;
using System.Text.RegularExpressions;

sealed class FwConfig
{
    private static readonly IReadOnlyDictionary<string, HashSet<string>> AllowedKeys =
        new Dictionary<string, HashSet<string>>(StringComparer.Ordinal)
        {
            ["project"] = new(StringComparer.Ordinal) { "name" },
            ["schema"] = new(StringComparer.Ordinal) { "system", "bridge", "config" },
            ["gen"] = new(StringComparer.Ordinal) { "gdscript", "csharp" },
            ["data"] = new(StringComparer.Ordinal) { "config" },
            ["pack"] = new(StringComparer.Ordinal) { "config" },
            ["script"] = new(StringComparer.Ordinal) { "gdscript", "csharp" },
            ["dotnet"] = new(StringComparer.Ordinal) { "game", "fwgen" },
        };

    private readonly Dictionary<string, Dictionary<string, string>> _sections;

    private FwConfig(Dictionary<string, Dictionary<string, string>> sections)
    {
        _sections = sections;
    }

    public string Value(string section, string key, string fallback)
    {
        if (_sections.TryGetValue(section, out var values) && values.TryGetValue(key, out var value))
        {
            return value;
        }
        return fallback;
    }

    public bool HasValue(string section, string key)
    {
        return _sections.TryGetValue(section, out var values) && values.ContainsKey(key);
    }

    public string PathValue(string root, string section, string key, string fallback)
    {
        var fullRoot = Path.GetFullPath(root);
        var path = Path.GetFullPath(Path.Combine(fullRoot, Value(section, key, fallback)));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rootPrefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            || fullRoot.EndsWith(Path.AltDirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        if (!path.Equals(fullRoot, comparison)
            && !path.StartsWith(rootPrefix, comparison))
        {
            throw new InvalidOperationException($"fw.toml [{section}].{key} escapes project root: {Value(section, key, fallback)}");
        }
        return path;
    }

    public string ProjectName()
    {
        return Value("project", "name", "Game");
    }

    public string CSharpProjectPath(string root)
    {
        return PathValue(root, "dotnet", "game", $"{ProjectName()}.csproj");
    }

    public string GeneratorProjectPath(string root)
    {
        return PathValue(root, "dotnet", "fwgen", "fw/csharp/FwGen/FwGen.csproj");
    }

    public string BridgeSchemaDir(string root)
    {
        return PathValue(root, "schema", "bridge", "schema/bridge");
    }

    public string ConfigSchemaDir(string root)
    {
        return PathValue(root, "schema", "config", "schema/config");
    }

    public string ConfigDataDir(string root)
    {
        return PathValue(root, "data", "config", "data/config");
    }

    public string SystemsSchemaPath(string root)
    {
        return PathValue(root, "schema", "system", "schema/systems.toml");
    }

    public string GodotGenDir(string root)
    {
        return PathValue(root, "gen", "gdscript", "scripts/_gen");
    }

    public string GodotSystemsGdPath(string root)
    {
        return Path.GetFullPath(Path.Combine(GodotGenDir(root), "_godot_systems.gd"));
    }

    public string ConfigGdPath(string root)
    {
        return Path.GetFullPath(Path.Combine(GodotGenDir(root), "_config.gd"));
    }

    public string ConfigPackDir(string root)
    {
        return PathValue(root, "pack", "config", "pack/config");
    }

    public string CoreSystemsCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_core_systems.cs"));
    }

    public string BridgeTypesCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_bridge_types.cs"));
    }

    public string BridgeCodecCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_bridge_codec.cs"));
    }

    public string BridgeIntentCodecCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_intent_codec.cs"));
    }

    public string BridgeEventCodecCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_event_codec.cs"));
    }

    public string BridgePacketCodecCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_packet_codec.cs"));
    }

    public string ConfigContractCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_config_contract.cs"));
    }

    public string ConfigCodecCsPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_config_codec.cs"));
    }

    public string GenerationManifestPath(string root)
    {
        return Path.GetFullPath(Path.Combine(CSharpGenRoot(root), "_fwgen_manifest.json"));
    }

    public static FwConfig Load(string root)
    {
        var path = Path.Combine(root, "fw.toml");
        var sections = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        if (!File.Exists(path))
        {
            return new FwConfig(sections);
        }

        var section = "";
        var lines = File.ReadAllLines(path, Encoding.UTF8);
        for (var index = 0; index < lines.Length; index++)
        {
            var lineNo = index + 1;
            var line = StripComment(lines[index]).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var sectionMatch = Regex.Match(line, @"^\[(.+)\]$");
            if (sectionMatch.Success)
            {
                section = sectionMatch.Groups[1].Value.Trim();
                if (!AllowedKeys.ContainsKey(section))
                {
                    throw new InvalidOperationException($"{path}:{lineNo} unsupported fw.toml section [{section}]");
                }
                if (!sections.TryAdd(section, new Dictionary<string, string>(StringComparer.Ordinal)))
                {
                    throw new InvalidOperationException($"{path}:{lineNo} duplicate fw.toml section [{section}]");
                }
                continue;
            }

            var valueMatch = Regex.Match(line, @"^([A-Za-z0-9_]+)\s*=\s*""(.*)""$");
            if (!valueMatch.Success || section.Length == 0)
            {
                throw new InvalidOperationException($"{path}:{lineNo} expected `key = \"value\"` under a known section");
            }
            var key = valueMatch.Groups[1].Value;
            if (!AllowedKeys[section].Contains(key))
            {
                throw new InvalidOperationException($"{path}:{lineNo} unsupported fw.toml key [{section}].{key}");
            }
            if (!sections[section].TryAdd(key, valueMatch.Groups[2].Value))
            {
                throw new InvalidOperationException($"{path}:{lineNo} duplicate fw.toml key [{section}].{key}");
            }
        }

        return new FwConfig(sections);
    }

    private static string StripComment(string line)
    {
        var inQuote = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"')
            {
                inQuote = !inQuote;
            }
            if (!inQuote && line[i] == '#')
            {
                return line[..i];
            }
        }
        return line;
    }

    private string CSharpGenRoot(string root)
    {
        return PathValue(root, "gen", "csharp", "csharp/_gen");
    }
}
