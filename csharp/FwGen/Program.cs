using System.Text;
using System.Text.RegularExpressions;

return FwGen.Run(args);

static class FwGen
{
    public static int Run(string[] args)
    {
        try
        {
            var options = CliOptions.Parse(args);
            if (options.Command.Count == 0)
            {
                throw new InvalidOperationException("missing command");
            }

            var root = Path.GetFullPath(options.Root);
            var config = FwConfig.Load(root);
            var command = options.Command[0];

            switch (command)
            {
                case "system":
                    SystemGen.Generate(root, config);
                    break;
                case "bridge":
                    BridgeGen.Generate(root, config);
                    break;
                case "config":
                    ConfigGen.Generate(root, config);
                    break;
                case "check-config":
                    ConfigGen.Check(root, config);
                    break;
                case "pak-config":
                    ConfigGen.Pack(root, config);
                    break;
                case "craft":
                    Craft.Run(root, config, options.Command.Skip(1).ToArray(), options);
                    break;
                default:
                    throw new InvalidOperationException($"unsupported command: {command}");
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}

sealed class CliOptions
{
    public string Root { get; private set; } = Directory.GetCurrentDirectory();
    public string Name { get; private set; } = "";
    public bool Force { get; private set; }
    public List<string> Command { get; } = [];

    public static CliOptions Parse(string[] args)
    {
        var options = new CliOptions();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--root":
                case "--project-root":
                    options.Root = RequireValue(args, ref i);
                    break;
                case "--name":
                    options.Name = RequireValue(args, ref i);
                    break;
                case "--force":
                    options.Force = true;
                    break;
                default:
                    options.Command.Add(args[i]);
                    break;
            }
        }
        return options;
    }

    private static string RequireValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length)
        {
            throw new InvalidOperationException($"{args[index]} requires a value");
        }
        index += 1;
        return args[index];
    }
}

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

    public string PathValue(string root, string section, string key, string fallback)
    {
        return Path.GetFullPath(Path.Combine(root, Value(section, key, fallback)));
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
}

static class SystemGen
{
    public static void Generate(string root, FwConfig config)
    {
        var schema = config.PathValue(root, "schema", "system", "schema/system.toml");
        var output = config.PathValue(root, "gen", "graph_gd", "scripts/gen/_graph.gd");
        var systems = Parse(schema);
        TextUtil.WriteText(output, Render(systems));
        Console.WriteLine($"generated system graph: {output}");
    }

