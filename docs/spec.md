# Fw Spec

## 结构
- `fw/`：可复用框架仓库，只保存运行时、生成器、模板、工具和通用文档。
- `fw.toml`：宿主工程路径与 .NET 工程入口，只接受固定 section/key，所有路径必须位于工程根目录内。
- `schema/systems.toml`：Godot system 与 C# core system 的统一事实源。
- `schema/bridge/*.proto`：intent、view、event、packet 和公共值类型事实源。
- `schema/config/*.proto`：配置结构事实源。
- `data/config/*`：人工维护的配置源数据。
- `pack/config/*`：生成的运行时配置包，不手改。
- `scripts/_gen`、`csharp/_gen`：生成代码，不手改。
- `Directory.Build.props`：宿主与 DS 的 target framework 事实源；当前以 Godot 4.6 使用的 `net8.0` 为兼容基线，并允许工具在仅安装较新运行时时按 `Major` 向前运行。
- `global.json`：固定构建用 .NET SDK 和 `Godot.NET.Sdk`；游戏项目中 Godot 写回的 SDK/target 必须与两项配置一致。
- `scenes/app`、`scenes/env`：应用入口和 mode 环境场景。
- `prefabs/actor`、`prefabs/form`、`prefabs/widget`、`prefabs/fx`：按表现对象角色组织的资源。

## Compatibility
- Godot：`4.6.2 .NET`，由模板、`global.json` 与 CI 共同固定。
- 构建 SDK：`.NET SDK 10.0.201`；只负责还原和编译，不改变游戏程序集的 API 基线。
- Target framework：`net8.0`；游戏、DS 与 `FwRuntime` 保持一致，命令行工具在缺少 8 运行时时允许 `Major` 向前运行。
- 自动验证平台：Windows 与 Linux；macOS 在成为发布目标前再加入 CI。
- Git tag 提供人类可读的 SemVer 版本，宿主 submodule commit 提供实际的精确版本锁定；二者职责不同。
- 公共兼容边界覆盖 Godot runtime、`FwRuntime`、配置入口、生成命令、schema 子集和生成合同。内部生成器类型与实现文件不属于宿主 API。
- `_fwgen_manifest.json` 负责发现生成器、输入或产物漂移，但不代替版本号；宿主升级必须同时审阅 submodule 指针与生成差异。

## Runtime
- Godot 运行链是 `AppRoot -> BaseMode -> SystemManager`。
- `AppRoot` 创建 mode host、`FUI`、`FPool`、`FAsset`，并负责 mode 切换。
- `BaseMode` 负责场景、Godot system 和 presentation 装配。
- `SystemManager` 按 phase 缓存后的顺序执行 `init / tick / shutdown`，shutdown 使用反向顺序。
- C# `SystemRuntime` 使用同样的生命周期和 phase 语义，由 `GameCore` 持有。
- 两端 runtime 都显式区分 created、initializing、running、faulted、stopping、stopped；失败初始化会把失败项本身也纳入逆序回滚。
- `AppRoot` 的 mode 切换先清理旧 mode/UI/pool；新 mode enter 失败时再次清理半成品，离开 SceneTree 时执行最终 shutdown。

## System
- `fwgen system` 只解析一次 `schema/systems.toml`，形成共享 `SystemSchema`，再分别生成 Godot 与 C# 注册入口。
- Godot system 使用独立 context；生成器创建 system/context，并把 `refs` 绑定到目标 system context。
- C# core system 当前共享聚合 `CoreContext`，结构仍是 `Refs / Config / State`。
- 两端统一的是生命周期、phase 和 context 三分法，不要求 context 实例粒度完全相同。
- 当聚合 `CoreContext` 变大时，可拆成 typed context slice；system 只接收需要的 Config/State/Refs。
- schema 会校验重复 system、重复 phase、未知 phase、缺失脚本/context/type、无效 refs，以及映射到同一 C#/GDScript 标识符的 system/phase 名。

