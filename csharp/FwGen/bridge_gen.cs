static class BridgeGen
{
    public static void Generate(string root, FwConfig config)
    {
        var gdDir = config.GodotGenDir(root);
        Directory.CreateDirectory(gdDir);
        var schema = BridgeSchema.Read(config.BridgeSchemaDir(root));

        BridgeGd.Write(gdDir, schema);
        BridgeTypes.Write(root, config, schema);
        BridgeCodec.Write(root, config, schema);
        Console.WriteLine($"generated bridge gd scripts: {gdDir}");
    }
}
