using System.Security.Cryptography;
using System.Text;

sealed class BridgeModel
{
    internal required ProtoSchema Schema { get; init; }
    internal required int ProtocolVersion { get; init; }
    internal required ProtoEnum[] ValueEnums { get; init; }
    internal required ProtoMessage[] ViewMessages { get; init; }
    internal required string[] FieldNames { get; init; }
    internal required ProtoField[] ActionFields { get; init; }
    internal required ProtoField[] EventFields { get; init; }
    internal required ProtoField[] PacketPayloads { get; init; }
    internal ProtoMessage? IntentRoot { get; init; }
    internal ProtoMessage? ActionRoot { get; init; }
    internal ProtoMessage? EventRoot { get; init; }
    internal ProtoMessage? PacketRoot { get; init; }
    internal ProtoEnum? ButtonEnum { get; init; }
    internal ProtoEnum? PacketEnum { get; init; }
}

static class BridgeSchema
{
    internal static BridgeModel Read(string schemaDir)
    {
        var schema = ProtoSchema.ParseFiles(SchemaFiles(schemaDir));
        if (string.IsNullOrWhiteSpace(schema.Package))
        {
            throw new InvalidOperationException("bridge schema must declare one shared package");
        }
        ValidateSupportedTypes(schema);
        var intentRoot = FindIntentRoot(schema);
        var actionRoot = FindActionRoot(schema, intentRoot);
        var eventRoot = FindOneofRoot(schema, "event.proto");
        var packetRoot = FindOneofRoot(schema, "packet.proto");
        var model = new BridgeModel
        {
            Schema = schema,
            ProtocolVersion = ComputeProtocolVersion(schema),
            ValueEnums = EnumsInFile(schema, "value.proto"),
            ViewMessages = MessagesInFile(schema, "view.proto")
                .Where(item => item.Fields.All(field => !field.IsOneof))
                .ToArray(),
            FieldNames = schema.Messages.Values
                .SelectMany(message => message.Fields)
                .Select(field => field.Name)
                .Append("kind")
                .Append("type")
                .Distinct(StringComparer.Ordinal)
                .OrderBy(item => item, StringComparer.Ordinal)
                .ToArray(),
            ActionFields = actionRoot == null ? [] : VariantFields(schema, actionRoot),
            EventFields = eventRoot == null ? [] : VariantFields(schema, eventRoot),
            PacketPayloads = packetRoot?.Fields.Where(field => field.IsOneof).ToArray() ?? [],
            IntentRoot = intentRoot,
            ActionRoot = actionRoot,
            EventRoot = eventRoot,
            PacketRoot = packetRoot,
            ButtonEnum = FindButtonEnum(schema),
            PacketEnum = FindPacketEnum(schema),
        };
        ValidateGeneratedIdentifiers(model);
        return model;
    }

