# Fw Spec

## 结构
- `fw/scripts/fw`
  Godot 运行时和 UI / View 子框架。
- `fw/csharp/FwGen`
  框架生成器入口，使用 `dotnet run` 执行。
- `fw/tools`
  跨平台工具包装，统一转发到 C# 生成器或 Godot C# 构建。
- `fw/templates`
  `fw new` 使用的新工程模板。
- `fw/docs`
  框架自身文档。

## 原理
- Godot 运行时仍然由 GDScript 承担，因为它直接服务 scene tree、UI、View、Mode 和 System 生命周期。
- 游戏核心逻辑由宿主项目的 C# 项目承担。
- 框架工具链由 C# 生成器承担。
- `fw/tools/gen.*` 调用 `fw/csharp/FwGen/FwGen.csproj`。
- `fw/tools/build.*` 先执行生成命令，再执行宿主 C# 项目的 `dotnet build`。

## System Context
- `SystemManager` 统一负责 system 的初始化、tick 和 shutdown 顺序。
- system 之间不直接互调，通过 context 暴露数据和接口。
- `refs` 指向目标 system 的 context，不指向 system 本体。
- context 只承载 `refs / config / state`。
- scene、camera、pool、FUI 等表现层对象不进入 system context，由 mode、logic 或 view 显式装配。

## 生成链
- `system`
  从 `schema/system.toml` 生成 `scripts/gen/_graph.gd`。
- `bridge`
  从 `schema/bridge/*.proto` 生成 GDScript action/event/snapshot 包装。
- `config`
  保留或创建 `scripts/gen/_config.gd`。当前游戏的 C# core 直接读取 `data/config`。
- `check-config`
  校验配置 schema 和数据目录存在。
- `pak-config`
  准备配置打包目录。

## 模板
`fw/templates/fw_new/default` 生成的是 C# 版最小项目：
- `fw.toml`
- Godot scene / script 骨架
- `schema/*`
- `<ProjectName>.csproj`
- `csharp/core`
- `csharp/bridge`

模板只生成 C# core / bridge 和 Godot 表现层骨架，不再生成 native bridge 配置。