## Core
- C# core 是玩法权威；Godot 只消费 view、event 和配置。
- `GameCore` 是 bridge 调用的唯一 core facade。
- `core/system` 保存有 phase 的权威运行阶段。
- `core/state` 保存可变权威状态。
- `core/rules` 保存无状态领域计算。
- `core/config` 负责只读配置装配。
- `core/const` 只保存少量编译期常量。
- bridge 不保存玩法真值，不把 Godot scene 或 UI 类型传入 core。

## Present
- `FUI` 使用 `open / close` 管理 form 与 UI layer。
- `FUI.open` 先实例化并 setup 新 form，成功后才关闭同 id/同层旧 form；screen stack 只在提交后隐藏前一项。
- `FForms.setup` 与 `FFormLogic.attach_ui/detach_ui` 具有幂等清理语义；form 被外部释放时，`FUI.close` 仍会移除 id 并恢复上一层 screen。
- `FPool` 使用 `register_prefab / spawn / recycle / flush` 管理 actor 和 fx。
- `spawn(key, parent, owner, props)` 把生命周期 owner 和 props 显式传给对象；Pool 同时追踪 active/free 对象。
- `FAsset` 使用 `load / unload` 缓存资源；加载失败会输出明确错误且不缓存空值。
- `actor / form / widget / fx` 对外统一使用 `setup / clear`，内部扩展点为 `on_setup / on_clear`。
- `actor / form / widget` 使用 `apply(vm, dt)`；`fx` 使用 `play(payload)`，完成后发出 `finished`。
- `view` 使用 `setup(root) / render(root, vm, dt) / clear(root)`，只做渲染适配，不管理对象生命周期。
- `FViewStore` 只为 `FViewRoot/FWidget` 保存 refs、props、binding、节点缓存和当前 VM；它不是 feature view。
- logic 读取 context 中的 VM/event，通过 context 数据入口或 intent 提交操作，不持有 system 本体。

## Bridge
- bridge 是 Godot 与 C# core 的唯一运行时边界。
- proto 是合同 DSL，当前不是严格 protobuf wire runtime。
- bridge 只接受固定五文件；parser 先收集完整文件集，再验证 import、共享 package 和类型引用。import 禁止父目录穿越、大小写漂移与歧义匹配。
- 支持的 proto3 子集：`syntax`、`package`、`import`、`message`、`enum`、普通字段、`repeated`、`oneof`。
- bridge 字段支持 `string / bool / float / double / int32 / int64 / uint32 / uint64 / sint32 / sint64`、同 schema message 和 enum；其他 protobuf 标量在生成前失败。
- `optional`、`map`、`service`、`option`、`reserved` 等未声明语法会直接报错。
- parser 会拒绝未知类型、重复 message/enum、重复 field 名/编号、重复 enum 名/编号、非法 tag、proto3 enum 首项非零和未闭合 block。
- schema 会按实际 C#/GDScript 命名规则检查生成的字段、成员、类型和 wrapper；不同声明映射到同一标识符时，在写文件前失败。
- `fwgen bridge` 生成 Godot 统一入口、C# bridge 类型、基础 codec、intent/event/packet codec。
- bridge schema 在一次 parse 后派生全部产物；同名 oneof payload 字段只有兼容类型才能合并，否则生成失败。
- 生成 DTO 保留 proto3 零值：整数为 0、bool 为 false、string/enum unspecified 为 `""`。
- intent 表达“想做什么”，view 表达“允许看到什么”，event 表达“一次发生了什么”，packet 只做信封。
- `Fw.Rt.Bridge.WireFrame` 是纯 C# 传输帧：`FWIR + version + flags + decoded length + payload length + SHA-256 + payload`；Brotli 只在确实缩小时启用，长度校验避免整数溢出。SHA-256 只提供损坏检测，不代替认证或加密。

