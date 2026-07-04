using System.Text;
using System.Text.RegularExpressions;

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
                    AddEnum(schema, currentEnum);
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
                        AddEnum(schema, currentEnum);
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
                        AddMessage(schema, current);
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
                AddMessage(schema, current);
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

    private static void AddMessage(ProtoSchema schema, ProtoMessage message)
    {
        if (schema.Messages.TryGetValue(message.Name, out var existing))
        {
            throw new InvalidOperationException(
                $"duplicate proto message `{message.Name}`: {existing.SourcePath} and {message.SourcePath}"
            );
        }
        schema.Messages[message.Name] = message;
    }

    private static void AddEnum(ProtoSchema schema, ProtoEnum protoEnum)
    {
        if (schema.Enums.TryGetValue(protoEnum.Name, out var existing))
        {
            throw new InvalidOperationException(
                $"duplicate proto enum `{protoEnum.Name}`: {existing.SourcePath} and {protoEnum.SourcePath}"
            );
        }
        schema.Enums[protoEnum.Name] = protoEnum;
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
        File.WriteAllText(path, StripTrailingWhitespace(text), new UTF8Encoding(false));
    }

    private static string StripTrailingWhitespace(string text)
    {
        string normalized = text.Replace("\r\n", "\n");
        return string.Join("\n", normalized.Split('\n').Select(line => line.TrimEnd()));
    }
}
