static class ConfigGen
{
    public static void Generate(string root, FwConfig config)
    {
        var schema = ConfigSchema.Read(config.ConfigSchemaDir(root));
        var schemaHash = ConfigSchema.Hash(config.ConfigSchemaDir(root));

        ConfigCs.Write(root, config, schema, schemaHash);
        ConfigGd.Write(root, config, schema, schemaHash);
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