    private static List<SystemNode> Parse(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"system schema not found: {path}");
        }

        var systems = new List<SystemNode>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        SystemNode? current = null;

        var lines = File.ReadAllLines(path, Encoding.UTF8);
        for (var lineIndex = 0; lineIndex < lines.Length; lineIndex++)
        {
            var lineNo = lineIndex + 1;
            var line = lines[lineIndex].Split('#')[0].Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                var id = line.Trim('[', ']').Trim();
                ValidateName(id, "system id", lineNo);
                if (!ids.Add(id))
                {
                    throw new InvalidOperationException($"{path}:{lineNo} duplicate system `{id}`");
                }
                current = new SystemNode(id);
                systems.Add(current);
                continue;
            }

            if (current == null)
            {
                throw new InvalidOperationException($"{path}:{lineNo} ref mapping must appear under a system section");
            }

            var parts = line.Split('=', 2);
            if (parts.Length != 2)
            {
                throw new InvalidOperationException($"{path}:{lineNo} expected `field = \"target\"`");
            }

            var field = parts[0].Trim();
            var target = ParseQuoted(parts[1].Trim(), path, lineNo);
            ValidateName(field, "ref field", lineNo);
            ValidateName(target, "ref target", lineNo);
            if (current.Refs.Any(item => item.Field == field))
            {
                throw new InvalidOperationException($"{path}:{lineNo} duplicate ref `{field}` in system `{current.Id}`");
            }
            current.Refs.Add(new SystemRef(field, target));
        }

        if (systems.Count == 0)
        {
            throw new InvalidOperationException($"{path}: system graph is empty");
        }

        foreach (var system in systems)
        {
            foreach (var systemRef in system.Refs)
            {
                if (!ids.Contains(systemRef.Target))
                {
                    throw new InvalidOperationException($"{path}: system `{system.Id}` refs `{systemRef.Field}` points to missing system `{systemRef.Target}`");
                }
            }
        }

        return systems;
    }

    private static string ParseQuoted(string value, string path, int lineNo)
    {
        if (!value.StartsWith('"') || !value.EndsWith('"') || value.Length < 2)
        {
            throw new InvalidOperationException($"{path}:{lineNo} ref target must be quoted");
        }
        var inner = value[1..^1];
        if (inner.StartsWith('$'))
        {
            throw new InvalidOperationException($"{path}:{lineNo} system refs can only point to systems");
        }
        return inner;
    }

    private static void ValidateName(string value, string label, int lineNo)
    {
        if (!Regex.IsMatch(value, @"^[A-Za-z_][A-Za-z0-9_]*$"))
        {
            throw new InvalidOperationException($"line {lineNo}: invalid {label} `{value}`");
        }
    }

    private static string Render(List<SystemNode> systems)
    {
        var entries = new List<string>();
        foreach (var system in systems)
        {
            if (system.Refs.Count == 0)
            {
                entries.Add($"\t\t&\"{system.Id}\": {{}}");
                continue;
            }

            var refs = string.Join(",\n", system.Refs.Select(item => $"\t\t\t&\"{item.Field}\": &\"{item.Target}\""));
            entries.Add($"\t\t&\"{system.Id}\": {{\n{refs}\n\t\t}}");
        }

        return "# @generated by fw_gen system. Do not edit.\n" +
               "class_name SystemGraph\n" +
               "extends RefCounted\n\n" +
               "static func refs() -> Dictionary:\n" +
               "\treturn {\n" +
               string.Join(",\n", entries) +
               "\n\t}\n";
    }

    private sealed record SystemNode(string Id)
    {
        public List<SystemRef> Refs { get; } = [];
    }

    private sealed record SystemRef(string Field, string Target);
}

static class BridgeGen
{
    public static void Generate(string root, FwConfig config)
    {
        var schemaDir = config.PathValue(root, "schema", "bridge", "schema/bridge");
        var gdDir = config.PathValue(root, "gen", "gd_dir", "scripts/gen");
        Directory.CreateDirectory(gdDir);

        var commonPath = Path.Combine(schemaDir, "common.proto");
        GenerateAction(schemaDir, gdDir);
        GenerateEvent(schemaDir, gdDir, commonPath);
        GenerateSnapshot(schemaDir, gdDir, commonPath);
        Console.WriteLine($"generated bridge gd scripts: {gdDir}");
    }

    private static void GenerateAction(string schemaDir, string gdDir)
    {
        var schema = ProtoSchema.ParseFiles([Path.Combine(schemaDir, "action.proto")]);
        if (!schema.Messages.TryGetValue("PlayerAction", out var actionRoot))
        {
            return;
        }

        var blocks = new List<string>();
        foreach (var variant in actionRoot.Fields.Where(item => item.IsOneof))
        {
            if (!schema.Messages.TryGetValue(variant.Type, out var action))
            {
                continue;
            }

            var args = action.Fields.Select(item => $"{item.Name}: {GdArgType(item)}");
            var lines = new List<string>
            {
                $"static func {variant.Name}({string.Join(", ", args)}) -> Dictionary:",
                "\treturn {",
                $"\t\t\"kind\": \"{variant.Name}\","
            };
            lines.AddRange(action.Fields.Select(item => $"\t\t\"{item.Name}\": {item.Name},"));
            lines.Add("\t}");
            blocks.Add(string.Join("\n", lines));
        }

        TextUtil.WriteText(Path.Combine(gdDir, "_action.gd"),
            "# This file is generated by fw_gen. Do not edit manually.\n" +
            "extends RefCounted\n" +
            "class_name _action\n\n" +
            string.Join("\n\n", blocks) +
            "\n");
    }

