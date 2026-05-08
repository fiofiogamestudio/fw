using System.Text;
using System.Text.RegularExpressions;

sealed class FwConfig
{
    private readonly Dictionary<string, Dictionary<string, string>> _sections;

    private FwConfig(Dictionary<string, Dictionary<string, string>> sections)
    {
        _sections = sections;
    }

    public string Value(string section, string key, string fallback)
    {
        if (_sections.TryGetValue(section, out var values) && values.TryGetValue(key, out var value))
        {
            return value;
        }
        return fallback;
    }

    public string PathValue(string root, string section, string key, string fallback)
    {
        return Path.GetFullPath(Path.Combine(root, Value(section, key, fallback)));
    }

    public static FwConfig Load(string root)
    {
        var path = Path.Combine(root, "fw.toml");
        var sections = new Dictionary<string, Dictionary<string, string>>(StringComparer.Ordinal);
        if (!File.Exists(path))
        {
            return new FwConfig(sections);
        }

        var section = "";
        foreach (var rawLine in File.ReadAllLines(path, Encoding.UTF8))
        {
            var line = StripComment(rawLine).Trim();
            if (line.Length == 0)
            {
                continue;
            }

            var sectionMatch = Regex.Match(line, @"^\[(.+)\]$");
            if (sectionMatch.Success)
            {
                section = sectionMatch.Groups[1].Value.Trim();
                sections.TryAdd(section, new Dictionary<string, string>(StringComparer.Ordinal));
                continue;
            }

            var valueMatch = Regex.Match(line, @"^([A-Za-z0-9_]+)\s*=\s*""(.*)""$");
            if (valueMatch.Success && section.Length > 0)
            {
                sections[section][valueMatch.Groups[1].Value] = valueMatch.Groups[2].Value;
            }
        }

        return new FwConfig(sections);
    }

    private static string StripComment(string line)
    {
        var inQuote = false;
        for (var i = 0; i < line.Length; i++)
        {
            if (line[i] == '"')
            {
                inQuote = !inQuote;
            }
            if (!inQuote && line[i] == '#')
            {
                return line[..i];
            }
        }
        return line;
    }
}
