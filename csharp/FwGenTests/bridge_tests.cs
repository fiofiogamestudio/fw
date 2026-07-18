using static TestKit;

static class BridgeTests
{
    internal static TestCase[] Cases =>
    [
        new("bridge uses proto zero defaults", TestBridgeZeroDefaults),
        new("bridge rejects unsupported scalars", TestUnsupportedBridgeScalar),
    ];

    private static void TestBridgeZeroDefaults()
    {
        WithTempDir(root =>
        {
            WriteProjectConfig(root);
            Write(root, "schema/bridge/value.proto", """
                syntax = "proto3";
                package audit.bridge;
                enum Kind {
                  KIND_UNSPECIFIED = 0;
                  KIND_VALUE = 1;
                }
                """);
            Write(root, "schema/bridge/intent.proto", """
                syntax = "proto3";
                package audit.bridge;
                message IncrementIntent {
                  uint32 amount = 1;
                }
                message GameAction {
                  oneof kind {
                    IncrementIntent increment = 1;
                  }
                }
                message GameIntent {
                  GameAction action = 1;
                }
                """);
            Write(root, "schema/bridge/view.proto", """
                syntax = "proto3";
                package audit.bridge;
                message GameView {
                  uint32 count = 1;
                  Kind kind = 2;
                }
                """);
            Write(root, "schema/bridge/event.proto", """
                syntax = "proto3";
                package audit.bridge;
                message ChangedEvent {
                  uint32 count = 1;
                  Kind kind = 2;
                }
                message GameEvent {
                  oneof payload {
                    ChangedEvent changed = 1;
                  }
                }
                """);
            Write(root, "schema/bridge/packet.proto", """
                syntax = "proto3";
                package audit.bridge;
                enum PacketType {
                  PACKET_TYPE_UNSPECIFIED = 0;
                  PACKET_TYPE_EVENT = 1;
                }
                message EventPacket {
                  GameEvent event = 1;
                }
                message Packet {
                  oneof payload {
                    EventPacket event = 1;
                  }
                }
                """);

            var config = FwConfig.Load(root);
            BridgeGen.Generate(root, config);
            string types = File.ReadAllText(config.BridgeTypesCsPath(root));
            string events = File.ReadAllText(config.BridgeEventCodecCsPath(root));
            True(!types.Contains("Count { get; init; } = 1", StringComparison.Ordinal), "numeric zero default");
            True(types.Contains("Kind { get; init; } = \"\"", StringComparison.Ordinal), "enum zero default");
            True(!types.Contains("using Godot;", StringComparison.Ordinal), "Godot-free bridge types without engine values");
            True(
                events.Contains("BridgeCodec.ReadString", StringComparison.Ordinal)
                    || events.Contains("ev.Payload", StringComparison.Ordinal),
                "event codec generated"
            );
        });
    }

    private static void TestUnsupportedBridgeScalar()
    {
        WithTempDir(root =>
        {
            Write(root, "schema/bridge/value.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/intent.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/view.proto", """
                syntax = "proto3";
                package audit.bridge;
                message GameView {
                  bytes payload = 1;
                }
                """);
            Write(root, "schema/bridge/event.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/packet.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");

            Throws(
                () => BridgeSchema.Read(Path.Combine(root, "schema", "bridge")),
                "unsupported scalar `bytes`"
            );
        });
    }
}