    private static void GenerateEvent(string schemaDir, string gdDir, string commonPath)
    {
        var files = File.Exists(commonPath)
            ? new[] { commonPath, Path.Combine(schemaDir, "event.proto") }
            : new[] { Path.Combine(schemaDir, "event.proto") };
        var schema = ProtoSchema.ParseFiles(files);
        if (!schema.Messages.TryGetValue("GameEvent", out var eventRoot))
        {
            return;
        }

        var classes = new List<string>();
        foreach (var variant in eventRoot.Fields.Where(item => item.IsOneof))
        {
            if (!schema.Messages.TryGetValue(variant.Type, out var message))
            {
                continue;
            }
            classes.Add(RenderWrapper(ClassNameForEvent(variant.Type), message.Fields, eventMode: true));
        }

        var bus = new StringBuilder();
        bus.AppendLine("class Bus:");
        bus.AppendLine("\textends RefCounted");
        bus.AppendLine();
        bus.AppendLine("\tvar _callbacks: Dictionary = {}");
        bus.AppendLine();
        bus.AppendLine("\tfunc clear() -> void:");
        bus.AppendLine("\t\t_callbacks.clear()");
        bus.AppendLine();
        foreach (var variant in eventRoot.Fields.Where(item => item.IsOneof))
        {
            var eventKey = ClassNameForEvent(variant.Type);
            bus.AppendLine($"\tfunc on_{variant.Name}(cb: Callable) -> void:");
            bus.AppendLine($"\t\t_callbacks[\"{eventKey}\"] = cb");
            bus.AppendLine();
        }
        bus.AppendLine("\tfunc dispatch(events: Array) -> void:");
        bus.AppendLine("\t\tfor ev in events:");
        bus.AppendLine("\t\t\tdispatch_one(ev)");
        bus.AppendLine();
        bus.AppendLine("\tfunc dispatch_one(raw: Dictionary) -> void:");
        bus.AppendLine("\t\tvar ev_type: String = str(raw.get(\"type\", \"\"))");
        bus.AppendLine("\t\tvar cb: Callable = _callbacks.get(ev_type, Callable())");
        bus.AppendLine("\t\tif not cb.is_valid():");
        bus.AppendLine("\t\t\treturn");
        bus.AppendLine("\t\tmatch ev_type:");
        foreach (var variant in eventRoot.Fields.Where(item => item.IsOneof))
        {
            var eventKey = ClassNameForEvent(variant.Type);
            bus.AppendLine($"\t\t\t\"{eventKey}\":");
            bus.AppendLine($"\t\t\t\tcb.call({ClassNameForEvent(variant.Type)}.wrap(raw))");
        }
        bus.AppendLine("\t\t\t_:");
        bus.AppendLine("\t\t\t\tpass");

        TextUtil.WriteText(Path.Combine(gdDir, "_event.gd"),
            "# This file is generated by fw_gen. Do not edit manually.\n" +
            "extends RefCounted\n" +
            "class_name _event\n\n" +
            string.Join("\n\n", classes) +
            "\n\n" +
            bus);
    }

