static class ConfigGen
{
    public static void Generate(string root, FwConfig config)
    {
        var model = ConfigSchema.Resolve(root, config);
        var batch = new GenerationBatch(root);

        ConfigCs.Stage(batch, root, config, model);
        ConfigGd.Stage(batch, root, config, model);
        GenerationManifest.StageConfig(batch, root, config);
        batch.Commit();
        Console.WriteLine($"generated config gd script: {config.ConfigGdPath(root)}");
        Console.WriteLine($"generated config csharp contract: {config.ConfigContractCsPath(root)}");
        Console.WriteLine($"generated config csharp codec: {config.ConfigCodecCsPath(root)}");
    }

    public static void Check(string root, FwConfig config)
    {
        ConfigData.Check(root, config);
    }

    public static void Pack(string root, FwConfig config)
    {
        ConfigData.Pack(root, config);
    }
}