    internal static int ComputeProtocolVersion(ProtoSchema schema)
    {
        var signature = new StringBuilder("fw.bridge.protocol.v1\n");
        signature.Append("package|").Append(schema.Package).Append('\n');

        foreach (var protoEnum in schema.Enums.Values.OrderBy(item => item.Name, StringComparer.Ordinal))
        {
            signature.Append("enum|")
                .Append(SourceRole(protoEnum.SourcePath)).Append('|')
                .Append(protoEnum.Name).Append('\n');
            foreach (var value in protoEnum.Values
                .OrderBy(item => item.Number)
                .ThenBy(item => item.Name, StringComparer.Ordinal))
            {
                signature.Append("value|")
                    .Append(value.Number).Append('|')
                    .Append(value.Name).Append('\n');
            }
        }

        foreach (var message in schema.Messages.Values.OrderBy(item => item.Name, StringComparer.Ordinal))
        {
            signature.Append("message|")
                .Append(SourceRole(message.SourcePath)).Append('|')
                .Append(message.Name).Append('\n');
            foreach (var field in message.Fields
                .OrderBy(item => item.Number)
                .ThenBy(item => item.Name, StringComparer.Ordinal))
            {
                signature.Append("field|")
                    .Append(field.Number).Append('|')
                    .Append(field.Name).Append('|')
                    .Append(field.Type).Append('|')
                    .Append(field.IsRepeated ? '1' : '0').Append('|')
                    .Append(field.OneofGroup).Append('\n');
            }
        }

        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(signature.ToString()));
        int version = ((digest[0] & 0x7f) << 24)
            | (digest[1] << 16)
            | (digest[2] << 8)
            | digest[3];
        return version == 0 ? 1 : version;
    }

    private static string SourceRole(string path)
    {
        return (Path.GetFileName(path) ?? "").ToLowerInvariant();
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

    private static void ValidateGeneratedIdentifiers(BridgeModel model)
    {
        var schema = model.Schema;

        ValidateFieldConstants(model);
        ValidateEnumConstants(model);
        ValidateTopLevelTypes(model);
        ValidateIntentMembers(model, model.IntentRoot, model.ActionRoot, model.ButtonEnum);
        ValidateEventMembers(model, model.EventRoot);
        ValidateGdWrappers(model);
    }

    private static void ValidateFieldConstants(BridgeModel model)
    {
        var names = new List<(string Source, string Identifier)>
        {
            ("generated BridgeField type", "BridgeField"),
        };
        names.AddRange(model.FieldNames
            .Select(name => (name, Pascal(name))));
        TextUtil.ValidateGeneratedNames("bridge field constant", names);
    }

    private static void ValidateEnumConstants(BridgeModel model)
    {
        foreach (var protoEnum in model.ValueEnums)
        {
            var className = BridgeEnumClass(protoEnum.Name);
            TextUtil.ValidateGeneratedNames(
                $"bridge enum `{protoEnum.Name}`",
                protoEnum.Values.Where(item => item.Number != 0)
                    .Select(item => (item.Name, Pascal(EnumTail(item.Name))))
                    .Prepend(($"generated {className} type", className))
            );
        }
        if (model.ButtonEnum != null)
        {
            TextUtil.ValidateGeneratedNames(
                $"bridge button enum `{model.ButtonEnum.Name}`",
                model.ButtonEnum.Values.Where(item => item.Number != 0)
                    .Select(item => (item.Name, Pascal(EnumTail(item.Name))))
                    .Prepend(("generated BridgeButton type", "BridgeButton"))
            );
        }
        if (model.PacketEnum != null)
        {
            TextUtil.ValidateGeneratedNames(
                $"bridge packet enum `{model.PacketEnum.Name}`",
                model.PacketEnum.Values.Where(item => item.Number != 0)
                    .Select(item => (item.Name, Pascal(PacketValueName(item.Name))))
                    .Prepend(("generated BridgePacketType type", "BridgePacketType"))
            );
        }
    }

    private static void ValidateTopLevelTypes(BridgeModel model)
    {
        var schema = model.Schema;
        var names = new List<(string Source, string Identifier)>
        {
            ("generated BridgeField", "BridgeField"),
            ("generated BridgePacketType", "BridgePacketType"),
        };
        names.AddRange(model.ValueEnums
            .Select(item => ($"value enum {item.Name}", BridgeEnumClass(item.Name))));
        if (model.ButtonEnum != null)
        {
            names.Add(($"button enum {model.ButtonEnum.Name}", "BridgeButton"));
        }
        if (model.IntentRoot != null)
        {
            names.Add(($"intent root {model.IntentRoot.Name}", model.IntentRoot.Name));
        }
        if (model.ActionRoot != null)
        {
            names.Add(($"action root {model.ActionRoot.Name}", model.ActionRoot.Name));
            foreach (var variant in model.ActionRoot.Fields.Where(item => item.IsOneof))
            {
                if (schema.Messages.TryGetValue(variant.Type, out var payload))
                {
                    names.Add(($"action variant {variant.Name}", payload.Name));
                }
            }
        }
        if (model.EventRoot != null)
        {
            names.Add(("generated CoreEvent", RuntimeEventType(model.EventRoot)));
            foreach (var variant in model.EventRoot.Fields.Where(item => item.IsOneof))
            {
                if (schema.Messages.TryGetValue(variant.Type, out var payload))
                {
                    names.Add(($"event variant {variant.Name}", payload.Name));
                }
            }
        }
        TextUtil.ValidateGeneratedNames("bridge C# type", names);
    }

    private static void ValidateIntentMembers(
        BridgeModel model,
        ProtoMessage? intentRoot,
        ProtoMessage? actionRoot,
        ProtoEnum? buttonEnum
    )
    {
        var schema = model.Schema;
        if (actionRoot != null)
        {
            var actionMembers = new List<(string Source, string Identifier)>
            {
                ("enclosing action type", actionRoot.Name),
                ("generated Kind property", "Kind"),
                ("generated Payload property", "Payload"),
                ("generated As method", "As"),
            };
            actionMembers.AddRange(actionRoot.Fields.Where(item => item.IsOneof)
                .Select(item => ($"variant {item.Name}", Pascal(item.Name))));
            actionMembers.AddRange(model.ActionFields
                .Select(item => ($"payload field {item.Name}", Pascal(item.Name))));
            TextUtil.ValidateGeneratedNames($"bridge action `{actionRoot.Name}` member", actionMembers);

            foreach (var variant in actionRoot.Fields.Where(item => item.IsOneof))
            {
                if (schema.Messages.TryGetValue(variant.Type, out var payload))
                {
                    ValidateMessageMembers(payload, $"bridge action payload `{payload.Name}`");
                }
            }
        }

        if (intentRoot == null)
        {
            return;
        }
        var intentMembers = intentRoot.Fields.Where(item => !item.IsOneof)
            .Select(item => ($"field {item.Name}", IntentPropertyName(item)))
            .ToList();
        intentMembers.Add(("enclosing intent type", intentRoot.Name));
        if (buttonEnum != null)
        {
            intentMembers.AddRange(buttonEnum.Values.Where(item => item.Number != 0)
                .Select(item => ($"button {item.Name}", "Btn" + Pascal(EnumTail(item.Name)))));
        }
        var properties = intentRoot.Fields.Where(item => !item.IsOneof)
            .Select(IntentPropertyName)
            .ToHashSet(StringComparer.Ordinal);
        if (properties.Contains("Hold") && properties.Contains("Down") && properties.Contains("Up"))
        {
            intentMembers.Add(("generated IsHold method", "IsHold"));
            intentMembers.Add(("generated IsDown method", "IsDown"));
            intentMembers.Add(("generated IsUp method", "IsUp"));
        }
        TextUtil.ValidateGeneratedNames($"bridge intent `{intentRoot.Name}` member", intentMembers);
    }

    private static void ValidateEventMembers(BridgeModel model, ProtoMessage? eventRoot)
    {
        var schema = model.Schema;
        if (eventRoot == null)
        {
            return;
        }
        var eventMembers = new List<(string Source, string Identifier)>
        {
            ("enclosing event type", RuntimeEventType(eventRoot)),
            ("generated Type property", "Type"),
            ("generated Payload property", "Payload"),
            ("generated As method", "As"),
        };
        eventMembers.AddRange(eventRoot.Fields.Where(item => item.IsOneof)
            .Select(item => ($"variant {item.Name}", ClassNameForEvent(item.Type))));
        eventMembers.AddRange(model.EventFields
            .Select(item => ($"payload field {item.Name}", Pascal(item.Name))));
        TextUtil.ValidateGeneratedNames($"bridge event `{eventRoot.Name}` member", eventMembers);

        foreach (var variant in eventRoot.Fields.Where(item => item.IsOneof))
        {
            if (schema.Messages.TryGetValue(variant.Type, out var payload))
            {
                ValidateMessageMembers(payload, $"bridge event payload `{payload.Name}`");
            }
        }
    }

    private static void ValidateMessageMembers(ProtoMessage message, string label)
    {
        TextUtil.ValidateGeneratedNames(
            label + " member",
            message.Fields.Select(item => ($"field {item.Name}", Pascal(item.Name)))
                .Prepend(("enclosing type", message.Name))
        );
    }

    private static void ValidateGdWrappers(BridgeModel model)
    {
        var schema = model.Schema;
        TextUtil.ValidateGeneratedNames(
            "bridge GDScript view type",
            model.ViewMessages.Select(item => (item.Name, ClassNameForView(item.Name)))
        );
        foreach (var message in model.ViewMessages)
        {
            ValidateGdWrapperMembers(schema, message, $"bridge view `{message.Name}`");
        }

        if (model.EventRoot == null)
        {
            return;
        }
        var eventTypes = new List<(string Source, string Identifier)> { ("generated Bus", "Bus") };
        foreach (var variant in model.EventRoot.Fields.Where(item => item.IsOneof))
        {
            eventTypes.Add(($"variant {variant.Name}", ClassNameForEvent(variant.Type)));
            if (schema.Messages.TryGetValue(variant.Type, out var message))
            {
                ValidateGdWrapperMembers(schema, message, $"bridge event `{message.Name}`");
            }
        }
        TextUtil.ValidateGeneratedNames("bridge GDScript event type", eventTypes);
    }

    private static void ValidateGdWrapperMembers(ProtoSchema schema, ProtoMessage message, string label)
    {
        var names = new List<(string Source, string Identifier)>
        {
            ("generated wrap method", "wrap"),
            ("generated raw method", "raw"),
        };
        names.AddRange(message.Fields.Select(item => ($"field {item.Name}", item.Name)));
        names.AddRange(message.Fields
            .Where(item => item.IsRepeated && !IsIntLike(item.Type) && schema.Messages.ContainsKey(item.Type))
            .Select(item => ($"field {item.Name} wrapper", item.Name + "_wrapped")));
        TextUtil.ValidateGeneratedNames(label + " GDScript member", names);
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

    private static ProtoMessage? FindActionRoot(ProtoSchema schema, ProtoMessage? intentRoot)
    {
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

    internal static string PacketValueName(string value)
    {
        return value.StartsWith("PACKET_TYPE_", StringComparison.Ordinal)
            ? value["PACKET_TYPE_".Length..].ToLowerInvariant()
            : EnumTail(value);
    }

    internal static string Pascal(string value)
    {
        return TextUtil.SchemaPascal(value);
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