    private static void GenerateSnapshot(string schemaDir, string gdDir, string commonPath)
    {
        var snapshotPath = Path.Combine(schemaDir, "snapshot.proto");
        var files = File.Exists(commonPath)
            ? new[] { commonPath, snapshotPath }
            : new[] { snapshotPath };
        var schema = ProtoSchema.ParseFiles(files);
        var snapshotMessages = schema.Messages.Values
            .Where(item => Path.GetFullPath(item.SourcePath) == Path.GetFullPath(snapshotPath))
            .Where(item => item.Fields.All(field => !field.IsOneof))
            .OrderBy(item => item.Name, StringComparer.Ordinal)
            .ToArray();

        var blocks = snapshotMessages
            .Select(message => RenderWrapper($"Wrapped{message.Name}", message.Fields, eventMode: false, schema))
            .ToArray();

        TextUtil.WriteText(Path.Combine(gdDir, "_snapshot.gd"),
            "# This file is generated by fw_gen. Do not edit manually.\n" +
            "extends RefCounted\n" +
            "class_name _snapshot\n\n" +
            string.Join("\n\n", blocks) +
            "\n");
    }

    private static string RenderWrapper(string className, IReadOnlyList<ProtoField> fields, bool eventMode, ProtoSchema? schema = null)
    {
        var block = new StringBuilder();
        block.AppendLine($"class {className}:");
        block.AppendLine("\textends RefCounted");
        block.AppendLine();
        block.AppendLine("\tvar _raw: Dictionary = {}");
        block.AppendLine();
        block.AppendLine($"\tstatic func wrap(raw: Dictionary):");
        block.AppendLine($"\t\tvar obj := {className}.new()");
        block.AppendLine("\t\tobj._raw = raw");
        block.AppendLine("\t\treturn obj");
        block.AppendLine();
        block.AppendLine("\tfunc raw() -> Dictionary:");
        block.AppendLine("\t\treturn _raw");

        foreach (var field in fields)
        {
            block.AppendLine();
            block.AppendLine($"\tfunc {field.Name}() -> {GdReturnType(field, eventMode)}:");
            block.AppendLine($"\t\treturn {GdGetter(field, eventMode)}");

            if (field.IsRepeated && schema != null && !IsIntLike(field.Type) && schema.Messages.ContainsKey(field.Type))
            {
                block.AppendLine();
                block.AppendLine($"\tfunc {field.Name}_wrapped() -> Array:");
                block.AppendLine("\t\tvar out: Array = []");
                block.AppendLine($"\t\tfor item in {field.Name}():");
                block.AppendLine($"\t\t\tout.append(Wrapped{field.Type}.wrap(item))");
                block.AppendLine("\t\treturn out");
            }
        }

        return block.ToString().TrimEnd();
    }

    private static string ClassNameForEvent(string messageType)
    {
        return messageType.EndsWith("Event", StringComparison.Ordinal)
            ? messageType[..^"Event".Length]
            : messageType;
    }

    private static string GdArgType(ProtoField field)
    {
        if (field.IsRepeated) return "Array";
        return field.Type switch
        {
            "string" => "String",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2i",
            _ when IsIntLike(field.Type) => "int",
            _ => "Variant"
        };
    }

    private static string GdReturnType(ProtoField field, bool eventMode)
    {
        if (field.IsRepeated) return "Array";
        return field.Type switch
        {
            "string" => "String",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2i",
            _ when IsIntLike(field.Type) => "int",
            _ => eventMode ? "Variant" : "String"
        };
    }

    private static string GdGetter(ProtoField field, bool eventMode)
    {
        if (field.IsRepeated)
        {
            return $"_raw.get(\"{field.Name}\", [])";
        }

        return field.Type switch
        {
            "string" => $"str(_raw.get(\"{field.Name}\", \"\"))",
            "bool" => $"bool(_raw.get(\"{field.Name}\", false))",
            "float" or "double" => $"float(_raw.get(\"{field.Name}\", 0.0))",
            "Vec2i" => $"_raw.get(\"{field.Name}\", Vector2i.ZERO)",
            _ when IsIntLike(field.Type) => $"int(_raw.get(\"{field.Name}\", 0))",
            _ => eventMode ? $"_raw.get(\"{field.Name}\", null)" : $"str(_raw.get(\"{field.Name}\", \"{EnumDefault(field.Type)}\"))"
        };
    }

