using Fw.Rt.Config;
using static TestKit;

static class ConfigTests
{
    internal static TestCase[] Cases =>
    [
        new("config pack header", TestConfigPackHeader),
        new("invalid Fixed32 marker fails", TestInvalidFixed32Marker),
        new("config reference validation", TestConfigReferenceValidation),
        new("duplicate config key fails", TestDuplicateConfigKey),
    ];

    private static void TestConfigPackHeader()
    {
        WithTempDir(root =>
        {
            WriteProjectConfig(root);
            Write(root, "schema/config/game.proto", """
                syntax = "proto3";
                message GameConfig {
                  string title = 1;
                }
                """);
            Write(root, "data/config/game.csv.txt", "key,title\ndefault,Audit\n");
            var config = FwConfig.Load(root);
            ConfigGen.Check(root, config);
            ConfigGen.Generate(root, config);
            ConfigGen.Pack(root, config);

            byte[] bytes = File.ReadAllBytes(Path.Combine(root, "pack/config/game.bin"));
            Equal("WCFG", System.Text.Encoding.ASCII.GetString(bytes, 0, 4), "config pack magic");
            Equal(1, System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(4, 4)), "config pack version");
            int payloadLength = System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(40, 4));
            Equal(bytes.Length - 76, payloadLength, "config pack payload length");
            True(
                System.Security.Cryptography.SHA256.HashData(bytes.AsSpan(76)).AsSpan().SequenceEqual(bytes.AsSpan(44, 32)),
                "config pack checksum"
            );
            string schemaHash = Convert.ToHexString(bytes.AsSpan(8, 32)).ToLowerInvariant();
            Dictionary<string, System.Text.Json.JsonElement> entries = ConfigPack.Decode(bytes, schemaHash);
            True(entries.TryGetValue("default", out var entry), "config pack runtime key");
            Equal("Audit", entry.GetProperty("title").GetString(), "config pack runtime value");
            byte[] tampered = [.. bytes];
            tampered[^1] ^= 0xff;
            Throws(() => ConfigPack.Decode(tampered, schemaHash), "checksum");
            string codec = File.ReadAllText(config.ConfigCodecCsPath(root));
            True(codec.Contains("public static List<string> ReadPackKeys", StringComparison.Ordinal), "config pack keys API");
            True(codec.Contains("ConfigPack.Decode", StringComparison.Ordinal), "shared config pack runtime");
        });
    }

    private static void TestInvalidFixed32Marker()
    {
        WithTempDir(root =>
        {
            WriteProjectConfig(root);
            Write(root, "schema/config/game.proto", """
                syntax = "proto3";
                message Fixed32 {
                  int32 raw = 1;
                }
                message GameConfig {
                  Fixed32 speed = 1;
                }
                """);
            Write(root, "data/config/game.csv.txt", "key,speed\ndefault,1.0\n");
            var config = FwConfig.Load(root);
            Throws(() => ConfigGen.Check(root, config), "reserved empty marker");
        });
    }

    private static void TestConfigReferenceValidation()
    {
        WithTempDir(root =>
        {
            WriteProjectConfig(root);
            Write(root, "schema/config/player.proto", """
                syntax = "proto3";
                package audit.config;
                message PlayerConfig {
                  uint32 speed = 1;
                }
                """);
            Write(root, "schema/config/game.proto", """
                syntax = "proto3";
                package audit.config;
                import "schema/config/player.proto";
                message GameConfig {
                  PlayerConfig player = 1;
                }
                """);
            Write(root, "data/config/player.csv.txt", "key,speed\ndefault,10\n");
            Write(root, "data/config/game.csv.txt", "key,player\ndefault,missing\n");
            Throws(() => ConfigGen.Check(root, FwConfig.Load(root)), "references missing PlayerConfig key");
        });
    }

    private static void TestDuplicateConfigKey()
    {
        WithTempDir(root =>
        {
            WriteProjectConfig(root);
            Write(root, "schema/config/game.proto", """
                syntax = "proto3";
                message GameConfig {
                  string title = 1;
                }
                """);
            Write(root, "data/config/game.csv.txt", "key,title\ndefault,First\ndefault,Second\n");
            Throws(() => ConfigGen.Check(root, FwConfig.Load(root)), "duplicate key");
        });
    }
}
