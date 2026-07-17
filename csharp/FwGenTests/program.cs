using Fw.Rt.Systems;
using Fw.Rt.Bridge;
using Fw.Rt.Config;

var tests = new (string Name, Action Run)[]
{
    ("valid proto subset", TestValidProto),
    ("missing proto import fails", TestMissingProtoImport),
    ("proto import traversal fails", TestProtoImportTraversal),
    ("ambiguous proto import fails", TestAmbiguousProtoImport),
    ("proto package mismatch fails", TestProtoPackageMismatch),
    ("unsupported proto fails", TestUnsupportedProto),
    ("duplicate proto fields fail", TestDuplicateProtoFields),
    ("unclosed proto fails", TestUnclosedProto),
    ("unknown proto type fails", TestUnknownProtoType),
    ("proto3 enum starts at zero", TestProtoEnumZero),
    ("valid system schema", TestValidSystemSchema),
    ("duplicate core system fails", TestDuplicateCoreSystem),
    ("unknown core phase fails", TestUnknownCorePhase),
    ("project name validation", TestProjectNameValidation),
    ("fw config rejects unknown keys", TestUnknownFwConfigKey),
    ("fw config contains paths", TestFwConfigPathContainment),
    ("manifest requires complete outputs", TestManifestOutputSet),
    ("atomic text write", TestAtomicWrite),
    ("bridge uses proto zero defaults", TestBridgeZeroDefaults),
    ("config pack header", TestConfigPackHeader),
    ("invalid Fixed32 marker fails", TestInvalidFixed32Marker),
    ("config reference validation", TestConfigReferenceValidation),
    ("duplicate config key fails", TestDuplicateConfigKey),
    ("generation lock excludes writers", TestGenerationLock),
    ("wire frame round trip", TestWireFrameRoundTrip),
    ("wire frame rejects tampering", TestWireFrameTampering),
    ("system init rollback", TestSystemInitRollback),
    ("system shutdown continues", TestSystemShutdownContinues),
};

var failures = new List<string>();
foreach (var test in tests)
{
    try
    {
        test.Run();
        Console.WriteLine($"[pass] {test.Name}");
    }
    catch (Exception ex)
    {
        failures.Add($"{test.Name}: {ex.Message}");
        Console.Error.WriteLine($"[fail] {test.Name}: {ex}");
    }
}

if (failures.Count > 0)
{
    Console.Error.WriteLine($"FwGenTests failed: {failures.Count}");
    return 1;
}

Console.WriteLine($"FwGenTests passed: {tests.Length}");
return 0;

static void TestValidProto()
{
    WithTempDir(root =>
    {
        var path = Write(root, "valid.proto", """
            syntax = "proto3";
            package audit.bridge;
            import "other.proto";

            message Empty {}

            enum Kind {
              KIND_UNSPECIFIED = 0;
              KIND_VALUE = 1;
            }

            message Payload {
              repeated uint32 values = 1;
              Kind kind = 2;
            }

            message Envelope {
              oneof payload {
                Payload data = 1;
                Empty empty = 2;
              }
            }
            """);

        var dependency = Write(root, "other.proto", """
            syntax = "proto3";
            package audit.bridge;
            """);
        var schema = ProtoSchema.ParseFiles([dependency, path]);
        Equal(3, schema.Messages.Count, "message count");
        Equal(1, schema.Enums.Count, "enum count");
        Equal(2, schema.Messages["Envelope"].Fields.Count, "oneof field count");
        True(schema.Messages["Envelope"].Fields.All(item => item.IsOneof), "oneof flags");
        True(schema.Messages["Envelope"].Fields.All(item => item.OneofGroup == "payload"), "oneof group");
        Equal(2, schema.Messages["Payload"].Fields[1].Number, "field number");
        Equal("audit.bridge", schema.Package, "package");
    });
}