    private static string EnumDefault(string type)
    {
        return type switch
        {
            "EntityKind" => "Player",
            "ItemKind" => "Torch",
            "WeaponSlot" => "Sword",
            "WeaponPhase" => "Idle",
            _ => ""
        };
    }

    private static bool IsIntLike(string type)
    {
        return type is "int32" or "int64" or "uint32" or "uint64" or "sint32" or "sint64"
            || type.EndsWith("Id", StringComparison.Ordinal);
    }
}

static class ConfigGen
{
    public static void Generate(string root, FwConfig config)
    {
        var output = config.PathValue(root, "gen", "config_gd", "scripts/gen/_config.gd");
        if (File.Exists(output))
        {
            Console.WriteLine($"kept existing config gd script: {output}");
            return;
        }

        var schemaDir = config.PathValue(root, "schema", "config", "schema/config");
        var schema = ProtoSchema.ParseFiles(Directory.Exists(schemaDir)
            ? Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal)
            : []);

        var roots = schema.Messages.Values
            .Where(item => item.Name.EndsWith("Config", StringComparison.Ordinal))
            .Select(item => TextUtil.Snake(item.Name[..^"Config".Length]))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();

        var text = new StringBuilder();
        text.AppendLine("# This file is generated by fw_gen. Do not edit manually.");
        text.AppendLine("extends RefCounted");
        text.AppendLine("class_name _config");
        text.AppendLine();
        text.AppendLine("static func _fallback() -> Dictionary:");
        text.AppendLine("\treturn {}");
        text.AppendLine();
        foreach (var rootName in roots)
        {
            text.AppendLine($"static func {rootName}_default_config() -> Dictionary:");
            text.AppendLine("\treturn _fallback()");
            text.AppendLine();
        }

        TextUtil.WriteText(output, text.ToString());
        Console.WriteLine($"generated minimal config gd script: {output}");
    }

    public static void Check(string root, FwConfig config)
    {
        var schemaDir = config.PathValue(root, "schema", "config", "schema/config");
        var dataDir = config.PathValue(root, "schema", "data_config", "data/config");
        if (!Directory.Exists(schemaDir))
        {
            throw new DirectoryNotFoundException($"config schema dir not found: {schemaDir}");
        }
        if (!Directory.Exists(dataDir))
        {
            throw new DirectoryNotFoundException($"config data dir not found: {dataDir}");
        }
        Console.WriteLine($"config paths ok: {schemaDir}, {dataDir}");
    }

    public static void Pack(string root, FwConfig config)
    {
        var packDir = config.PathValue(root, "gen", "config_pack_dir", "data/gen/config");
        Directory.CreateDirectory(packDir);
        Console.WriteLine($"prepared config pack dir: {packDir}");
    }
}

static class Craft
{
    public static void Run(string root, FwConfig config, string[] args, CliOptions options)
    {
        if (args.Length == 0 || args[0] != "fw-new")
        {
            throw new InvalidOperationException("supported craft command: craft fw-new");
        }

        var name = string.IsNullOrWhiteSpace(options.Name) ? config.Value("project", "name", "Game") : options.Name;
        var templateRoot = Path.Combine(root, "fw", "templates", "fw_new", "default");
        if (!Directory.Exists(templateRoot))
        {
            throw new DirectoryNotFoundException($"template not found: {templateRoot}");
        }

        CopyTemplate(templateRoot, root, name, options.Force);
        var nextConfig = FwConfig.Load(root);
        SystemGen.Generate(root, nextConfig);
        BridgeGen.Generate(root, nextConfig);
        ConfigGen.Generate(root, nextConfig);
        Console.WriteLine($"created fw project scaffold: {root}");
    }

