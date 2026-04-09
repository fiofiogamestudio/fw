# Fw

`fw/` 是一个放在 Godot 工程根目录即可直接接入的 Rust + Godot 通用框架。

这个目录内只保留这一份 README，目的只有一个：

- 告诉使用者怎么把 `fw/` 接到一个新工程里

如果你是在当前宿主仓库里维护这套框架，本地维护说明不放在 `fw/` 里，而放在宿主仓库的：

- `docs/fw/rule.md`
- `docs/fw/spec.md`
- `docs/fw/use.md`

## 接入前提

先准备好：

1. 一个已经创建完成的 Godot 工程
2. 工程根目录下已有 `project.godot`
3. 把 `fw/` 放到这个工程根目录

最终目录形态类似：

```text
<game_root>/
  fw/
  project.godot
```

## 初始化项目骨架

在游戏工程根目录执行：

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\fw\tools\new.ps1 -ProjectRoot . -Name MyGame
```

或：

```bash
./fw/tools/new.sh --project-root . --name MyGame
```

这会调用独立 craft：

```text
cargo run --manifest-path fw/rust/Cargo.toml -p fw_gen -- --root <project_root> craft fw-new --name <game_name>
```

它会补齐一套最小可运行骨架，包括：

- `fw.toml`
- `justfile`
- `scenes/main.tscn`
- `scripts/app/*`
- `scripts/system/*`
- `prefabs/ui/game_form.tscn`
- `schema/*`
- `rust/crates/core`
- `rust/crates/bridge`

## 后续常用命令

生成：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
```

构建：

```powershell
.\fw\tools\build.ps1
```

## 框架约束

这套框架默认你接受这些约束：

- Godot 负责 presentation
- Rust 负责 gameplay
- Godot 运行时主链路是 `AppRoot -> BaseMode -> SystemManager`
- Rust gameplay 统一走 `system-context`
- 跨端边界只走 `action / snapshot / event`
- 主 UI 统一走 `xxx_form.tscn + FForm + xxx_logic.gd`

如果你的项目接受这套约束，`fw/` 可以直接作为根目录框架使用。
