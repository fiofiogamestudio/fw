use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Deserialize;

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct FConfig {
    pub project: ProjectConfig,
    pub godot: GodotConfig,
    pub rust: RustConfig,
    pub schema: SchemaConfig,
    pub gen: GenConfig,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct ProjectConfig {
    pub name: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct GodotConfig {
    pub main_scene: String,
    pub app_script: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct RustConfig {
    pub workspace: String,
    pub generator_package: String,
    pub library_package: String,
    pub library_name: String,
    pub bin_dir: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct SchemaConfig {
    pub bridge: String,
    pub config: String,
    pub system: String,
    pub data_config: String,
}

#[derive(Default, Deserialize)]
#[serde(default)]
pub struct GenConfig {
    pub gd_dir: String,
    pub graph_gd: String,
    pub bridge_rust_out: String,
    pub core_rust_out: String,
    pub config_gd: String,
    pub config_rust_reader: String,
    pub config_rust_types: String,
    pub config_pack_dir: String,
}

impl FConfig {
    pub fn load(project_root: &Path) -> Result<Self> {
        let path = project_root.join("fw.toml");
        if !path.exists() {
            return Ok(Self::default());
        }
        let text = fs::read_to_string(&path)
            .with_context(|| format!("failed to read {}", path.display()))?;
        toml::from_str(&text).with_context(|| format!("failed to parse {}", path.display()))
    }
}
