# Fw Spec

## 结构
- `fw/scripts/fw`：Godot 表现层基础设施。
- `fw/csharp/FwRuntime`：C# system runtime。
- `fw/csharp/FwGen`：system、bridge、config 和 `fw new` 生成器。
- `fw/tools`：生成、构建、新建项目入口脚本。
- `fw/templates/fw_new/default`：新游戏工程模板。
- `fw/docs`：规范源文档。

## 生成结果
`fw new` 应生成：
- `docs/fw/rule.md`
- `docs/fw/spec.md`
- `docs/fw/use.md`
- `fw.toml`
- `schema/system.toml`
- `schema/core_system.toml`
- `schema/bridge/*`
- `schema/config/*`
- `scripts/app/*`
- `scripts/mode/*`
- `csharp/core/*`
- `csharp/bridge/*`

## System 规范
- GDScript system 由 `schema/system.toml` 声明。
- `FwGen` 生成 `_graph.gd` 和 `_systems.gd`。
- C# core system 由 `schema/core_system.toml` 声明。
- `FwGen` 生成 `csharp/core/core_systems.cs`。
- C# system 使用 `Fw.Rt.Systems.SystemRuntime`。
- C# 和 GDScript system 统一使用 `id / phase / context / init / tick / shutdown`。
- system context 只放 `refs / config / state`。
- C# core 可以使用无状态 `rules` 承载可复用规则函数。
- `query`、`solver` 不作为架构后缀；相关计算归入 `rules`。
- 推荐宿主项目 C# 目录按 `core/system`、`core/rules`、`core/state`、`core/config` 和 `bridge/codec` 分组。

## Bridge / Config 生成
- `schema/bridge/*.proto` 生成 GD wrapper、C# bridge 合同和 C# bridge codec；合同包含字段、领域枚举、输入按钮、事件和网络包类型常量，codec 提供通用 packet 读写、输入解码和事件编码。
- `schema/config/*.proto` 生成 C# typed config 和配置字段常量。
- `schema/core_system.toml` 生成 C# system 注册表、phase 顺序和 phase 常量。
- 手写 codec 只做 Godot 数据与生成合同之间的映射，不重复定义协议字段、网络包类型和配置类型。
