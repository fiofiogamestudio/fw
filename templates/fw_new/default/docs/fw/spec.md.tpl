# Fw Spec

## 结构
- `fw.toml`：工程路径和工具入口配置。
- `schema/systems.toml`：Godot system 与 C# core system 的统一事实源。
- `schema/bridge/*.proto`：Godot 与 C# 的 bridge 协议事实源。
- `schema/config/*.proto`：配置结构事实源。
- `data/config/*`：人工维护的配置源数据。
- `pack/config/*`：生成的运行时配置包，不手改。
- `scripts/_gen`：生成的 GDScript 入口，包括 `_godot_systems.gd`、`_bridge.gd`、`_config.gd`。
- `csharp/_gen`：生成的 C# 入口，包括 `_core_systems.cs`、`_bridge_types.cs`、`_bridge_codec.cs`、`_intent_codec.cs`、`_event_codec.cs`、`_config_contract.cs`。
- `csharp/core`：玩法权威逻辑、状态、system、rules、config loader。
- `csharp/bridge`：Godot 可调用的 C# 边界和手写语义 codec。

## 原理
- `schema/systems.toml` 生成两端 system 注册表，Godot 与 C# 共用 `system / context / phase / refs / config / state` 范式。
- `schema/bridge` 按语义分为 value、intent、view、event、packet。生成到 Godot 时统一落到 `Bridge.Value / Bridge.Intent / Bridge.View / Bridge.Event / Bridge.Packet`。
- C# bridge 生成基础字段、枚举、输入和事件 codec；复杂 view、map 等语义投影由 `csharp/bridge/codec` 手写。
- `CoreRuntime` 只负责按生成的 core system 顺序推进；具体玩法写在 `csharp/core/system` 和 `csharp/core/rules`。
- 表现层只消费 core 输出的 view、event 和配置，不反推核心规则。

## 约束
- `_gen` 目录和 `_` 前缀文件都是生成产物，不手改。
- `data/config` 是源数据，`pack/config` 是生成数据。
- `fw/templates/fw_new/default` 必须与当前框架规范同步，避免新项目继承旧范式。
