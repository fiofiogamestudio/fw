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
data_config = "data/config"

[gen]
gd_dir = "scripts/gen"
graph_gd = "scripts/gen/_graph.gd"
config_gd = "scripts/gen/_config.gd"
config_pack_dir = "data/gen/config"
