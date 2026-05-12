using System.Text;
using System.Text.RegularExpressions;

sealed class FwConfig
{
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
        return Path.GetFullPath(Path.Combine(root, Value(section, key, fallback)));
    }

    public string ProjectName()
    {
        return Value("project", "name", "Game");
    }

    public string CSharpProjectPath(string root)
    {
        var fallback = Value("csharp", "project", $"{ProjectName()}.csproj");
        fallback = Value("build", "csharp", fallback);
        return PathValue(root, "dotnet", "game", fallback);
    }

    public string GeneratorProjectPath(string root)
    {
        var fallback = Value("generator", "project", "fw/csharp/FwGen/FwGen.csproj");
        fallback = Value("build", "generator", fallback);
        return PathValue(root, "dotnet", "generator", fallback);
    }

    public string BridgeSchemaDir(string root)
    {
        var fallback = PathValue(root, "schema", "bridge", Path.Combine(SchemaRoot(), "bridge"));
        return PathValue(root, "path", "bridge_schema", Path.GetRelativePath(root, fallback));
    }

    public string ConfigSchemaDir(string root)
    {
        var fallback = PathValue(root, "schema", "config", Path.Combine(SchemaRoot(), "config"));
        return PathValue(root, "path", "config_schema", Path.GetRelativePath(root, fallback));
    }

    public string ConfigDataDir(string root)
    {
        if (HasValue("schema", "data_config"))
        {
            return PathValue(root, "schema", "data_config", "data/config");
        }
        var fallback = PathValue(root, "data", "config", Path.Combine(DataRoot(), "config"));
        return PathValue(root, "path", "config_data", Path.GetRelativePath(root, fallback));
    }

    public string SystemsSchemaPath(string root)
    {
        var fallback = PathValue(root, "schema", "systems", Path.Combine(SchemaRoot(), "systems.toml"));
        return PathValue(root, "path", "systems", Path.GetRelativePath(root, fallback));
    }

    public string GodotSystemSchemaPath(string root)
    {
        var systemsPath = SystemsSchemaPath(root);
        if (File.Exists(systemsPath) || HasValue("schema", "systems"))
        {
            return systemsPath;
        }
        return PathValue(root, "schema", "system", Path.Combine(SchemaRoot(), "system.toml"));
    }

    public string CoreSystemSchemaPath(string root)
    {
        var systemsPath = SystemsSchemaPath(root);
        if (File.Exists(systemsPath) || HasValue("schema", "systems"))
        {
            return systemsPath;
        }
        return PathValue(root, "schema", "core_system", Path.Combine(SchemaRoot(), "core_system.toml"));
    }

    public string GodotGenDir(string root)
    {
        var fallback = PathValue(root, "gen", "gd_dir", Path.Combine(GodotRoot(), "_gen"));
        return PathValue(root, "path._gen", "gdscript", Path.GetRelativePath(root, fallback));
    }

    public string GraphGdPath(string root)
    {
        return PathValue(root, "gen", "graph_gd", Path.Combine(GodotGenRoot(root), "_graph.gd"));
    }

    public string SystemsGdPath(string root)
    {
        return PathValue(root, "gen", "systems_gd", Path.Combine(GodotGenRoot(root), "_systems.gd"));
    }

    public string ConfigGdPath(string root)
    {
        return PathValue(root, "gen", "config_gd", Path.Combine(GodotGenRoot(root), "_config.gd"));
    }

    public string ConfigPackDir(string root)
    {
        var fallback = PathValue(root, "gen", "config_pack_dir", Path.Combine(DataRoot(), "_gen", "config"));
        return PathValue(root, "path._gen", "config", Path.GetRelativePath(root, fallback));
    }

    public string CoreSystemsCsPath(string root)
    {
        return PathValue(root, "gen", "core_systems_cs", Path.Combine(CSharpGenRoot(root), "_core_systems.cs"));
    }

    public string BridgeContractCsPath(string root)
    {
        return PathValue(root, "gen", "bridge_contract_cs", Path.Combine(CSharpGenRoot(root), "_bridge_contract.cs"));
    }

    public string BridgeCodecCsPath(string root)
    {
        return PathValue(root, "gen", "bridge_codec_cs", Path.Combine(CSharpGenRoot(root), "_bridge_codec.cs"));
    }

    public string BridgeInputCodecCsPath(string root)
    {
        return PathValue(root, "gen", "bridge_input_codec_cs", Path.Combine(CSharpGenRoot(root), "_input_codec.cs"));
    }

    public string BridgeEventCodecCsPath(string root)
    {
        return PathValue(root, "gen", "bridge_event_codec_cs", Path.Combine(CSharpGenRoot(root), "_event_codec.cs"));
    }

    public string ConfigContractCsPath(string root)
    {
        return PathValue(root, "gen", "config_contract_cs", Path.Combine(CSharpGenRoot(root), "_config_contract.cs"));
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
        foreach (var rawLine in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var sectionMatch = Regex.Match(line, @"^\[(.+)\]$");
            if (sectionMatch.Success)
            {
                section = sectionMatch.Groups[1].Value.Trim();
                sections.TryAdd(section, new Dictionary<string, string>(StringComparer.Ordinal));
                continue;
            }

            var valueMatch = Regex.Match(line, @"^([A-Za-z0-9_]+)\s*=\s*""(.*)""$");
            if (valueMatch.Success && section.Length > 0)
            {
                sections[section][valueMatch.Groups[1].Value] = valueMatch.Groups[2].Value;
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

    private string SchemaRoot()
    {
        return Value("path", "schema", Value("layout", "schema", "schema"));
    }

    private string DataRoot()
    {
        return Value("path", "data", Value("layout", "data", "data"));
    }

    private string GodotRoot()
    {
        return Value("path", "gdscript", Value("path", "godot", Value("layout", "godot", "scripts")));
    }

    private string CSharpRoot()
    {
        return Value("path", "csharp", Value("layout", "csharp", "csharp"));
    }

    private string GodotGenRoot(string root)
    {
        return Path.GetRelativePath(root, GodotGenDir(root));
    }

    private string CSharpGenRoot(string root)
    {
        var fallback = Path.Combine(CSharpRoot(), "_gen");
        return PathValue(root, "path._gen", "csharp", fallback);
    }
}
