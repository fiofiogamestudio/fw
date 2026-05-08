using System.Text;
using System.Text.RegularExpressions;

static class Craft
{
    public static void Run(string root, FwConfig config, string[] args, CliOptions options)
    {
        if (args.Length == 0 || args[0] != "fw-new")
        {
            throw new InvalidOperationException("supported craft command: craft fw-new");
        }

        var name = string.IsNullOrWhiteSpace(options.Name) ? config.Value("project", "name", "Game") : options.Name;
        var templateRoot = Path.Combine(root, "fw", "templates", "fw_new", "default");
        if (!Directory.Exists(templateRoot))
        {
            throw new DirectoryNotFoundException($"template not found: {templateRoot}");
        }

        CopyTemplate(templateRoot, root, name, options.Force);
        var nextConfig = FwConfig.Load(root);
        SystemGen.Generate(root, nextConfig);
        BridgeGen.Generate(root, nextConfig);
        ConfigGen.Generate(root, nextConfig);
        Console.WriteLine($"created fw project scaffold: {root}");
    }

    private static void CopyTemplate(string templateRoot, string outputRoot, string projectName, bool force)
    {
        foreach (var source in Directory.GetFiles(templateRoot, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(templateRoot, source);
            if (relative.StartsWith("extension" + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            {
                continue;
            }

            var targetRelative = relative.EndsWith(".tpl", StringComparison.Ordinal)
                ? relative[..^".tpl".Length]
                : relative;
            targetRelative = targetRelative.Replace("__PROJECT_NAME__", projectName, StringComparison.Ordinal);
            var target = Path.Combine(outputRoot, targetRelative);

            if (File.Exists(target) && !force)
            {
                continue;
            }

            var text = File.ReadAllText(source, Encoding.UTF8)
                .Replace("__PROJECT_NAME__", projectName, StringComparison.Ordinal)
                .Replace("__LIB_NAME__", Slug(projectName), StringComparison.Ordinal);
            TextUtil.WriteText(target, text);
        }
    }

    private static string Slug(string value)
    {
        var text = Regex.Replace(value.Trim().ToLowerInvariant(), @"[^a-z0-9_]+", "_");
        return string.IsNullOrWhiteSpace(text) ? "game" : text.Trim('_');
    }
}
