[project]
name = "__PROJECT_NAME__"

[godot]
main_scene = "scenes/main.tscn"
app_script = "scripts/app/main_app.gd"

[csharp]
project = "__PROJECT_NAME__.csproj"
core_dir = "csharp/core"
bridge_dir = "csharp/bridge"

[generator]
project = "fw/csharp/FwGen/FwGen.csproj"

[schema]
bridge = "schema/bridge"
config = "schema/config"
system = "schema/system.toml"
core_system = "schema/core_system.toml"
data_config = "data/config"

[gen]
gd_dir = "scripts/gen"
graph_gd = "scripts/gen/_graph.gd"
systems_gd = "scripts/gen/_systems.gd"
config_gd = "scripts/gen/_config.gd"
config_pack_dir = "data/gen/config"
bridge_contract_cs = "csharp/core/state/bridge_contract.cs"
config_contract_cs = "csharp/core/config/config_contract.cs"
core_systems_cs = "csharp/core/core_systems.cs"
