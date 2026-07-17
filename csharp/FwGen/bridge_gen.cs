static partial class BridgeGen
{
    public static void Generate(string root, FwConfig config)
    {
        var schemaDir = config.BridgeSchemaDir(root);
        var gdDir = config.GodotGenDir(root);
        Directory.CreateDirectory(gdDir);
        var schema = ProtoSchema.ParseFiles(SchemaFiles(schemaDir));
        if (string.IsNullOrWhiteSpace(schema.Package))
        {
            throw new InvalidOperationException("bridge schema must declare one shared package");
        }

        GenerateBridgeGd(gdDir, schema);
        GenerateTypesCs(root, config, schema);
        GenerateCodecCs(root, config);
        GenerateIntentCodecCs(root, config, schema);
        GenerateEventCodecCs(root, config, schema);
        GeneratePacketCodecCs(root, config, schema);
        Console.WriteLine($"generated bridge gd scripts: {gdDir}");
    }

    private static void DeleteLegacyFile(string path)
    {
        if (File.Exists(path))
        {
            File.Delete(path);
        }
    }
}
