static class BridgeGen
{
    public static void Generate(string root, FwConfig config)
    {
        var gdDir = config.GodotGenDir(root);
        var schema = BridgeSchema.Read(config.BridgeSchemaDir(root));
        var batch = new GenerationBatch(root);

        BridgeGd.Stage(batch, gdDir, schema);
        BridgeTypes.Stage(batch, root, config, schema);
        BridgeCodec.Stage(batch, root, config, schema);
        GenerationManifest.StageBridge(batch, root, config);
        batch.Commit();
        Console.WriteLine($"generated bridge gd scripts: {gdDir}");
        Console.WriteLine($"generated bridge csharp types: {config.BridgeTypesCsPath(root)}");
    }
}
