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

    internal sealed record ConfigRoot(
        string Name,
        ProtoMessage Message,
        bool IsJson,
        string SourcePath,
        string PackPath
    );
}
