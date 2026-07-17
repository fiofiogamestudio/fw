using System.Text;
using System.Text.RegularExpressions;

sealed record SystemSchema(RuntimeSystemSchema Godot, RuntimeSystemSchema Core);

sealed class RuntimeSystemSchema
{
    public RuntimeSystemSchema(string runtime)
    {
        Runtime = runtime;
    }

    public string Runtime { get; }
    public List<string> PhaseOrder { get; set; } = [];
    public List<SystemNode> Systems { get; } = [];
}

sealed class SystemNode
{
    public SystemNode(string id, int lineNo)
    {
        Id = id;
        LineNo = lineNo;
    }

    public string Id { get; }
    public int LineNo { get; }
    public string Phase { get; set; } = "";
    public string Script { get; set; } = "";
    public string Context { get; set; } = "";
    public string Type { get; set; } = "";
    public bool Manual { get; set; }
    public List<SystemRef> Refs { get; } = [];
    public HashSet<string> Fields { get; } = new(StringComparer.Ordinal);
    public bool AutoGodot => !Manual && Script.Length > 0 && Context.Length > 0;
}

sealed record SystemRef(string Field, string Target);

static class SystemSchemaParser
{
    private static readonly Regex SectionPattern = new(
        @"^(godot|core)\.(phases|system\.([A-Za-z_][A-Za-z0-9_]*))$",
        RegexOptions.CultureInvariant
    );

    private static readonly Regex NamePattern = new(
        @"^[A-Za-z_][A-Za-z0-9_]*$",
        RegexOptions.CultureInvariant
    );

    private static readonly Regex TypePattern = new(
        @"^[A-Za-z_][A-Za-z0-9_.]*$",
        RegexOptions.CultureInvariant
    );

