[package]
name = "bridge"
version = "0.1.0"
edition = "2024"

[lib]
name = "__LIB_NAME__"
crate-type = ["cdylib"]

[dependencies]
godot = "0.4.5"
core = { path = "../core" }
