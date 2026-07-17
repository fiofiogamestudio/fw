using System.Security.Cryptography;
using System.Text;

sealed class GenerationLock : IDisposable
{
    private readonly FileStream _stream;

    private GenerationLock(FileStream stream)
    {
        _stream = stream;
    }

    public static GenerationLock Acquire(string root, TimeSpan? timeout = null)
    {
        var wait = timeout ?? TimeSpan.FromSeconds(15);
        var lockDir = Path.Combine(Path.GetTempPath(), "fwgen-locks");
        Directory.CreateDirectory(lockDir);
        var normalizedRoot = Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(normalizedRoot))).ToLowerInvariant();
        var path = Path.Combine(lockDir, hash + ".lock");
        var deadline = DateTime.UtcNow + wait;

        while (true)
        {
            try
            {
                var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
                stream.SetLength(0);
                using var writer = new StreamWriter(stream, Encoding.UTF8, leaveOpen: true);
                writer.Write($"pid={Environment.ProcessId}\nroot={normalizedRoot}\n");
                writer.Flush();
                stream.Flush(true);
                return new GenerationLock(stream);
            }
            catch (IOException) when (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(50);
            }
            catch (IOException ex)
            {
                throw new TimeoutException($"timed out waiting for fwgen project lock: {normalizedRoot}", ex);
            }
        }
    }

    public void Dispose()
    {
        _stream.Dispose();
    }
}