## Config
- `fwgen config` 从 config schema 生成 Godot config 入口、C# typed config、路径常量和 codec。
- config 字段支持 bridge 的基础标量、空 `Fixed32` marker 和同 schema message；enum、`bytes`、`fixed*`、`sfixed*` 当前不进入生成阶段。
- schema 会检查生成的 C# 字段、类型、配置路径和 GDScript parser 名；保留名或名称归一化冲突在写文件前失败。
- `config_check` 检查 schema 与 `data/config` 的字段一致性。
- `config_pack` 把源配置打包到 `pack/config`。
- config pack 使用 76-byte `WCFG` header，校验版本、schema SHA-256、payload length 和 payload SHA-256；纯 C# `Fw.Rt.Config.ConfigPack` 是格式实现，生成器负责调用它，生成 codec 只负责文件读取与 typed 映射。
- 空 `message Fixed32 {}` 是 signed Q24.8 marker；pack 时乘 256 并检查 int32 范围，读取时除 256。
- 生成清单只把 config schema 与数据文件布局视为结构输入，普通数据值变化不会要求重生成代码。
- 默认模板自带最小 `data/config/game.csv.txt`，生成后可立即通过 check/build。
- 默认模板是最小但完整的 `Godot intent -> C# GameSystem -> view/event -> Godot VM` 计数器闭环，不默认塞入网络、DS 或具体世界玩法。

## 生成
- `BridgeGen`、`ConfigGen` 只编排流程；`BridgeSchema`、`ConfigSchema` 解析语义模型，`BridgeGd / BridgeTypes / BridgeCodec` 与 `ConfigGd / ConfigCs / ConfigData` 单向消费模型。各阶段是独立类型，不共享 partial 私有状态，也不形成新命令或新合同。
- 所有输出使用确定性排序；重复生成内容保持一致。
- 单个文件先写同目录临时文件，再原子替换目标，避免留下半写文件。
- `csharp/_gen/_fwgen_manifest.json` 记录生成器、输入和完整输出集合的 hash；`fw check` 拒绝缺失、过期、集合异常或被手改的生成产物。
- `fw check` 同时检查路径、目录、角色后缀、禁止引用以及 system/bridge/config schema。
- `new` 在返回成功前自动完成生成、`config_check` 和 `fw check`。

## 测试
- `FwGenTests` 按 `proto / system / bridge / config / runtime / api` 分组，覆盖合法/非法 proto、import/package/oneof、proto 零值、生成标识符冲突、system phase/回滚/fault 清理、生成锁、生成清单、config pack 和 wire frame，包括 import 穿越/歧义、数字溢出、格式头、版本、校验和、长度边界、逐字节变异和 C# 公共 API 合同。
- `tools/test.ps1`、`tools/test.sh` 会构建 runtime/generator，运行生成器测试，并在全新临时目录验证 `new -> check -> config_pack -> build`。
- 测试会比较规范源与模板镜像，并验证重复生成、重复打包的内容完全一致。
- 本地存在 Godot .NET 时继续执行 headless editor 扫描、编辑器改写后的二次 check/build、runtime 故障注入和主场景启动；可用 `GODOT_BIN` 显式指定可执行文件。
- `.github/workflows/ci.yml` 使用只读仓库权限，在 Windows 与 Linux 安装固定 Godot .NET，并执行同一完整测试链；同一引用的新任务会取消旧任务，单个 job 最长运行 30 分钟。
- `fw/csharp/Directory.Build.props` 统一 FwGen、FwRuntime 与测试工程的 target framework，并把 C# 警告视为错误；默认模板对宿主使用同一规则。
- `fw/tests/runtime_test.gd` 覆盖 Godot 公共 API 合同、binding 所有权、pool 状态互斥、ViewStore 缓存、UI wrapper/form logic、失效 UI stack、GDScript system 与 mode 回滚；普通 Godot `ERROR` 默认会让测试失败，仅显式故障注入可放行。

## 治理
- `fw/docs` 与 `fw/.codex/skills/fw/SKILL.md` 是框架规范源。
- 模板中的 skill/docs 是派生产物。
- `hooks/pre-commit` 只做 `fw -> template` 同步；若更新派生文件会中止提交，要求审阅并重新暂存。
- hook 不读取父工程、不自动 `git add`，`new/gen/build` 也不修改 Git 配置。
