using System.Text;
using System.Text.RegularExpressions;

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
