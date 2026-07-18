using System.Text;
using System.Text.RegularExpressions;

sealed class ProtoSchema
{
    private static readonly HashSet<string> PortableScalarTypes = new(StringComparer.Ordinal)
    {
        "string",
        "bool",
        "float",
        "double",
        "int32",
        "int64",
        "uint32",
        "uint64",
        "sint32",
        "sint64",
    };

    private static readonly HashSet<string> ScalarTypes = new(StringComparer.Ordinal)
    {
        "double",
        "float",
        "int32",
        "int64",
        "uint32",
        "uint64",
        "sint32",
        "sint64",
        "fixed32",
        "fixed64",
        "sfixed32",
        "sfixed64",
        "bool",
        "string",
        "bytes",
    };

    public Dictionary<string, ProtoMessage> Messages { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, ProtoEnum> Enums { get; } = new(StringComparer.Ordinal);
    public string Package { get; private set; } = "";
    public HashSet<string> SourceFiles { get; } = new(StringComparer.Ordinal);

    public static bool IsPortableScalar(string type)
    {
        return PortableScalarTypes.Contains(type);
    }

    public static ProtoSchema ParseFiles(IEnumerable<string> files)
    {
        var schema = new ProtoSchema();
        var inputs = files.Select(Path.GetFullPath).Distinct(StringComparer.Ordinal)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();
        if (inputs.Length == 0)
        {
            throw new InvalidOperationException("proto schema file list is empty");
        }
        foreach (var file in inputs)
        {
            if (!File.Exists(file))
            {
                throw new FileNotFoundException($"proto schema not found: {file}");
            }
            schema.SourceFiles.Add(file);
        }
        foreach (var file in inputs)
        {
            ParseFile(schema, file);
        }
        ValidateTypes(schema);
        return schema;
    }

    private static void ParseFile(ProtoSchema schema, string path)
    {
        ProtoMessage? currentMessage = null;
        ProtoEnum? currentEnum = null;
        var oneofGroup = "";
        var sawSyntax = false;

        var lines = File.ReadAllLines(path, Encoding.UTF8);
        for (var index = 0; index < lines.Length; index++)
        {
            var lineNo = index + 1;
            var line = StripLineComment(lines[index]).Trim();
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

                var valueMatch = Regex.Match(
                    line,
                    @"^([A-Z_][A-Z0-9_]*)\s*=\s*(-?\d+)\s*;$",
                    RegexOptions.CultureInvariant
                );
                if (!valueMatch.Success)
                {
                    throw Error(path, lineNo, $"unsupported enum syntax `{line}`");
                }

                var name = valueMatch.Groups[1].Value;
                if (!int.TryParse(valueMatch.Groups[2].Value, out var number))
                {
                    throw Error(path, lineNo, $"invalid enum number `{valueMatch.Groups[2].Value}`");
                }
                if (currentEnum.Values.Any(item => item.Name == name))
                {
                    throw Error(path, lineNo, $"duplicate enum value `{name}` in `{currentEnum.Name}`");
                }
                if (currentEnum.Values.Any(item => item.Number == number))
                {
                    throw Error(path, lineNo, $"duplicate enum number `{number}` in `{currentEnum.Name}`");
                }
                currentEnum.Values.Add(new ProtoEnumValue(name, number, lineNo));
                continue;
            }

            if (currentMessage != null)
            {
                var oneofMatch = Regex.Match(
                    line,
                    @"^oneof\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$",
                    RegexOptions.CultureInvariant
                );
                if (oneofMatch.Success)
                {
                    if (oneofGroup.Length > 0)
                    {
                        throw Error(path, lineNo, "nested oneof is not supported");
                    }
                    oneofGroup = oneofMatch.Groups[1].Value;
                    continue;
                }

                if (line == "}")
                {
                    if (oneofGroup.Length > 0)
                    {
                        oneofGroup = "";
                        continue;
                    }
                    AddMessage(schema, currentMessage);
                    currentMessage = null;
                    continue;
                }

                var fieldMatch = Regex.Match(
                    line,
                    @"^(repeated\s+)?([A-Za-z_][A-Za-z0-9_]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(\d+)\s*;$",
                    RegexOptions.CultureInvariant
                );
                if (!fieldMatch.Success)
                {
                    throw Error(path, lineNo, $"unsupported message syntax `{line}`");
                }

                var repeated = fieldMatch.Groups[1].Success;
                var type = fieldMatch.Groups[2].Value;
                var name = fieldMatch.Groups[3].Value;
                if (!int.TryParse(fieldMatch.Groups[4].Value, out var number))
                {
                    throw Error(path, lineNo, $"invalid protobuf field number `{fieldMatch.Groups[4].Value}`");
                }
                if (oneofGroup.Length > 0 && repeated)
                {
                    throw Error(path, lineNo, "oneof fields cannot be repeated");
                }
                ValidateFieldNumber(path, lineNo, number);
                if (currentMessage.Fields.Any(item => item.Name == name))
                {
                    throw Error(path, lineNo, $"duplicate field `{name}` in message `{currentMessage.Name}`");
                }
                if (currentMessage.Fields.Any(item => item.Number == number))
                {
                    throw Error(path, lineNo, $"duplicate field number `{number}` in message `{currentMessage.Name}`");
                }
                currentMessage.Fields.Add(new ProtoField(name, type, repeated, oneofGroup, number, lineNo));
                continue;
            }

            var syntaxMatch = Regex.Match(line, "^syntax\\s*=\\s*\"(proto2|proto3)\"\\s*;$", RegexOptions.CultureInvariant);
            if (syntaxMatch.Success)
            {
                if (sawSyntax)
                {
                    throw Error(path, lineNo, "duplicate syntax declaration");
                }
                if (syntaxMatch.Groups[1].Value != "proto3")
                {
                    throw Error(path, lineNo, "fwgen only supports proto3 schema");
                }
                sawSyntax = true;
                continue;
            }

            var packageMatch = Regex.Match(
                line,
                @"^package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;$",
                RegexOptions.CultureInvariant
            );
            if (packageMatch.Success)
            {
                var package = packageMatch.Groups[1].Value;
                if (schema.Package.Length == 0)
                {
                    schema.Package = package;
                }
                else if (!string.Equals(schema.Package, package, StringComparison.Ordinal))
                {
                    throw Error(path, lineNo, $"package `{package}` does not match `{schema.Package}`");
                }
                continue;
            }

            var importMatch = Regex.Match(line, "^import\\s+\"([^\"]+)\"\\s*;$", RegexOptions.CultureInvariant);
            if (importMatch.Success)
            {
                ValidateImport(schema, path, lineNo, importMatch.Groups[1].Value);
                continue;
            }

            var emptyMessageMatch = Regex.Match(
                line,
                @"^message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*\}$",
                RegexOptions.CultureInvariant
            );
            if (emptyMessageMatch.Success)
            {
                AddMessage(schema, new ProtoMessage(emptyMessageMatch.Groups[1].Value, path, lineNo));
                continue;
            }

            var messageMatch = Regex.Match(
                line,
                @"^message\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$",
                RegexOptions.CultureInvariant
            );
            if (messageMatch.Success)
            {
                currentMessage = new ProtoMessage(messageMatch.Groups[1].Value, path, lineNo);
                continue;
            }

            var enumMatch = Regex.Match(
                line,
                @"^enum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{$",
                RegexOptions.CultureInvariant
            );
            if (enumMatch.Success)
            {
                currentEnum = new ProtoEnum(enumMatch.Groups[1].Value, path, lineNo);
                continue;
            }

            throw Error(path, lineNo, $"unsupported proto syntax `{line}`");
        }

        if (!sawSyntax)
        {
            throw new InvalidOperationException($"{path}: missing `syntax = \"proto3\";`");
        }
        if (oneofGroup.Length > 0)
        {
            throw new InvalidOperationException($"{path}: unclosed oneof block");
        }
        if (currentMessage != null)
        {
            throw new InvalidOperationException($"{path}:{currentMessage.LineNo} unclosed message `{currentMessage.Name}`");
        }
        if (currentEnum != null)
        {
            throw new InvalidOperationException($"{path}:{currentEnum.LineNo} unclosed enum `{currentEnum.Name}`");
        }
    }

