using System.Security.Cryptography;
using System.Text;

static class ConfigSchema
{
    internal static ProtoSchema Read(string schemaDir)
    {
        var schema = ProtoSchema.ParseFiles(Directory.Exists(schemaDir)
            ? Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal)
            : []);
        ValidateFixed32(schema);
        ValidateSupportedTypes(schema);
        ValidateGeneratedIdentifiers(schema);
        return schema;
    }

    internal static string Hash(string schemaDir)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var path in Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal))
        {
            var relative = Path.GetRelativePath(schemaDir, path).Replace('\\', '/');
            var text = File.ReadAllText(path, Encoding.UTF8).Replace("\r\n", "\n").Replace('\r', '\n');
            hash.AppendData(Encoding.UTF8.GetBytes(relative + "\n"));
            hash.AppendData(Encoding.UTF8.GetBytes(text));
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    internal static ConfigRoot[] ConfigRoots(string root, FwConfig config, ProtoSchema schema)
    {
        var dataDir = config.ConfigDataDir(root);
        var packDir = config.ConfigPackDir(root);
        return schema.Messages.Values
            .Where(item => item.Name.EndsWith("Config", StringComparison.Ordinal))
            .Select(item =>
            {
                var rootName = TextUtil.Snake(item.Name[..^"Config".Length]);
                var isJson = File.Exists(Path.Combine(dataDir, $"{rootName}.json"));
                var sourcePath = ResourcePath(root, Path.Combine(dataDir, isJson ? $"{rootName}.json" : $"{rootName}.csv.txt"));
                var packPath = ResourcePath(root, Path.Combine(packDir, $"{rootName}.bin"));
                return new ConfigRoot(rootName, item, isJson, sourcePath, packPath);
            })
            .OrderBy(item => item.Name, StringComparer.Ordinal)
            .ToArray();
    }

    internal static bool IsMessageType(string type, ProtoSchema schema)
    {
        return schema.Messages.ContainsKey(type);
    }

    internal static bool IsConfigMessage(string type)
    {
        return type.EndsWith("Config", StringComparison.Ordinal);
    }

    internal static string ConfigRootName(string type)
    {
        return TextUtil.Snake(type[..^"Config".Length]);
    }

    internal static string ConfigClassName(string type)
    {
        return type == "GameConfig" ? "CoreConfig" : type;
    }

    internal static string ResourcePath(string root, string fullPath)
    {
        var relative = Path.GetRelativePath(root, fullPath).Replace('\\', '/');
        return $"res://{relative}";
    }

    internal static void ValidateFixed32(ProtoSchema schema)
    {
        if (schema.Messages.TryGetValue("Fixed32", out var marker) && marker.Fields.Count != 0)
        {
            throw new InvalidOperationException("Fixed32 is a reserved empty marker for signed Q24.8 config values");
        }
    }

    private static void ValidateSupportedTypes(ProtoSchema schema)
    {
        foreach (var message in schema.Messages.Values)
        {
            foreach (var field in message.Fields)
            {
                if (schema.Enums.ContainsKey(field.Type))
                {
                    throw new InvalidOperationException(
                        $"{message.SourcePath}:{field.LineNo} config field `{message.Name}.{field.Name}` uses enum `{field.Type}`; config enums are not supported"
                    );
                }
                if (ProtoSchema.IsPortableScalar(field.Type) || schema.Messages.ContainsKey(field.Type))
                {
                    continue;
                }
                throw new InvalidOperationException(
                    $"{message.SourcePath}:{field.LineNo} config field `{message.Name}.{field.Name}` uses unsupported scalar `{field.Type}`"
                );
            }
        }
    }

    private static void ValidateGeneratedIdentifiers(ProtoSchema schema)
    {
        var messages = schema.Messages.Values
            .Where(item => item.Name != "Fixed32")
            .ToArray();

        ValidateCsTypes(messages);
        ValidateFieldConstants(schema);
        ValidateMessageMembers(messages);
        ValidateConfigRoots(messages);
        ValidateGdParsers(messages);
    }

    private static void ValidateCsTypes(IEnumerable<ProtoMessage> messages)
    {
        var names = new List<(string Source, string Identifier)>
        {
            ("generated ConfigField", "ConfigField"),
            ("generated ConfigPath", "ConfigPath"),
            ("generated ConfigCodec", "ConfigCodec"),
        };
        names.AddRange(messages.Select(item => ($"message {item.Name}", ConfigClassName(item.Name))));
        TextUtil.ValidateGeneratedNames("config C# type", names);
    }

    private static void ValidateFieldConstants(ProtoSchema schema)
    {
        var names = new List<(string Source, string Identifier)>
        {
            ("generated ConfigField type", "ConfigField"),
        };
        names.AddRange(schema.Messages.Values
            .SelectMany(message => message.Fields)
            .Select(field => field.Name)
            .Append("key")
            .Distinct(StringComparer.Ordinal)
            .Select(name => (name, TextUtil.SchemaPascal(name))));
        TextUtil.ValidateGeneratedNames("config field constant", names);
    }

    private static void ValidateMessageMembers(IEnumerable<ProtoMessage> messages)
    {
        foreach (var message in messages)
        {
            TextUtil.ValidateGeneratedNames(
                $"config message `{message.Name}` member",
                message.Fields.Select(item => (item.Name, TextUtil.SchemaPascal(item.Name)))
                    .Prepend(("enclosing type", ConfigClassName(message.Name)))
            );
        }
    }

    private static void ValidateConfigRoots(IEnumerable<ProtoMessage> messages)
    {
        var roots = messages
            .Where(item => item.Name.EndsWith("Config", StringComparison.Ordinal))
            .Select(item => (Source: item.Name, Name: TextUtil.Snake(item.Name[..^"Config".Length])))
            .ToArray();
        TextUtil.ValidateGeneratedNames(
            "config root",
            roots.Select(item => (item.Source, item.Name))
        );

        var pathMembers = new List<(string Source, string Identifier)>
        {
            ("generated AllSourcePaths", "AllSourcePaths"),
            ("generated AllPackPaths", "AllPackPaths"),
        };
        foreach (var root in roots)
        {
            var identifier = TextUtil.SchemaPascal(root.Name);
            pathMembers.Add(($"root {root.Source} source", identifier + "Source"));
            pathMembers.Add(($"root {root.Source} pack", identifier + "Pack"));
        }
        TextUtil.ValidateGeneratedNames("config path member", pathMembers);
    }

    private static void ValidateGdParsers(IEnumerable<ProtoMessage> messages)
    {
        var names = new List<(string Source, string Identifier)>
        {
            ("generated scalar int parser", "int"),
            ("generated scalar bool parser", "bool"),
            ("generated scalar fixed parser", "fixed"),
            ("generated scalar float parser", "float"),
            ("generated scalar string parser", "string"),
            ("generated scalar array parser", "array"),
        };
        names.AddRange(messages.Select(item => ($"message {item.Name}", TextUtil.Snake(item.Name))));
        TextUtil.ValidateGeneratedNames("config GDScript parser", names);
    }

    internal sealed record ConfigRoot(
        string Name,
        ProtoMessage Message,
        bool IsJson,
        string SourcePath,
        string PackPath
    );
}
