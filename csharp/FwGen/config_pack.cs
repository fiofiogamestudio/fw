using Fw.Rt.Config;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

static partial class ConfigGen
{
    public static void Check(string root, FwConfig config)
    {
        var schemaDir = config.ConfigSchemaDir(root);
        var dataDir = config.ConfigDataDir(root);
        if (!Directory.Exists(schemaDir))
        {
            throw new DirectoryNotFoundException($"config schema dir not found: {schemaDir}");
        }
        if (!Directory.Exists(dataDir))
        {
            throw new DirectoryNotFoundException($"config data dir not found: {dataDir}");
        }

        var schema = ProtoSchema.ParseFiles(Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal));
        ValidateFixed32(schema);
        var roots = schema.Messages.Values
            .Where(item => item.Name.EndsWith("Config", StringComparison.Ordinal))
            .OrderBy(item => item.Name, StringComparer.Ordinal)
            .ToArray();
        if (roots.Length == 0)
        {
            throw new InvalidOperationException($"config schema has no *Config messages: {schemaDir}");
        }

        var packedByType = new Dictionary<string, List<Dictionary<string, object?>>>(StringComparer.Ordinal);
        foreach (var message in roots)
        {
            CheckConfigData(dataDir, message);
            var rootName = TextUtil.Snake(message.Name[..^"Config".Length]);
            packedByType[message.Name] = PackConfigData(dataDir, schema, message, rootName);
        }

        var keysByType = packedByType.ToDictionary(
            pair => pair.Key,
            pair => pair.Value.Select(entry => (string)entry["key"]!).ToHashSet(StringComparer.Ordinal),
            StringComparer.Ordinal
        );
        foreach (var message in roots)
        {
            foreach (var entry in packedByType[message.Name])
            {
                ValidatePackedMessage(
                    entry["value"],
                    schema,
                    message,
                    keysByType,
                    $"{message.Name}[{entry["key"]}]"
                );
            }
        }

