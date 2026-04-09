use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde_json::{Map, Number, Value};

use crate::support::proto::{parse_dir, FieldRule, ProtoField, ProtoMessage, ProtoSchema};
use crate::support::util::{indent, join_blocks, snake, strip_suffix, write_utf8};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceKind {
    Table,
    Tree,
}

#[derive(Clone, Debug)]
struct RootConfig {
    name: String,
    module: String,
    kind: SourceKind,
    source: String,
    message: ProtoMessage,
    ref_fields: BTreeSet<String>,
}

#[derive(Clone, Debug)]
struct ConfigModel {
    roots: Vec<RootConfig>,
    helpers: Vec<ProtoMessage>,
    messages: BTreeMap<String, ProtoMessage>,
    root_names: BTreeSet<String>,
}

#[derive(Clone, Debug)]
struct RawEntry {
    key: String,
    value: Value,
}

pub fn generate(
    project_root: &Path,
    schema_dir: &Path,
    data_root: &Path,
    gd_out: &Path,
    rust_reader_out: &Path,
    rust_types_out: &Path,
) -> Result<()> {
    let model = load_model(schema_dir)?;
    ensure_source_templates(data_root, &model)?;

    write_utf8(rust_types_out, &render_rust_types(&model))?;
    write_utf8(rust_reader_out, &render_rust_reader(&model))?;
    write_utf8(gd_out, &render_gd_reader(&model))?;

    println!(
        "Generated config interfaces:\n  schema : {}\n  data   : {}\n  gd out : {}\n  rust   : {}\n  types  : {}",
        display_rel(project_root, schema_dir),
        display_rel(project_root, data_root),
        display_rel(project_root, gd_out),
        display_rel(project_root, rust_reader_out),
        display_rel(project_root, rust_types_out),
    );
    Ok(())
}

pub fn check(project_root: &Path, schema_dir: &Path, data_root: &Path) -> Result<()> {
    let model = load_model(schema_dir)?;
    let raw_entries = load_all_raw_entries(data_root, &model)?;
    for root in &model.roots {
        let entries = raw_entries
            .get(&root.module)
            .with_context(|| format!("missing checked entries for {}", root.module))?;
        if entries.is_empty() {
            bail!("{} must contain at least one config entry", root.source);
        }
        if !entries.iter().any(|entry| entry.key == "default") {
            bail!("{} must contain key \"default\"", root.source);
        }
    }

    println!(
        "Checked config sources:\n  schema : {}\n  data   : {}",
        display_rel(project_root, schema_dir),
        display_rel(project_root, data_root),
    );
    Ok(())
}

pub fn pak(
    project_root: &Path,
    schema_dir: &Path,
    data_root: &Path,
    pack_out_dir: &Path,
) -> Result<()> {
    let model = load_model(schema_dir)?;
    let raw_entries = load_all_raw_entries(data_root, &model)?;

    fs::create_dir_all(pack_out_dir)?;
    for root in &model.roots {
        let entries = raw_entries
            .get(&root.module)
            .with_context(|| format!("missing pack entries for {}", root.module))?;
        let path = pack_out_dir.join(format!("{}.bin", root.module));
        write_bin_entries(&path, entries)?;
    }

    println!(
        "Packed config binaries:\n  schema : {}\n  data   : {}\n  out    : {}",
        display_rel(project_root, schema_dir),
        display_rel(project_root, data_root),
        display_rel(project_root, pack_out_dir),
    );
    Ok(())
}

fn load_model(schema_dir: &Path) -> Result<ConfigModel> {
    let schema = parse_dir(schema_dir)?;
    build_model(&schema)
}

fn build_model(schema: &ProtoSchema) -> Result<ConfigModel> {
    let root_names = schema
        .messages
        .keys()
        .filter(|name| name.ends_with("Config"))
        .cloned()
        .collect::<BTreeSet<_>>();
    if root_names.is_empty() {
        bail!("schema/config must define at least one *Config message");
    }

    let mut roots = Vec::new();
    for root_name in order_root_names(schema, &root_names)? {
        let message = schema
            .messages
            .get(&root_name)
            .cloned()
            .with_context(|| format!("missing root config message {root_name}"))?;
        let module = snake(strip_suffix(&root_name, "Config"));
        let ref_fields = message
            .fields
            .iter()
            .filter(|field| field.rule == FieldRule::Singular && root_names.contains(&field.ty))
            .map(|field| field.name.clone())
            .collect::<BTreeSet<_>>();
        let kind = infer_source_kind(schema, &root_names, &message)?;
        let ext = match kind {
            SourceKind::Table => "csv",
            SourceKind::Tree => "json",
        };
        roots.push(RootConfig {
            name: root_name.clone(),
            module: module.clone(),
            kind,
            source: format!("data/config/{}.{}", module, ext),
            message,
            ref_fields,
        });
    }

    let helpers = order_helper_messages(schema, &root_names)?;

    Ok(ConfigModel {
        roots,
        helpers,
        messages: schema.messages.clone(),
        root_names,
    })
}

