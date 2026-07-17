using System.Text;

static partial class ConfigGen
{
    public static void Generate(string root, FwConfig config)
    {
        var schemaDir = config.ConfigSchemaDir(root);
        var schema = ProtoSchema.ParseFiles(Directory.Exists(schemaDir)
            ? Directory.GetFiles(schemaDir, "*.proto").OrderBy(item => item, StringComparer.Ordinal)
            : []);
        ValidateFixed32(schema);
        var schemaHash = SchemaHash(schemaDir);

        GenerateCSharp(root, config, schema, schemaHash);
        GenerateGd(root, config, schema, schemaHash);
    }

    private static void GenerateCSharp(string root, FwConfig config, ProtoSchema schema, string schemaHash)
    {
        var rootNamespace = TextUtil.PascalName(config.ProjectName());
        var roots = ConfigRoots(root, config, schema);

        GenerateCSharpContract(config.ConfigContractCsPath(root), schema, rootNamespace, roots);
        GenerateCSharpCodec(
            config.ConfigCodecCsPath(root),
            schema,
            rootNamespace,
            schemaHash);
    }

    private static void GenerateGd(string root, FwConfig config, ProtoSchema schema, string schemaHash)
    {
        var messages = schema.Messages.Values
            .Where(item => item.Name != "Fixed32")
            .OrderBy(item => item.Name.EndsWith("Config", StringComparison.Ordinal) ? 1 : 0)
            .ThenBy(item => item.Name, StringComparer.Ordinal)
            .ToArray();
        var roots = ConfigRoots(root, config, schema);

        var text = new StringBuilder();
        text.Append(GdRuntimePrelude(schemaHash));
        RenderGdDefaults(text, messages, schema);
        RenderGdParsers(text, messages, schema, false);
        RenderGdParsers(text, messages, schema, true);
        RenderGdLoaders(text, roots, schema);

        var output = config.ConfigGdPath(root);
        TextUtil.WriteText(output, text.ToString());
        Console.WriteLine($"generated config gd script: {output}");
    }
}
