# Fw Spec

## 结构
- `docs/fw/rule.md`：长期工程规则。
- `docs/fw/spec.md`：当前结构和原理。
- `docs/fw/use.md`：操作说明。
- `fw/`：可复用框架、生成器、工具和模板。
- `fw.toml`：工程路径和构建入口配置。
- `schema/systems.toml`：Godot system 和 C# core system 的统一事实源。
- `schema/bridge/*.proto`：Godot 与 C# bridge 协议事实源。
- `schema/config/*.proto`：配置 schema 事实源。
- `data/config/*`：游戏配置数据。
- `scripts/app`、`scripts/mode`：Godot 表现层。
- `scripts/_gen`：生成的 GDScript graph、system factory、bridge wrapper 和 config 入口。
- `csharp/_gen`：生成的 C# system 注册表、bridge 合同、基础 codec 和 typed config。
- `csharp/core`：C# 核心规则门面、runtime、context、system、rules、state、config loader 和常量。
- `csharp/bridge`：Godot 可调用的 C# bridge 边界和手写语义投影 codec。

## 原理
- `fw.toml` 显式列出工程关键路径，路径表本身就是工程结构地图。
- `path.schema`、`path.gdscript`、`path.csharp` 是普通工程入口目录，目录名不能随意漂移。
- `path.systems`、`path.bridge_schema`、`path.config_schema` 和 `path.config_data` 是手写事实源路径。
- `path._gen.config`、`path._gen.gdscript` 和 `path._gen.csharp` 是生成产物路径。
- `_gen` 目录和 `_` 前缀文件都表示机器生成，用户不直接编辑。
- `AppRoot -> Mode -> SystemManager` 驱动 Godot 表现层 system。
- `schema/systems.toml` 的 `godot.*` 生成 `scripts/_gen/_graph.gd` 和 `scripts/_gen/_systems.gd`。
- `schema/systems.toml` 的 `core.*` 生成 `csharp/_gen/_core_systems.cs`，包含 phase 顺序和 phase 常量。
- `schema/bridge/*.proto` 生成 `scripts/_gen/_action.gd`、`_event.gd`、`_snapshot.gd`、`_input.gd` 以及 `csharp/_gen` 下的 bridge 合同和基础 codec。
- `schema/config/*.proto` 生成 `csharp/_gen/_config_contract.cs`，包含 typed config 和配置字段常量。
- GDScript system 负责输入、bridge、event、world、hud 等表现层协作。
- C# core 通过 `CoreRuntime`、`CoreSystems` 和 `Fw.Rt.Systems.SystemRuntime` 按生成 phase 顺序推进核心 system。
- `CoreContext` 暴露 C# core 的 `Refs / Config / State`。
- `GameBridge` 用于本地运行，`NetBridge` 用于 host / client 网络运行。
- `csharp/_gen` 中的基础 codec 只提供通用合同和读写能力；地图和 snapshot 的语义投影保留在 `csharp/bridge/codec` 手写。
- UI 使用 `form + logic`：form 负责结构，logic 负责表现层交互和刷新。
- view 只做表现，表现层逻辑放在 logic 或 system。

## Core System
- 推荐 phase 按稳定职责命名，例如 `simulation`、`combat`、`projectile`、`visibility`、`match`。
- core system 只能读写 `CoreContext`，不要直接接触 Godot Node、SceneTree、PackedScene、Form 或 View。
- core system 注册和 phase 常量由 `schema/systems.toml` 的 `core.*` 生成，`CoreRuntime` 只调用生成注册表。
- core rules 放在 `csharp/core/rules`，是无状态规则函数集合，由 core system 调用，不参与生命周期和 phase。
- `query`、`solver` 这类计算职责归入 `rules`，不单独形成架构后缀。
- 项目特有玩法系统写在宿主项目 `csharp/core/system`，只有跨游戏通用能力才上提到 `fw`。
