# Fw

`fw/` 是这套 Rust + Godot 通用框架的根目录。

当前 `fw/` 已经包含：

- Godot 运行时与 UI 子框架：`scripts/fw`
- Rust 通用运行时：`rust/crates/fw`
- 生成器与模板：`rust/crates/fw_gen`、`templates`
- 工具脚本：`tools`
- 框架文档：`docs`

如果你是第一次接这套框架，建议按这个顺序看：

1. [`docs/rule.md`](docs/rule.md)
2. [`docs/spec.md`](docs/spec.md)
3. [`docs/use.md`](docs/use.md)

## 快速上手

如果你已经先创建了一个空的 Godot 工程，并把 `fw/` 放到了工程根目录，可以直接执行：

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\fw\tools\new.ps1 -ProjectRoot . -Name MyGame
```

或者：

```bash
./fw/tools/new.sh --project-root . --name MyGame
```

这会执行独立 craft：

```text
cargo run --manifest-path fw/rust/Cargo.toml -p fw_gen -- --root <project_root> craft fw-new --name <game_name>
```

它会在当前工程根目录补齐：

- `fw.toml`
- `justfile`
- `scenes/main.tscn`
- `scripts/app/*`
- `scripts/system/*`
- `prefabs/ui/game_form.tscn`
- `schema/*`
- `rust/crates/core`
- `rust/crates/bridge`

随后就可以继续运行：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\build.ps1
```
