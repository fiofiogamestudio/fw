[project]
name = "__PROJECT_NAME__"

[path]
schema = "schema"
systems = "schema/systems.toml"
bridge_schema = "schema/bridge"
config_schema = "schema/config"
config_data = "data/config"
gdscript = "scripts"
csharp = "csharp"

[path._gen]
config = "data/_gen/config"
gdscript = "scripts/_gen"
csharp = "csharp/_gen"

[dotnet]
game = "__PROJECT_NAME__.csproj"
generator = "fw/csharp/FwGen/FwGen.csproj"
