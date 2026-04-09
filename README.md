# Fw

`fw/` 是一套放到 Godot 工程根目录即可接入的 Rust + Godot 框架。

这个目录只保留这一份 `README.md`，只回答一件事：

- 怎么把 `fw/` 接到一个新的游戏工程里

如果你是在宿主仓库里维护这套框架，不在这里看维护说明，而去看宿主仓库里的：

- `docs/fw/rule.md`
- `docs/fw/spec.md`
- `docs/fw/use.md`

## 适用前提

这套框架默认你接受这些约束：

- Godot 负责 presentation
- Rust 负责 gameplay
- Godot 运行时主链路是 `AppRoot -> BaseMode -> SystemManager`
- Rust gameplay 统一走 `system-context`
- 跨端边界只走 `action / snapshot / event`
- 主 UI 统一走 `xxx_form.tscn + FForm + xxx_logic.gd`

如果你的项目接受这些约束，就可以直接使用 `fw/`。

## 你会得到什么

接入后，`fw/` 会提供这些通用能力：

- Godot 运行时骨架：`AppRoot -> BaseMode -> SystemManager`
- Godot UI 子框架：`FForm + xxx_logic.gd`
- Rust 通用运行时、数学和流程能力
- `fw new`、`fw gen`、`fw build` 这一套工具链

## 目录要求

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

## 快速开始

推荐顺序只有三步：

1. 把 `fw/` 放到工程根目录
2. 运行 `fw new`
3. 再运行生成和构建

## 初始化骨架

在游戏工程根目录执行：

```powershell
powershell -NoLogo -NoProfile -ExecutionPolicy Bypass -File .\fw\tools\new.ps1 -ProjectRoot . -Name MyGame
```

或：

```bash
./fw/tools/new.sh --project-root . --name MyGame
```

底层实际调用的是独立 craft：

```text
cargo run --manifest-path fw/rust/Cargo.toml -p fw_gen -- --root <project_root> craft fw-new --name <game_name>
```

## 初始化结果

`fw new` 会在当前工程根目录补齐一套最小骨架，包括：

- `fw.toml`
- `justfile`
- `scenes/main.tscn`
- `scripts/app/*`
- `scripts/system/*`
- `prefabs/ui/game_form.tscn`
- `schema/*`
- `rust/crates/core`
- `rust/crates/bridge`

这一步不会改动 `fw/` 本身，只会在当前游戏工程里补齐接入层和最小内容层。

## 生成与构建

完成 `fw new` 后，通常继续执行：

```powershell
.\fw\tools\gen.ps1 system
.\fw\tools\gen.ps1 bridge
.\fw\tools\gen.ps1 config
.\fw\tools\build.ps1
```

如果你使用 `just`，通常也可以直接执行：

```powershell
just build
```

## 常用命令

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

如果你使用 `just`，通常也可以直接执行：

```powershell
just build
```

## 哪些是框架，哪些是游戏

`fw/` 只提供框架和工具。真正属于游戏自己的内容，仍然需要你自己写。

框架负责：

- Godot 运行时与 UI 子框架
- Rust 通用运行时
- 生成器、工具脚本、模板

游戏负责：

- `schema/bridge/*`
- `schema/config/*`
- `schema/system.toml`
- Rust gameplay systems
- Godot modes
- Godot presentation systems
- `xxx_form.tscn`
- `xxx_logic.gd`

## 接入后默认结构

接入后的最小工程通常会长成：

```text
<game_root>/
  fw/
  fw.toml
  justfile
  scenes/
  scripts/app/
  scripts/system/
  prefabs/ui/
  schema/
  rust/
```

## 本地维护说明去哪看

如果你不是在“接入新工程”，而是在当前宿主仓库里维护、升级或调整 `fw/`，请不要继续看这里，直接看：

- `docs/fw/rule.md`
- `docs/fw/spec.md`
- `docs/fw/use.md`
