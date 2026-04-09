[package]
name = "core"
version = "0.1.0"
edition = "2024"

[dependencies]
fw = { path = "../../../fw/rust/crates/fw" }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
csv = "1"
