return FwGen.Run(args);

static class FwGen
{
    public static int Run(string[] args)
    {
        try
        {
            var options = CliOptions.Parse(args);
            if (options.Command.Count == 0)
            {
                throw new InvalidOperationException("missing command");
            }

            var root = Path.GetFullPath(options.Root);
            var config = FwConfig.Load(root);
            var command = options.Command[0];

            switch (command)
            {
                case "system":
                    SystemGen.Generate(root, config);
                    CoreSystemGen.Generate(root, config);
                    break;
                case "bridge":
                    BridgeGen.Generate(root, config);
                    break;
                case "config":
                    ConfigGen.Generate(root, config);
                    break;
                case "config_check":
                    ConfigGen.Check(root, config);
                    break;
                case "config_pack":
                    ConfigGen.Pack(root, config);
                    break;
                case "craft":
                    Craft.Run(root, config, options.Command.Skip(1).ToArray(), options);
                    break;
                default:
                    throw new InvalidOperationException($"unsupported command: {command}");
            }

            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(ex.Message);
            return 1;
        }
    }
}
