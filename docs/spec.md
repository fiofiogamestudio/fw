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
- `schema/systems.toml`
- `schema/bridge/*`
- `schema/config/*`
- `scripts/app/*`
- `scripts/mode/*`
- `scripts/_gen/*`
- `csharp/core/*`
- `csharp/bridge/*`
- `csharp/_gen/*`

## FwGen 结构
- `Program.cs`：命令入口，只分发 `system`、`bridge`、`config`、`craft` 等命令。
- `SystemGen.cs`：从 `schema/systems.toml` 的 `godot.*` 生成 GDScript system graph 和 system 注册。
- `CoreSystemGen.cs`：从 `schema/systems.toml` 的 `core.*` 生成 C# core system 注册表和 phase 常量。
- `BridgeGen.cs`：生成 bridge 的 GD wrapper、C# 合同和 C# 基础 codec。
- `ConfigGen.cs`：生成 C# typed config、配置字段常量和配置包入口。
- `Craft.cs`：生成 `fw new` 项目骨架。
- `ProtoSchema.cs`：解析 proto schema，并提供生成器共享的 proto model。
- `FwConfig.cs` / `CliOptions.cs`：读取 `fw.toml` 和命令行参数。

## FwToml
- `fw.toml` 显式描述项目名、工程路径和构建入口。
- `path.schema`、`path.gdscript`、`path.csharp` 是普通工程入口目录，目录名不能随意漂移。
- `path.systems`、`path.bridge_schema`、`path.config_schema` 和 `path.config_data` 是手写事实源路径。
- `path._gen.config`、`path._gen.gdscript` 和 `path._gen.csharp` 是生成产物路径。
- `_gen` 目录和 `_` 前缀文件都表示机器生成，用户不直接编辑。
- 旧版 `[layout]`、`[build]`、`[schema]` 和 `[gen]` 字段仍作为兼容覆盖项保留。

## System 规范
- GDScript 和 C# system 统一声明在 `schema/systems.toml`。
- GDScript system 使用 `godot.phases` 和 `godot.system.<id>`。
- C# core system 使用 `core.phases` 和 `core.system.<id>`。
- C# system 使用 `Fw.Rt.Systems.SystemRuntime`。
- C# 和 GDScript system 统一使用 `id / phase / context / init / tick / shutdown`。
- system context 只放 `refs / config / state`。
- C# core 可以使用无状态 `rules` 承载可复用规则函数。
- `query`、`solver` 不作为架构后缀；相关计算归入 `rules`。

## Bridge / Config 生成
- `schema/bridge/*.proto` 生成 GD wrapper、C# bridge 合同和 C# 基础 codec。
- `schema/config/*.proto` 生成 C# typed config 和配置字段常量。
- 生成的 C# 合同、注册表和基础 codec 统一放在 `csharp/_gen`。
- 手写语义 codec 放在宿主项目 `csharp/bridge/codec`，不重复定义协议字段、网络包类型和配置类型。