    private static void CopyTemplate(string templateRoot, string outputRoot, string projectName, bool force)
    {
        foreach (var source in Directory.GetFiles(templateRoot, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(templateRoot, source);
            if (relative.StartsWith("rust" + Path.DirectorySeparatorChar, StringComparison.Ordinal)
                || relative.StartsWith("extension" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                continue;
            }

            var targetRelative = relative.EndsWith(".tpl", StringComparison.Ordinal)
                ? relative[..^".tpl".Length]
                : relative;
            targetRelative = targetRelative.Replace("__PROJECT_NAME__", projectName, StringComparison.Ordinal);
            var target = Path.Combine(outputRoot, targetRelative);

            if (File.Exists(target) && !force)
            {
                continue;
            }

            var text = File.ReadAllText(source, Encoding.UTF8)
                .Replace("__PROJECT_NAME__", projectName, StringComparison.Ordinal)
                .Replace("__LIB_NAME__", Slug(projectName), StringComparison.Ordinal);
            TextUtil.WriteText(target, text);
        }
    }

    private static string Slug(string value)
    {
        var text = Regex.Replace(value.Trim().ToLowerInvariant(), @"[^a-z0-9_]+", "_");
        return string.IsNullOrWhiteSpace(text) ? "game" : text.Trim('_');
    }
}

sealed class ProtoSchema
{
    public Dictionary<string, ProtoMessage> Messages { get; } = new(StringComparer.Ordinal);
    public HashSet<string> Enums { get; } = new(StringComparer.Ordinal);

    public static ProtoSchema ParseFiles(IEnumerable<string> files)
    {
        var schema = new ProtoSchema();
        foreach (var file in files.Where(File.Exists))
        {
            ParseFile(schema, file);
        }
        return schema;
    }

    private static void ParseFile(ProtoSchema schema, string path)
    {
        ProtoMessage? current = null;
        var inOneof = false;
        var inEnum = false;

        foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = raw.Split("//")[0].Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (current == null)
            {
                var enumMatch = Regex.Match(line, @"^enum\s+([A-Za-z_][A-Za-z0-9_]*)");
                if (enumMatch.Success)
                {
                    schema.Enums.Add(enumMatch.Groups[1].Value);
                    inEnum = !line.Contains('}');
                    continue;
                }
                if (inEnum)
                {
                    inEnum = !line.Contains('}');
                    continue;
                }

                var messageMatch = Regex.Match(line, @"^message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{?");
                if (messageMatch.Success)
                {
                    current = new ProtoMessage(messageMatch.Groups[1].Value, path);
                    if (line.Contains('}'))
                    {
                        schema.Messages[current.Name] = current;
                        current = null;
                    }
                    continue;
                }
                continue;
            }

            if (line.StartsWith("oneof ", StringComparison.Ordinal))
            {
                inOneof = true;
                continue;
            }
            if (line == "}")
            {
                if (inOneof)
                {
                    inOneof = false;
                    continue;
                }
                schema.Messages[current.Name] = current;
                current = null;
                continue;
            }

            var fieldMatch = Regex.Match(line, @"^(repeated\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+;");
            if (fieldMatch.Success)
            {
                current.Fields.Add(new ProtoField(
                    fieldMatch.Groups[3].Value,
                    fieldMatch.Groups[2].Value,
                    fieldMatch.Groups[1].Success,
                    inOneof));
            }
        }
    }
}

sealed record ProtoMessage(string Name, string SourcePath)
{
    public List<ProtoField> Fields { get; } = [];
}

sealed record ProtoField(string Name, string Type, bool IsRepeated, bool IsOneof);

static class TextUtil
{
    public static string Snake(string value)
    {
        var output = new StringBuilder();
        for (var i = 0; i < value.Length; i++)
        {
            var ch = value[i];
            if (char.IsUpper(ch) && i > 0)
            {
                output.Append('_');
            }
            output.Append(char.ToLowerInvariant(ch));
        }
        return output.ToString();
    }

    public static void WriteText(string path, string text)
    {
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }
        File.WriteAllText(path, text.Replace("\r\n", "\n"), new UTF8Encoding(false));
    }
}