fn order_root_names(schema: &ProtoSchema, root_names: &BTreeSet<String>) -> Result<Vec<String>> {
    fn visit(
        name: &str,
        schema: &ProtoSchema,
        root_names: &BTreeSet<String>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        out: &mut Vec<String>,
    ) -> Result<()> {
        if visited.contains(name) {
            return Ok(());
        }
        if !visiting.insert(name.to_owned()) {
            bail!("config root dependency cycle detected at {name}");
        }
        let message = schema
            .messages
            .get(name)
            .with_context(|| format!("missing root message {name}"))?;
        for field in &message.fields {
            if field.rule == FieldRule::Singular && root_names.contains(&field.ty) {
                visit(&field.ty, schema, root_names, visiting, visited, out)?;
            }
        }
        visiting.remove(name);
        visited.insert(name.to_owned());
        out.push(name.to_owned());
        Ok(())
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    for name in root_names {
        visit(
            name,
            schema,
            root_names,
            &mut visiting,
            &mut visited,
            &mut out,
        )?;
    }
    Ok(out)
}

fn order_helper_messages(
    schema: &ProtoSchema,
    root_names: &BTreeSet<String>,
) -> Result<Vec<ProtoMessage>> {
    fn visit(
        name: &str,
        schema: &ProtoSchema,
        root_names: &BTreeSet<String>,
        visiting: &mut BTreeSet<String>,
        visited: &mut BTreeSet<String>,
        out: &mut Vec<ProtoMessage>,
    ) -> Result<()> {
        if visited.contains(name) || root_names.contains(name) || name == "Fixed32" {
            return Ok(());
        }
        if !visiting.insert(name.to_owned()) {
            bail!("config helper dependency cycle detected at {name}");
        }
        let message = schema
            .messages
            .get(name)
            .with_context(|| format!("missing helper message {name}"))?;
        for field in &message.fields {
            if is_message_type(&field.ty, schema) {
                visit(&field.ty, schema, root_names, visiting, visited, out)?;
            }
        }
        visiting.remove(name);
        visited.insert(name.to_owned());
        out.push(message.clone());
        Ok(())
    }

    let mut visiting = BTreeSet::new();
    let mut visited = BTreeSet::new();
    let mut out = Vec::new();
    for name in schema.messages.keys() {
        visit(
            name,
            schema,
            root_names,
            &mut visiting,
            &mut visited,
            &mut out,
        )?;
    }
    Ok(out)
}

fn infer_source_kind(
    schema: &ProtoSchema,
    root_names: &BTreeSet<String>,
    message: &ProtoMessage,
) -> Result<SourceKind> {
    fn visit(
        name: &str,
        schema: &ProtoSchema,
        root_names: &BTreeSet<String>,
        visited: &mut BTreeSet<String>,
    ) -> Result<bool> {
        if !visited.insert(name.to_owned()) {
            return Ok(false);
        }
        let message = schema
            .messages
            .get(name)
            .with_context(|| format!("missing config message {name}"))?;
        for field in &message.fields {
            if field.rule == FieldRule::Repeated {
                return Ok(true);
            }
            if is_message_type(&field.ty, schema) && !root_names.contains(&field.ty) {
                if visit(&field.ty, schema, root_names, visited)? {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    let mut visited = BTreeSet::new();
    if visit(&message.name, schema, root_names, &mut visited)? {
        Ok(SourceKind::Tree)
    } else {
        Ok(SourceKind::Table)
    }
}

fn is_message_type(name: &str, schema: &ProtoSchema) -> bool {
    name == "Fixed32" || schema.messages.contains_key(name)
}

fn display_rel(project_root: &Path, path: &Path) -> String {
    path.strip_prefix(project_root)
        .unwrap_or(path)
        .display()
        .to_string()
}

fn ensure_source_templates(data_root: &Path, model: &ConfigModel) -> Result<()> {
    for root in &model.roots {
        let path = data_root.join(format!(
            "{}.{}",
            root.module,
            match root.kind {
                SourceKind::Table => "csv",
                SourceKind::Tree => "json",
            }
        ));
        if path.exists() {
            continue;
        }
        let content = match root.kind {
            SourceKind::Table => render_csv_template(root),
            SourceKind::Tree => render_json_template(root, model)?,
        };
        write_utf8(&path, &content)?;
    }
    Ok(())
}

fn render_csv_template(root: &RootConfig) -> String {
    let mut headers = vec!["key".to_owned()];
    headers.extend(root.message.fields.iter().map(|field| field.name.clone()));
    let mut values = vec!["default".to_owned()];
    values.extend(
        root.message
            .fields
            .iter()
            .map(|field| default_table_cell(root, field)),
    );
    format!("{}\n{}\n", headers.join(","), values.join(","))
}

fn default_table_cell(root: &RootConfig, field: &ProtoField) -> String {
    if root.ref_fields.contains(&field.name) {
        return "default".to_owned();
    }
    default_text_scalar(&field.ty)
}

fn render_json_template(root: &RootConfig, model: &ConfigModel) -> Result<String> {
    let mut obj = match default_json_value_for_message(&root.message.name, model)? {
        Value::Object(map) => map,
        _ => bail!("tree root {} default must be object", root.name),
    };
    obj.insert("key".to_owned(), Value::String("default".to_owned()));
    Ok(format!(
        "{}\n",
        serde_json::to_string_pretty(&Value::Array(vec![Value::Object(obj)]))?
    ))
}

fn default_text_scalar(proto_type: &str) -> String {
    match proto_type {
        "bool" => "false".to_owned(),
        "string" => String::new(),
        "Fixed32" => "0.0".to_owned(),
        _ => "0".to_owned(),
    }
}

fn default_json_value_for_message(name: &str, model: &ConfigModel) -> Result<Value> {
    let message = model
        .messages
        .get(name)
        .with_context(|| format!("missing message {name}"))?;
    let mut map = Map::new();
    for field in &message.fields {
        map.insert(
            field.name.clone(),
            default_raw_value_for_field(field, model, None)?,
        );
    }
    Ok(Value::Object(map))
}

fn load_all_raw_entries(
    data_root: &Path,
    model: &ConfigModel,
) -> Result<BTreeMap<String, Vec<RawEntry>>> {
    let mut out = BTreeMap::new();
    for root in &model.roots {
        let entries = load_root_raw_entries(data_root, model, &out, root)?;
        out.insert(root.module.clone(), entries);
    }
    Ok(out)
}

fn load_root_raw_entries(
    data_root: &Path,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    root: &RootConfig,
) -> Result<Vec<RawEntry>> {
    match root.kind {
        SourceKind::Table => load_table_root_entries(data_root, model, loaded, root),
        SourceKind::Tree => load_tree_root_entries(data_root, model, loaded, root),
    }
}

fn load_table_root_entries(
    data_root: &Path,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    root: &RootConfig,
) -> Result<Vec<RawEntry>> {
    let path = data_root.join(format!("{}.csv", root.module));
    let mut reader = csv::Reader::from_path(&path)
        .with_context(|| format!("failed to read csv {}", path.display()))?;
    let headers = reader
        .headers()
        .with_context(|| format!("failed to read csv headers {}", path.display()))?
        .iter()
        .enumerate()
        .map(|(index, value)| normalize_csv_header(value, index))
        .collect::<Vec<_>>();
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for (row_index, result) in reader.records().enumerate() {
        let record = result.with_context(|| {
            format!(
                "failed to read csv record {} in {}",
                row_index,
                path.display()
            )
        })?;
        let mut row = BTreeMap::new();
        for (header, value) in headers.iter().zip(record.iter()) {
            row.insert(header.clone(), value.to_owned());
        }
        let ctx = format!("{}[{}]", root.module, row_index);
        let key = row
            .get("key")
            .map(String::as_str)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("{ctx} missing column key"))?
            .to_owned();
        if !seen.insert(key.clone()) {
            bail!("{ctx} duplicates key {key}");
        }
        let value = normalize_table_root_value(root, &row, model, loaded, &ctx)?;
        entries.push(RawEntry { key, value });
    }
    Ok(entries)
}

fn load_tree_root_entries(
    data_root: &Path,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    root: &RootConfig,
) -> Result<Vec<RawEntry>> {
    let path = data_root.join(format!("{}.json", root.module));
    let text = fs::read_to_string(&path)
        .with_context(|| format!("failed to read json {}", path.display()))?;
    let parsed: Value = serde_json::from_str(&text)
        .with_context(|| format!("failed to parse json {}", path.display()))?;
    let items = parsed
        .as_array()
        .with_context(|| format!("{} must be a json array", path.display()))?;
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for (index, item) in items.iter().enumerate() {
        let ctx = format!("{}[{}]", root.module, index);
        let obj = item
            .as_object()
            .with_context(|| format!("{ctx} must be a json object"))?;
        let key = obj
            .get("key")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .with_context(|| format!("{ctx} missing field key"))?
            .to_owned();
        if !seen.insert(key.clone()) {
            bail!("{ctx} duplicates key {key}");
        }
        let value = normalize_tree_message_value(&root.message.name, item, model, loaded, &ctx)?;
        entries.push(RawEntry { key, value });
    }
    Ok(entries)
}

fn normalize_csv_header(header: &str, index: usize) -> String {
    if index == 0 {
        header.trim_start_matches('\u{feff}').to_owned()
    } else {
        header.to_owned()
    }
}

fn normalize_table_root_value(
    root: &RootConfig,
    row: &BTreeMap<String, String>,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    ctx: &str,
) -> Result<Value> {
    let mut out = Map::new();
    for field in &root.message.fields {
        let value = if root.ref_fields.contains(&field.name) {
            let dep_module = snake(strip_suffix(&field.ty, "Config"));
            let ref_key = row
                .get(&field.name)
                .map(String::as_str)
                .filter(|value| !value.is_empty())
                .unwrap_or("default");
            clone_raw_required(
                loaded.get(&dep_module).with_context(|| {
                    format!(
                        "{ctx}.{} missing loaded dependency {}",
                        field.name, dep_module
                    )
                })?,
                ref_key,
                &format!("{ctx}.{}", field.name),
            )?
        } else if let Some(cell) = row.get(&field.name) {
            normalize_text_scalar(&field.ty, cell, &format!("{ctx}.{}", field.name))?
        } else {
            default_raw_value_for_field(field, model, Some(loaded))?
        };
        out.insert(field.name.clone(), value);
    }
    Ok(Value::Object(out))
}

fn normalize_tree_message_value(
    message_name: &str,
    value: &Value,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    ctx: &str,
) -> Result<Value> {
    let message = model
        .messages
        .get(message_name)
        .with_context(|| format!("missing message {message_name}"))?;
    let obj = value
        .as_object()
        .with_context(|| format!("{ctx} must be a json object"))?;
    let mut out = Map::new();
    for field in &message.fields {
        let field_ctx = format!("{ctx}.{}", field.name);
        let normalized = match obj.get(&field.name) {
            Some(field_value) => {
                normalize_json_field(field, field_value, model, loaded, &field_ctx)?
            }
            None => default_raw_value_for_field(field, model, Some(loaded))?,
        };
        out.insert(field.name.clone(), normalized);
    }
    Ok(Value::Object(out))
}

fn normalize_json_field(
    field: &ProtoField,
    value: &Value,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    ctx: &str,
) -> Result<Value> {
    if field.rule == FieldRule::Repeated {
        let items = value
            .as_array()
            .with_context(|| format!("{ctx} must be a json array"))?;
        let mut out = Vec::new();
        for (index, item) in items.iter().enumerate() {
            out.push(normalize_json_singular(
                &field.ty,
                item,
                model,
                loaded,
                &format!("{ctx}[{index}]"),
            )?);
        }
        return Ok(Value::Array(out));
    }
    normalize_json_singular(&field.ty, value, model, loaded, ctx)
}

fn normalize_json_singular(
    proto_type: &str,
    value: &Value,
    model: &ConfigModel,
    loaded: &BTreeMap<String, Vec<RawEntry>>,
    ctx: &str,
) -> Result<Value> {
    if is_scalar_type(proto_type) {
        return normalize_json_scalar(proto_type, value, ctx);
    }
    if model.root_names.contains(proto_type) {
        if let Some(key) = value.as_str() {
            let dep_module = snake(strip_suffix(proto_type, "Config"));
            return clone_raw_required(
                loaded
                    .get(&dep_module)
                    .with_context(|| format!("{ctx} missing loaded dependency {}", dep_module))?,
                key,
                ctx,
            );
        }
    }
    normalize_tree_message_value(proto_type, value, model, loaded, ctx)
}

fn clone_raw_required(entries: &[RawEntry], key: &str, ctx: &str) -> Result<Value> {
    entries
        .iter()
        .find(|entry| entry.key == key)
        .map(|entry| entry.value.clone())
        .with_context(|| format!("{ctx} references missing key {key}"))
}

fn write_bin_entries(path: &Path, entries: &[RawEntry]) -> Result<()> {
    let payload = entries
        .iter()
        .map(|entry| {
            let mut obj = Map::new();
            obj.insert("key".to_owned(), Value::String(entry.key.clone()));
            obj.insert("value".to_owned(), entry.value.clone());
            Value::Object(obj)
        })
        .collect::<Vec<_>>();
    let json = serde_json::to_vec(&payload)?;
    let mut out = Vec::with_capacity(4 + json.len());
    out.extend_from_slice(b"WCFG");
    out.extend_from_slice(&json);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, out)?;
    Ok(())
}

fn default_raw_value_for_field(
    field: &ProtoField,
    model: &ConfigModel,
    loaded: Option<&BTreeMap<String, Vec<RawEntry>>>,
) -> Result<Value> {
    if field.rule == FieldRule::Repeated {
        return Ok(Value::Array(Vec::new()));
    }
    if is_scalar_type(&field.ty) {
        return default_raw_scalar(&field.ty);
    }
    if model.root_names.contains(&field.ty) {
        let dep_module = snake(strip_suffix(&field.ty, "Config"));
        if let Some(loaded) = loaded {
            return clone_raw_required(
                loaded
                    .get(&dep_module)
                    .with_context(|| format!("missing loaded dependency {}", dep_module))?,
                "default",
                &dep_module,
            );
        }
        return Ok(default_json_value_for_message(&field.ty, model)?);
    }
    default_json_value_for_message(&field.ty, model)
}

fn default_raw_scalar(proto_type: &str) -> Result<Value> {
    match proto_type {
        "bool" => Ok(Value::Bool(false)),
        "string" => Ok(Value::String(String::new())),
        "Fixed32" => Ok(Value::Number(Number::from(0))),
        "int32" | "int64" | "uint32" | "uint64" => Ok(Value::Number(Number::from(0))),
        other => bail!("unsupported scalar type {other}"),
    }
}

fn normalize_text_scalar(proto_type: &str, text: &str, ctx: &str) -> Result<Value> {
    match proto_type {
        "bool" => Ok(Value::Bool(parse_text_bool(text, ctx)?)),
        "string" => Ok(Value::String(text.to_owned())),
        "Fixed32" => Ok(Value::Number(Number::from(parse_text_fixed_raw(
            text, ctx,
        )?))),
        "int32" | "int64" => Ok(Value::Number(Number::from(parse_text_i64(text, ctx)?))),
        "uint32" | "uint64" => Ok(Value::Number(Number::from(parse_text_u64(text, ctx)?))),
        other => bail!("unsupported scalar type {other}"),
    }
}

fn normalize_json_scalar(proto_type: &str, value: &Value, ctx: &str) -> Result<Value> {
    match proto_type {
        "bool" => Ok(Value::Bool(
            value
                .as_bool()
                .with_context(|| format!("{ctx} must be bool"))?,
        )),
        "string" => Ok(Value::String(
            value
                .as_str()
                .with_context(|| format!("{ctx} must be string"))?
                .to_owned(),
        )),
        "Fixed32" => {
            if let Some(raw) = value.as_i64() {
                Ok(Value::Number(Number::from(raw)))
            } else {
                let number = value
                    .as_f64()
                    .with_context(|| format!("{ctx} must be fixed-compatible number"))?;
                Ok(Value::Number(Number::from((number * 256.0) as i64)))
            }
        }
        "int32" | "int64" => {
            Ok(Value::Number(Number::from(value.as_i64().with_context(
                || format!("{ctx} must be int-compatible number"),
            )?)))
        }
        "uint32" | "uint64" => {
            Ok(Value::Number(Number::from(value.as_u64().with_context(
                || format!("{ctx} must be uint-compatible number"),
            )?)))
        }
        other => bail!("unsupported scalar type {other}"),
    }
}

fn is_scalar_type(proto_type: &str) -> bool {
    matches!(
        proto_type,
        "int32" | "int64" | "uint32" | "uint64" | "bool" | "string" | "Fixed32"
    )
}

fn parse_text_bool(text: &str, ctx: &str) -> Result<bool> {
    match text.to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" => Ok(true),
        "0" | "false" | "no" => Ok(false),
        _ => bail!("{ctx} must be bool-compatible text"),
    }
}

fn parse_text_fixed_raw(text: &str, ctx: &str) -> Result<i64> {
    let value = text
        .parse::<f64>()
        .with_context(|| format!("{ctx} must be float-compatible text"))?;
    Ok((value * 256.0) as i64)
}

fn parse_text_i64(text: &str, ctx: &str) -> Result<i64> {
    text.parse::<i64>()
        .with_context(|| format!("{ctx} must be int-compatible text"))
}

fn parse_text_u64(text: &str, ctx: &str) -> Result<u64> {
    text.parse::<u64>()
        .with_context(|| format!("{ctx} must be uint-compatible text"))
}

fn render_rust_types(model: &ConfigModel) -> String {
    let mut blocks = Vec::new();
    blocks.push(
        "// This file is generated by fw_gen. Do not edit manually.\n#![allow(dead_code)]\n\nuse fw::Fixed;\n"
            .to_owned(),
    );
    for message in &model.helpers {
        blocks.push(render_rust_message_type(message));
    }
    for root in &model.roots {
        blocks.push(render_rust_message_type(&root.message));
    }
    format!("{}\n", join_blocks(&blocks))
}

fn render_rust_message_type(message: &ProtoMessage) -> String {
    let derives = if rust_message_is_copy(message) {
        "#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default, serde::Serialize, serde::Deserialize)]"
    } else {
        "#[derive(Clone, PartialEq, Debug, Default, serde::Serialize, serde::Deserialize)]"
    };
    let fields = message
        .fields
        .iter()
        .map(|field| format!("    pub {}: {},", field.name, rust_type_for_field(field)))
        .collect::<Vec<_>>()
        .join("\n");
    format!("{derives}\npub struct {} {{\n{}\n}}", message.name, fields)
}

fn rust_message_is_copy(message: &ProtoMessage) -> bool {
    message
        .fields
        .iter()
        .all(|field| field.rule == FieldRule::Singular && rust_type_is_copy_like(&field.ty))
}

fn rust_type_is_copy_like(proto_type: &str) -> bool {
    matches!(
        proto_type,
        "int32" | "int64" | "uint32" | "uint64" | "bool" | "Fixed32"
    )
}

fn rust_type_for_field(field: &ProtoField) -> String {
    let base = rust_type_for_proto(&field.ty);
    if field.rule == FieldRule::Repeated {
        format!("Vec<{base}>")
    } else {
        base
    }
}

fn rust_type_for_proto(proto_type: &str) -> String {
    match proto_type {
        "int32" => "i32".to_owned(),
        "int64" => "i64".to_owned(),
        "uint32" => "u32".to_owned(),
        "uint64" => "u64".to_owned(),
        "bool" => "bool".to_owned(),
        "string" => "String".to_owned(),
        "Fixed32" => "Fixed".to_owned(),
        other => other.to_owned(),
    }
}

fn render_rust_reader(model: &ConfigModel) -> String {
    let type_names = model
        .helpers
        .iter()
        .map(|message| message.name.clone())
        .chain(model.roots.iter().map(|root| root.name.clone()))
        .collect::<Vec<_>>();
    let parse_functions = model
        .helpers
        .iter()
        .map(|message| render_rust_json_parser(message, model))
        .chain(
            model
                .roots
                .iter()
                .map(|root| render_rust_json_parser(&root.message, model)),
        )
        .collect::<Vec<_>>();
    let modules = model
        .roots
        .iter()
        .map(|root| render_rust_root_module(root, model))
        .collect::<Vec<_>>();
    let mut out = String::new();
    out.push_str(
        &format!(
            "// This file is generated by fw_gen. Do not edit manually.\n#![allow(dead_code)]\n#![allow(unused_imports)]\n\nuse std::sync::OnceLock;\n\n#[cfg(debug_assertions)]\nuse std::{{\n    collections::HashMap,\n    path::{{Path, PathBuf}},\n}};\n\n#[cfg(not(debug_assertions))]\nuse serde::de::DeserializeOwned;\n#[cfg(debug_assertions)]\nuse serde_json::Value;\nuse serde::{{Deserialize, Serialize}};\nuse serde_json;\n\nuse crate::config::{{{}}};\nuse fw::Fixed;\n\nconst PACK_MAGIC: &[u8] = b\"WCFG\";\n\n#[derive(Clone, Serialize, Deserialize)]\nstruct PackEntry<T> {{\n    key: String,\n    value: T,\n}}\n\n#[cfg(debug_assertions)]\nfn project_root() -> &'static Path {{\n    Path::new(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/../../..\"))\n}}\n\n#[cfg(debug_assertions)]\nfn source_path(relative: &str) -> PathBuf {{\n    project_root().join(relative)\n}}\n\n#[cfg(debug_assertions)]\nfn normalize_csv_header(header: &str, index: usize) -> String {{\n    if index == 0 {{\n        header.trim_start_matches('\\u{{feff}}').to_owned()\n    }} else {{\n        header.to_owned()\n    }}\n}}\n\n#[cfg(debug_assertions)]\nfn read_csv_rows(relative: &str) -> Vec<HashMap<String, String>> {{\n    let path = source_path(relative);\n    let mut reader = csv::Reader::from_path(&path)\n        .unwrap_or_else(|err| panic!(\"failed to read {{}}: {{err}}\", path.display()));\n    let headers = reader\n        .headers()\n        .unwrap_or_else(|err| panic!(\"failed to read headers for {{}}: {{err}}\", path.display()))\n        .iter()\n        .enumerate()\n        .map(|(index, value)| normalize_csv_header(value, index))\n        .collect::<Vec<_>>();\n    let mut rows = Vec::new();\n    for (index, result) in reader.records().enumerate() {{\n        let record = result.unwrap_or_else(|err| panic!(\"failed to read csv record {{index}} in {{}}: {{err}}\", path.display()));\n        let mut row = HashMap::new();\n        for (header, value) in headers.iter().zip(record.iter()) {{\n            row.insert(header.clone(), value.to_owned());\n        }}\n        rows.push(row);\n    }}\n    rows\n}}\n\n#[cfg(debug_assertions)]\nfn read_json_array(relative: &str, ctx: &str) -> Vec<Value> {{\n    let path = source_path(relative);\n    let text = std::fs::read_to_string(&path)\n        .unwrap_or_else(|err| panic!(\"failed to read {{}}: {{err}}\", path.display()));\n    let parsed: Value = serde_json::from_str(&text)\n        .unwrap_or_else(|err| panic!(\"failed to parse {{}}: {{err}}\", path.display()));\n    parsed\n        .as_array()\n        .unwrap_or_else(|| panic!(\"{{ctx}} must be a json array\"))\n        .clone()\n}}\n\n#[cfg(debug_assertions)]\nfn cell<'a>(row: &'a HashMap<String, String>, name: &str, ctx: &str) -> &'a str {{\n    row.get(name)\n        .map(String::as_str)\n        .unwrap_or_else(|| panic!(\"{{ctx}} missing column {{name}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_bool(cell: &str, ctx: &str) -> bool {{\n    match cell.to_ascii_lowercase().as_str() {{\n        \"1\" | \"true\" | \"yes\" => true,\n        \"0\" | \"false\" | \"no\" => false,\n        _ => panic!(\"{{ctx}} must be bool-compatible text\"),\n    }}\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_i32(cell: &str, ctx: &str) -> i32 {{\n    cell.parse::<i32>().unwrap_or_else(|err| panic!(\"{{ctx}} must be i32: {{err}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_i64(cell: &str, ctx: &str) -> i64 {{\n    cell.parse::<i64>().unwrap_or_else(|err| panic!(\"{{ctx}} must be i64: {{err}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_u32(cell: &str, ctx: &str) -> u32 {{\n    cell.parse::<u32>().unwrap_or_else(|err| panic!(\"{{ctx}} must be u32: {{err}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_u64(cell: &str, ctx: &str) -> u64 {{\n    cell.parse::<u64>().unwrap_or_else(|err| panic!(\"{{ctx}} must be u64: {{err}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_text_fixed(cell: &str, ctx: &str) -> Fixed {{\n    let value = cell.parse::<f32>().unwrap_or_else(|err| panic!(\"{{ctx}} must be float-compatible text: {{err}}\"));\n    Fixed::from_f32(value)\n}}\n\n#[cfg(debug_assertions)]\nfn as_object<'a>(value: &'a Value, ctx: &str) -> &'a serde_json::Map<String, Value> {{\n    value.as_object().unwrap_or_else(|| panic!(\"{{ctx}} must be a json object\"))\n}}\n\n#[cfg(debug_assertions)]\nfn object_field<'a>(obj: &'a serde_json::Map<String, Value>, field: &str, ctx: &str) -> &'a Value {{\n    obj.get(field).unwrap_or_else(|| panic!(\"{{ctx}} missing field {{field}}\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_bool(value: &Value, ctx: &str) -> bool {{\n    value.as_bool().unwrap_or_else(|| panic!(\"{{ctx}} must be bool\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_i32(value: &Value, ctx: &str) -> i32 {{\n    value.as_i64().unwrap_or_else(|| panic!(\"{{ctx}} must be i32-compatible number\")) as i32\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_i64(value: &Value, ctx: &str) -> i64 {{\n    value.as_i64().unwrap_or_else(|| panic!(\"{{ctx}} must be i64-compatible number\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_u32(value: &Value, ctx: &str) -> u32 {{\n    value.as_u64().unwrap_or_else(|| panic!(\"{{ctx}} must be u32-compatible number\")) as u32\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_u64(value: &Value, ctx: &str) -> u64 {{\n    value.as_u64().unwrap_or_else(|| panic!(\"{{ctx}} must be u64-compatible number\"))\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_fixed(value: &Value, ctx: &str) -> Fixed {{\n    if let Some(raw) = value.as_i64() {{\n        return Fixed::from_raw(raw as i32);\n    }}\n    let number = value.as_f64().unwrap_or_else(|| panic!(\"{{ctx}} must be fixed-compatible number\"));\n    Fixed::from_f32(number as f32)\n}}\n\n#[cfg(debug_assertions)]\nfn parse_json_array<T>(value: &Value, ctx: &str, item_parser: fn(&Value, &str) -> T) -> Vec<T> {{\n    let items = value.as_array().unwrap_or_else(|| panic!(\"{{ctx}} must be a json array\"));\n    items.iter().enumerate().map(|(index, item)| item_parser(item, &format!(\"{{}}[{{}}]\", ctx, index))).collect()\n}}\n\n#[cfg(not(debug_assertions))]\nfn decode_bin_entries<T: DeserializeOwned>(bytes: &[u8], ctx: &str) -> Vec<PackEntry<T>> {{\n    assert!(bytes.len() >= PACK_MAGIC.len(), \"{{ctx}} binary is too short\");\n    assert_eq!(&bytes[..PACK_MAGIC.len()], PACK_MAGIC, \"{{ctx}} binary magic mismatch\");\n    serde_json::from_slice(&bytes[PACK_MAGIC.len()..])\n        .unwrap_or_else(|err| panic!(\"failed to decode {{ctx}} binary: {{err}}\"))\n}}\n\nfn clone_by_key<T: Clone>(entries: &[PackEntry<T>], key: &str) -> Option<T> {{\n    entries.iter().find(|entry| entry.key == key).map(|entry| entry.value.clone())\n}}\n\nfn clone_required_by_key<T: Clone>(entries: &[PackEntry<T>], key: &str, ctx: &str) -> T {{\n    clone_by_key(entries, key).unwrap_or_else(|| panic!(\"{{ctx}} references missing key {{key}}\"))\n}}\n\nfn clone_by_index<T: Clone>(entries: &[PackEntry<T>], index: usize) -> Option<T> {{\n    entries.get(index).map(|entry| entry.value.clone())\n}}\n\nfn clone_all<T: Clone>(entries: &[PackEntry<T>]) -> Vec<T> {{\n    entries.iter().map(|entry| entry.value.clone()).collect()\n}}\n\n{}\n\n{}\n",
            type_names.join(", "),
            join_blocks(&parse_functions),
            join_blocks(&modules),
        )
    );
    out
}

fn render_rust_json_parser(message: &ProtoMessage, model: &ConfigModel) -> String {
    let fn_name = snake(&message.name);
    let fields = message
        .fields
        .iter()
        .map(|field| {
            format!(
                "        {}: {},",
                field.name,
                render_rust_json_field_expr(field, model, "obj", "ctx")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "#[cfg(debug_assertions)]\nfn parse_{}_json_object(obj: &serde_json::Map<String, Value>, ctx: &str) -> {} {{\n    {} {{\n{}\n    }}\n}}\n\n#[cfg(debug_assertions)]\nfn parse_{}_json(value: &Value, ctx: &str) -> {} {{\n    let obj = as_object(value, ctx);\n    parse_{}_json_object(obj, ctx)\n}}",
        fn_name,
        message.name,
        message.name,
        fields,
        fn_name,
        message.name,
        fn_name
    )
}

fn render_rust_json_field_expr(
    field: &ProtoField,
    model: &ConfigModel,
    object_name: &str,
    ctx_name: &str,
) -> String {
    let field_ctx = format!("&format!(\"{{}}.{}\", {})", field.name, ctx_name);
    let missing = rust_default_expr(field, model, &field_ctx);
    let parse = if field.rule == FieldRule::Repeated {
        let parser = rust_json_item_parser(&field.ty);
        format!(
            "parse_json_array(object_field({object_name}, \"{field_name}\", {ctx_name}), {field_ctx}, {parser})",
            field_name = field.name,
        )
    } else {
        rust_json_value_expr(
            field,
            model,
            &format!(
                "object_field({object_name}, \"{}\", {ctx_name})",
                field.name
            ),
            &field_ctx,
        )
    };
    format!(
        "match {object_name}.get(\"{field_name}\") {{\n            Some(_) => {parse},\n            None => {missing},\n        }}",
        field_name = field.name,
    )
}

fn rust_json_value_expr(
    field: &ProtoField,
    model: &ConfigModel,
    source_expr: &str,
    ctx_expr: &str,
) -> String {
    match field.ty.as_str() {
        "bool" => format!("parse_json_bool({source_expr}, {ctx_expr})"),
        "int32" => format!("parse_json_i32({source_expr}, {ctx_expr})"),
        "int64" => format!("parse_json_i64({source_expr}, {ctx_expr})"),
        "uint32" => format!("parse_json_u32({source_expr}, {ctx_expr})"),
        "uint64" => format!("parse_json_u64({source_expr}, {ctx_expr})"),
        "Fixed32" => format!("parse_json_fixed({source_expr}, {ctx_expr})"),
        "string" => format!(
            "{source_expr}.as_str().unwrap_or_else(|| panic!(\"{{}} must be string\", {ctx_expr})).to_owned()"
        ),
        other if model.root_names.contains(other) => {
            let dep_module = snake(strip_suffix(other, "Config"));
            let dep_parser = format!("parse_{}_json", snake(other));
            format!(
                "if let Some(key) = {source_expr}.as_str() {{ clone_required_by_key({dep_module}::entries(), key, {ctx_expr}) }} else {{ {dep_parser}({source_expr}, {ctx_expr}) }}"
            )
        }
        other => format!("parse_{}_json({source_expr}, {ctx_expr})", snake(other)),
    }
}

fn rust_json_item_parser(proto_type: &str) -> String {
    match proto_type {
        "bool" => "parse_json_bool".to_owned(),
        "int32" => "parse_json_i32".to_owned(),
        "int64" => "parse_json_i64".to_owned(),
        "uint32" => "parse_json_u32".to_owned(),
        "uint64" => "parse_json_u64".to_owned(),
        "Fixed32" => "parse_json_fixed".to_owned(),
        "string" => "|value, ctx| value.as_str().unwrap_or_else(|| panic!(\"{} must be string\", ctx)).to_owned()".to_owned(),
        other => format!("parse_{}_json", snake(other)),
    }
}

fn rust_default_expr(field: &ProtoField, model: &ConfigModel, ctx_expr: &str) -> String {
    if field.rule == FieldRule::Repeated {
        return "Vec::new()".to_owned();
    }
    match field.ty.as_str() {
        "bool" => "false".to_owned(),
        "int32" | "int64" | "uint32" | "uint64" => "0".to_owned(),
        "Fixed32" => "Fixed::ZERO".to_owned(),
        "string" => "String::new()".to_owned(),
        other if model.root_names.contains(other) => {
            let dep_module = snake(strip_suffix(other, "Config"));
            format!("clone_required_by_key({dep_module}::entries(), \"default\", {ctx_expr})")
        }
        other => format!("{other}::default()"),
    }
}

fn render_rust_root_module(root: &RootConfig, _model: &ConfigModel) -> String {
    let load_text = match root.kind {
        SourceKind::Table => render_rust_table_loader(root),
        SourceKind::Tree => render_rust_tree_loader(root),
    };
    format!(
        "pub mod {module} {{\n    use super::*;\n\n    static ENTRIES: OnceLock<Vec<PackEntry<{name}>>> = OnceLock::new();\n\n{load_text}\n\n    #[cfg(not(debug_assertions))]\n    fn load_bin() -> Vec<PackEntry<{name}>> {{\n        decode_bin_entries(\n            include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/../../../data/gen/config/{module}.bin\")),\n            \"{module}\",\n        )\n    }}\n\n    pub(super) fn entries() -> &'static Vec<PackEntry<{name}>> {{\n        ENTRIES.get_or_init(|| {{\n            #[cfg(debug_assertions)]\n            {{\n                load_text()\n            }}\n            #[cfg(not(debug_assertions))]\n            {{\n                load_bin()\n            }}\n        }})\n    }}\n\n    pub fn by_key(key: &str) -> Option<{name}> {{\n        clone_by_key(entries(), key)\n    }}\n\n    pub fn by_index(index: usize) -> Option<{name}> {{\n        clone_by_index(entries(), index)\n    }}\n\n    pub fn all() -> Vec<{name}> {{\n        clone_all(entries())\n    }}\n\n    pub fn default_config() -> {name} {{\n        by_key(\"default\").expect(\"generated config source must contain default\")\n    }}\n}}",
        module = root.module,
        name = root.name,
        load_text = indent(&load_text, 4),
    )
}

fn render_rust_table_loader(root: &RootConfig) -> String {
    let mut fields = Vec::new();
    for field in &root.message.fields {
        let ctx = format!("&format!(\"{{}}.{}\", ctx)", field.name);
        let expr = if root.ref_fields.contains(&field.name) {
            let dep_module = snake(strip_suffix(&field.ty, "Config"));
            format!(
                "match row.get(\"{field_name}\") {{\n                    Some(cell) => clone_required_by_key(super::{dep_module}::entries(), cell.as_str(), {ctx}),\n                    None => clone_required_by_key(super::{dep_module}::entries(), \"default\", {ctx}),\n                }}",
                field_name = field.name,
            )
        } else {
            let parser = rust_text_scalar_expr(&field.ty, &format!("cell.as_str()"), &ctx);
            let default = rust_default_expr(
                field,
                &ConfigModel {
                    roots: Vec::new(),
                    helpers: Vec::new(),
                    messages: BTreeMap::new(),
                    root_names: BTreeSet::new(),
                },
                &ctx,
            );
            format!(
                "match row.get(\"{field_name}\") {{\n                    Some(cell) => {parser},\n                    None => {default},\n                }}",
                field_name = field.name,
            )
        };
        fields.push(format!("                {}: {},", field.name, expr));
    }
    format!(
        "#[cfg(debug_assertions)]\n    fn load_text() -> Vec<PackEntry<{name}>> {{\n        let rows = read_csv_rows(\"{source}\");\n        let mut entries = Vec::new();\n        for (index, row) in rows.iter().enumerate() {{\n            let ctx = format!(\"{module}[{{}}]\", index);\n            let key = cell(row, \"key\", &ctx).to_owned();\n            let value = {name} {{\n{fields}\n            }};\n            entries.push(PackEntry {{ key, value }});\n        }}\n        entries\n    }}",
        name = root.name,
        source = root.source,
        module = root.module,
        fields = fields.join("\n"),
    )
}

fn render_rust_tree_loader(root: &RootConfig) -> String {
    format!(
        "#[cfg(debug_assertions)]\n    fn load_text() -> Vec<PackEntry<{name}>> {{\n        let items = read_json_array(\"{source}\", \"{module}\");\n        let mut entries = Vec::new();\n        for (index, item) in items.iter().enumerate() {{\n            let obj = as_object(item, &format!(\"{module}[{{}}]\", index));\n            let ctx = format!(\"{module}[{{}}]\", index);\n            let key = obj\n                .get(\"key\")\n                .and_then(Value::as_str)\n                .unwrap_or_else(|| panic!(\"{{}} missing field key\", ctx))\n                .to_owned();\n            let value = parse_{parser}_json_object(obj, &ctx);\n            entries.push(PackEntry {{ key, value }});\n        }}\n        entries\n    }}",
        name = root.name,
        source = root.source,
        module = root.module,
        parser = snake(&root.message.name),
    )
}

fn rust_text_scalar_expr(proto_type: &str, source_expr: &str, ctx_expr: &str) -> String {
    match proto_type {
        "bool" => format!("parse_text_bool({source_expr}, {ctx_expr})"),
        "int32" => format!("parse_text_i32({source_expr}, {ctx_expr})"),
        "int64" => format!("parse_text_i64({source_expr}, {ctx_expr})"),
        "uint32" => format!("parse_text_u32({source_expr}, {ctx_expr})"),
        "uint64" => format!("parse_text_u64({source_expr}, {ctx_expr})"),
        "Fixed32" => format!("parse_text_fixed({source_expr}, {ctx_expr})"),
        "string" => format!("{source_expr}.to_owned()"),
        other => format!("/* unsupported {other} */ Default::default()"),
    }
}

fn render_gd_reader(model: &ConfigModel) -> String {
    let defaults = model
        .helpers
        .iter()
        .map(|message| render_gd_default_fn(message, model))
        .chain(
            model
                .roots
                .iter()
                .map(|root| render_gd_default_fn(&root.message, model)),
        )
        .collect::<Vec<_>>();
    let parsers = model
        .helpers
        .iter()
        .map(|message| render_gd_parser_fn(message, model))
        .chain(
            model
                .roots
                .iter()
                .map(|root| render_gd_parser_fn(&root.message, model)),
        )
        .collect::<Vec<_>>();
    let roots = model
        .roots
        .iter()
        .map(|root| render_gd_root_loader(root, model))
        .collect::<Vec<_>>();
    let mut out = String::new();
    out.push_str(
        r#"# This file is generated by fw_gen. Do not edit manually.
extends RefCounted
class_name _config

const PACK_MAGIC: PackedByteArray = PackedByteArray([87, 67, 70, 71])
const FIXED_SCALE: float = 256.0

static func _normalize_csv_header(header: String, index: int) -> String:
	if index == 0 and not header.is_empty() and header.unicode_at(0) == 0xfeff:
		return header.substr(1)
	return header

static func _read_csv_rows(path: String) -> Array:
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	assert(file != null, "failed to open %s" % path)
	var headers: PackedStringArray = file.get_csv_line()
	var rows: Array = []
	while not file.eof_reached():
		var values: PackedStringArray = file.get_csv_line()
		if values.is_empty():
			continue
		var row: Dictionary = {}
		for index in range(min(headers.size(), values.size())):
			row[_normalize_csv_header(str(headers[index]), index)] = str(values[index])
		rows.append(row)
	return rows

static func _read_json_array(path: String, ctx: String) -> Array:
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	assert(file != null, "failed to open %s" % path)
	var parsed: Variant = JSON.parse_string(file.get_as_text())
	assert(parsed is Array, "%s must be a json array" % ctx)
	return parsed

static func _read_bin_entries(path: String, ctx: String) -> Array:
	var file: FileAccess = FileAccess.open(path, FileAccess.READ)
	assert(file != null, "failed to open %s" % path)
	var bytes: PackedByteArray = file.get_buffer(file.get_length())
	assert(bytes.size() >= PACK_MAGIC.size(), "%s binary is too short" % ctx)
	for index in range(PACK_MAGIC.size()):
		assert(bytes[index] == PACK_MAGIC[index], "%s binary magic mismatch" % ctx)
	var payload: PackedByteArray = PackedByteArray()
	payload.resize(bytes.size() - PACK_MAGIC.size())
	for index in range(payload.size()):
		payload[index] = bytes[PACK_MAGIC.size() + index]
	var parsed: Variant = JSON.parse_string(payload.get_string_from_utf8())
	assert(parsed is Array, "%s binary payload must be an array" % ctx)
	return parsed

static func _cell(row: Dictionary, field: String, ctx: String) -> String:
	assert(row.has(field), "%s missing column %s" % [ctx, field])
	return str(row[field])

static func _as_dictionary(value: Variant, ctx: String) -> Dictionary:
	assert(value is Dictionary, "%s must be a dictionary" % ctx)
	return value

static func _object_field(obj: Dictionary, field: String, ctx: String) -> Variant:
	assert(obj.has(field), "%s missing field %s" % [ctx, field])
	return obj[field]

static func _parse_text_int(value: Variant, ctx: String) -> int:
	match typeof(value):
		TYPE_STRING:
			var text: String = str(value)
			assert(text.is_valid_int(), "%s must be int-compatible text" % ctx)
			return int(text)
		TYPE_INT, TYPE_FLOAT:
			return int(value)
		_:
			assert(false, "%s must be int-compatible value" % ctx)
			return 0

static func _parse_text_bool(value: Variant, ctx: String) -> bool:
	match typeof(value):
		TYPE_BOOL:
			return bool(value)
		TYPE_STRING:
			var text: String = str(value).to_lower()
			if text in ["1", "true", "yes"]:
				return true
			if text in ["0", "false", "no"]:
				return false
		_:
			pass
	assert(false, "%s must be bool-compatible value" % ctx)
	return false

static func _parse_text_fixed(value: Variant, ctx: String) -> float:
	match typeof(value):
		TYPE_STRING:
			var text: String = str(value)
			assert(text.is_valid_float() or text.is_valid_int(), "%s must be float-compatible text" % ctx)
			return float(text)
		TYPE_INT, TYPE_FLOAT:
			return float(value)
		_:
			assert(false, "%s must be float-compatible value" % ctx)
			return 0.0

static func _parse_text_string(value: Variant, _ctx: String) -> String:
	return str(value)

static func _parse_text_array(value: Variant, ctx: String, item_parser: Callable) -> Array:
	assert(value is Array, "%s must be an array" % ctx)
	var items: Array = value
	var out: Array = []
	for index in range(items.size()):
		out.append(item_parser.call(items[index], "%s[%d]" % [ctx, index]))
	return out

static func _parse_bin_int(value: Variant, ctx: String) -> int:
	match typeof(value):
		TYPE_INT, TYPE_FLOAT:
			return int(value)
		TYPE_STRING:
			var text: String = str(value)
			assert(text.is_valid_int(), "%s must be int-compatible text" % ctx)
			return int(text)
		_:
			assert(false, "%s must be int-compatible value" % ctx)
			return 0

static func _parse_bin_bool(value: Variant, ctx: String) -> bool:
	if typeof(value) == TYPE_BOOL:
		return bool(value)
	assert(false, "%s must be bool" % ctx)
	return false

static func _parse_bin_fixed(value: Variant, ctx: String) -> float:
	match typeof(value):
		TYPE_INT, TYPE_FLOAT:
			return float(value) / FIXED_SCALE
		TYPE_STRING:
			var text: String = str(value)
			assert(text.is_valid_float() or text.is_valid_int(), "%s must be fixed-compatible text" % ctx)
			return float(text) / FIXED_SCALE
		_:
			assert(false, "%s must be fixed-compatible value" % ctx)
			return 0.0

static func _parse_bin_string(value: Variant, ctx: String) -> String:
	if typeof(value) == TYPE_STRING:
		return str(value)
	assert(false, "%s must be string" % ctx)
	return ""

static func _parse_bin_array(value: Variant, ctx: String, item_parser: Callable) -> Array:
	assert(value is Array, "%s must be an array" % ctx)
	var items: Array = value
	var out: Array = []
	for index in range(items.size()):
		out.append(item_parser.call(items[index], "%s[%d]" % [ctx, index]))
	return out

static func _clone_value(value: Variant) -> Variant:
	if value is Dictionary:
		var out: Dictionary = {}
		for key in value.keys():
			out[key] = _clone_value(value[key])
		return out
	if value is Array:
		var out: Array = []
		for item in value:
			out.append(_clone_value(item))
		return out
	return value

static func _clone_by_key(entries: Array, key: String) -> Dictionary:
	for item in entries:
		var entry: Dictionary = _as_dictionary(item, "entry")
		if str(entry.get("key", "")) == key:
			return _clone_value(entry.get("value", {}))
	return {}

static func _clone_required_by_key(entries: Array, key: String, ctx: String) -> Dictionary:
	var value: Dictionary = _clone_by_key(entries, key)
	assert(not value.is_empty(), "%s references missing key %s" % [ctx, key])
	return value

static func _clone_by_index(entries: Array, index: int) -> Dictionary:
	if index < 0 or index >= entries.size():
		return {}
	var entry: Dictionary = _as_dictionary(entries[index], "entry")
	return _clone_value(entry.get("value", {}))

static func _clone_all(entries: Array) -> Array:
	var out: Array = []
	for item in entries:
		var entry: Dictionary = _as_dictionary(item, "entry")
		out.append(_clone_value(entry.get("value", {})))
	return out
"#,
    );
    out.push_str("\n\n");
    out.push_str(&join_blocks(&defaults));
    out.push_str("\n\n");
    out.push_str(&join_blocks(&parsers));
    out.push_str("\n\n");
    out.push_str(&join_blocks(&roots));
    out.push('\n');
    out
}

fn render_gd_default_fn(message: &ProtoMessage, model: &ConfigModel) -> String {
    let body = message
        .fields
        .iter()
        .map(|field| {
            format!(
                "\t\t\"{}\": {},",
                field.name,
                gd_default_expr(field, model, "\"default\"")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "static func _default_{}() -> Dictionary:\n\treturn {{\n{}\n\t}}",
        snake(&message.name),
        body
    )
}

fn render_gd_parser_fn(message: &ProtoMessage, model: &ConfigModel) -> String {
    let text_body = message
        .fields
        .iter()
        .map(|field| {
            format!(
                "\t\t\"{}\": {},",
                field.name,
                gd_parse_field_expr(field, model, true)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let bin_body = message
        .fields
        .iter()
        .map(|field| {
            format!(
                "\t\t\"{}\": {},",
                field.name,
                gd_parse_field_expr(field, model, false)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "static func _parse_text_{}(value: Variant, ctx: String) -> Dictionary:\n\tvar obj: Dictionary = _as_dictionary(value, ctx)\n\treturn {{\n{}\n\t}}\n\nstatic func _parse_bin_{}(value: Variant, ctx: String) -> Dictionary:\n\tvar obj: Dictionary = _as_dictionary(value, ctx)\n\treturn {{\n{}\n\t}}",
        snake(&message.name),
        text_body,
        snake(&message.name),
        bin_body
    )
}

fn render_gd_root_loader(root: &RootConfig, _model: &ConfigModel) -> String {
    let text_loader = match root.kind {
        SourceKind::Table => render_gd_table_loader(root),
        SourceKind::Tree => render_gd_tree_loader(root),
    };
    format!(
        "static var _{module}_loaded: bool = false\nstatic var _{module}_entries: Array = []\n\n{loader}\n\nstatic func _load_{module}_bin() -> Array:\n\tvar raw_entries: Array = _read_bin_entries(\"res://data/gen/config/{module}.bin\", \"{module}\")\n\tvar entries: Array = []\n\tfor index in range(raw_entries.size()):\n\t\tvar item: Dictionary = _as_dictionary(raw_entries[index], \"%s[%d]\" % [\"{module}\", index])\n\t\tvar ctx: String = \"{module}[%d]\" % index\n\t\tentries.append({{\"key\": _parse_bin_string(_object_field(item, \"key\", ctx), \"%s.key\" % ctx), \"value\": _parse_bin_{parser}(_object_field(item, \"value\", ctx), \"%s.value\" % ctx)}})\n\treturn entries\n\nstatic func _load_{module}_entries() -> Array:\n\tif _{module}_loaded:\n\t\treturn _{module}_entries\n\tif OS.has_feature(\"editor\"):\n\t\t_{module}_entries = _load_{module}_text()\n\telse:\n\t\t_{module}_entries = _load_{module}_bin()\n\t_{module}_loaded = true\n\treturn _{module}_entries\n\nstatic func {module}_by_key(key: String) -> Dictionary:\n\treturn _clone_by_key(_load_{module}_entries(), key)\n\nstatic func {module}_by_index(index: int) -> Dictionary:\n\treturn _clone_by_index(_load_{module}_entries(), index)\n\nstatic func {module}_all() -> Array:\n\treturn _clone_all(_load_{module}_entries())\n\nstatic func {module}_default_config() -> Dictionary:\n\tvar value: Dictionary = {module}_by_key(\"default\")\n\tassert(not value.is_empty(), \"generated config source must contain default\")\n\treturn value",
        module = root.module,
        loader = text_loader,
        parser = snake(&root.message.name),
    )
}

fn render_gd_table_loader(root: &RootConfig) -> String {
    let value_lines = root
        .message
        .fields
        .iter()
        .map(|field| {
            format!(
                "\t\t\t\"{}\": {},",
                field.name,
                gd_table_field_expr(root, field)
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "static func _load_{module}_text() -> Array:\n\tvar rows: Array = _read_csv_rows(\"res://{source}\")\n\tvar entries: Array = []\n\tfor index in range(rows.size()):\n\t\tvar row: Dictionary = rows[index]\n\t\tvar ctx: String = \"{module}[%d]\" % index\n\t\tvar value: Dictionary = {{\n{values}\n\t\t}}\n\t\tentries.append({{\"key\": _cell(row, \"key\", ctx), \"value\": value}})\n\treturn entries",
        module = root.module,
        source = root.source,
        values = value_lines
    )
}

fn render_gd_tree_loader(root: &RootConfig) -> String {
    format!(
        "static func _load_{module}_text() -> Array:\n\tvar items: Array = _read_json_array(\"res://{source}\", \"{module}\")\n\tvar entries: Array = []\n\tfor index in range(items.size()):\n\t\tvar item: Dictionary = _as_dictionary(items[index], \"%s[%d]\" % [\"{module}\", index])\n\t\tvar ctx: String = \"{module}[%d]\" % index\n\t\tentries.append({{\"key\": _parse_text_string(_object_field(item, \"key\", ctx), \"%s.key\" % ctx), \"value\": _parse_text_{parser}(item, ctx)}})\n\treturn entries",
        module = root.module,
        source = root.source,
        parser = snake(&root.message.name),
    )
}

fn gd_table_field_expr(root: &RootConfig, field: &ProtoField) -> String {
    if root.ref_fields.contains(&field.name) {
        let dep_module = snake(strip_suffix(&field.ty, "Config"));
        return format!(
            "_clone_required_by_key(_load_{dep_module}_entries(), _cell(row, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx) if row.has(\"{field_name}\") else _clone_required_by_key(_load_{dep_module}_entries(), \"default\", \"%s.{field_name}\" % ctx)",
            field_name = field.name,
        );
    }
    gd_scalar_text_expr(&field.ty, &field.name)
}

fn gd_parse_field_expr(field: &ProtoField, model: &ConfigModel, text_mode: bool) -> String {
    let parse_prefix = if text_mode {
        "_parse_text"
    } else {
        "_parse_bin"
    };
    let default = gd_default_expr(field, model, "\"default\"");
    if field.rule == FieldRule::Repeated {
        let item_parser = gd_item_parser(&field.ty, text_mode);
        return format!(
            "{parse_prefix}_array(_object_field(obj, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx, {item_parser}) if obj.has(\"{field_name}\") else {default}",
            field_name = field.name,
        );
    }
    match field.ty.as_str() {
        "bool" | "int32" | "int64" | "uint32" | "uint64" | "Fixed32" | "string" => {
            let parser = gd_scalar_parser(&field.ty, text_mode);
            format!(
                "{parser}(_object_field(obj, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx) if obj.has(\"{field_name}\") else {default}",
                field_name = field.name,
            )
        }
        other if model.root_names.contains(other) => {
            let dep_module = snake(strip_suffix(other, "Config"));
            let nested_parser = format!("{parse_prefix}_{}", snake(other));
            format!(
                "(_clone_required_by_key(_load_{dep_module}_entries(), str(_object_field(obj, \"{field_name}\", ctx)), \"%s.{field_name}\" % ctx) if typeof(_object_field(obj, \"{field_name}\", ctx)) == TYPE_STRING else {nested_parser}(_object_field(obj, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx)) if obj.has(\"{field_name}\") else _clone_required_by_key(_load_{dep_module}_entries(), \"default\", \"%s.{field_name}\" % ctx)",
                field_name = field.name,
            )
        }
        other => {
            let nested_parser = format!("{parse_prefix}_{}", snake(other));
            format!(
                "{nested_parser}(_object_field(obj, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx) if obj.has(\"{field_name}\") else {default}",
                field_name = field.name,
            )
        }
    }
}

fn gd_default_expr(field: &ProtoField, model: &ConfigModel, ctx_expr: &str) -> String {
    if field.rule == FieldRule::Repeated {
        return "[]".to_owned();
    }
    match field.ty.as_str() {
        "bool" => "false".to_owned(),
        "int32" | "int64" | "uint32" | "uint64" => "0".to_owned(),
        "Fixed32" => "0.0".to_owned(),
        "string" => "\"\"".to_owned(),
        other if model.root_names.contains(other) => {
            let dep_module = snake(strip_suffix(other, "Config"));
            format!("_clone_required_by_key(_load_{dep_module}_entries(), \"default\", {ctx_expr})")
        }
        other => format!("_default_{}()", snake(other)),
    }
}

fn gd_scalar_text_expr(proto_type: &str, field_name: &str) -> String {
    let parser = gd_scalar_parser(proto_type, true);
    format!(
        "{parser}(_cell(row, \"{field_name}\", ctx), \"%s.{field_name}\" % ctx) if row.has(\"{field_name}\") else {}",
        match proto_type {
            "bool" => "false",
            "Fixed32" => "0.0",
            "string" => "\"\"",
            _ => "0",
        }
    )
}

fn gd_scalar_parser(proto_type: &str, text_mode: bool) -> &'static str {
    match (proto_type, text_mode) {
        ("bool", true) => "_parse_text_bool",
        ("bool", false) => "_parse_bin_bool",
        ("Fixed32", true) => "_parse_text_fixed",
        ("Fixed32", false) => "_parse_bin_fixed",
        ("string", true) => "_parse_text_string",
        ("string", false) => "_parse_bin_string",
        (_, true) => "_parse_text_int",
        (_, false) => "_parse_bin_int",
    }
}

fn gd_item_parser(proto_type: &str, text_mode: bool) -> String {
    match proto_type {
        "bool" | "int32" | "int64" | "uint32" | "uint64" | "Fixed32" | "string" => {
            gd_scalar_parser(proto_type, text_mode).to_owned()
        }
        other => format!(
            "{}_{}",
            if text_mode {
                "_parse_text"
            } else {
                "_parse_bin"
            },
            snake(other)
        ),
    }
}
