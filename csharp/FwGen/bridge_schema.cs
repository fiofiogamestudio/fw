using System.Text;

static class BridgeSchema
{
    internal static ProtoSchema Read(string schemaDir)
    {
        var schema = ProtoSchema.ParseFiles(SchemaFiles(schemaDir));
        if (string.IsNullOrWhiteSpace(schema.Package))
        {
            throw new InvalidOperationException("bridge schema must declare one shared package");
        }
        ValidateSupportedTypes(schema);
        return schema;
    }

    private static void ValidateSupportedTypes(ProtoSchema schema)
    {
        foreach (var message in schema.Messages.Values)
        {
            foreach (var field in message.Fields)
            {
                if (ProtoSchema.IsPortableScalar(field.Type)
                    || schema.Messages.ContainsKey(field.Type)
                    || schema.Enums.ContainsKey(field.Type))
                {
                    continue;
                }
                throw new InvalidOperationException(
                    $"{message.SourcePath}:{field.LineNo} bridge field `{message.Name}.{field.Name}` uses unsupported scalar `{field.Type}`"
                );
            }
        }
    }

    internal static string[] SchemaFiles(string schemaDir)
    {
        var names = new[] { "value.proto", "intent.proto", "view.proto", "event.proto", "packet.proto" };
        var files = names.Select(name => Path.Combine(schemaDir, name)).ToArray();
        var missing = files.Where(path => !File.Exists(path)).Select(path => Path.GetFileName(path) ?? path).ToArray();
        if (missing.Length > 0)
        {
            throw new FileNotFoundException($"bridge schema is missing: {string.Join(", ", missing)}");
        }

        var allowed = names.ToHashSet(StringComparer.OrdinalIgnoreCase);
        var extras = Directory.GetFiles(schemaDir, "*.proto")
            .Select(path => Path.GetFileName(path) ?? "")
            .Where(name => !allowed.Contains(name))
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        if (extras.Length > 0)
        {
            throw new InvalidOperationException($"bridge schema only allows value/intent/view/event/packet.proto; found: {string.Join(", ", extras)}");
        }
        return files;
    }

    internal static string ClassNameForEvent(string messageType)
    {
        return messageType.EndsWith("Event", StringComparison.Ordinal)
            ? messageType[..^"Event".Length]
            : messageType;
    }

    internal static string ClassNameForView(string messageType)
    {
        return messageType.EndsWith("View", StringComparison.Ordinal)
            ? messageType[..^"View".Length]
            : messageType;
    }

    internal static ProtoMessage[] MessagesInFile(ProtoSchema schema, string fileName)
    {
        return schema.Messages.Values
            .Where(item => Path.GetFileName(item.SourcePath).Equals(fileName, StringComparison.OrdinalIgnoreCase))
            .OrderBy(item => item.LineNo)
            .ToArray();
    }

    internal static ProtoEnum[] EnumsInFile(ProtoSchema schema, string fileName)
    {
        return schema.Enums.Values
            .Where(item => Path.GetFileName(item.SourcePath).Equals(fileName, StringComparison.OrdinalIgnoreCase))
            .OrderBy(item => item.LineNo)
            .ToArray();
    }

    internal static ProtoMessage? FindIntentRoot(ProtoSchema schema)
    {
        var messages = MessagesInFile(schema, "intent.proto");
        if (messages.Length == 0)
        {
            return null;
        }
        var referenced = messages.SelectMany(message => message.Fields)
            .Where(field => schema.Messages.ContainsKey(field.Type))
            .Select(field => field.Type)
            .ToHashSet(StringComparer.Ordinal);
        var roots = messages.Where(message => !referenced.Contains(message.Name)).ToArray();
        if (roots.Length == 1)
        {
            return roots[0];
        }
        var intentRoots = roots.Where(message => message.Name.EndsWith("Intent", StringComparison.Ordinal)).ToArray();
        if (intentRoots.Length == 1)
        {
            return intentRoots[0];
        }
        throw new InvalidOperationException("intent.proto must expose exactly one unreferenced root message");
    }

