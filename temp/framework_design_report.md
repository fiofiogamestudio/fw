# Fw 框架整体设计报告

## 范围
这份报告回顾当前 `fw` 子模块作为可复用 Godot + C# 游戏框架的设计。
重点说明结构、运行原理、优点、风险和可能的改进方向。

## 当前结构
- `fw/scripts/fw/rt/system` 提供 GDScript 运行时主干，包括 `AppRoot`、`BaseMode`、`BaseSystem` 和 `SystemManager`。
- `fw/scripts/fw/rt/pool` 通过 `PoolManager` 和 pool node 提供 prefab 池化能力。
- `fw/scripts/fw/vu` 提供 view 工具、refs、props、binding、view root、UI layer、form、widget 和常用 UI 组件。
- `fw/csharp/FwRuntime` 提供 C# `SystemRuntime` 和泛型 `ISystem<TContext>` 合同。
- `fw/csharp/FwGen` 提供 GDScript system、C# core system、bridge types/codec、config contract、config pack 和 `fw new` 的生成能力。
- `fw/tools` 提供面向项目的命令入口，包括 `gen`、`build` 和 `new`。
- `fw/templates/fw_new/default` 是 `fw new` 使用的新游戏工程模板。
- `fw/docs` 是框架侧文档源。
- `fw/hooks/pre-commit` 在提交 `fw` 仓库前，把宿主工程的 docs/skill 同步回模板。

## 运行原则
- `fw` 本身不是具体游戏运行时，而是一套面向 Godot 表现层 + C# 玩法核心的规范性脚手架。
- GDScript 和 C# 共享同一套 system 词汇：`id`、`phase`、`context`、`init`、`tick`、`shutdown`。
- 两边共享的是架构范式，不是完全相同的源文件。
- GDScript systems 由宿主工程的 `schema/systems.toml` 中的 `godot.*` 声明，再生成 `_godot_systems.gd`。
- C# core systems 由宿主工程的 `schema/systems.toml` 中的 `core.*` 声明，再生成 `csharp/_gen/_core_systems.cs`。
- Bridge 和 config 合同由类 proto schema 生成，保证两侧字段名和 packet 常量稳定。
- 跨游戏复用的基础设施放在 `fw`，具体玩法留在宿主工程。

## Runtime Flow
- `AppRoot` 创建 mode host、pool manager、UI root 和 UI runtime，然后调用 `on_app_ready`。
- 宿主游戏继承 `AppRoot`，通过 `switch_mode` 进入具体 mode。
- `BaseMode` 持有 `SystemManager`，并把 mode tick 委托给已注册 systems。
- `SystemManager` 按 id 和 phase 注册 systems，根据生成的 graph 绑定 context refs，按 phase 顺序 init/tick，并在退出时反向 shutdown。
- `FUI` 管理稳定 UI 层级：HUD、screen、popup、modal、toast、tooltip。
- `FViewRoot` 和 `FView` 让非 form 场景根节点也能使用 refs/props，而不必强行把所有场景都做成 form。
- C# `SystemRuntime` 用同样的 phase 生命周期推进 core gameplay。

## 生成链路
- `Program.cs` 分发 `system`、`bridge`、`config`、`config_check`、`config_pack`、`craft` 等命令。
- `FwConfig.cs` 读取 `fw.toml`，它是宿主工程的生成路径地图。
- `SystemGen.cs` 从 `schema/systems.toml` 的 `godot.*` 生成 GDScript system setup、phase 顺序和 refs 绑定入口。
- `CoreSystemGen.cs` 从 `schema/systems.toml` 的 `core.*` 生成 C# core system 注册表和 phase 常量。
- `BridgeGen.cs` 生成 bridge 字段常量、packet helper、GDScript wrapper、C# input decoding 和 C# event encoding。
- `ConfigGen.cs` 生成 typed config contract 和 config 字段常量。
- `Craft.cs` 把 `fw/templates/fw_new/default` 拷贝到宿主工程，并立即运行生成命令。

## 优点
- 框架运行时核心很小，可读性较好。
- GDScript 和 C# 已经共享同一套心智模型，在表现层和 core 之间切换时成本更低。
- 生成的 system setup 可以避免 GDScript 手动绑定 refs 的常见错误。
- 生成的 C# core system 注册表可以避免手写 phase 顺序漂移。
- Bridge 和 config 生成减少了跨语言边界重复定义常量和字段名的问题。
- `fw new` 让框架具备复用到未来游戏的能力，而不是只服务当前工程。
- UI layer 和 form 生命周期集中管理，宿主游戏不需要重复实现基础 screen 管理。
- pre-commit hook 给框架作者提供了一个现实可用的方式，把宿主 docs 和 skill 规则同步进模板。

## 不足和风险
- `BridgeGen.cs` 仍然是最大的生成器文件，所以 bridge 生成是当前 `fw` 内部复杂度热点。
- GDScript 的 `SystemManager` 通过动态属性检查 refs，灵活但错误只能在运行期暴露。
- `FwConfig` 是有意做轻量的，只解析当前需要的 TOML 子集；现在足够，但不是完整 TOML parser。
- 框架目前提供了 runtime 和 generation 约定，但针对生成项目的测试基础设施还不多。
- `FViewRoot` 有价值，但仍然比较年轻，需要继续保持纯 view refs/props 和项目表现逻辑之间的边界。
- pre-commit hook 假设宿主仓库是 `fw` 的父目录，这符合当前工作流，但不是所有 submodule 布局都通用。

## 可能改进方向
- 按输出职责继续拆分 `BridgeGen.cs`，例如 C# types、C# codec、GDScript wrapper 和 packet helpers。
- 增加生成器级测试，使用小型 fixture schema 覆盖 bridge 和 config 输出。
- 增加 `fw check` 命令，用 dry-run 方式检查生成文件是否过期。
- 在 `fw/docs/use.md` 中继续明确 hook 行为，并保持通过 `core.hooksPath` 显式启用。
- 如果未来 C# core graph 也引入 refs，可以考虑增加编译期或生成期校验。
- 增加一个最小模板验证命令：创建临时 `fw new` 工程、构建、然后清理。

## 总体评价
`fw` 当前已经可以作为可复用游戏脚手架使用。它最强的设计点是：用 schema-driven generation 支撑 GDScript 与 C# 共享 system-context 生命周期。后续最需要保护的是边界纪律：框架代码保持通用，具体玩法留在宿主工程，生成文件保持派生产物身份，不要变成新的手写事实源。