static void TestMissingProtoImport()
{
    WithTempDir(root =>
    {
        var path = Write(root, "missing_import.proto", """
            syntax = "proto3";
            import "missing.proto";
            message Example {}
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "not part of the parsed schema set");
    });
}

static void TestProtoImportTraversal()
{
    WithTempDir(root =>
    {
        var source = Write(root, "schema/source.proto", """
            syntax = "proto3";
            import "../outside.proto";
            message Source {}
            """);
        var outside = Write(root, "outside.proto", """
            syntax = "proto3";
            message Outside {}
            """);
        Throws(() => ProtoSchema.ParseFiles([source, outside]), "must stay inside");
    });
}

static void TestAmbiguousProtoImport()
{
    WithTempDir(root =>
    {
        var source = Write(root, "schema/source.proto", """
            syntax = "proto3";
            import "common.proto";
            message Source {}
            """);
        var first = Write(root, "schema/a/common.proto", """
            syntax = "proto3";
            message First {}
            """);
        var second = Write(root, "schema/b/common.proto", """
            syntax = "proto3";
            message Second {}
            """);
        Throws(() => ProtoSchema.ParseFiles([source, first, second]), "is ambiguous");
    });
}

static void TestProtoPackageMismatch()
{
    WithTempDir(root =>
    {
        var first = Write(root, "first.proto", """
            syntax = "proto3";
            package first.bridge;
            message First {}
            """);
        var second = Write(root, "second.proto", """
            syntax = "proto3";
            package second.bridge;
            message Second {}
            """);
        Throws(() => ProtoSchema.ParseFiles([first, second]), "does not match");
    });
}

static void TestUnsupportedProto()
{
    WithTempDir(root =>
    {
        var path = Write(root, "unsupported.proto", """
            syntax = "proto3";
            message Example {
              optional string title = 1;
            }
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "unsupported message syntax");
    });
}

