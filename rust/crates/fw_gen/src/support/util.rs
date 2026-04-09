use std::fs;
use std::path::{Path, PathBuf};

use anyhow::Result;
use heck::{ToPascalCase, ToSnakeCase};

pub fn project_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .canonicalize()
        .expect("project root must exist")
}

pub fn read_utf8(path: &Path) -> Result<String> {
    Ok(fs::read_to_string(path)?)
}

pub fn write_utf8(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let needs_write = match fs::read_to_string(path) {
        Ok(old) => old != content,
        Err(_) => true,
    };
    if needs_write {
        fs::write(path, content)?;
    }
    Ok(())
}

pub fn list_proto_files(dir: &Path) -> Result<Vec<PathBuf>> {
    let mut out = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.is_dir() {
            out.extend(list_proto_files(&path)?);
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("proto") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

pub fn snake(name: &str) -> String {
    name.to_snake_case()
}

pub fn pascal(name: &str) -> String {
    name.to_pascal_case()
}

pub fn strip_suffix<'a>(value: &'a str, suffix: &str) -> &'a str {
    value.strip_suffix(suffix).unwrap_or(value)
}

pub fn indent(block: &str, spaces: usize) -> String {
    let prefix = " ".repeat(spaces);
    block
        .lines()
        .map(|line| {
            if line.is_empty() {
                String::new()
            } else {
                format!("{prefix}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn join_blocks(blocks: &[String]) -> String {
    blocks
        .iter()
        .filter(|block| !block.trim().is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n\n")
}
