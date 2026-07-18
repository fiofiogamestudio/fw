using System.Text;

sealed class GenerationBatch
{
    private sealed record PendingWrite(string Path, byte[] Content);
    private sealed record AppliedChange(string Path, string? BackupPath);

    private readonly string _root;
    private readonly StringComparison _pathComparison;
    private readonly Dictionary<string, PendingWrite> _writes;
    private readonly HashSet<string> _deletes;
    private readonly Action<string>? _beforeApply;

    internal GenerationBatch(string root, Action<string>? beforeApply = null)
    {
        _root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        _pathComparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        _writes = new Dictionary<string, PendingWrite>(PathComparer());
        _deletes = new HashSet<string>(PathComparer());
        _beforeApply = beforeApply;
    }

    internal void StageText(string path, string text)
    {
        StageBytes(path, new UTF8Encoding(false).GetBytes(TextUtil.NormalizeText(text)));
    }

    internal void StageBytes(string path, byte[] content)
    {
        var fullPath = Resolve(path);
        if (_deletes.Contains(fullPath))
        {
            throw new InvalidOperationException($"generation target is both written and deleted: {Relative(fullPath)}");
        }
        if (!_writes.TryAdd(fullPath, new PendingWrite(fullPath, [.. content])))
        {
            throw new InvalidOperationException($"generation target is written more than once: {Relative(fullPath)}");
        }
    }

    internal void StageDelete(string path)
    {
        var fullPath = Resolve(path);
        if (_writes.ContainsKey(fullPath))
        {
            throw new InvalidOperationException($"generation target is both written and deleted: {Relative(fullPath)}");
        }
        _deletes.Add(fullPath);
    }

    internal byte[] ReadBytes(string path)
    {
        var fullPath = Resolve(path);
        if (_writes.TryGetValue(fullPath, out var pending))
        {
            return [.. pending.Content];
        }
        if (_deletes.Contains(fullPath) || !File.Exists(fullPath))
        {
            throw new FileNotFoundException($"generation output not found: {Relative(fullPath)}");
        }
        return File.ReadAllBytes(fullPath);
    }

    internal void Commit()
    {
        var writes = _writes.Values
            .Where(item => !File.Exists(item.Path) || !File.ReadAllBytes(item.Path).AsSpan().SequenceEqual(item.Content))
            .OrderBy(item => item.Path, StringComparer.Ordinal)
            .ToArray();
        var deletes = _deletes
            .Where(File.Exists)
            .OrderBy(item => item, StringComparer.Ordinal)
            .ToArray();
        if (writes.Length == 0 && deletes.Length == 0)
        {
            return;
        }

        var transactionId = Guid.NewGuid().ToString("N");
        var temporary = new Dictionary<string, string>(PathComparer());
        var applied = new List<AppliedChange>();
        try
        {
            foreach (var write in writes)
            {
                var directory = Path.GetDirectoryName(write.Path);
                if (!string.IsNullOrEmpty(directory))
                {
                    Directory.CreateDirectory(directory);
                }
                var tempPath = write.Path + $".fwgen.{transactionId}.new";
                using (var stream = new FileStream(tempPath, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                {
                    stream.Write(write.Content);
                    stream.Flush(true);
                }
                temporary.Add(write.Path, tempPath);
            }

            foreach (var write in writes)
            {
                Apply(write.Path, temporary[write.Path], transactionId, applied);
                temporary.Remove(write.Path);
            }
            foreach (var path in deletes)
            {
                Apply(path, null, transactionId, applied);
            }
        }
        catch (Exception commitError)
        {
            try
            {
                RollBack(applied);
            }
            catch (Exception rollbackError)
            {
                throw new AggregateException("generation commit and rollback both failed", commitError, rollbackError);
            }
            throw;
        }
        finally
        {
            foreach (var tempPath in temporary.Values)
            {
                TryDeleteArtifact(tempPath);
            }
        }

        foreach (var change in applied)
        {
            if (change.BackupPath != null)
            {
                TryDeleteArtifact(change.BackupPath);
            }
        }
    }

    private void Apply(string path, string? tempPath, string transactionId, List<AppliedChange> applied)
    {
        _beforeApply?.Invoke(path);
        var backupPath = File.Exists(path) ? path + $".fwgen.{transactionId}.bak" : null;
        if (backupPath != null)
        {
            File.Move(path, backupPath);
        }
        applied.Add(new AppliedChange(path, backupPath));
        if (tempPath != null)
        {
            File.Move(tempPath, path);
        }
    }

    private static void RollBack(List<AppliedChange> applied)
    {
        for (var index = applied.Count - 1; index >= 0; index--)
        {
            var change = applied[index];
            if (File.Exists(change.Path))
            {
                File.Delete(change.Path);
            }
            if (change.BackupPath != null && File.Exists(change.BackupPath))
            {
                File.Move(change.BackupPath, change.Path);
            }
        }
    }

    private string Resolve(string path)
    {
        var fullPath = Path.IsPathRooted(path)
            ? Path.GetFullPath(path)
            : Path.GetFullPath(path, _root);
        var rootPrefix = _root.EndsWith(Path.DirectorySeparatorChar)
            || _root.EndsWith(Path.AltDirectorySeparatorChar)
            ? _root
            : _root + Path.DirectorySeparatorChar;
        if (!fullPath.Equals(_root, _pathComparison)
            && !fullPath.StartsWith(rootPrefix, _pathComparison))
        {
            throw new InvalidOperationException($"generation target escapes project root: {fullPath}");
        }
        return fullPath;
    }

    private string Relative(string path)
    {
        return Path.GetRelativePath(_root, path).Replace('\\', '/');
    }

    private static StringComparer PathComparer()
    {
        return OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    }

    private static void TryDeleteArtifact(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            Console.Error.WriteLine($"warning: failed to remove generation transaction artifact '{path}': {error.Message}");
        }
    }
}