static void TestDuplicateProtoFields()
{
    WithTempDir(root =>
    {
        var path = Write(root, "duplicate.proto", """
            syntax = "proto3";
            message Example {
              string first = 1;
              string second = 1;
            }
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "duplicate field number");
    });
}

static void TestUnclosedProto()
{
    WithTempDir(root =>
    {
        var path = Write(root, "unclosed.proto", """
            syntax = "proto3";
            message Example {
              string title = 1;
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "unclosed message");
    });
}

static void TestUnknownProtoType()
{
    WithTempDir(root =>
    {
        var path = Write(root, "unknown.proto", """
            syntax = "proto3";
            message Example {
              Missing value = 1;
            }
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "unknown type");
    });
}

static void TestProtoEnumZero()
{
    WithTempDir(root =>
    {
        var path = Write(root, "enum.proto", """
            syntax = "proto3";
            enum Kind {
              KIND_VALUE = 1;
            }
            """);
        Throws(() => ProtoSchema.ParseFiles([path]), "first value must be zero");
    });
}

static void TestValidSystemSchema()
{
    WithTempDir(root =>
    {
        Write(root, "scripts/input_system.gd", "extends RefCounted\n");
        Write(root, "scripts/input_context.gd", "extends RefCounted\n");
        Write(root, "scripts/view_system.gd", "extends RefCounted\n");
        Write(root, "scripts/view_context.gd", "extends RefCounted\n");
        var schemaPath = Write(root, "schema/systems.toml", """
            [godot.phases]
            order = ["input", "present"]

            [godot.system.input]
            phase = "input"
            script = "res://scripts/input_system.gd"
            context = "res://scripts/input_context.gd"

            [godot.system.view]
            phase = "present"
            script = "res://scripts/view_system.gd"
            context = "res://scripts/view_context.gd"
            input = "input"

            [core.phases]
            order = ["simulation"]

            [core.system.simulation]
            phase = "simulation"
            type = "SimulationSystem"
            """);

        var schema = SystemSchemaParser.Parse(root, schemaPath);
        Equal(2, schema.Godot.Systems.Count, "godot system count");
        Equal("input", schema.Godot.Systems[1].Refs[0].Target, "godot ref target");
        Equal("SimulationSystem", schema.Core.Systems[0].Type, "core type");
    });
}

static void TestDuplicateCoreSystem()
{
    WithTempDir(root =>
    {
        var schemaPath = WriteMinimalGodot(root, """
            [core.phases]
            order = ["simulation"]

            [core.system.simulation]
            phase = "simulation"
            type = "SimulationSystem"

            [core.system.simulation]
            phase = "simulation"
            type = "OtherSystem"
            """);
        Throws(() => SystemSchemaParser.Parse(root, schemaPath), "duplicate core system");
    });
}

static void TestUnknownCorePhase()
{
    WithTempDir(root =>
    {
        var schemaPath = WriteMinimalGodot(root, """
            [core.phases]
            order = ["simulation"]

            [core.system.simulation]
            phase = "missing"
            type = "SimulationSystem"
            """);
        Throws(() => SystemSchemaParser.Parse(root, schemaPath), "outside phases.order");
    });
}

static void TestProjectNameValidation()
{
    Craft.ValidateProjectName("valid_game2");
    Throws(() => Craft.ValidateProjectName("2invalid"), "start with a letter");
    Throws(() => Craft.ValidateProjectName("invalid game"), "start with a letter");
    Throws(() => Craft.ValidateProjectName("../escape"), "start with a letter");
}

static void TestUnknownFwConfigKey()
{
    WithTempDir(root =>
    {
        Write(root, "fw.toml", """
            [project]
            name = "audit"
            typo = "ignored"
            """);
        Throws(() => FwConfig.Load(root), "unsupported fw.toml key");
    });
}

static void TestFwConfigPathContainment()
{
    WithTempDir(root =>
    {
        Write(root, "fw.toml", """
            [gen]
            csharp = "../outside"
            """);
        var config = FwConfig.Load(root);
        Throws(() => config.GenerationManifestPath(root), "escapes project root");
    });
}

static void TestManifestOutputSet()
{
    WithTempDir(root =>
    {
        Write(root, "fw.toml", """
            [project]
            name = "audit"
            [schema]
            system = "schema/systems.toml"
            bridge = "schema/bridge"
            config = "schema/config"
            [gen]
            gdscript = "scripts/_gen"
            csharp = "csharp/_gen"
            [data]
            config = "data/config"
            [pack]
            config = "pack/config"
            [script]
            gdscript = "scripts"
            csharp = "csharp"
            [dotnet]
            game = "audit.csproj"
            fwgen = "fw/csharp/FwGen/FwGen.csproj"
            """);
        Write(root, "fw/csharp/FwGen/source.cs", "class Source {}\n");
        Write(root, "fw/csharp/FwGen/FwGen.csproj", "<Project />\n");
        Write(root, "fw/csharp/Directory.Build.props", "<Project />\n");
        Write(root, "schema/systems.toml", "systems\n");
        Write(root, "schema/bridge/value.proto", "syntax = \"proto3\";\n");
        Write(root, "schema/config/game.proto", "syntax = \"proto3\";\n");
        Write(root, "data/config/game.csv.txt", "key\ndefault\n");

        var config = FwConfig.Load(root);
        var outputs = new[]
        {
            config.GodotSystemsGdPath(root),
            config.CoreSystemsCsPath(root),
            Path.Combine(config.GodotGenDir(root), "_bridge.gd"),
            config.BridgeTypesCsPath(root),
            config.BridgeCodecCsPath(root),
            config.BridgeIntentCodecCsPath(root),
            config.BridgeEventCodecCsPath(root),
            config.BridgePacketCodecCsPath(root),
            config.ConfigGdPath(root),
            config.ConfigContractCsPath(root),
            config.ConfigCodecCsPath(root),
        };
        foreach (var output in outputs)
        {
            Write(root, Path.GetRelativePath(root, output), "generated\n");
        }

        GenerationManifest.UpdateSystem(root, config);
        GenerationManifest.UpdateBridge(root, config);
        GenerationManifest.UpdateConfig(root, config);
        File.WriteAllText(Path.Combine(root, "data/config/game.csv.txt"), "key\ndefault_changed\n");
        GenerationManifest.Verify(root, config);
        var manifestPath = config.GenerationManifestPath(root);
        var model = System.Text.Json.JsonSerializer.Deserialize<GenerationManifestModel>(File.ReadAllText(manifestPath))!;
        model.Commands["bridge"].Outputs.RemoveAt(0);
        File.WriteAllText(manifestPath, System.Text.Json.JsonSerializer.Serialize(model));
        Throws(() => GenerationManifest.Verify(root, config), "output set is incomplete");
    });
}

static void TestAtomicWrite()
{
    WithTempDir(root =>
    {
        var path = Path.Combine(root, "out", "value.txt");
        TextUtil.WriteText(path, "first  \n");
        TextUtil.WriteText(path, "second  \n");
        Equal("second\n", File.ReadAllText(path), "atomic output");
        Equal(0, Directory.GetFiles(Path.GetDirectoryName(path)!, "*.tmp.*").Length, "temporary files");
    });
}

static void TestBridgeZeroDefaults()
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
        True(events.Contains("BridgeCodec.ReadString", StringComparison.Ordinal) || events.Contains("ev.Payload", StringComparison.Ordinal), "event codec generated");
    });
}

static void TestConfigPackHeader()
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

static void TestInvalidFixed32Marker()
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

static void TestConfigReferenceValidation()
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

static void TestDuplicateConfigKey()
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

static void TestGenerationLock()
{
    WithTempDir(root =>
    {
        using var first = GenerationLock.Acquire(root, TimeSpan.FromSeconds(1));
        Throws(() =>
        {
            using var second = GenerationLock.Acquire(root, TimeSpan.FromMilliseconds(25));
        }, "timed out waiting");
    });
}

static void TestWireFrameRoundTrip()
{
    byte[] value = System.Text.Encoding.UTF8.GetBytes(new string('a', 4096));
    byte[] frame = WireFrame.Encode(value, new WireFrameOptions(64, 8192, 8192));
    True(WireFrame.HasHeader(frame), "wire header");
    True(WireFrame.Decode(frame, new WireFrameOptions(64, 8192, 8192)).SequenceEqual(value), "wire round trip");
}

static void TestWireFrameTampering()
{
    byte[] frame = WireFrame.Encode("payload"u8);
    frame[^1] ^= 0xff;
    Throws(() => WireFrame.Decode(frame), "checksum mismatch");
    Throws(() => WireFrame.Encode(new byte[32], new WireFrameOptions(0, 16, 64)), "decoded limit");
    Throws(() => WireFrame.Decode(frame, new WireFrameOptions(0, 64, int.MaxValue)), "limits are invalid");
}

static void TestSystemInitRollback()
{
    var calls = new List<string>();
    var runtime = new SystemRuntime();
    runtime.SetPhaseOrder(["first", "second"]);
    runtime.Add("first", new ProbeSystem(
        () => calls.Add("init:first"),
        () => calls.Add("shutdown:first")
    ), new object(), "first");
    runtime.Add("second", new ProbeSystem(
        () =>
        {
            calls.Add("init:second");
            throw new InvalidOperationException("init failed");
        },
        () => calls.Add("shutdown:second")
    ), new object(), "second");

    Throws(runtime.InitAll, "initialization failed");
    Equal(SystemRuntimeState.Stopped, runtime.State, "runtime state after rollback");
    Equal(
        "init:first,init:second,shutdown:second,shutdown:first",
        string.Join(',', calls),
        "rollback order"
    );
}

static void TestSystemShutdownContinues()
{
    var calls = new List<string>();
    var runtime = new SystemRuntime();
    runtime.Add("first", new ProbeSystem(
        () => calls.Add("init:first"),
        () => calls.Add("shutdown:first")
    ), new object());
    runtime.Add("second", new ProbeSystem(
        () => calls.Add("init:second"),
        () =>
        {
            calls.Add("shutdown:second");
            throw new InvalidOperationException("shutdown failed");
        }
    ), new object());

    runtime.InitAll();
    Throws(runtime.ShutdownAll, "failed to shut down");
    Equal(SystemRuntimeState.Stopped, runtime.State, "runtime state after shutdown error");
    Equal("init:first,init:second,shutdown:second,shutdown:first", string.Join(',', calls), "shutdown order");
    runtime.ShutdownAll();
}

static string WriteMinimalGodot(string root, string coreSchema)
{
    Write(root, "scripts/game_system.gd", "extends RefCounted\n");
    Write(root, "scripts/game_context.gd", "extends RefCounted\n");
    return Write(root, "schema/systems.toml", """
        [godot.phases]
        order = ["present"]

        [godot.system.game]
        phase = "present"
        script = "res://scripts/game_system.gd"
        context = "res://scripts/game_context.gd"

        """ + coreSchema);
}

static void WriteProjectConfig(string root)
{
    Write(root, "fw.toml", """
        [project]
        name = "audit"
        """);
}

static string Write(string root, string relativePath, string content)
{
    var path = Path.Combine(root, relativePath.Replace('/', Path.DirectorySeparatorChar));
    Directory.CreateDirectory(Path.GetDirectoryName(path)!);
    File.WriteAllText(path, content);
    return path;
}

static void WithTempDir(Action<string> action)
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

static void Throws(Action action, string expected)
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

static void Equal<T>(T expected, T actual, string label)
{
    if (!EqualityComparer<T>.Default.Equals(expected, actual))
    {
        throw new InvalidOperationException($"{label}: expected `{expected}`, got `{actual}`");
    }
}

static void True(bool value, string label)
{
    if (!value)
    {
        throw new InvalidOperationException($"{label}: expected true");
    }
}

sealed class ProbeSystem(Action init, Action shutdown) : ISystem<object>
{
    public void Init(object context)
    {
        _ = context;
        init();
    }

    public void Tick(float dt)
    {
        _ = dt;
    }

    public void Shutdown()
    {
        shutdown();
    }
}
