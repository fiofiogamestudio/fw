use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::support::util::{list_proto_files, read_utf8};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FieldRule {
    Singular,
    Repeated,
}

#[derive(Clone, Debug)]
pub struct ProtoField {
    pub rule: FieldRule,
    pub ty: String,
    pub name: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct ProtoOneof {
    pub name: String,
    pub fields: Vec<ProtoField>,
}

#[derive(Clone, Debug)]
pub struct ProtoMessage {
    pub name: String,
    pub file: String,
    pub fields: Vec<ProtoField>,
    pub oneofs: Vec<ProtoOneof>,
}

#[allow(dead_code)]
#[derive(Clone, Debug)]
pub struct ProtoEnum {
    pub name: String,
    pub file: String,
    pub variants: Vec<String>,
}

#[derive(Clone, Debug, Default)]
pub struct ProtoSchema {
    pub messages: BTreeMap<String, ProtoMessage>,
    pub enums: BTreeMap<String, ProtoEnum>,
}

enum ContextKind {
    Message {
        name: String,
        fields: Vec<ProtoField>,
        oneofs: Vec<ProtoOneof>,
    },
    Enum {
        name: String,
        variants: Vec<String>,
    },
    Oneof {
        name: String,
        fields: Vec<ProtoField>,
    },
}

struct StackItem {
    file: String,
    kind: ContextKind,
}

pub fn parse_dir(root: &Path) -> Result<ProtoSchema> {
    let mut schema = ProtoSchema::default();
    let files = list_proto_files(root)?;
    for path in files {
        parse_file(root, &path, &mut schema)
            .with_context(|| format!("failed to parse proto {}", path.display()))?;
    }
    Ok(schema)
}

fn parse_file(root: &Path, path: &Path, schema: &mut ProtoSchema) -> Result<()> {
    let rel = path
        .strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    let content = read_utf8(path)?;
    let mut stack: Vec<StackItem> = Vec::new();

    for raw_line in content.lines() {
        let line = strip_comment(raw_line).trim();
        if line.is_empty()
            || line.starts_with("syntax ")
            || line.starts_with("package ")
            || line.starts_with("import ")
        {
            continue;
        }

        if let Some(name) = parse_decl(line, "message") {
            stack.push(StackItem {
                file: rel.clone(),
                kind: ContextKind::Message {
                    name,
                    fields: Vec::new(),
                    oneofs: Vec::new(),
                },
            });
            continue;
        }

        if let Some(name) = parse_empty_decl(line, "message") {
            schema.messages.insert(
                name.clone(),
                ProtoMessage {
                    name,
                    file: rel.clone(),
                    fields: Vec::new(),
                    oneofs: Vec::new(),
                },
            );
            continue;
        }

        if let Some(name) = parse_decl(line, "enum") {
            stack.push(StackItem {
                file: rel.clone(),
                kind: ContextKind::Enum {
                    name,
                    variants: Vec::new(),
                },
            });
            continue;
        }

        if let Some(name) = parse_empty_decl(line, "enum") {
            schema.enums.insert(
                name.clone(),
                ProtoEnum {
                    name,
                    file: rel.clone(),
                    variants: Vec::new(),
                },
            );
            continue;
        }

        if let Some(name) = parse_decl(line, "oneof") {
            stack.push(StackItem {
                file: rel.clone(),
                kind: ContextKind::Oneof {
                    name,
                    fields: Vec::new(),
                },
            });
            continue;
        }

        if line == "}" {
            let item = stack.pop().context("unexpected closing brace")?;
            match item.kind {
                ContextKind::Message {
                    name,
                    fields,
                    oneofs,
                } => {
                    schema.messages.insert(
                        name.clone(),
                        ProtoMessage {
                            name,
                            file: item.file,
                            fields,
                            oneofs,
                        },
                    );
                }
                ContextKind::Enum { name, variants } => {
                    schema.enums.insert(
                        name.clone(),
                        ProtoEnum {
                            name,
                            file: item.file,
                            variants,
                        },
                    );
                }
                ContextKind::Oneof { name, fields } => {
                    let parent = stack.last_mut().context("oneof must be inside message")?;
                    match &mut parent.kind {
                        ContextKind::Message { oneofs, .. } => {
                            oneofs.push(ProtoOneof { name, fields });
                        }
                        _ => bail!("oneof must be nested inside message"),
                    }
                }
            }
            continue;
        }

        if let Some(field) = parse_field(line) {
            let current = stack
                .last_mut()
                .context("field declared outside message/oneof")?;
            match &mut current.kind {
                ContextKind::Message { fields, .. } => fields.push(field),
                ContextKind::Oneof { fields, .. } => fields.push(field),
                ContextKind::Enum { variants, .. } => {
                    variants.push(line.split('=').next().unwrap_or(line).trim().to_owned());
                }
            }
            continue;
        }

        if let Some(current) = stack.last_mut() {
            if let ContextKind::Enum { variants, .. } = &mut current.kind {
                variants.push(
                    line.split('=')
                        .next()
                        .unwrap_or(line)
                        .trim()
                        .trim_end_matches(';')
                        .to_owned(),
                );
                continue;
            }
        }

        bail!("unsupported proto line: {line}");
    }

    if !stack.is_empty() {
        bail!("unterminated proto block in {}", path.display());
    }
    Ok(())
}

fn strip_comment(line: &str) -> &str {
    line.split("//").next().unwrap_or(line)
}

fn parse_decl(line: &str, keyword: &str) -> Option<String> {
    let prefix = format!("{keyword} ");
    if !line.starts_with(&prefix) {
        return None;
    }
    let rest = line[prefix.len()..].trim();
    let name = rest.strip_suffix('{')?.trim();
    Some(name.to_owned())
}

fn parse_empty_decl(line: &str, keyword: &str) -> Option<String> {
    let prefix = format!("{keyword} ");
    if !line.starts_with(&prefix) {
        return None;
    }
    let rest = line[prefix.len()..].trim();
    let name = rest.strip_suffix("{}")?.trim();
    Some(name.to_owned())
}

fn parse_field(line: &str) -> Option<ProtoField> {
    if !line.contains('=') {
        return None;
    }
    let lhs = line
        .trim_end_matches(';')
        .split('=')
        .next()
        .unwrap_or(line)
        .trim();
    let parts = lhs.split_whitespace().collect::<Vec<_>>();
    match parts.as_slice() {
        ["repeated", ty, name] => Some(ProtoField {
            rule: FieldRule::Repeated,
            ty: (*ty).to_owned(),
            name: (*name).to_owned(),
        }),
        [ty, name] => Some(ProtoField {
            rule: FieldRule::Singular,
            ty: (*ty).to_owned(),
            name: (*name).to_owned(),
        }),
        _ => None,
    }
}
