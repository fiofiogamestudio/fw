static class TestKit
{
    internal static void WriteProjectConfig(string root)
    {
        Write(root, "fw.toml", """
            [project]
            name = "audit"
            """);
    }

    internal static string Write(string root, string relativePath, string content)
    {
        var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, content);
        return path;
    }

    internal static void WithTempDir(Action<string> action)
    {
        var root = Path.Combine(Path.GetTempPath(), "fwgen-tests", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            action(root);
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }

    internal static void Throws(Action action, string expected)
    {
        try
        {
            action();
        }
        catch (Exception ex) when (ex.Message.Contains(expected, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        throw new InvalidOperationException($"expected exception containing `{expected}`");
    }

    internal static void Throws<TException>(Action action, string label)
        where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        catch (Exception error)
        {
            throw new InvalidOperationException(
                $"{label}: expected {typeof(TException).Name}, got {error.GetType().Name}",
                error
            );
        }
        throw new InvalidOperationException($"{label}: expected {typeof(TException).Name}");
    }

    internal static void Equal<T>(T expected, T actual, string label)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"{label}: expected `{expected}`, got `{actual}`");
        }
    }

    internal static void True(bool value, string label)
    {
        if (!value)
        {
            throw new InvalidOperationException($"{label}: expected true");
        }
    }

    internal static byte[] Changed(byte[] source, int index, byte value)
    {
        byte[] changed = [.. source];
        changed[index] = value;
        return changed;
    }
}
