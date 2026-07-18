using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

sealed class GenerationManifestModel
{
    public int Format { get; set; } = 1;
    public SortedDictionary<string, GenerationManifestSection> Commands { get; set; } = new(StringComparer.Ordinal);
}

sealed class GenerationManifestSection
{
    public string GeneratorHash { get; set; } = "";
    public string InputHash { get; set; } = "";
    public List<GenerationManifestFile> Outputs { get; set; } = [];
}

sealed class GenerationManifestFile
{
    public string Path { get; set; } = "";
    public string Hash { get; set; } = "";
}

static class GenerationManifest
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        WriteIndented = true,
    };

    public static void UpdateSystem(string root, FwConfig config)
    {
        var batch = new GenerationBatch(root);
        StageSystem(batch, root, config);
        batch.Commit();
    }

    internal static void StageSystem(GenerationBatch batch, string root, FwConfig config)
    {
        Stage(
            batch,
            root,
            config,
            "system",
            [config.SystemsSchemaPath(root), Path.Combine(root, "fw.toml")],
            [config.GodotSystemsGdPath(root), config.CoreSystemsCsPath(root)]
        );
    }

    public static void UpdateBridge(string root, FwConfig config)
    {
        var batch = new GenerationBatch(root);
        StageBridge(batch, root, config);
        batch.Commit();
    }

    internal static void StageBridge(GenerationBatch batch, string root, FwConfig config)
    {
        var inputs = SchemaFiles(config.BridgeSchemaDir(root)).Append(Path.Combine(root, "fw.toml"));
        Stage(
            batch,
            root,
            config,
            "bridge",
            inputs,
            [
                Path.Combine(config.GodotGenDir(root), "_bridge.gd"),
                config.BridgeTypesCsPath(root),
                config.BridgeCodecCsPath(root),
                config.BridgeIntentCodecCsPath(root),
                config.BridgeEventCodecCsPath(root),
                config.BridgePacketCodecCsPath(root),
            ]
        );
    }

    public static void UpdateConfig(string root, FwConfig config)
    {
        var batch = new GenerationBatch(root);
        StageConfig(batch, root, config);
        batch.Commit();
    }

    internal static void StageConfig(GenerationBatch batch, string root, FwConfig config)
    {
        Stage(
            batch,
            root,
            config,
            "config",
            ConfigInputHash(root, config),
            [config.ConfigGdPath(root), config.ConfigContractCsPath(root), config.ConfigCodecCsPath(root)]
        );
    }

    public static void Verify(string root, FwConfig config)
    {
        var path = config.GenerationManifestPath(root);
        if (!File.Exists(path))
        {
            throw new InvalidOperationException($"generated manifest missing: {Relative(root, path)}; run fwgen system, bridge and config");
        }

        var model = Load(path);
        if (model.Format != 1)
        {
            throw new InvalidOperationException($"unsupported generated manifest format: {model.Format}");
        }
        VerifySection(
            root,
            model,
            "system",
            [config.SystemsSchemaPath(root), Path.Combine(root, "fw.toml")],
            [config.GodotSystemsGdPath(root), config.CoreSystemsCsPath(root)]
        );
        VerifySection(
            root,
            model,
            "bridge",
            SchemaFiles(config.BridgeSchemaDir(root)).Append(Path.Combine(root, "fw.toml")),
            [
                Path.Combine(config.GodotGenDir(root), "_bridge.gd"),
                config.BridgeTypesCsPath(root),
                config.BridgeCodecCsPath(root),
                config.BridgeIntentCodecCsPath(root),
                config.BridgeEventCodecCsPath(root),
                config.BridgePacketCodecCsPath(root),
            ]
        );
        VerifySection(
            root,
            model,
            "config",
            ConfigInputHash(root, config),
            [config.ConfigGdPath(root), config.ConfigContractCsPath(root), config.ConfigCodecCsPath(root)]
        );
    }

    private static void Stage(
        GenerationBatch batch,
        string root,
        FwConfig config,
        string command,
        IEnumerable<string> inputs,
        IEnumerable<string> outputs
    )
    {
        Stage(batch, root, config, command, HashInputs(root, inputs), outputs);
    }

    private static void Stage(
        GenerationBatch batch,
        string root,
        FwConfig config,
        string command,
        string inputHash,
        IEnumerable<string> outputs
    )
    {
        var manifestPath = config.GenerationManifestPath(root);
        var model = LoadForUpdate(manifestPath);
        model.Format = 1;
        model.Commands[command] = new GenerationManifestSection
        {
            GeneratorHash = GeneratorHash(root),
            InputHash = inputHash,
            Outputs = outputs
                .Select(Path.GetFullPath)
                .OrderBy(item => item, StringComparer.Ordinal)
                .Select(item => new GenerationManifestFile
                {
                    Path = Relative(root, item),
                    Hash = HashOutput(batch, item),
                })
                .ToList(),
        };
        batch.StageText(manifestPath, JsonSerializer.Serialize(model, JsonOptions) + "\n");
    }

    private static void VerifySection(
        string root,
        GenerationManifestModel model,
        string command,
        IEnumerable<string> inputs,
        IEnumerable<string> expectedOutputs
    )
    {
        VerifySection(root, model, command, HashInputs(root, inputs), expectedOutputs);
    }

    private static void VerifySection(
        string root,
        GenerationManifestModel model,
        string command,
        string inputHash,
        IEnumerable<string> expectedOutputs
    )
    {
        if (model.Commands == null)
        {
            throw new InvalidOperationException("generated manifest has no command map");
        }
        if (!model.Commands.TryGetValue(command, out var section))
        {
            throw new InvalidOperationException($"generated manifest has no `{command}` entry; run fwgen {command}");
        }
        if (section.GeneratorHash != GeneratorHash(root))
        {
            throw new InvalidOperationException($"{command} output was created by a different fwgen build; run fwgen {command}");
        }
        if (section.InputHash != inputHash)
        {
            throw new InvalidOperationException($"{command} schema/data changed after generation; run fwgen {command}");
        }
        if (section.Outputs == null)
        {
            throw new InvalidOperationException($"generated manifest `{command}` output list is missing");
        }

        var expectedPaths = expectedOutputs
            .Select(Path.GetFullPath)
            .Select(path => Relative(root, path))
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        var actualPaths = section.Outputs
            .Select(output => output.Path)
            .OrderBy(path => path, StringComparer.Ordinal)
            .ToArray();
        if (!expectedPaths.SequenceEqual(actualPaths, StringComparer.Ordinal))
        {
            throw new InvalidOperationException(
                $"generated manifest `{command}` output set is incomplete or unexpected; run fwgen {command}"
            );
        }

        foreach (var output in section.Outputs)
        {
            var path = Path.GetFullPath(Path.Combine(root, output.Path.Replace('/', Path.DirectorySeparatorChar)));
            EnsureInsideRoot(root, path, $"generated manifest `{command}` output");
            if (!File.Exists(path))
            {
                throw new InvalidOperationException($"generated output missing: {output.Path}; run fwgen {command}");
            }
            if (HashFile(path) != output.Hash)
            {
                throw new InvalidOperationException($"generated output changed: {output.Path}; regenerate instead of editing _gen");
            }
        }
    }

    private static GenerationManifestModel Load(string path)
    {
        return JsonSerializer.Deserialize<GenerationManifestModel>(File.ReadAllText(path, Encoding.UTF8), JsonOptions)
            ?? throw new InvalidOperationException($"invalid generated manifest: {path}");
    }

    private static GenerationManifestModel LoadForUpdate(string path)
    {
        if (!File.Exists(path))
        {
            return new GenerationManifestModel();
        }
        try
        {
            var model = Load(path);
            return model.Format == 1 ? model : new GenerationManifestModel();
        }
        catch (JsonException)
        {
            return new GenerationManifestModel();
        }
    }

    private static IEnumerable<string> SchemaFiles(string dir)
    {
        return Directory.Exists(dir)
            ? Directory.GetFiles(dir, "*.proto", SearchOption.TopDirectoryOnly).OrderBy(item => item, StringComparer.Ordinal)
            : [];
    }

    private static IEnumerable<string> ConfigDataFiles(string dir)
    {
        return Directory.Exists(dir)
            ? Directory.GetFiles(dir, "*", SearchOption.TopDirectoryOnly)
                .Where(item => item.EndsWith(".json", StringComparison.OrdinalIgnoreCase)
                    || item.EndsWith(".csv.txt", StringComparison.OrdinalIgnoreCase))
                .OrderBy(item => item, StringComparer.Ordinal)
            : [];
    }

    private static string ConfigInputHash(string root, FwConfig config)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        var structuralInputs = SchemaFiles(config.ConfigSchemaDir(root))
            .Append(Path.Combine(root, "fw.toml"));
        foreach (var path in structuralInputs.Select(Path.GetFullPath).OrderBy(item => item, StringComparer.Ordinal))
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"generation input not found: {path}");
            }
            hash.AppendData(Encoding.UTF8.GetBytes(Relative(root, path) + "\n"));
            hash.AppendData(NormalizedBytes(path));
        }
        foreach (var path in ConfigDataFiles(config.ConfigDataDir(root)).Select(Path.GetFullPath))
        {
            hash.AppendData(Encoding.UTF8.GetBytes(Relative(root, path) + "\n"));
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static string HashInputs(string root, IEnumerable<string> inputs)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var path in inputs.Select(Path.GetFullPath).Distinct(StringComparer.OrdinalIgnoreCase).OrderBy(item => item, StringComparer.Ordinal))
        {
            if (!File.Exists(path))
            {
                throw new FileNotFoundException($"generation input not found: {path}");
            }
            hash.AppendData(Encoding.UTF8.GetBytes(Relative(root, path) + "\n"));
            hash.AppendData(NormalizedBytes(path));
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static string GeneratorHash(string root)
    {
        var generatorDir = Path.Combine(root, "fw", "csharp", "FwGen");
        if (!Directory.Exists(generatorDir))
        {
            return Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(typeof(GenerationManifest).Assembly.Location)))
                .ToLowerInvariant();
        }
        var inputs = Directory.GetFiles(generatorDir, "*.cs", SearchOption.TopDirectoryOnly)
            .Append(Path.Combine(generatorDir, "FwGen.csproj"))
            .Append(Path.Combine(root, "fw", "csharp", "Directory.Build.props"));
        return HashInputs(root, inputs);
    }

    private static string HashFile(string path)
    {
        if (!File.Exists(path))
        {
            throw new FileNotFoundException($"file not found while hashing: {path}");
        }
        return Convert.ToHexString(SHA256.HashData(NormalizedBytes(path))).ToLowerInvariant();
    }

    private static string HashOutput(GenerationBatch batch, string path)
    {
        return Convert.ToHexString(SHA256.HashData(NormalizedBytes(path, batch.ReadBytes(path)))).ToLowerInvariant();
    }

    private static byte[] NormalizedBytes(string path)
    {
        return NormalizedBytes(path, File.ReadAllBytes(path));
    }

    private static byte[] NormalizedBytes(string path, byte[] content)
    {
        var extension = Path.GetExtension(path);
        var isText = extension.Equals(".cs", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".gd", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".json", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".toml", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".proto", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".txt", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".csproj", StringComparison.OrdinalIgnoreCase)
            || extension.Equals(".props", StringComparison.OrdinalIgnoreCase);
        if (!isText)
        {
            return content;
        }
        var text = Encoding.UTF8.GetString(content).Replace("\r\n", "\n").Replace('\r', '\n');
        return Encoding.UTF8.GetBytes(text);
    }

    private static string Relative(string root, string path)
    {
        var fullPath = Path.GetFullPath(path);
        EnsureInsideRoot(root, fullPath, "generation path");
        return Path.GetRelativePath(Path.GetFullPath(root), fullPath).Replace('\\', '/');
    }

    private static void EnsureInsideRoot(string root, string path, string label)
    {
        var fullRoot = Path.GetFullPath(root);
        var fullPath = Path.GetFullPath(path);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var rootPrefix = fullRoot.EndsWith(Path.DirectorySeparatorChar)
            || fullRoot.EndsWith(Path.AltDirectorySeparatorChar)
            ? fullRoot
            : fullRoot + Path.DirectorySeparatorChar;
        if (fullPath.Equals(fullRoot, comparison)
            || fullPath.StartsWith(rootPrefix, comparison))
        {
            return;
        }
        throw new InvalidOperationException($"{label} escapes project root: {fullPath}");
    }
}
