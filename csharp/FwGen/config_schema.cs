static partial class ConfigGen
{
    private static ConfigRoot[] ConfigRoots(string root, FwConfig config, ProtoSchema schema)
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

    private static bool IsMessageType(string type, ProtoSchema schema)
    {
        return schema.Messages.ContainsKey(type);
    }

    private static bool IsConfigMessage(string type)
    {
        return type.EndsWith("Config", StringComparison.Ordinal);
    }

    private static string ConfigRootName(string type)
    {
        return TextUtil.Snake(type[..^"Config".Length]);
    }

    private static string ConfigClassName(string type)
    {
        return type == "GameConfig" ? "CoreConfig" : type;
    }

    private static string ResourcePath(string root, string fullPath)
    {
        var relative = Path.GetRelativePath(root, fullPath).Replace('\\', '/');
        return $"res://{relative}";
    }

    private sealed record ConfigRoot(
        string Name,
        ProtoMessage Message,
        bool IsJson,
        string SourcePath,
        string PackPath
    );
}