    private static void ValidateImport(ProtoSchema schema, string sourcePath, int lineNo, string importPath)
    {
        var portable = importPath.Replace('\\', '/');
        if (
            Path.IsPathRooted(importPath)
            || portable.Split('/', StringSplitOptions.RemoveEmptyEntries).Any(segment => segment == "..")
        )
        {
            throw Error(sourcePath, lineNo, $"import `{importPath}` must stay inside the parsed schema root");
        }

        var normalized = portable.Replace('/', Path.DirectorySeparatorChar);
        var local = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(sourcePath) ?? ".", normalized));
        string suffix = "/" + portable.TrimStart('.', '/');
        string[] matches = schema.SourceFiles
            .Where(file => string.Equals(file, local, StringComparison.Ordinal)
                || file.Replace('\\', '/').EndsWith(suffix, StringComparison.Ordinal))
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (matches.Length == 0)
        {
            throw Error(sourcePath, lineNo, $"import `{importPath}` is not part of the parsed schema set");
        }
        if (matches.Length > 1)
        {
            throw Error(sourcePath, lineNo, $"import `{importPath}` is ambiguous in the parsed schema set");
        }
    }

    private static void ValidateFieldNumber(string path, int lineNo, int number)
    {
        if (number <= 0 || number > 536_870_911 || number is >= 19_000 and <= 19_999)
        {
            throw Error(path, lineNo, $"invalid protobuf field number `{number}`");
        }
    }

    private static void ValidateTypes(ProtoSchema schema)
    {
        foreach (var message in schema.Messages.Values)
        {
            foreach (var field in message.Fields)
            {
                if (ScalarTypes.Contains(field.Type)
                    || schema.Messages.ContainsKey(field.Type)
                    || schema.Enums.ContainsKey(field.Type))
                {
                    continue;
                }
                throw new InvalidOperationException(
                    $"{message.SourcePath}:{field.LineNo} field `{message.Name}.{field.Name}` uses unknown type `{field.Type}`"
                );
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
        if (schema.Enums.TryGetValue(message.Name, out var existingEnum))
        {
            throw new InvalidOperationException(
                $"proto type `{message.Name}` is both enum and message: {existingEnum.SourcePath} and {message.SourcePath}"
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
        if (schema.Messages.TryGetValue(protoEnum.Name, out var existingMessage))
        {
            throw new InvalidOperationException(
                $"proto type `{protoEnum.Name}` is both message and enum: {existingMessage.SourcePath} and {protoEnum.SourcePath}"
            );
        }
        if (protoEnum.Values.Count == 0)
        {
            throw new InvalidOperationException($"{protoEnum.SourcePath}:{protoEnum.LineNo} enum `{protoEnum.Name}` is empty");
        }
        if (protoEnum.Values[0].Number != 0)
        {
            throw new InvalidOperationException(
                $"{protoEnum.SourcePath}:{protoEnum.Values[0].LineNo} proto3 enum `{protoEnum.Name}` first value must be zero"
            );
        }
        schema.Enums[protoEnum.Name] = protoEnum;
    }

    private static string StripLineComment(string line)
    {
        var inQuote = false;
        for (var index = 0; index < line.Length - 1; index++)
        {
            if (line[index] == '"')
            {
                inQuote = !inQuote;
            }
            if (!inQuote && line[index] == '/' && line[index + 1] == '/')
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

sealed record ProtoMessage(string Name, string SourcePath, int LineNo = 0)
{
    public List<ProtoField> Fields { get; } = [];
}

sealed record ProtoEnum(string Name, string SourcePath, int LineNo = 0)
{
    public List<ProtoEnumValue> Values { get; } = [];
}

sealed record ProtoEnumValue(string Name, int Number, int LineNo = 0);

sealed record ProtoField(string Name, string Type, bool IsRepeated, string OneofGroup, int Number, int LineNo)
{
    public bool IsOneof => OneofGroup.Length > 0;
}

static class TextUtil
{
    public static string Snake(string value)
    {
        var output = new StringBuilder();
        for (var index = 0; index < value.Length; index++)
        {
            var ch = value[index];
            if (char.IsUpper(ch) && index > 0)
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

    public static string SchemaPascal(string value)
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

    public static void ValidateGeneratedNames(
        string label,
        IEnumerable<(string Source, string Identifier)> names
    )
    {
        var items = names.ToArray();
        foreach (var item in items.Where(item => string.IsNullOrWhiteSpace(item.Identifier)))
        {
            throw new InvalidOperationException(
                $"{label} name `{item.Source}` produces an empty generated identifier"
            );
        }

        foreach (var group in items.GroupBy(item => item.Identifier, StringComparer.Ordinal)
            .OrderBy(group => group.Key, StringComparer.Ordinal))
        {
            var sources = group.Select(item => item.Source)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(item => item, StringComparer.Ordinal)
                .ToArray();
            if (sources.Length > 1)
            {
                throw new InvalidOperationException(
                    $"{label} names `{string.Join("`, `", sources)}` produce the same generated identifier `{group.Key}`"
                );
            }
        }
    }

    public static void WriteText(string path, string text)
    {
        var fullPath = Path.GetFullPath(path);
        var dir = Path.GetDirectoryName(fullPath);
        if (!string.IsNullOrEmpty(dir))
        {
            Directory.CreateDirectory(dir);
        }

        var temp = fullPath + $".tmp.{Guid.NewGuid():N}";
        try
        {
            File.WriteAllText(temp, StripTrailingWhitespace(text), new UTF8Encoding(false));
            File.Move(temp, fullPath, true);
        }
        finally
        {
            if (File.Exists(temp))
            {
                File.Delete(temp);
            }
        }
    }

    private static string StripTrailingWhitespace(string text)
    {
        var normalized = text.Replace("\r\n", "\n");
        return string.Join("\n", normalized.Split('\n').Select(line => line.TrimEnd()));
    }
}
