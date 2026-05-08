# Fw Spec

## 结构
- `docs/fw/rule.md`：长期工程规则。
- `docs/fw/spec.md`：当前结构和原理。
- `docs/fw/use.md`：操作说明。
- `fw/`：可复用框架、生成器、工具和模板。
- `fw.toml`：工程路径和生成配置入口。
- `schema/system.toml`：GDScript system graph 事实源。
- `schema/core_system.toml`：C# core system 注册事实源。
- `schema/bridge/*.proto`：Godot 与 C# bridge 协议事实源。
- `schema/config/*.proto`：配置 schema 事实源。
- `data/config/*`：游戏配置数据。
- `scripts/app`、`scripts/mode`：Godot 表现层。
- `csharp/core`：C# 核心规则门面、runtime、context 和常量。
- `csharp/core/core_systems.cs`：由 `schema/core_system.toml` 生成的 C# system 注册表。
- `csharp/core/system`：C# core system。
- `csharp/core/rules`：C# core 无状态规则函数。
- `csharp/core/state`：C# core 运行期状态、领域数据和生成的 bridge 合同。
- `csharp/core/config`：生成的 C# typed config 和启动期加载器。
- `csharp/bridge`：Godot 可调用的 C# bridge 边界。
- `csharp/bridge/codec`：Godot 数据和 C# 类型转换。

## 原理
- `AppRoot -> Mode -> SystemManager` 驱动 Godot 表现层 system。
- `schema/system.toml` 生成 `scripts/gen/_graph.gd` 和 `scripts/gen/_systems.gd`。
- `schema/core_system.toml` 生成 `csharp/core/core_systems.cs`，包含 phase 顺序和 phase 常量。
- `schema/bridge/*.proto` 生成 `scripts/gen/_action.gd`、`_event.gd`、`_snapshot.gd`、`_input.gd`、`csharp/core/state/bridge_contract.cs`、`csharp/bridge/codec/bridge_codec.cs`、`input_codec.cs` 和 `event_codec.cs`，包含字典字段、领域枚举值、输入按钮、事件、网络包类型常量、通用 packet codec、输入解码和事件编码。
- `schema/config/*.proto` 生成 `csharp/core/config/config_contract.cs`，包含 typed config 和配置字段常量。
- GDScript system 负责输入、bridge、event、world、hud 等表现层协作。
- C# core 通过 `CoreRuntime`、`CoreSystems` 和 `Fw.Rt.Systems.SystemRuntime` 按生成 phase 顺序推进核心 system。
- `CoreContext` 暴露 C# core 的 `Refs / Config / State`。
- `GameBridge` 用于本地运行，`NetBridge` 用于 host / client 网络运行。
- `bridge/codec` 把 Godot Dictionary / Array 和生成合同里的 C# 命令、事件、snapshot 互转；字段名、包类型、通用 packet 读写、输入解码和事件编码由生成代码提供，地图和 snapshot 投影保留手写语义逻辑。
- UI 使用 `form + logic`：form 负责结构，logic 负责表现层交互和刷新。
- view 只做表现，表现层逻辑放在 logic 或 system。

## Core System
- 推荐 phase 按稳定职责命名，例如 `simulation`、`combat`、`projectile`、`visibility`、`match`。
- core system 只能读写 `CoreContext`，不要直接接触 Godot Node、SceneTree、PackedScene、Form 或 View。
- core system 注册和 phase 常量由 `schema/core_system.toml` 生成，`CoreRuntime` 只调用生成注册表。
- core rules 放在 `csharp/core/rules`，是无状态规则函数集合，由 core system 调用，不参与生命周期和 phase。
- `query`、`solver` 这类计算职责归入 `rules`，不单独形成架构后缀。
- 项目特有玩法系统写在宿主项目 `csharp/core/system`，只有跨游戏通用能力才上提到 `fw`。
