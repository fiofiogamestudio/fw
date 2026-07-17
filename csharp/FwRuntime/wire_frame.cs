using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;

namespace Fw.Rt.Bridge;

public sealed record WireFrameOptions(
    int CompressionThresholdBytes = 900,
    int MaxDecodedBytes = 1024 * 1024,
    int MaxEncodedBytes = 1024 * 1024
);

public static class WireFrame
{
    private const int HeaderSize = 48;
    private const byte Version = 1;
    private const byte CompressedFlag = 1;
    private static readonly byte[] Magic = "FWIR"u8.ToArray();

    public static byte[] Encode(ReadOnlySpan<byte> decoded, WireFrameOptions? options = null)
    {
        options ??= new WireFrameOptions();
        ValidateOptions(options);
        if (decoded.Length > options.MaxDecodedBytes)
        {
            throw new InvalidDataException($"Wire payload exceeds decoded limit: {decoded.Length} bytes.");
        }

        byte flags = 0;
        byte[] payload = decoded.ToArray();
        if (decoded.Length >= options.CompressionThresholdBytes)
        {
            byte[] compressed = Compress(decoded);
            if (compressed.Length < payload.Length)
            {
                payload = compressed;
                flags = CompressedFlag;
            }
        }
        if (payload.Length > options.MaxEncodedBytes)
        {
            throw new InvalidDataException($"Wire payload exceeds encoded limit: {payload.Length} bytes.");
        }

        var frame = new byte[HeaderSize + payload.Length];
        Magic.CopyTo(frame, 0);
        frame[4] = Version;
        frame[5] = flags;
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(8, 4), decoded.Length);
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(12, 4), payload.Length);
        SHA256.HashData(decoded).CopyTo(frame, 16);
        payload.CopyTo(frame, HeaderSize);
        return frame;
    }

    public static byte[] Decode(ReadOnlySpan<byte> frame, WireFrameOptions? options = null)
    {
        options ??= new WireFrameOptions();
        ValidateOptions(options);
        if (frame.Length < HeaderSize || !frame[..Magic.Length].SequenceEqual(Magic))
        {
            throw new InvalidDataException("Wire frame magic is invalid.");
        }
        if (frame[4] != Version)
        {
            throw new InvalidDataException($"Wire frame version {frame[4]} is unsupported.");
        }

        byte flags = frame[5];
        if ((flags & ~CompressedFlag) != 0 || frame[6] != 0 || frame[7] != 0)
        {
            throw new InvalidDataException("Wire frame flags are invalid.");
        }

        int decodedLength = BinaryPrimitives.ReadInt32LittleEndian(frame.Slice(8, 4));
        int payloadLength = BinaryPrimitives.ReadInt32LittleEndian(frame.Slice(12, 4));
        if (decodedLength < 0 || decodedLength > options.MaxDecodedBytes)
        {
            throw new InvalidDataException($"Wire decoded length is invalid: {decodedLength}.");
        }
        if (payloadLength < 0 || payloadLength > options.MaxEncodedBytes || payloadLength != frame.Length - HeaderSize)
        {
            throw new InvalidDataException($"Wire encoded length is invalid: {payloadLength}.");
        }

        ReadOnlySpan<byte> payload = frame.Slice(HeaderSize, payloadLength);
        byte[] decoded = (flags & CompressedFlag) != 0
            ? Decompress(payload, decodedLength, options.MaxDecodedBytes)
            : payload.ToArray();
        if (decoded.Length != decodedLength)
        {
            throw new InvalidDataException($"Wire decoded length mismatch: expected {decodedLength}, got {decoded.Length}.");
        }
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(decoded), frame.Slice(16, 32)))
        {
            throw new InvalidDataException("Wire frame checksum mismatch.");
        }
        return decoded;
    }

    public static bool HasHeader(ReadOnlySpan<byte> value)
    {
        return value.Length >= Magic.Length && value[..Magic.Length].SequenceEqual(Magic);
    }

    private static byte[] Compress(ReadOnlySpan<byte> value)
    {
        using var output = new MemoryStream();
        using (var brotli = new BrotliStream(output, CompressionLevel.Fastest, true))
        {
            brotli.Write(value);
        }
        return output.ToArray();
    }

    private static byte[] Decompress(ReadOnlySpan<byte> value, int expectedLength, int maxLength)
    {
        using var input = new MemoryStream(value.ToArray(), false);
        using var brotli = new BrotliStream(input, CompressionMode.Decompress);
        using var output = expectedLength > 0 ? new MemoryStream(expectedLength) : new MemoryStream();
        var buffer = new byte[4096];
        while (true)
        {
            int read = brotli.Read(buffer, 0, buffer.Length);
            if (read == 0)
            {
                break;
            }
            output.Write(buffer, 0, read);
            if (output.Length > maxLength || output.Length > expectedLength)
            {
                throw new InvalidDataException("Wire payload exceeded its declared decoded length.");
            }
        }
        return output.ToArray();
    }

    private static void ValidateOptions(WireFrameOptions options)
    {
        if (
            options.CompressionThresholdBytes < 0
            || options.MaxDecodedBytes <= 0
            || options.MaxEncodedBytes <= 0
            || options.MaxEncodedBytes > int.MaxValue - HeaderSize
        )
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Wire limits are invalid.");
        }
    }
}
