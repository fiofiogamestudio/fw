using static TestKit;

static class SystemTests
{
    internal static TestCase[] Cases =>
    [
        new("valid system schema", TestValidSystemSchema),
        new("duplicate core system fails", TestDuplicateCoreSystem),
        new("unknown core phase fails", TestUnknownCorePhase),
        new("project name validation", TestProjectNameValidation),
        new("fw config rejects unknown keys", TestUnknownFwConfigKey),
        new("fw config contains paths", TestFwConfigPathContainment),
        new("manifest requires complete outputs", TestManifestOutputSet),
        new("atomic text write", TestAtomicWrite),
    ];

    private static void TestValidSystemSchema()
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

    private static void TestDuplicateCoreSystem()
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

    private static void TestUnknownCorePhase()
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

    private static void TestProjectNameValidation()
    {
        Craft.ValidateProjectName("valid_game2");
        Throws(() => Craft.ValidateProjectName("2invalid"), "start with a letter");
        Throws(() => Craft.ValidateProjectName("invalid game"), "start with a letter");
        Throws(() => Craft.ValidateProjectName("../escape"), "start with a letter");
    }

    private static void TestUnknownFwConfigKey()
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

    private static void TestFwConfigPathContainment()
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

    private static void TestManifestOutputSet()
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

    private static void TestAtomicWrite()
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

    private static string WriteMinimalGodot(string root, string coreSchema)
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
}
