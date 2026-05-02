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
                    CoreSystemGen.Generate(root, config);
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
    private static readonly HashSet<string> MetaFields = new(StringComparer.Ordinal)
    {
        "phase",
        "runtime",
        "script",
        "context",
        "manual",
    };

    public static void Generate(string root, FwConfig config)
    {
        var schema = config.PathValue(root, "schema", "system", "schema/system.toml");
        var graphOutput = config.PathValue(root, "gen", "graph_gd", "scripts/gen/_graph.gd");
        var systemsOutput = config.PathValue(root, "gen", "systems_gd", "scripts/gen/_systems.gd");
        var model = Parse(root, schema);
        TextUtil.WriteText(graphOutput, RenderGraph(model));
        TextUtil.WriteText(systemsOutput, RenderSystems(model));
        Console.WriteLine($"generated system graph: {graphOutput}");
        Console.WriteLine($"generated system registrations: {systemsOutput}");
    }

    private static SystemSchema Parse(string root, string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"system schema not found: {path}");
        }

        var systems = new List<SystemNode>();
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var phaseOrder = new List<string>();
        SystemNode? current = null;
        var section = "";

        var lines = File.ReadAllLines(path, Encoding.UTF8);
        for (var lineIndex = 0; lineIndex < lines.Length; lineIndex++)
        {
            var lineNo = lineIndex + 1;
            var line = StripComment(lines[lineIndex]).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                section = line.Trim('[', ']').Trim();
                current = null;
                if (section == "phases")
                {
                    continue;
                }

                var id = section;
                ValidateName(id, "system id", lineNo);
                if (!ids.Add(id))
                {
                    throw new InvalidOperationException($"{path}:{lineNo} duplicate system `{id}`");
                }
                current = new SystemNode(id);
                systems.Add(current);
                continue;
            }

            var parts = line.Split('=', 2);
            if (parts.Length != 2)
            {
                throw new InvalidOperationException($"{path}:{lineNo} expected `field = \"target\"`");
            }

            var field = parts[0].Trim();
            var value = parts[1].Trim();
            ValidateName(field, "field", lineNo);

            if (section == "phases")
            {
                if (field != "order")
                {
                    throw new InvalidOperationException($"{path}:{lineNo} unsupported phases field `{field}`");
                }
                phaseOrder = ParseQuotedList(value, path, lineNo);
                foreach (var phase in phaseOrder)
                {
                    ValidateName(phase, "phase", lineNo);
                }
                continue;
            }

            if (current == null)
            {
                throw new InvalidOperationException($"{path}:{lineNo} mapping must appear under a system section");
            }

            if (MetaFields.Contains(field))
            {
                ParseMeta(current, field, value, path, lineNo);
                continue;
            }

            var target = ParseQuotedName(value, path, lineNo, "ref target");
            if (target.StartsWith('$'))
            {
                throw new InvalidOperationException($"{path}:{lineNo} system refs can only point to systems");
            }
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

        var knownPhases = new HashSet<string>(phaseOrder, StringComparer.Ordinal);
        foreach (var system in systems)
        {
            if (system.Runtime.Length > 0 && system.Runtime != "gd")
            {
                throw new InvalidOperationException($"{path}: system `{system.Id}` has unsupported runtime `{system.Runtime}`");
            }
            if (!system.Manual && system.Script.Length == 0 && system.Context.Length == 0)
            {
                system.Manual = true;
            }
            if (!system.Manual && (system.Script.Length == 0 || system.Context.Length == 0))
            {
                throw new InvalidOperationException($"{path}: system `{system.Id}` needs both script and context, or manual = true");
            }
            if (system.Phase.Length > 0 && phaseOrder.Count > 0 && !knownPhases.Contains(system.Phase))
            {
                throw new InvalidOperationException($"{path}: system `{system.Id}` uses phase `{system.Phase}` outside phases.order");
            }
            if (system.Auto)
            {
                ValidateResourcePath(root, system.Script, path, system.Id, "script");
                ValidateResourcePath(root, system.Context, path, system.Id, "context");
            }
            foreach (var systemRef in system.Refs)
            {
                if (!ids.Contains(systemRef.Target))
                {
                    throw new InvalidOperationException($"{path}: system `{system.Id}` refs `{systemRef.Field}` points to missing system `{systemRef.Target}`");
                }
            }
        }

        return new SystemSchema(phaseOrder, systems);
    }

    private static void ParseMeta(SystemNode system, string field, string value, string path, int lineNo)
    {
        switch (field)
        {
            case "phase":
                system.Phase = ParseQuotedName(value, path, lineNo, "phase");
                break;
            case "runtime":
                system.Runtime = ParseQuotedName(value, path, lineNo, "runtime");
                break;
            case "script":
                system.Script = ParseQuotedRaw(value, path, lineNo, "script");
                break;
            case "context":
                system.Context = ParseQuotedRaw(value, path, lineNo, "context");
                break;
            case "manual":
                system.Manual = ParseBool(value, path, lineNo);
                break;
        }
    }

    private static string ParseQuotedName(string value, string path, int lineNo, string label)
    {
        var inner = ParseQuotedRaw(value, path, lineNo, label);
        ValidateName(inner, label, lineNo);
        return inner;
    }

    private static string ParseQuotedRaw(string value, string path, int lineNo, string label)
    {
        if (!value.StartsWith('"') || !value.EndsWith('"') || value.Length < 2)
        {
            throw new InvalidOperationException($"{path}:{lineNo} {label} must be quoted");
        }
        return value[1..^1];
    }

    private static List<string> ParseQuotedList(string value, string path, int lineNo)
    {
        if (!value.StartsWith('[') || !value.EndsWith(']'))
        {
            throw new InvalidOperationException($"{path}:{lineNo} expected quoted string array");
        }
        var inner = value[1..^1].Trim();
        if (inner.Length == 0)
        {
            return [];
        }

        var items = new List<string>();
        foreach (var rawPart in inner.Split(','))
        {
            var item = rawPart.Trim();
            items.Add(ParseQuotedRaw(item, path, lineNo, "array item"));
        }
        return items;
    }

    private static bool ParseBool(string value, string path, int lineNo)
    {
        return value switch
        {
            "true" => true,
            "false" => false,
            _ => throw new InvalidOperationException($"{path}:{lineNo} bool value must be true or false")
        };
    }

    private static void ValidateName(string value, string label, int lineNo)
    {
        if (!Regex.IsMatch(value, @"^[A-Za-z_][A-Za-z0-9_]*$"))
        {
            throw new InvalidOperationException($"line {lineNo}: invalid {label} `{value}`");
        }
    }

    private static void ValidateResourcePath(string root, string value, string schemaPath, string systemId, string label)
    {
        if (!value.StartsWith("res://", StringComparison.Ordinal))
        {
            return;
        }

        var relative = value["res://".Length..].Replace('/', Path.DirectorySeparatorChar);
        var fullPath = Path.Combine(root, relative);
        if (!File.Exists(fullPath))
        {
            throw new FileNotFoundException($"{schemaPath}: system `{systemId}` {label} not found: {value}");
        }
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

    private static string RenderGraph(SystemSchema model)
    {
        var entries = new List<string>();
        foreach (var system in model.Systems)
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
               RenderPhaseOrder(model) +
               "\n\n" +
               RenderSystemPhases(model) +
               "\n\n" +
               "static func refs() -> Dictionary:\n" +
               "\treturn {\n" +
               string.Join(",\n", entries) +
               "\n\t}\n";
    }

    private static string RenderPhaseOrder(SystemSchema model)
    {
        if (model.PhaseOrder.Count == 0)
        {
            return "static func phase_order() -> Array[StringName]:\n\treturn []";
        }

        return "static func phase_order() -> Array[StringName]:\n" +
               "\treturn [\n" +
               string.Join(",\n", model.PhaseOrder.Select(item => $"\t\t&\"{item}\"")) +
               "\n\t]";
    }

    private static string RenderSystemPhases(SystemSchema model)
    {
        var entries = model.Systems
            .Where(item => item.Phase.Length > 0)
            .Select(item => $"\t\t&\"{item.Id}\": &\"{item.Phase}\"");
        return "static func system_phases() -> Dictionary:\n" +
               "\treturn {\n" +
               string.Join(",\n", entries) +
               "\n\t}";
    }

    private static string RenderSystems(SystemSchema model)
    {
        var systems = model.Systems.Where(item => item.Auto).ToArray();
        var text = new StringBuilder();
        text.AppendLine("# @generated by fw_gen system. Do not edit.");
        text.AppendLine("class_name Systems");
        text.AppendLine("extends RefCounted");
        text.AppendLine();

        foreach (var system in systems)
        {
            var stem = Pascal(system.Id);
            text.AppendLine($"const {stem}SystemScript = preload(\"{EscapeGdString(system.Script)}\")");
            text.AppendLine($"const {stem}ContextScript = preload(\"{EscapeGdString(system.Context)}\")");
        }

        if (systems.Length > 0)
        {
            text.AppendLine();
        }
        text.AppendLine("static func create(mode: Variant) -> Dictionary:");
        text.AppendLine("\tvar entries: Dictionary = {}");
        foreach (var system in systems)
        {
            var stem = Pascal(system.Id);
            var local = TextUtil.Snake(system.Id);
            text.AppendLine($"\tvar {local}_system = {stem}SystemScript.new()");
            text.AppendLine($"\tvar {local}_context = {stem}ContextScript.new()");
            text.AppendLine($"\tmode.add_system(&\"{system.Id}\", {local}_system, {local}_context, &\"{system.Phase}\")");
            text.AppendLine($"\tentries[&\"{system.Id}\"] = {{");
            text.AppendLine($"\t\t\"system\": {local}_system,");
            text.AppendLine($"\t\t\"context\": {local}_context,");
            text.AppendLine("\t}");
        }
        text.AppendLine("\treturn entries");
        return text.ToString();
    }

    private static string Pascal(string value)
    {
        var text = new StringBuilder();
        foreach (var part in value.Split('_', StringSplitOptions.RemoveEmptyEntries))
        {
            text.Append(char.ToUpperInvariant(part[0]));
            if (part.Length > 1)
            {
                text.Append(part[1..]);
            }
        }
        return text.Length == 0 ? "System" : text.ToString();
    }

    private static string EscapeGdString(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private sealed record SystemSchema(List<string> PhaseOrder, List<SystemNode> Systems);

    private sealed class SystemNode
    {
        public SystemNode(string id)
        {
            Id = id;
        }

        public string Id { get; }
        public string Phase { get; set; } = "";
        public string Runtime { get; set; } = "gd";
        public string Script { get; set; } = "";
        public string Context { get; set; } = "";
        public bool Manual { get; set; }
        public List<SystemRef> Refs { get; } = [];
        public bool Auto => !Manual && Script.Length > 0 && Context.Length > 0;
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
        GenerateInput(schemaDir, gdDir);
        GenerateAction(schemaDir, gdDir);
        GenerateEvent(schemaDir, gdDir, commonPath);
        GenerateSnapshot(schemaDir, gdDir, commonPath);
        GenerateContractCs(root, config, schemaDir);
        Console.WriteLine($"generated bridge gd scripts: {gdDir}");
    }

    private static void GenerateInput(string schemaDir, string gdDir)
    {
        var inputPath = Path.Combine(schemaDir, "input.proto");
        if (!File.Exists(inputPath))
        {
            return;
        }

        var schema = ProtoSchema.ParseFiles([inputPath]);
        if (!schema.Enums.TryGetValue("PlayerButton", out var buttons))
        {
            return;
        }

        var text = new StringBuilder();
        text.AppendLine("# This file is generated by fw_gen. Do not edit manually.");
        text.AppendLine("extends RefCounted");
        text.AppendLine("class_name _input");
        text.AppendLine();
        foreach (var value in buttons.Values.Where(item => item.Number != 0))
        {
            text.AppendLine($"const BTN_{EnumTail(value.Name).ToUpperInvariant()} := {value.Number}");
        }

        TextUtil.WriteText(Path.Combine(gdDir, "_input.gd"), text.ToString());
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

    private static void GenerateContractCs(string root, FwConfig config, string schemaDir)
    {
        var output = config.PathValue(root, "gen", "bridge_contract_cs", "csharp/core/state/bridge_contract.cs");
        IEnumerable<string> files = Directory.Exists(schemaDir)
            ? Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal)
            : Array.Empty<string>();
        var schema = ProtoSchema.ParseFiles(files);
        var rootNamespace = TextUtil.PascalName(config.Value("project", "name", "Game"));
        var text = new StringBuilder();
        text.AppendLine("// @generated by fw_gen bridge. Do not edit.");
        text.AppendLine("using System.Collections.Generic;");
        text.AppendLine("using Godot;");
        text.AppendLine();
        text.AppendLine($"namespace {rootNamespace}.Core;");
        text.AppendLine();
        RenderBridgeFields(text, schema);
        text.AppendLine();
        RenderBridgeEnums(text, schema);
        text.AppendLine();
        RenderPacketTypes(text, schema);
        text.AppendLine();
        RenderPlayerActionCs(text, schema);
        text.AppendLine();
        RenderPlayerCommandCs(text);
        text.AppendLine();
        RenderCoreEventCs(text, schema);
        TextUtil.WriteText(output, text.ToString());
        Console.WriteLine($"generated bridge csharp contract: {output}");
    }

    private static void RenderBridgeFields(StringBuilder text, ProtoSchema schema)
    {
        var fields = schema.Messages.Values
            .SelectMany(message => message.Fields)
            .Select(field => field.Name)
            .Append("kind")
            .Append("type")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();

        text.AppendLine("public static class BridgeField");
        text.AppendLine("{");
        foreach (var field in fields)
        {
            text.AppendLine($"    public const string {Pascal(field)} = \"{field}\";");
        }
        text.AppendLine("}");
    }

    private static void RenderBridgeEnums(StringBuilder text, ProtoSchema schema)
    {
        RenderStringEnum(text, schema, "EntityKind", "BridgeEntityKind");
        text.AppendLine();
        RenderStringEnum(text, schema, "ItemKind", "BridgeItemKind");
        text.AppendLine();
        RenderStringEnum(text, schema, "WeaponSlot", "BridgeWeaponSlot");
        text.AppendLine();
        RenderStringEnum(text, schema, "WeaponPhase", "BridgeWeaponPhase");
        text.AppendLine();
        RenderButtonEnum(text, schema);
    }

    private static void RenderPacketTypes(StringBuilder text, ProtoSchema schema)
    {
        text.AppendLine("public static class BridgePacketType");
        text.AppendLine("{");
        if (schema.Enums.TryGetValue("NetPacketType", out var protoEnum))
        {
            foreach (var value in protoEnum.Values.Where(item => item.Number != 0))
            {
                var name = value.Name.StartsWith("NET_PACKET_TYPE_", StringComparison.Ordinal)
                    ? value.Name["NET_PACKET_TYPE_".Length..].ToLowerInvariant()
                    : EnumTail(value.Name);
                text.AppendLine($"    public const string {Pascal(name)} = \"{name}\";");
            }
        }
        text.AppendLine("}");
    }

    private static void RenderStringEnum(StringBuilder text, ProtoSchema schema, string enumName, string className)
    {
        text.AppendLine($"public static class {className}");
        text.AppendLine("{");
        if (schema.Enums.TryGetValue(enumName, out var protoEnum))
        {
            foreach (var value in protoEnum.Values.Where(item => item.Number != 0))
            {
                var name = EnumTail(value.Name);
                text.AppendLine($"    public const string {Pascal(name)} = \"{Pascal(name)}\";");
            }
        }
        text.AppendLine("}");
    }

    private static void RenderButtonEnum(StringBuilder text, ProtoSchema schema)
    {
        text.AppendLine("public static class BridgeButton");
        text.AppendLine("{");
        if (schema.Enums.TryGetValue("PlayerButton", out var protoEnum))
        {
            foreach (var value in protoEnum.Values.Where(item => item.Number != 0))
            {
                text.AppendLine($"    public const int {Pascal(EnumTail(value.Name))} = {value.Number};");
            }
        }
        text.AppendLine("}");
    }

    private static void RenderPlayerActionCs(StringBuilder text, ProtoSchema schema)
    {
        text.AppendLine("public sealed class PlayerAction");
        text.AppendLine("{");
        if (schema.Messages.TryGetValue("PlayerAction", out var actionRoot))
        {
            foreach (var variant in actionRoot.Fields.Where(item => item.IsOneof))
            {
                text.AppendLine($"    public const string {Pascal(variant.Name)} = \"{variant.Name}\";");
            }

            var fields = actionRoot.Fields
                .Where(item => item.IsOneof)
                .SelectMany(variant => schema.Messages.TryGetValue(variant.Type, out var message) ? message.Fields : [])
                .GroupBy(field => field.Name, StringComparer.Ordinal)
                .Select(group => group.First())
                .OrderBy(field => field.Name, StringComparer.Ordinal)
                .ToArray();

            text.AppendLine();
            text.AppendLine("    public string Kind { get; init; } = \"\";");
            foreach (var field in fields)
            {
                var init = CsDefaultInit(field);
                text.AppendLine($"    public {CsCoreType(field.Type, field.IsRepeated)} {Pascal(field.Name)} {{ get; init; }}{init}");
            }
        }
        else
        {
            text.AppendLine("    public string Kind { get; init; } = \"\";");
        }
        text.AppendLine("}");
    }

    private static void RenderPlayerCommandCs(StringBuilder text)
    {
        text.AppendLine("public readonly struct PlayerCommand");
        text.AppendLine("{");
        text.AppendLine("    public const int BtnPrimary = BridgeButton.Primary;");
        text.AppendLine("    public const int BtnSecondary = BridgeButton.Secondary;");
        text.AppendLine("    public const int BtnSprint = BridgeButton.Sprint;");
        text.AppendLine("    public const int BtnInteract = BridgeButton.Interact;");
        text.AppendLine();
        text.AppendLine("    public PlayerCommand(");
        text.AppendLine("        long playerId,");
        text.AppendLine("        uint clientTick,");
        text.AppendLine("        Vector2I moveDir,");
        text.AppendLine("        Vector2I aimDir,");
        text.AppendLine("        int hold,");
        text.AppendLine("        int down,");
        text.AppendLine("        int up,");
        text.AppendLine("        PlayerAction? action");
        text.AppendLine("    )");
        text.AppendLine("    {");
        text.AppendLine("        PlayerId = playerId;");
        text.AppendLine("        ClientTick = clientTick;");
        text.AppendLine("        MoveDir = moveDir;");
        text.AppendLine("        AimDir = aimDir;");
        text.AppendLine("        Hold = hold;");
        text.AppendLine("        Down = down;");
        text.AppendLine("        Up = up;");
        text.AppendLine("        Action = action;");
        text.AppendLine("    }");
        text.AppendLine();
        text.AppendLine("    public long PlayerId { get; }");
        text.AppendLine("    public uint ClientTick { get; }");
        text.AppendLine("    public Vector2I MoveDir { get; }");
        text.AppendLine("    public Vector2I AimDir { get; }");
        text.AppendLine("    public int Hold { get; }");
        text.AppendLine("    public int Down { get; }");
        text.AppendLine("    public int Up { get; }");
        text.AppendLine("    public PlayerAction? Action { get; }");
        text.AppendLine();
        text.AppendLine("    public bool IsHold(int mask) => (Hold & mask) != 0;");
        text.AppendLine("    public bool IsDown(int mask) => (Down & mask) != 0;");
        text.AppendLine("    public bool IsUp(int mask) => (Up & mask) != 0;");
        text.AppendLine("}");
    }

    private static void RenderCoreEventCs(StringBuilder text, ProtoSchema schema)
    {
        text.AppendLine("public sealed class CoreEvent");
        text.AppendLine("{");
        if (schema.Messages.TryGetValue("GameEvent", out var eventRoot))
        {
            foreach (var variant in eventRoot.Fields.Where(item => item.IsOneof))
            {
                text.AppendLine($"    public const string {ClassNameForEvent(variant.Type)} = \"{ClassNameForEvent(variant.Type)}\";");
            }

            var fields = eventRoot.Fields
                .Where(item => item.IsOneof)
                .SelectMany(variant => schema.Messages.TryGetValue(variant.Type, out var message) ? message.Fields : [])
                .GroupBy(field => field.Name, StringComparer.Ordinal)
                .Select(group => group.First())
                .OrderBy(field => field.Name, StringComparer.Ordinal)
                .ToArray();

            text.AppendLine();
            text.AppendLine("    public string Type { get; init; } = \"\";");
            foreach (var field in fields)
            {
                var init = CsDefaultInit(field);
                text.AppendLine($"    public {CsCoreType(field.Type, field.IsRepeated)} {Pascal(field.Name)} {{ get; init; }}{init}");
            }
        }
        else
        {
            text.AppendLine("    public string Type { get; init; } = \"\";");
        }
        text.AppendLine("}");
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

    private static string EnumTail(string value)
    {
        var parts = value.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length <= 2)
        {
            return value.ToLowerInvariant();
        }
        return string.Join("_", parts.Skip(2)).ToLowerInvariant();
    }

    private static string Pascal(string value)
    {
        var text = new StringBuilder();
        foreach (var part in value.Split('_', StringSplitOptions.RemoveEmptyEntries))
        {
            text.Append(char.ToUpperInvariant(part[0]));
            if (part.Length > 1)
            {
                text.Append(part[1..].ToLowerInvariant());
            }
        }
        return text.Length == 0 ? "Value" : text.ToString();
    }

    private static string CsCoreType(string type, bool repeated)
    {
        var itemType = type switch
        {
            "string" => "string",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2I",
            "PlayerId" => "long",
            "EntityId" => "int",
            "PlayerAction" => "PlayerAction?",
            "EntityKind" or "ItemKind" or "WeaponSlot" or "WeaponPhase" => "string",
            _ when IsIntLike(type) => "int",
            _ => Pascal(type),
        };
        return repeated ? $"List<{itemType}>" : itemType;
    }

    private static string CsDefaultInit(ProtoField field)
    {
        if (field.IsRepeated)
        {
            return " = new();";
        }
        if (field.Type == "string")
        {
            return " = \"\";";
        }
        if (field.Type == "PlayerAction")
        {
            return "";
        }
        return field.Type switch
        {
            "EntityKind" => field.Name == "victim_kind"
                ? " = BridgeEntityKind.Dummy;"
                : $" = BridgeEntityKind.{Pascal(EnumDefault("EntityKind"))};",
            "ItemKind" => $" = BridgeItemKind.{Pascal(EnumDefault("ItemKind"))};",
            "WeaponSlot" => $" = BridgeWeaponSlot.{Pascal(EnumDefault("WeaponSlot"))};",
            "WeaponPhase" => $" = BridgeWeaponPhase.{Pascal(EnumDefault("WeaponPhase"))};",
            _ when field.Name == "count" => " = 1;",
            _ => "",
        };
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
        GenerateCSharp(root, config);
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
        var rootNamespace = TextUtil.PascalName(config.Value("project", "name", "Game"));

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

    private static void GenerateCSharp(string root, FwConfig config)
    {
        var schemaDir = config.PathValue(root, "schema", "config", "schema/config");
        var output = config.PathValue(root, "gen", "config_contract_cs", "csharp/core/config/config_contract.cs");
        var schema = ProtoSchema.ParseFiles(Directory.Exists(schemaDir)
            ? Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal)
            : []);
        var rootNamespace = TextUtil.PascalName(config.Value("project", "name", "Game"));

        var messages = schema.Messages.Values
            .Where(item => item.Name != "Fixed32")
            .OrderBy(item => item.Name == "GameConfig" ? "CoreConfig" : item.Name, StringComparer.Ordinal)
            .ToArray();

        var text = new StringBuilder();
        text.AppendLine("// @generated by fw_gen config. Do not edit.");
        text.AppendLine("using System.Collections.Generic;");
        text.AppendLine();
        text.AppendLine($"namespace {rootNamespace}.Core;");
        text.AppendLine();
        RenderConfigFields(text, schema);
        text.AppendLine();
        foreach (var message in messages)
        {
            var className = message.Name == "GameConfig" ? "CoreConfig" : message.Name;
            text.AppendLine($"public sealed class {className}");
            text.AppendLine("{");
            foreach (var field in message.Fields)
            {
                text.AppendLine($"    public {CsConfigType(field.Type, field.IsRepeated)} {Pascal(field.Name)} {{ get; init; }}{CsConfigInit(field, schema)}");
            }
            text.AppendLine("}");
            text.AppendLine();
        }

        TextUtil.WriteText(output, text.ToString());
        Console.WriteLine($"generated config csharp contract: {output}");
    }

    private static void RenderConfigFields(StringBuilder text, ProtoSchema schema)
    {
        var fields = schema.Messages.Values
            .SelectMany(message => message.Fields)
            .Select(field => field.Name)
            .Append("key")
            .Distinct(StringComparer.Ordinal)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();

        text.AppendLine("public static class ConfigField");
        text.AppendLine("{");
        foreach (var field in fields)
        {
            text.AppendLine($"    public const string {Pascal(field)} = \"{field}\";");
        }
        text.AppendLine("}");
    }

    private static string CsConfigType(string type, bool repeated)
    {
        var itemType = type switch
        {
            "string" => "string",
            "bool" => "bool",
            "float" or "double" or "Fixed32" => "float",
            "uint32" => "int",
            "uint64" => "ulong",
            "int32" or "sint32" => "int",
            "int64" or "sint64" => "long",
            _ => type == "GameConfig" ? "CoreConfig" : type,
        };
        return repeated ? $"List<{itemType}>" : itemType;
    }

    private static string CsConfigInit(ProtoField field, ProtoSchema schema)
    {
        if (field.IsRepeated)
        {
            return " = new();";
        }
        if (field.Type == "string")
        {
            return " = \"\";";
        }
        if (schema.Messages.ContainsKey(field.Type) && field.Type != "Fixed32")
        {
            return " = new();";
        }
        return "";
    }

    private static string Pascal(string value)
    {
        var text = new StringBuilder();
        foreach (var part in value.Split('_', StringSplitOptions.RemoveEmptyEntries))
        {
            text.Append(char.ToUpperInvariant(part[0]));
            if (part.Length > 1)
            {
                text.Append(part[1..].ToLowerInvariant());
            }
        }
        return text.Length == 0 ? "Value" : text.ToString();
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
            if (relative.StartsWith("extension" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
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

static class CoreSystemGen
{
    private sealed record CoreSystemSchema(List<string> PhaseOrder, List<CoreSystemNode> Systems);
    private sealed record CoreSystemNode(string Id, string Phase, string Type);

    public static void Generate(string root, FwConfig config)
    {
        var schemaPath = config.PathValue(root, "schema", "core_system", "schema/core_system.toml");
        if (!File.Exists(schemaPath))
        {
            return;
        }

        var output = config.PathValue(root, "gen", "core_systems_cs", "csharp/core/core_systems.cs");
        var schema = Parse(schemaPath);
        var rootNamespace = TextUtil.PascalName(config.Value("project", "name", "Game"));
        TextUtil.WriteText(output, Render(schema, rootNamespace));
        Console.WriteLine($"generated core system registrations: {output}");
    }

    private static CoreSystemSchema Parse(string path)
    {
        var phaseOrder = new List<string>();
        var systems = new List<CoreSystemNode>();
        var values = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
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

            if (line.StartsWith('[') && line.EndsWith(']'))
            {
                section = line.Trim('[', ']').Trim();
                if (section.Length == 0)
                {
                    throw new InvalidOperationException($"{path}:{lineNo} section cannot be empty");
                }
                values.TryAdd(section, new Dictionary<string, string>(StringComparer.Ordinal));
                continue;
            }

            var parts = line.Split('=', 2);
            if (parts.Length != 2 || section.Length == 0)
            {
                throw new InvalidOperationException($"{path}:{lineNo} expected `field = \"value\"` under a section");
            }

            var field = parts[0].Trim();
            var value = parts[1].Trim();
            if (section == "phases" && field == "order")
            {
                phaseOrder = ParseQuotedList(value, path, lineNo);
                continue;
            }

            values[section][field] = ParseQuotedRaw(value, path, lineNo);
        }

        foreach (var (id, fields) in values)
        {
            if (id == "phases")
            {
                continue;
            }
            if (!fields.TryGetValue("phase", out var phase) || phase.Length == 0)
            {
                throw new InvalidOperationException($"{path}: core system `{id}` needs phase");
            }
            if (!fields.TryGetValue("type", out var type) || type.Length == 0)
            {
                throw new InvalidOperationException($"{path}: core system `{id}` needs type");
            }
            systems.Add(new CoreSystemNode(id, phase, type));
        }

        if (systems.Count == 0)
        {
            throw new InvalidOperationException($"{path}: core system schema is empty");
        }
        return new CoreSystemSchema(phaseOrder, systems);
    }

    private static string Render(CoreSystemSchema schema, string rootNamespace)
    {
        var text = new StringBuilder();
        text.AppendLine("// @generated by fw_gen system. Do not edit.");
        text.AppendLine("using Fw.Rt.Systems;");
        text.AppendLine();
        text.AppendLine($"namespace {rootNamespace}.Core;");
        text.AppendLine();
        text.AppendLine("internal static class CoreSystems");
        text.AppendLine("{");
        foreach (var system in schema.Systems)
        {
            text.AppendLine($"    public const string Id{TextUtil.PascalName(system.Id)} = \"{system.Id}\";");
        }
        if (schema.Systems.Count > 0)
        {
            text.AppendLine();
        }
        foreach (var phase in schema.PhaseOrder)
        {
            text.AppendLine($"    public const string Phase{TextUtil.PascalName(phase)} = \"{phase}\";");
        }
        if (schema.PhaseOrder.Count > 0)
        {
            text.AppendLine();
        }
        text.AppendLine("    public static readonly string[] PhaseOrder =");
        text.AppendLine("    [");
        foreach (var phase in schema.PhaseOrder)
        {
            text.AppendLine($"        Phase{TextUtil.PascalName(phase)},");
        }
        text.AppendLine("    ];");
        text.AppendLine();
        text.AppendLine("    public static void Register(SystemRuntime runtime, CoreContext context)");
        text.AppendLine("    {");
        text.AppendLine("        runtime.SetPhaseOrder(PhaseOrder);");
        foreach (var system in schema.Systems)
        {
            text.AppendLine($"        runtime.Add(Id{TextUtil.PascalName(system.Id)}, new {system.Type}(), context, Phase{TextUtil.PascalName(system.Phase)});");
        }
        text.AppendLine("    }");
        text.AppendLine("}");
        return text.ToString();
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

    private static string ParseQuotedRaw(string value, string path, int lineNo)
    {
        if (!value.StartsWith('"') || !value.EndsWith('"') || value.Length < 2)
        {
            throw new InvalidOperationException($"{path}:{lineNo} value must be quoted");
        }
        return value[1..^1];
    }

    private static List<string> ParseQuotedList(string value, string path, int lineNo)
    {
        if (!value.StartsWith('[') || !value.EndsWith(']'))
        {
            throw new InvalidOperationException($"{path}:{lineNo} expected quoted string array");
        }

        var inner = value[1..^1].Trim();
        if (inner.Length == 0)
        {
            return [];
        }

        var items = new List<string>();
        foreach (var rawPart in inner.Split(','))
        {
            items.Add(ParseQuotedRaw(rawPart.Trim(), path, lineNo));
        }
        return items;
    }
}

sealed class ProtoSchema
{
    public Dictionary<string, ProtoMessage> Messages { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, ProtoEnum> Enums { get; } = new(StringComparer.Ordinal);

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
        ProtoEnum? currentEnum = null;
        var inOneof = false;

        foreach (var raw in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = raw.Split("//")[0].Trim();
            if (line.Length == 0)
            {
                continue;
            }

            if (currentEnum != null)
            {
                if (line == "}")
                {
                    schema.Enums[currentEnum.Name] = currentEnum;
                    currentEnum = null;
                    continue;
                }

                var valueMatch = Regex.Match(line, @"^([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+);");
                if (valueMatch.Success)
                {
                    currentEnum.Values.Add(new ProtoEnumValue(
                        valueMatch.Groups[1].Value,
                        int.Parse(valueMatch.Groups[2].Value)));
                }
                continue;
            }

            if (current == null)
            {
                var enumMatch = Regex.Match(line, @"^enum\s+([A-Za-z_][A-Za-z0-9_]*)");
                if (enumMatch.Success)
                {
                    currentEnum = new ProtoEnum(enumMatch.Groups[1].Value, path);
                    if (line.Contains('}'))
                    {
                        schema.Enums[currentEnum.Name] = currentEnum;
                        currentEnum = null;
                    }
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

sealed record ProtoEnum(string Name, string SourcePath)
{
    public List<ProtoEnumValue> Values { get; } = [];
}

sealed record ProtoEnumValue(string Name, int Number);

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

    public static string PascalName(string value)
    {
        var text = new StringBuilder();
        foreach (var part in Regex.Split(value, @"[^A-Za-z0-9]+").Where(item => item.Length > 0))
        {
            text.Append(char.ToUpperInvariant(part[0]));
            if (part.Length > 1)
            {
                text.Append(part[1..]);
            }
        }
        return text.Length == 0 ? "Game" : text.ToString();
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
