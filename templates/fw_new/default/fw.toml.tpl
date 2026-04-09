[project]
name = "__PROJECT_NAME__"

[godot]
main_scene = "scenes/main.tscn"
app_script = "scripts/app/main_app.gd"

[rust]
workspace = "rust/Cargo.toml"
generator_manifest = "fw/rust/Cargo.toml"
generator_package = "fw_gen"
library_package = "bridge"
library_name = "__LIB_NAME__"
bin_dir = "bin"

[schema]
bridge = "schema/bridge"
config = "schema/config"
system = "schema/system.toml"
data_config = "data/config"

[gen]
gd_dir = "scripts/gen"
graph_gd = "scripts/gen/_graph.gd"
bridge_rust_out = "rust/crates/bridge/_gen"
core_rust_out = "rust/crates/core/src/_gen"
config_gd = "scripts/gen/_config.gd"
config_rust_reader = "rust/crates/core/src/_gen/_config.rs"
config_rust_types = "rust/crates/core/src/_gen/_config_types.rs"
config_pack_dir = "data/gen/config"