        Console.WriteLine($"config check ok: {schemaDir}, {dataDir}");
    }

    public static void Pack(string root, FwConfig config)
    {
        Check(root, config);
        var schemaDir = config.ConfigSchemaDir(root);
        var dataDir = config.ConfigDataDir(root);
        var packDir = config.ConfigPackDir(root);
        if (!Directory.Exists(schemaDir))
        {
            throw new DirectoryNotFoundException($"config schema dir not found: {schemaDir}");
        }
        if (!Directory.Exists(dataDir))
        {
            throw new DirectoryNotFoundException($"config data dir not found: {dataDir}");
        }

        var schema = ProtoSchema.ParseFiles(Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal));
        ValidateFixed32(schema);
        var schemaHash = Convert.FromHexString(SchemaHash(schemaDir));
        var roots = schema.Messages.Values
            .Where(item => item.Name.EndsWith("Config", StringComparison.Ordinal))
            .Where(item => item.Name != "GameConfig" || HasConfigData(dataDir, "game"))
            .OrderBy(item => TextUtil.Snake(item.Name[..^"Config".Length]), StringComparer.Ordinal)
            .ToArray();
        if (roots.Length == 0)
        {
            throw new InvalidOperationException($"config schema has no packable *Config messages: {schemaDir}");
        }

        Directory.CreateDirectory(packDir);
        foreach (var message in roots)
        {
            var rootName = TextUtil.Snake(message.Name[..^"Config".Length]);
            var entries = PackConfigData(dataDir, schema, message, rootName);
            var output = Path.Combine(packDir, $"{rootName}.bin");
            WriteConfigPack(output, entries, schemaHash);
            Console.WriteLine($"packed config {rootName}: {output}");
        }
    }

    private static bool HasConfigData(string dataDir, string rootName)
    {
        return File.Exists(Path.Combine(dataDir, $"{rootName}.csv.txt"))
            || File.Exists(Path.Combine(dataDir, $"{rootName}.json"));
    }

    private static List<Dictionary<string, object?>> PackConfigData(
        string dataDir,
        ProtoSchema schema,
        ProtoMessage message,
        string rootName
    )
    {
        var jsonPath = Path.Combine(dataDir, $"{rootName}.json");
        if (File.Exists(jsonPath))
        {
            return PackJsonConfig(jsonPath, schema, message, rootName);
        }

        var csvPath = Path.Combine(dataDir, $"{rootName}.csv.txt");
        if (File.Exists(csvPath))
        {
            return PackCsvConfig(csvPath, schema, message, rootName);
        }

        throw new FileNotFoundException($"missing config data for {message.Name}: {csvPath} or {jsonPath}");
    }

    private static List<Dictionary<string, object?>> PackCsvConfig(
        string path,
        ProtoSchema schema,
        ProtoMessage message,
        string rootName
    )
    {
        var lines = File.ReadAllLines(path, Encoding.UTF8)
            .Select(item => item.Trim())
            .Where(item => item.Length > 0)
            .ToArray();
        if (lines.Length == 0)
        {
            throw new InvalidOperationException($"{rootName} config is empty: {path}");
        }

        var headers = SplitCsvLine(lines[0]);
        var entries = new List<Dictionary<string, object?>>();
        for (var lineIndex = 1; lineIndex < lines.Length; lineIndex++)
        {
            var values = SplitCsvLine(lines[lineIndex]);
            var row = new Dictionary<string, string>(StringComparer.Ordinal);
            for (var index = 0; index < Math.Min(headers.Length, values.Length); index++)
            {
                row[headers[index]] = values[index];
            }

            if (!row.TryGetValue("key", out var key) || string.IsNullOrEmpty(key))
            {
                throw new InvalidOperationException($"{rootName} config missing key at line {lineIndex + 1}: {path}");
            }

            entries.Add(new Dictionary<string, object?>
            {
                ["key"] = key,
                ["value"] = PackCsvMessage(row, schema, message, rootName),
            });
        }

        return entries;
    }

    private static Dictionary<string, object?> PackCsvMessage(
        IReadOnlyDictionary<string, string> row,
        ProtoSchema schema,
        ProtoMessage message,
        string ctx
    )
    {
        var value = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var field in message.Fields)
        {
            if (!row.TryGetValue(field.Name, out var raw) || string.IsNullOrWhiteSpace(raw))
            {
                continue;
            }
            if (field.IsRepeated)
            {
                throw new InvalidOperationException($"{ctx}.{field.Name} repeated field cannot be packed from csv text");
            }
            value[field.Name] = PackScalarOrReference(raw, schema, field);
        }
        return value;
    }

    private static List<Dictionary<string, object?>> PackJsonConfig(
        string path,
        ProtoSchema schema,
        ProtoMessage message,
        string rootName
    )
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException($"{rootName} config must be a json array: {path}");
        }

        var entries = new List<Dictionary<string, object?>>();
        var index = 0;
        foreach (var item in document.RootElement.EnumerateArray())
        {
            var ctx = $"{rootName}[{index}]";
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException($"{ctx} config item must be object: {path}");
            }
            if (!item.TryGetProperty("key", out var keyElement))
            {
                throw new InvalidOperationException($"{ctx} config item missing key: {path}");
            }

            entries.Add(new Dictionary<string, object?>
            {
                ["key"] = PackJsonScalar(keyElement, "string", $"{ctx}.key"),
                ["value"] = PackJsonMessage(item, schema, message, ctx),
            });
            index++;
        }

        return entries;
    }

    private static Dictionary<string, object?> PackJsonMessage(
        JsonElement source,
        ProtoSchema schema,
        ProtoMessage message,
        string ctx
    )
    {
        var value = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var field in message.Fields)
        {
            if (!source.TryGetProperty(field.Name, out var item))
            {
                continue;
            }
            value[field.Name] = PackJsonField(item, schema, field, $"{ctx}.{field.Name}");
        }
        return value;
    }

    private static object? PackJsonField(JsonElement item, ProtoSchema schema, ProtoField field, string ctx)
    {
        if (field.IsRepeated)
        {
            if (item.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidOperationException($"{ctx} must be array");
            }
            var values = new List<object?>();
            foreach (var child in item.EnumerateArray())
            {
                values.Add(PackJsonItem(child, schema, field.Type, ctx));
            }
            return values;
        }

        return PackJsonItem(item, schema, field.Type, ctx);
    }

    private static object? PackJsonItem(JsonElement item, ProtoSchema schema, string type, string ctx)
    {
        if (schema.Messages.TryGetValue(type, out var message) && type != "Fixed32")
        {
            if (item.ValueKind == JsonValueKind.String)
            {
                return item.GetString() ?? "";
            }
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException($"{ctx} must be object or config key");
            }
            return PackJsonMessage(item, schema, message, ctx);
        }

        return PackJsonScalar(item, type, ctx);
    }

    private static object? PackScalarOrReference(string raw, ProtoSchema schema, ProtoField field)
    {
        if (schema.Messages.ContainsKey(field.Type) && field.Type != "Fixed32")
        {
            return raw;
        }
        return PackStringScalar(raw, field.Type);
    }

    private static object? PackJsonScalar(JsonElement item, string type, string ctx)
    {
        return type switch
        {
            "string" => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : item.ToString(),
            "bool" => item.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                JsonValueKind.String => PackStringBool(item.GetString() ?? "", ctx),
                _ => throw new InvalidOperationException($"{ctx} must be bool"),
            },
            "float" or "double" => PackJsonDouble(item, ctx),
            "Fixed32" => PackFixed(PackJsonDouble(item, ctx)),
            "uint64" => item.ValueKind == JsonValueKind.String
                ? ulong.Parse(item.GetString() ?? "0", CultureInfo.InvariantCulture)
                : item.GetUInt64(),
            "uint32" => item.ValueKind == JsonValueKind.String
                ? int.Parse(item.GetString() ?? "0", CultureInfo.InvariantCulture)
                : item.GetInt32(),
            "int64" or "sint64" => item.ValueKind == JsonValueKind.String
                ? long.Parse(item.GetString() ?? "0", CultureInfo.InvariantCulture)
                : item.GetInt64(),
            "int32" or "sint32" => item.ValueKind == JsonValueKind.String
                ? int.Parse(item.GetString() ?? "0", CultureInfo.InvariantCulture)
                : item.GetInt32(),
            _ => item.ValueKind == JsonValueKind.String ? item.GetString() ?? "" : item.ToString(),
        };
    }

    private static object? PackStringScalar(string raw, string type)
    {
        return type switch
        {
            "string" => raw,
            "bool" => PackStringBool(raw, type),
            "float" or "double" => double.Parse(raw, CultureInfo.InvariantCulture),
            "Fixed32" => PackFixed(double.Parse(raw, CultureInfo.InvariantCulture)),
            "uint64" => ulong.Parse(raw, CultureInfo.InvariantCulture),
            "uint32" => int.Parse(raw, CultureInfo.InvariantCulture),
            "int64" or "sint64" => long.Parse(raw, CultureInfo.InvariantCulture),
            "int32" or "sint32" => int.Parse(raw, CultureInfo.InvariantCulture),
            _ => raw,
        };
    }

    private static bool PackStringBool(string raw, string ctx)
    {
        return raw.Trim().ToLowerInvariant() switch
        {
            "1" or "true" or "yes" => true,
            "0" or "false" or "no" => false,
            _ => throw new InvalidOperationException($"{ctx} must be bool-compatible text"),
        };
    }

    private static double PackJsonDouble(JsonElement item, string ctx)
    {
        return item.ValueKind == JsonValueKind.String
            ? double.Parse(item.GetString() ?? "0", CultureInfo.InvariantCulture)
            : item.ValueKind == JsonValueKind.Number
                ? item.GetDouble()
                : throw new InvalidOperationException($"{ctx} must be numeric");
    }

    private static int PackFixed(double value)
    {
        var scaled = Math.Round(value * 256.0, MidpointRounding.AwayFromZero);
        if (!double.IsFinite(scaled) || scaled < int.MinValue || scaled > int.MaxValue)
        {
            throw new OverflowException($"Fixed32 value is outside Q24.8 range: {value}");
        }
        return (int)scaled;
    }

    private static void ValidateFixed32(ProtoSchema schema)
    {
        if (schema.Messages.TryGetValue("Fixed32", out var marker) && marker.Fields.Count != 0)
        {
            throw new InvalidOperationException("Fixed32 is a reserved empty marker for signed Q24.8 config values");
        }
    }

    private static void WriteConfigPack(string output, object entries, byte[] schemaHash)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(output) ?? ".");
        var payload = JsonSerializer.SerializeToUtf8Bytes(entries);
        byte[] outputBytes = ConfigPack.Encode(payload, schemaHash);

        var temp = output + $".tmp.{Guid.NewGuid():N}";
        try
        {
            File.WriteAllBytes(temp, outputBytes);
            File.Move(temp, output, true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    private static string SchemaHash(string schemaDir)
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

    private static void CheckConfigData(string dataDir, ProtoMessage message)
    {
        var rootName = TextUtil.Snake(message.Name[..^"Config".Length]);
        var csvPath = Path.Combine(dataDir, $"{rootName}.csv.txt");
        var jsonPath = Path.Combine(dataDir, $"{rootName}.json");
        if (File.Exists(jsonPath))
        {
            CheckJsonConfig(jsonPath, message, rootName);
            return;
        }
        if (File.Exists(csvPath))
        {
            CheckCsvConfig(csvPath, message, rootName);
            return;
        }

        throw new FileNotFoundException($"missing config data for {message.Name}: {csvPath} or {jsonPath}");
    }

    private static void CheckCsvConfig(string path, ProtoMessage message, string rootName)
    {
        var lines = File.ReadAllLines(path, Encoding.UTF8)
            .Select(item => item.Trim())
            .Where(item => item.Length > 0)
            .ToArray();
        if (lines.Length == 0)
        {
            throw new InvalidOperationException($"{rootName} config is empty: {path}");
        }

        var headers = SplitCsvLine(lines[0]);
        var headerSet = new HashSet<string>(headers, StringComparer.Ordinal);
        if (headerSet.Count != headers.Length)
        {
            throw new InvalidOperationException($"{rootName} config has duplicate columns: {path}");
        }
        if (!headerSet.Contains("key"))
        {
            throw new InvalidOperationException($"{rootName} config missing key column: {path}");
        }

        var allowedFields = message.Fields.Select(item => item.Name)
            .Append("key")
            .ToHashSet(StringComparer.Ordinal);
        foreach (var header in headers)
        {
            if (!allowedFields.Contains(header))
            {
                throw new InvalidOperationException($"{rootName} config unknown column {header}: {path}");
            }
        }

        foreach (var field in message.Fields)
        {
            if (!headerSet.Contains(field.Name))
            {
                throw new InvalidOperationException($"{rootName} config missing column {field.Name}: {path}");
            }
        }

        var keyIndex = Array.IndexOf(headers, "key");
        var hasDefault = false;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        for (var lineIndex = 1; lineIndex < lines.Length; lineIndex++)
        {
            var values = SplitCsvLine(lines[lineIndex]);
            if (values.Length != headers.Length)
            {
                throw new InvalidOperationException($"{rootName} config line {lineIndex + 1} has {values.Length} cells; expected {headers.Length}: {path}");
            }
            string key = values[keyIndex];
            if (string.IsNullOrWhiteSpace(key))
            {
                throw new InvalidOperationException($"{rootName} config has empty key at line {lineIndex + 1}: {path}");
            }
            if (!keys.Add(key))
            {
                throw new InvalidOperationException($"{rootName} config has duplicate key `{key}`: {path}");
            }
            if (key == "default")
            {
                hasDefault = true;
            }
        }
        if (!hasDefault)
        {
            throw new InvalidOperationException($"{rootName} config missing default row: {path}");
        }
    }

    private static void CheckJsonConfig(string path, ProtoMessage message, string rootName)
    {
        using var document = JsonDocument.Parse(File.ReadAllText(path, Encoding.UTF8));
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException($"{rootName} config must be a json array: {path}");
        }

        var allowedFields = message.Fields.Select(item => item.Name)
            .Append("key")
            .ToHashSet(StringComparer.Ordinal);
        var hasDefault = false;
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in document.RootElement.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw new InvalidOperationException($"{rootName} config item must be object: {path}");
            }

            if (!item.TryGetProperty("key", out var key) || key.ValueKind != JsonValueKind.String)
            {
                throw new InvalidOperationException($"{rootName} config item requires a string key: {path}");
            }
            string keyText = key.GetString() ?? "";
            if (string.IsNullOrWhiteSpace(keyText))
            {
                throw new InvalidOperationException($"{rootName} config item has an empty key: {path}");
            }
            if (!keys.Add(keyText))
            {
                throw new InvalidOperationException($"{rootName} config has duplicate key `{keyText}`: {path}");
            }
            if (keyText == "default")
            {
                hasDefault = true;
            }

            foreach (var property in item.EnumerateObject())
            {
                if (!allowedFields.Contains(property.Name))
                {
                    throw new InvalidOperationException($"{rootName} config unknown field {property.Name}: {path}");
                }
            }
        }
        if (!hasDefault)
        {
            throw new InvalidOperationException($"{rootName} config missing default item: {path}");
        }
    }

    private static void ValidatePackedMessage(
        object? raw,
        ProtoSchema schema,
        ProtoMessage message,
        IReadOnlyDictionary<string, HashSet<string>> keysByType,
        string ctx
    )
    {
        if (raw is not IReadOnlyDictionary<string, object?> value)
        {
            throw new InvalidOperationException($"{ctx} must be an object");
        }
        foreach (var field in message.Fields)
        {
            if (!value.TryGetValue(field.Name, out object? fieldValue) || fieldValue == null)
            {
                continue;
            }
            if (field.IsRepeated)
            {
                if (fieldValue is not IEnumerable<object?> items)
                {
                    throw new InvalidOperationException($"{ctx}.{field.Name} must be an array");
                }
                var index = 0;
                foreach (object? item in items)
                {
                    ValidatePackedValue(item, schema, field.Type, keysByType, $"{ctx}.{field.Name}[{index}]");
                    index++;
                }
                continue;
            }
            ValidatePackedValue(fieldValue, schema, field.Type, keysByType, $"{ctx}.{field.Name}");
        }
    }

    private static void ValidatePackedValue(
        object? value,
        ProtoSchema schema,
        string type,
        IReadOnlyDictionary<string, HashSet<string>> keysByType,
        string ctx
    )
    {
        if (!schema.Messages.TryGetValue(type, out var nested) || type == "Fixed32")
        {
            return;
        }
        if (value is string key)
        {
            if (!keysByType.TryGetValue(type, out var keys) || !keys.Contains(key))
            {
                throw new InvalidOperationException($"{ctx} references missing {type} key `{key}`");
            }
            return;
        }
        ValidatePackedMessage(value, schema, nested, keysByType, ctx);
    }

    private static string[] SplitCsvLine(string line)
    {
        var values = new List<string>();
        var current = new StringBuilder();
        var inQuote = false;
        for (var index = 0; index < line.Length; index += 1)
        {
            var ch = line[index];
            if (ch == '"')
            {
                if (inQuote && index + 1 < line.Length && line[index + 1] == '"')
                {
                    current.Append('"');
                    index += 1;
                }
                else
                {
                    inQuote = !inQuote;
                }
                continue;
            }
            if (ch == ',' && !inQuote)
            {
                values.Add(NormalizeHeader(current.ToString(), values.Count));
                current.Clear();
                continue;
            }
            current.Append(ch);
        }
        if (inQuote)
        {
            throw new InvalidOperationException("CSV line has an unclosed quoted field");
        }
        values.Add(NormalizeHeader(current.ToString(), values.Count));
        return values.ToArray();
    }

    private static string NormalizeHeader(string value, int index)
    {
        return index == 0 && value.Length > 0 && value[0] == '\ufeff'
            ? value[1..]
            : value;
    }
}
