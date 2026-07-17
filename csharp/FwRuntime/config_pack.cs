using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text.Json;

namespace Fw.Rt.Config;

public static class ConfigPack
{
    public const int HeaderSize = 76;
    public const int Version = 1;
    private static ReadOnlySpan<byte> Magic => "WCFG"u8;

    public static byte[] Encode(ReadOnlySpan<byte> payload, ReadOnlySpan<byte> schemaHash)
    {
        if (schemaHash.Length != 32)
        {
            throw new ArgumentException("Config schema hash must be SHA-256.", nameof(schemaHash));
        }
        if (payload.Length > int.MaxValue - HeaderSize)
        {
            throw new InvalidDataException("Config pack payload is too large.");
        }

        var pack = new byte[HeaderSize + payload.Length];
        Magic.CopyTo(pack);
        BinaryPrimitives.WriteInt32LittleEndian(pack.AsSpan(4, 4), Version);
        schemaHash.CopyTo(pack.AsSpan(8, 32));
        BinaryPrimitives.WriteInt32LittleEndian(pack.AsSpan(40, 4), payload.Length);
        SHA256.HashData(payload).CopyTo(pack, 44);
        payload.CopyTo(pack.AsSpan(HeaderSize));
        return pack;
    }

    public static Dictionary<string, JsonElement> Decode(ReadOnlyMemory<byte> pack, string expectedSchemaHash)
    {
        byte[] expectedHash;
        try
        {
            expectedHash = Convert.FromHexString(expectedSchemaHash);
        }
        catch (FormatException error)
        {
            throw new ArgumentException("Expected config schema hash must be hexadecimal.", nameof(expectedSchemaHash), error);
        }
        if (expectedHash.Length != 32)
        {
            throw new ArgumentException("Expected config schema hash must be SHA-256.", nameof(expectedSchemaHash));
        }

        ReadOnlySpan<byte> bytes = pack.Span;
        if (bytes.Length < HeaderSize || !bytes[..Magic.Length].SequenceEqual(Magic))
        {
            throw new InvalidDataException("Config pack header is invalid.");
        }
        int version = BinaryPrimitives.ReadInt32LittleEndian(bytes.Slice(4, 4));
        if (version != Version)
        {
            throw new InvalidDataException($"Config pack version {version} is unsupported.");
        }
        if (!CryptographicOperations.FixedTimeEquals(bytes.Slice(8, 32), expectedHash))
        {
            throw new InvalidDataException("Config pack schema hash does not match.");
        }

        int payloadLength = BinaryPrimitives.ReadInt32LittleEndian(bytes.Slice(40, 4));
        if (payloadLength < 0 || payloadLength != bytes.Length - HeaderSize)
        {
            throw new InvalidDataException("Config pack payload length is invalid.");
        }
        ReadOnlySpan<byte> payload = bytes.Slice(HeaderSize, payloadLength);
        if (!CryptographicOperations.FixedTimeEquals(SHA256.HashData(payload), bytes.Slice(44, 32)))
        {
            throw new InvalidDataException("Config pack checksum does not match.");
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(pack.Slice(HeaderSize, payloadLength));
            if (document.RootElement.ValueKind != JsonValueKind.Array)
            {
                throw new InvalidDataException("Config pack payload must be an array.");
            }

            var entries = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (JsonElement entry in document.RootElement.EnumerateArray())
            {
                if (
                    entry.ValueKind != JsonValueKind.Object
                    || !entry.TryGetProperty("key", out JsonElement keyElement)
                    || keyElement.ValueKind != JsonValueKind.String
                    || string.IsNullOrEmpty(keyElement.GetString())
                    || !entry.TryGetProperty("value", out JsonElement value)
                )
                {
                    throw new InvalidDataException("Config pack contains an invalid entry.");
                }

                string key = keyElement.GetString()!;
                if (!entries.TryAdd(key, value.Clone()))
                {
                    throw new InvalidDataException($"Config pack contains duplicate key `{key}`.");
                }
            }
            return entries;
        }
        catch (JsonException error)
        {
            throw new InvalidDataException("Config pack payload is not valid JSON.", error);
        }
    }
}
