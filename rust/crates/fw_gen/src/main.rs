mod cmd {
    pub mod bridge;
    pub mod config;
    pub mod system;
}
mod craft {
    pub mod fw_new;
}
mod support {
    pub mod fw_config;
    pub mod proto;
    pub mod util;
}

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use support::fw_config::FConfig;
use support::util::project_root;

#[derive(Parser)]
#[command(name = "fw_gen")]
#[command(about = "Rust/GDScript 共享生成工具")]
struct Cli {
    #[arg(long, global = true)]
    root: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Craft {
        #[command(subcommand)]
        command: CraftCommand,
    },
    Bridge {
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long)]
        gd_out: Option<PathBuf>,
        #[arg(long)]
        rust_out: Option<PathBuf>,
        #[arg(long)]
        core_out: Option<PathBuf>,
    },
    Config {
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long)]
        data_root: Option<PathBuf>,
        #[arg(long)]
        gd_out: Option<PathBuf>,
        #[arg(long)]
        rust_reader_out: Option<PathBuf>,
        #[arg(long)]
        rust_types_out: Option<PathBuf>,
    },
    CheckConfig {
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long)]
        data_root: Option<PathBuf>,
    },
    PakConfig {
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long)]
        data_root: Option<PathBuf>,
        #[arg(long)]
        pack_out_dir: Option<PathBuf>,
    },
    System {
        #[arg(long)]
        schema: Option<PathBuf>,
        #[arg(long)]
        gd_out: Option<PathBuf>,
    },
}

#[derive(Subcommand)]
enum CraftCommand {
    #[command(name = "fw-new")]
    FwNew {
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        force: bool,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let root = cli
        .root
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                project_root().join(path)
            }
        })
        .unwrap_or_else(project_root);
    if let Command::Craft { command } = &cli.command {
        return match command {
            CraftCommand::FwNew { name, force } => {
                craft::fw_new::run(&root, name.as_deref(), *force)
            }
        };
    }
    let fw_config = FConfig::load(&root)?;
    match cli.command {
        Command::Craft { .. } => unreachable!(),
        Command::Bridge {
            schema,
            gd_out,
            rust_out,
            core_out,
        } => cmd::bridge::generate(
            &root,
            &root.join(path_or(
                schema,
                non_empty(&fw_config.schema.bridge),
                "schema/bridge",
            )),
            &root.join(path_or(
                gd_out,
                non_empty(&fw_config.gen.gd_dir),
                "scripts/gen",
            )),
            &root.join(path_or(
                rust_out,
                non_empty(&fw_config.gen.bridge_rust_out),
                "rust/crates/bridge/_gen",
            )),
            &root.join(path_or(
                core_out,
                non_empty(&fw_config.gen.core_rust_out),
                "rust/crates/core/src/_gen",
            )),
        ),
        Command::Config {
            schema,
            data_root,
            gd_out,
            rust_reader_out,
            rust_types_out,
        } => cmd::config::generate(
            &root,
            &root.join(path_or(
                schema,
                non_empty(&fw_config.schema.config),
                "schema/config",
            )),
            &root.join(path_or(
                data_root,
                non_empty(&fw_config.schema.data_config),
                "data/config",
            )),
            &root.join(path_or(
                gd_out,
                non_empty(&fw_config.gen.config_gd),
                "scripts/gen/_config.gd",
            )),
            &root.join(path_or(
                rust_reader_out,
                non_empty(&fw_config.gen.config_rust_reader),
                "rust/crates/core/src/_gen/_config.rs",
            )),
            &root.join(path_or(
                rust_types_out,
                non_empty(&fw_config.gen.config_rust_types),
                "rust/crates/core/src/_gen/_config_types.rs",
            )),
        ),
        Command::CheckConfig { schema, data_root } => cmd::config::check(
            &root,
            &root.join(path_or(
                schema,
                non_empty(&fw_config.schema.config),
                "schema/config",
            )),
            &root.join(path_or(
                data_root,
                non_empty(&fw_config.schema.data_config),
                "data/config",
            )),
        ),
        Command::PakConfig {
            schema,
            data_root,
            pack_out_dir,
        } => cmd::config::pak(
            &root,
            &root.join(path_or(
                schema,
                non_empty(&fw_config.schema.config),
                "schema/config",
            )),
            &root.join(path_or(
                data_root,
                non_empty(&fw_config.schema.data_config),
                "data/config",
            )),
            &root.join(path_or(
                pack_out_dir,
                non_empty(&fw_config.gen.config_pack_dir),
                "data/gen/config",
            )),
        ),
        Command::System { schema, gd_out } => cmd::system::generate(
            &root,
            &root.join(path_or(
                schema,
                non_empty(&fw_config.schema.system),
                "schema/system.toml",
            )),
            &root.join(path_or(
                gd_out,
                non_empty(&fw_config.gen.graph_gd),
                "scripts/gen/_graph.gd",
            )),
        ),
    }
}

fn non_empty(value: &str) -> Option<&str> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn path_or(cli: Option<PathBuf>, config: Option<&str>, fallback: &str) -> PathBuf {
    cli.unwrap_or_else(|| PathBuf::from(config.unwrap_or(fallback)))
}