    public static SystemSchema Parse(string root, string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"system schema not found: {path}");
        }

        var godot = new RuntimeSystemSchema("godot");
        var core = new RuntimeSystemSchema("core");
        var phaseSections = new HashSet<string>(StringComparer.Ordinal);
        RuntimeSystemSchema? currentRuntime = null;
        SystemNode? currentSystem = null;
        var inPhases = false;
        var phaseOrderSeen = false;

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
                var section = line[1..^1].Trim();
                var match = SectionPattern.Match(section);
                if (!match.Success)
                {
                    throw Error(path, lineNo, $"unsupported section `{section}`; expected godot/core phases or system section");
                }

                currentRuntime = match.Groups[1].Value == "godot" ? godot : core;
                inPhases = match.Groups[2].Value == "phases";
                currentSystem = null;
                phaseOrderSeen = false;

                if (inPhases)
                {
                    if (!phaseSections.Add(currentRuntime.Runtime))
                    {
                        throw Error(path, lineNo, $"duplicate [{currentRuntime.Runtime}.phases] section");
                    }
                    continue;
                }

                var id = match.Groups[3].Value;
                ValidateName(path, lineNo, id, "system id");
                if (currentRuntime.Systems.Any(item => item.Id == id))
                {
                    throw Error(path, lineNo, $"duplicate {currentRuntime.Runtime} system `{id}`");
                }
                currentSystem = new SystemNode(id, lineNo);
                currentRuntime.Systems.Add(currentSystem);
                continue;
            }

            if (currentRuntime == null)
            {
                throw Error(path, lineNo, "field must appear under a godot/core section");
            }

            var parts = line.Split('=', 2);
            if (parts.Length != 2)
            {
                throw Error(path, lineNo, "expected `field = value`");
            }

            var field = parts[0].Trim();
            var value = parts[1].Trim();
            ValidateName(path, lineNo, field, "field");

            if (inPhases)
            {
                if (field != "order")
                {
                    throw Error(path, lineNo, $"unsupported phases field `{field}`");
                }
                if (phaseOrderSeen)
                {
                    throw Error(path, lineNo, "duplicate phases order");
                }
                phaseOrderSeen = true;
                currentRuntime.PhaseOrder = ParseQuotedList(path, lineNo, value);
                ValidatePhaseOrder(path, lineNo, currentRuntime);
                continue;
            }

            if (currentSystem == null)
            {
                throw Error(path, lineNo, "field must appear under a system section");
            }
            if (!currentSystem.Fields.Add(field))
            {
                throw Error(path, lineNo, $"duplicate field `{field}` in system `{currentSystem.Id}`");
            }

            if (currentRuntime.Runtime == "godot")
            {
                ParseGodotField(path, lineNo, currentSystem, field, value);
            }
            else
            {
                ParseCoreField(path, lineNo, currentSystem, field, value);
            }
        }

        ValidateRuntime(root, path, godot);
        ValidateRuntime(root, path, core);
        return new SystemSchema(godot, core);
    }

    private static void ParseGodotField(string path, int lineNo, SystemNode system, string field, string value)
    {
        switch (field)
        {
            case "phase":
                system.Phase = ParseQuotedName(path, lineNo, value, "phase");
                break;
            case "script":
                system.Script = ParseQuoted(path, lineNo, value, "script");
                break;
            case "context":
                system.Context = ParseQuoted(path, lineNo, value, "context");
                break;
            case "manual":
                system.Manual = ParseBool(path, lineNo, value);
                break;
            default:
                system.Refs.Add(new SystemRef(field, ParseQuotedName(path, lineNo, value, "ref target")));
                break;
        }
    }

    private static void ParseCoreField(string path, int lineNo, SystemNode system, string field, string value)
    {
        switch (field)
        {
            case "phase":
                system.Phase = ParseQuotedName(path, lineNo, value, "phase");
                break;
            case "type":
                system.Type = ParseQuoted(path, lineNo, value, "type");
                if (!TypePattern.IsMatch(system.Type))
                {
                    throw Error(path, lineNo, $"invalid core system type `{system.Type}`");
                }
                break;
            default:
                throw Error(path, lineNo, $"unsupported core system field `{field}`");
        }
    }

    private static void ValidateRuntime(string root, string path, RuntimeSystemSchema runtime)
    {
        if (runtime.Systems.Count == 0)
        {
            throw new InvalidOperationException($"{path}: {runtime.Runtime} system schema is empty");
        }
        if (runtime.PhaseOrder.Count == 0)
        {
            throw new InvalidOperationException($"{path}: [{runtime.Runtime}.phases].order cannot be empty");
        }

        var knownPhases = runtime.PhaseOrder.ToHashSet(StringComparer.Ordinal);
        var knownSystems = runtime.Systems.Select(item => item.Id).ToHashSet(StringComparer.Ordinal);
        foreach (var system in runtime.Systems)
        {
            if (system.Phase.Length == 0)
            {
                throw new InvalidOperationException($"{path}:{system.LineNo} {runtime.Runtime} system `{system.Id}` needs phase");
            }
            if (!knownPhases.Contains(system.Phase))
            {
                throw new InvalidOperationException(
                    $"{path}:{system.LineNo} {runtime.Runtime} system `{system.Id}` uses phase `{system.Phase}` outside phases.order"
                );
            }

            if (runtime.Runtime == "godot")
            {
                if (!system.Manual && system.Script.Length == 0 && system.Context.Length == 0)
                {
                    system.Manual = true;
                }
                if (!system.Manual && (system.Script.Length == 0 || system.Context.Length == 0))
                {
                    throw new InvalidOperationException(
                        $"{path}:{system.LineNo} godot system `{system.Id}` needs both script and context, or manual = true"
                    );
                }
                if (system.AutoGodot)
                {
                    ValidateResourcePath(root, path, system, system.Script, "script");
                    ValidateResourcePath(root, path, system, system.Context, "context");
                }
                foreach (var systemRef in system.Refs)
                {
                    if (!knownSystems.Contains(systemRef.Target))
                    {
                        throw new InvalidOperationException(
                            $"{path}:{system.LineNo} system `{system.Id}` refs `{systemRef.Field}` points to missing system `{systemRef.Target}`"
                        );
                    }
                }
            }
            else if (system.Type.Length == 0)
            {
                throw new InvalidOperationException($"{path}:{system.LineNo} core system `{system.Id}` needs type");
            }
        }
    }

    private static void ValidatePhaseOrder(string path, int lineNo, RuntimeSystemSchema runtime)
    {
        var phases = new HashSet<string>(StringComparer.Ordinal);
        foreach (var phase in runtime.PhaseOrder)
        {
            ValidateName(path, lineNo, phase, "phase");
            if (!phases.Add(phase))
            {
                throw Error(path, lineNo, $"duplicate phase `{phase}` in {runtime.Runtime}.phases.order");
            }
        }
    }

    private static void ValidateResourcePath(
        string root,
        string schemaPath,
        SystemNode system,
        string value,
        string label
    )
    {
        var relative = value.StartsWith("res://", StringComparison.Ordinal) ? value["res://".Length..] : value;
        var fullPath = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        var fullRoot = Path.GetFullPath(root);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rootPrefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            || fullRoot.EndsWith(Path.AltDirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        if (!fullPath.Equals(fullRoot, comparison) && !fullPath.StartsWith(rootPrefix, comparison))
        {
            throw new InvalidOperationException(
                $"{schemaPath}:{system.LineNo} system `{system.Id}` {label} escapes project root: {value}"
            );
        }
        if (!File.Exists(fullPath))
        {
            throw new FileNotFoundException(
                $"{schemaPath}:{system.LineNo} system `{system.Id}` {label} not found: {value}"
            );
        }
    }

    private static List<string> ParseQuotedList(string path, int lineNo, string value)
    {
        if (!value.StartsWith('[') || !value.EndsWith(']'))
        {
            throw Error(path, lineNo, "expected quoted string array");
        }

        var inner = value[1..^1].Trim();
        if (inner.Length == 0)
        {
            return [];
        }

        return inner.Split(',')
            .Select(item => ParseQuotedName(path, lineNo, item.Trim(), "phase"))
            .ToList();
    }

    private static string ParseQuotedName(string path, int lineNo, string value, string label)
    {
        var result = ParseQuoted(path, lineNo, value, label);
        ValidateName(path, lineNo, result, label);
        return result;
    }

    private static string ParseQuoted(string path, int lineNo, string value, string label)
    {
        if (!value.StartsWith('"') || !value.EndsWith('"') || value.Length < 2)
        {
            throw Error(path, lineNo, $"{label} must be quoted");
        }
        return value[1..^1];
    }

    private static bool ParseBool(string path, int lineNo, string value)
    {
        return value switch
        {
            "true" => true,
            "false" => false,
            _ => throw Error(path, lineNo, "bool value must be true or false"),
        };
    }

    private static void ValidateName(string path, int lineNo, string value, string label)
    {
        if (!NamePattern.IsMatch(value))
        {
            throw Error(path, lineNo, $"invalid {label} `{value}`");
        }
    }

    private static string StripComment(string line)
    {
        var inQuote = false;
        for (var index = 0; index < line.Length; index++)
        {
            if (line[index] == '"')
            {
                inQuote = !inQuote;
            }
            if (!inQuote && line[index] == '#')
            {
                return line[..index];
            }
        }
        return line;
    }

    private static InvalidOperationException Error(string path, int lineNo, string message)
    {
        return new InvalidOperationException($"{path}:{lineNo} {message}");
    }
}
