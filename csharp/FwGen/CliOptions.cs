sealed class CliOptions
{
    public string Root { get; private set; } = Directory.GetCurrentDirectory();
    public string Name { get; private set; } = "";
    public bool Force { get; private set; }
    public List<string> Command { get; } = [];

    public static CliOptions Parse(string[] args)
    {
        var options = new CliOptions();
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--root":
                case "--project-root":
                    options.Root = RequireValue(args, ref i);
                    break;
                case "--name":
                    options.Name = RequireValue(args, ref i);
                    break;
                case "--force":
                    options.Force = true;
                    break;
                default:
                    options.Command.Add(args[i]);
                    break;
            }
        }
        return options;
    }

    private static string RequireValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length)
        {
            throw new InvalidOperationException($"{args[index]} requires a value");
        }
        index += 1;
        return args[index];
    }
}
