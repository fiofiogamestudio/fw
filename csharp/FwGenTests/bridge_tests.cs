using static TestKit;

static class BridgeTests
{
    internal static TestCase[] Cases =>
    [
        new("bridge uses proto zero defaults", TestBridgeZeroDefaults),
        new("bridge rejects unsupported scalars", TestUnsupportedBridgeScalar),
        new("bridge rejects generated name collisions", TestGeneratedBridgeNameCollision),
        new("bridge rejects generated type collisions", TestGeneratedBridgeTypeCollision),
        new("bridge rejects enclosing member collisions", TestBridgeEnclosingMemberCollision),
        new("bridge derives protocol version from schema semantics", TestProtocolVersion),
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

    private static void TestGeneratedBridgeNameCollision()
    {
        WithTempDir(root =>
        {
            Write(root, "schema/bridge/value.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/intent.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/view.proto", """
                syntax = "proto3";
                package audit.bridge;
                message GameView {
                  string player_id = 1;
                  string player__id = 2;
                }
                """);
            Write(root, "schema/bridge/event.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/packet.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");

            Throws(
                () => BridgeSchema.Read(Path.Combine(root, "schema", "bridge")),
                "same generated identifier"
            );
        });
    }

    private static void TestGeneratedBridgeTypeCollision()
    {
        WithTempDir(root =>
        {
            Write(root, "schema/bridge/value.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/intent.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/view.proto", """
                syntax = "proto3";
                package audit.bridge;
                message GameView {
                  string title = 1;
                }
                message Game {
                  string name = 1;
                }
                """);
            Write(root, "schema/bridge/event.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/packet.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");

            Throws(
                () => BridgeSchema.Read(Path.Combine(root, "schema", "bridge")),
                "same generated identifier"
            );
        });
    }

    private static void TestBridgeEnclosingMemberCollision()
    {
        WithTempDir(root =>
        {
            Write(root, "schema/bridge/value.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/intent.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/view.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");
            Write(root, "schema/bridge/event.proto", """
                syntax = "proto3";
                package audit.bridge;
                message ItemEvent {
                  string item_event = 1;
                }
                message EventEnvelope {
                  oneof event {
                    ItemEvent item = 1;
                  }
                }
                """);
            Write(root, "schema/bridge/packet.proto", "syntax = \"proto3\";\npackage audit.bridge;\n");

            Throws(
                () => BridgeSchema.Read(Path.Combine(root, "schema", "bridge")),
                "same generated identifier"
            );
        });
    }

    private static void TestProtocolVersion()
    {
        WithTempDir(root =>
        {
            string firstRoot = Path.Combine(root, "first");
            string reorderedRoot = Path.Combine(root, "reordered");
            string changedRoot = Path.Combine(root, "changed");
            WriteVersionSchema(firstRoot, """
                message GameView {
                  uint32 count = 1;
                  string label = 2;
                }
                """);
            WriteVersionSchema(reorderedRoot, """
                // Comments and declaration order are not protocol semantics.
                message GameView {
                    string label = 2; // same field
                    uint32 count = 1;
                }
                """);
            WriteVersionSchema(changedRoot, """
                message GameView {
                  uint32 count = 1;
                  string label = 3;
                }
                """);

            var first = BridgeSchema.Read(Path.Combine(firstRoot, "schema", "bridge"));
            var reordered = BridgeSchema.Read(Path.Combine(reorderedRoot, "schema", "bridge"));
            var changed = BridgeSchema.Read(Path.Combine(changedRoot, "schema", "bridge"));

            True(first.ProtocolVersion > 0, "protocol version is positive");
            Equal(first.ProtocolVersion, reordered.ProtocolVersion, "format-independent protocol version");
            True(first.ProtocolVersion != changed.ProtocolVersion, "schema change updates protocol version");

            WriteProjectConfig(firstRoot);
            var config = FwConfig.Load(firstRoot);
            BridgeGen.Generate(firstRoot, config);
            string codec = File.ReadAllText(config.BridgeCodecCsPath(firstRoot));
            True(
                codec.Contains($"ProtocolVersion = {first.ProtocolVersion};", StringComparison.Ordinal),
                "generated protocol version"
            );
        });
    }

    private static void WriteVersionSchema(string root, string viewSchema)
    {
        const string header = "syntax = \"proto3\";\npackage audit.bridge;\n";
        Write(root, "schema/bridge/value.proto", header);
        Write(root, "schema/bridge/intent.proto", header + "message GameIntent {\n  uint32 tick = 1;\n}\n");
        Write(root, "schema/bridge/view.proto", header + viewSchema);
        Write(root, "schema/bridge/event.proto", header + """
            message ChangedEvent {}
            message GameEvent {
              oneof payload {
                ChangedEvent changed = 1;
              }
            }
            """);
        Write(root, "schema/bridge/packet.proto", header + """
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
    }
}