    internal static ProtoMessage? FindActionRoot(ProtoSchema schema)
    {
        var intentRoot = FindIntentRoot(schema);
        if (intentRoot == null)
        {
            return null;
        }
        var referencedRoots = intentRoot.Fields
            .Where(field => schema.Messages.TryGetValue(field.Type, out var message)
                && message.Fields.Any(item => item.IsOneof))
            .Select(field => schema.Messages[field.Type])
            .Distinct()
            .ToArray();
        if (referencedRoots.Length > 1)
        {
            throw new InvalidOperationException("intent root references more than one oneof action message");
        }
        var root = referencedRoots.FirstOrDefault();
        ValidateOneofGroup(root, "intent action");
        return root;
    }

    internal static ProtoMessage? FindOneofRoot(ProtoSchema schema, string fileName)
    {
        var roots = MessagesInFile(schema, fileName)
            .Where(message => message.Fields.Any(field => field.IsOneof))
            .ToArray();
        var root = roots.Length switch
        {
            0 => null,
            1 => roots[0],
            _ => throw new InvalidOperationException($"{fileName} must contain at most one oneof root message"),
        };
        ValidateOneofGroup(root, fileName);
        return root;
    }

    internal static void ValidateOneofGroup(ProtoMessage? root, string label)
    {
        if (root == null)
        {
            return;
        }
        var groups = root.Fields.Where(field => field.IsOneof)
            .Select(field => field.OneofGroup)
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (groups.Length != 1)
        {
            throw new InvalidOperationException($"{label} root `{root.Name}` must contain exactly one oneof group");
        }
    }

    internal static ProtoEnum? FindButtonEnum(ProtoSchema schema)
    {
        var candidates = EnumsInFile(schema, "intent.proto")
            .Where(item => item.Name.EndsWith("Button", StringComparison.Ordinal))
            .ToArray();
        return candidates.Length switch
        {
            0 => null,
            1 => candidates[0],
            _ => throw new InvalidOperationException("intent.proto must contain at most one *Button enum"),
        };
    }

    internal static ProtoEnum? FindPacketEnum(ProtoSchema schema)
    {
        var candidates = EnumsInFile(schema, "packet.proto");
        var preferred = candidates.Where(item => item.Name == "PacketType").ToArray();
        if (preferred.Length == 1)
        {
            return preferred[0];
        }
        return candidates.Length switch
        {
            0 => null,
            1 => candidates[0],
            _ => throw new InvalidOperationException("packet.proto must identify exactly one packet type enum"),
        };
    }

    internal static ProtoField[] VariantFields(ProtoSchema schema, ProtoMessage root)
    {
        var fields = root.Fields.Where(item => item.IsOneof)
            .SelectMany(variant => schema.Messages.TryGetValue(variant.Type, out var message) ? message.Fields : [])
            .GroupBy(field => field.Name, StringComparer.Ordinal)
            .Select(group =>
            {
                var first = group.First();
                if (group.Any(field => field.IsRepeated != first.IsRepeated))
                {
                    throw new InvalidOperationException(
                        $"oneof `{root.Name}` payload field `{group.Key}` mixes repeated and scalar values"
                    );
                }
                var types = group.Select(field => field.Type).Distinct(StringComparer.Ordinal).ToArray();
                if (types.Length == 1)
                {
                    return first;
                }
                if (types.All(IsIntLike))
                {
                    return first with { Type = "int64" };
                }
                if (types.All(type => type == "string" || schema.Enums.ContainsKey(type)))
                {
                    return first with { Type = "string" };
                }
                throw new InvalidOperationException(
                    $"oneof `{root.Name}` payload field `{group.Key}` has incompatible types: {string.Join(", ", types)}"
                );
            })
            .OrderBy(field => field.Name, StringComparer.Ordinal)
            .ToArray();
        return fields;
    }

    internal static string RuntimeEventType(ProtoMessage eventRoot)
    {
        _ = eventRoot;
        return "CoreEvent";
    }

