[project]
name = "__PROJECT_NAME__"

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
game = "__PROJECT_NAME__.csproj"
fwgen = "fw/csharp/FwGen/FwGen.csproj"
