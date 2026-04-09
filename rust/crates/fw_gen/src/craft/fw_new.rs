use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use heck::{ToPascalCase, ToSnakeCase};

use crate::cmd;
use crate::support::util::{read_utf8, write_utf8};

const PLACEHOLDER_PROJECT_NAME: &str = "__PROJECT_NAME__";
const PLACEHOLDER_PROJECT_NAME_SNAKE: &str = "__PROJECT_NAME_SNAKE__";
const PLACEHOLDER_PROJECT_NAME_PASCAL: &str = "__PROJECT_NAME_PASCAL__";
const PLACEHOLDER_LIBRARY_NAME: &str = "__LIB_NAME__";

pub fn run(project_root: &Path, name: Option<&str>, force: bool) -> Result<()> {
    ensure_godot_project(project_root)?;

    let project_name = resolve_project_name(project_root, name)?;
    let project_name_snake = project_name.to_snake_case();
    let project_name_pascal = project_name.to_pascal_case();
    let library_name = format!("{project_name_snake}_bridge");

    let template_root = template_root();
    if !template_root.exists() {
        bail!("fw_new template root missing: {}", template_root.display());
    }

    copy_template_dir(
        &template_root,
        &template_root,
        project_root,
        &project_name,
        &project_name_snake,
        &project_name_pascal,
        &library_name,
        force,
    )?;

    ensure_project_main_scene(project_root, "res://scenes/main.tscn")?;

    cmd::system::generate(
        project_root,
        &project_root.join("schema/system.toml"),
        &project_root.join("scripts/gen/_graph.gd"),
    )?;
    cmd::bridge::generate(
        project_root,
        &project_root.join("schema/bridge"),
        &project_root.join("scripts/gen"),
        &project_root.join("rust/crates/bridge/_gen"),
        &project_root.join("rust/crates/core/src/_gen"),
    )?;
    cmd::config::generate(
        project_root,
        &project_root.join("schema/config"),
        &project_root.join("data/config"),
        &project_root.join("scripts/gen/_config.gd"),
        &project_root.join("rust/crates/core/src/_gen/_config.rs"),
        &project_root.join("rust/crates/core/src/_gen/_config_types.rs"),
    )?;

    println!(
        "Created fw project skeleton:\n  root : {}\n  name : {}\n  scene: scenes/main.tscn",
        project_root.display(),
        project_name
    );
    Ok(())
}

fn template_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("templates")
        .join("fw_new")
        .join("default")
}

fn ensure_godot_project(project_root: &Path) -> Result<()> {
    let project_godot = project_root.join("project.godot");
    if !project_godot.exists() {
        bail!(
            "fw_new requires an existing Godot project. Missing {}",
            project_godot.display()
        );
    }
    Ok(())
}

fn resolve_project_name(project_root: &Path, input: Option<&str>) -> Result<String> {
    if let Some(name) = input {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            bail!("fw_new project name cannot be empty");
        }
        return Ok(trimmed.to_owned());
    }

    let Some(name) = project_root.file_name().and_then(|value| value.to_str()) else {
        bail!("failed to infer project name from {}", project_root.display());
    };
    let trimmed = name.trim();
    if trimmed.is_empty() {
        bail!("failed to infer project name from {}", project_root.display());
    }
    Ok(trimmed.to_owned())
}

fn copy_template_dir(
    current_dir: &Path,
    template_root: &Path,
    project_root: &Path,
    project_name: &str,
    project_name_snake: &str,
    project_name_pascal: &str,
    library_name: &str,
    force: bool,
) -> Result<()> {
    for entry in fs::read_dir(current_dir)? {
        let path = entry?.path();
        if path.is_dir() {
            let rel = path.strip_prefix(template_root).unwrap_or(&path);
            let target_dir = project_root.join(rel);
            fs::create_dir_all(&target_dir)?;
            copy_template_dir(
                &path,
                template_root,
                project_root,
                project_name,
                project_name_snake,
                project_name_pascal,
                library_name,
                force,
            )?;
            continue;
        }

        let rel = path.strip_prefix(template_root).unwrap_or(&path);
        let rel_text = rel.to_string_lossy().replace('\\', "/");
        let target_rel = rel_text.strip_suffix(".tpl").unwrap_or(&rel_text);
        let target = project_root.join(PathBuf::from(target_rel));
        let raw = read_utf8(&path)?;
        let rendered = raw
            .replace(PLACEHOLDER_PROJECT_NAME, project_name)
            .replace(PLACEHOLDER_PROJECT_NAME_SNAKE, project_name_snake)
            .replace(PLACEHOLDER_PROJECT_NAME_PASCAL, project_name_pascal)
            .replace(PLACEHOLDER_LIBRARY_NAME, library_name);

        if target.exists() && !force {
            let existing = read_utf8(&target).unwrap_or_default();
            if existing == rendered {
                continue;
            }
            bail!(
                "fw_new refuses to overwrite existing file without --force: {}",
                target.display()
            );
        }
        write_utf8(&target, &rendered)?;
    }
    Ok(())
}

fn ensure_project_main_scene(project_root: &Path, main_scene: &str) -> Result<()> {
    let path = project_root.join("project.godot");
    let text = read_utf8(&path).with_context(|| format!("failed to read {}", path.display()))?;
    let mut lines = text.lines().map(str::to_owned).collect::<Vec<_>>();

    let mut application_index: Option<usize> = None;
    let mut next_section_index: Option<usize> = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed == "[application]" {
            application_index = Some(index);
            continue;
        }
        if application_index.is_some()
            && trimmed.starts_with('[')
            && trimmed.ends_with(']')
            && next_section_index.is_none()
        {
            next_section_index = Some(index);
            break;
        }
    }

    let main_scene_line = format!("run/main_scene=\"{main_scene}\"");
    if let Some(section_start) = application_index {
        let section_end = next_section_index.unwrap_or(lines.len());
        for index in (section_start + 1)..section_end {
            if lines[index].trim_start().starts_with("run/main_scene=") {
                lines[index] = main_scene_line;
                write_utf8(&path, &lines.join("\n"))?;
                return Ok(());
            }
        }
        lines.insert(section_end, main_scene_line);
        write_utf8(&path, &lines.join("\n"))?;
        return Ok(());
    }

    if !lines.is_empty() && !lines.last().is_some_and(|line| line.is_empty()) {
        lines.push(String::new());
    }
    lines.push("[application]".to_owned());
    lines.push(main_scene_line);
    write_utf8(&path, &lines.join("\n"))?;
    Ok(())
}