    internal static string EnumTail(string value)
    {
        var parts = value.Split('_', StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length <= 2)
        {
            return value.ToLowerInvariant();
        }
        return string.Join("_", parts.Skip(2)).ToLowerInvariant();
    }

    internal static string Pascal(string value)
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

    internal static string Camel(string value)
    {
        var pascal = Pascal(value);
        return pascal.Length == 0
            ? "value"
            : char.ToLowerInvariant(pascal[0]) + pascal[1..];
    }

    internal static string GdConstName(string value)
    {
        return string.Join("_", value.Split('_', StringSplitOptions.RemoveEmptyEntries))
            .ToUpperInvariant();
    }

    internal static string CsCoreType(ProtoSchema schema, string type, bool repeated)
    {
        var itemType = type switch
        {
            "string" => "string",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2I",
            "PlayerId" => "long",
            "EntityId" => "int",
            "int64" or "sint64" or "uint64" => "long",
            "bytes" => "byte[]",
            _ when schema.Enums.ContainsKey(type) => "string",
            _ when IsIntLike(type) => "int",
            _ => type + "?",
        };
        return repeated ? $"List<{itemType}>" : itemType;
    }

    internal static string CsDefaultInit(ProtoSchema schema, ProtoField field)
    {
        if (field.IsRepeated)
        {
            return " = new();";
        }
        if (field.Type == "string")
        {
            return " = \"\";";
        }
        if (schema.Messages.ContainsKey(field.Type))
        {
            return "";
        }
        if (schema.Enums.ContainsKey(field.Type))
        {
            return " = \"\";";
        }
        return "";
    }

    internal static string CsIntentType(ProtoSchema schema, ProtoField field)
    {
        if (field.Name == "client_tick" && field.Type == "uint32")
        {
            return "uint";
        }
        if (field.Name is "buttons_hold" or "buttons_down" or "buttons_up")
        {
            return "int";
        }
        return CsCoreType(schema, field.Type, field.IsRepeated);
    }

    internal static string IntentPropertyName(ProtoField field)
    {
        return field.Name switch
        {
            "buttons_hold" => "Hold",
            "buttons_down" => "Down",
            "buttons_up" => "Up",
            _ => Pascal(field.Name),
        };
    }

    internal static string GdArgType(ProtoSchema schema, ProtoField field)
    {
        if (field.IsRepeated) return "Array";
        return field.Type switch
        {
            "string" => "String",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2i",
            _ when schema.Enums.ContainsKey(field.Type) => "String",
            _ when IsIntLike(field.Type) => "int",
            _ => "Variant"
        };
    }

    internal static string GdReturnType(ProtoSchema? schema, ProtoField field, bool eventMode)
    {
        if (field.IsRepeated) return "Array";
        return field.Type switch
        {
            "string" => "String",
            "bool" => "bool",
            "float" or "double" => "float",
            "Vec2i" => "Vector2i",
            _ when IsIntLike(field.Type) => "int",
            _ when schema != null && schema.Enums.ContainsKey(field.Type) => "String",
            _ => eventMode ? "Variant" : "String"
        };
    }

    internal static string GdGetter(ProtoSchema? schema, ProtoField field, bool eventMode)
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
            _ when schema != null && schema.Enums.ContainsKey(field.Type) => $"str(_raw.get(\"{field.Name}\", \"\"))",
            _ => eventMode ? $"_raw.get(\"{field.Name}\", null)" : $"_raw.get(\"{field.Name}\", null)"
        };
    }

    internal static string BridgeEnumDefault(ProtoSchema schema, string type)
    {
        _ = schema;
        _ = type;
        return "\"\"";
    }

    internal static string BridgeEnumClass(string enumName)
    {
        return $"Bridge{enumName}";
    }

    internal static bool IsIntLike(string type)
    {
        return type is "int32" or "int64" or "uint32" or "uint64" or "sint32" or "sint64"
            || type.EndsWith("Id", StringComparison.Ordinal);
    }
}
