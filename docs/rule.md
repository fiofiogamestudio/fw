# Fw Rule

## 简介
本文件定义 Godot + C# 游戏工程的长期规则。
规则只描述工程边界和编码范式，不描述具体玩法、临时实现或操作步骤。

## 规则

### 权威
- C# core 是玩法规则权威。
- Godot / GDScript 是表现层。
- 表现层只能消费 core 的 view、event 和配置。
- 表现层不得保存或推导核心规则真值。

### 分层
- App 只负责全局入口和 mode 切换。
- Mode 是 Godot 独有的运行场景入口，只负责场景装配、system 装配和表现层装配。
- System 负责一个稳定阶段的运行逻辑。
- Service 负责框架能力，不属于 system。
- Logic 负责表现层逻辑。
- View 只负责渲染适配，不拥有对象生命周期。
- Form / Widget 是 UI 表现对象，负责 UI 结构、局部表现和交互信号。

### Context
- mode context 和 system context 都使用 `refs / config / state`。
- `refs` 只保存依赖对象引用。
- `config` 只保存启动参数和只读配置。
- `state` 只保存运行期状态。
- system 的 `refs` 只指向其他 system 的 context。
- system 默认只读其他 system context 的 `state`。
- system 如需写入其他 context，只能调用对方 context 暴露的明确数据入口方法，不得直接改写对方 `state` 字段。
- system 不直接持有其他 system 本体。
- system context 不保存 scene、camera、pool、UI、form、view 等表现层对象。

### System
- system 使用 `id / phase / context / init / tick / shutdown`。
- system 顺序由 phase 决定。
- system 声明事实源是 `schema/systems.toml`。
- `schema/systems.toml` 用 `godot.*` 描述 GDScript system。
- `schema/systems.toml` 用 `core.*` 描述 C# core system。
- C# core system 由 `GameCore` 内部的 system runtime 按生成顺序推进。
- 生成的 system setup、system 注册和 bridge/config 合同不得手改。
- 生成目录统一使用 `_gen`，表示用户不应直接修改。
- 生成文件统一使用 `_` 前缀，表示用户不应直接修改。
- 生成的 GDScript 文件统一放在 `scripts/_gen`。
- 生成的 C# 文件统一放在 `csharp/_gen`。
- Godot 和 C# 共享 `system / context / phase / refs / config / state` 主干。
- 共享的是运行范式，不是所有文件后缀。

### C# Core
- C# core 只负责玩法规则和权威状态。
- C# 分为 `bridge / core` 两层。
- `bridge` 是边界层，只负责 Godot 调用、网络、packet、codec 和数据进出。
- `core` 是玩法权威层，只负责 `GameCore` facade、`CoreContext`、有 phase 的 core system、state、rules、config 和 const。
- `core` 是对外 facade，只做启动、tick、查询和边界方法。
- `system` 只负责有 phase 的运行阶段。
- `context` 只保存 `refs / config / state`。
- `rules` 只保存无状态规则函数，不持有字段，不参与 tick。
- `rules` 只能被 core system 或 core facade 调用。
- `state` 保存可变运行期状态。
- `intent` 保存表现层整理后提交给 core 的玩家意图数据，不保存执行结果。
- `event` 保存 core 输出事件。
- `config` 保存只读配置结构。
- `codec` 只负责数据格式和 C# 类型转换；bridge codec 特指 Godot Dictionary 与 C# 类型转换。
- `const` 只保存少量编译期常量，不保存玩法调参。
- `query`、`solver` 不作为架构后缀；需要复用的计算归入 `rules`。

### Bridge
- bridge 是 Godot 和 C# core 的唯一运行时边界。
- GDScript 不直接依赖 C# core 内部类型。
- C# core 不依赖 Godot scene、form、view 或 GDScript system。
- bridge 协议事实源是 `schema/bridge/*.proto`。
- bridge 派生的输入命令、事件和字典字段合同由生成器生成。
- bridge 的生成合同和基础 codec 放在 `csharp/_gen`。
- 联机 wire codec 必须能被 Godot 客户端和纯 C# DS 同时读取；不得依赖 Godot 引擎私有二进制格式作为网络协议。
- 联机 packet 必须校验协议版本；加入战局后的 UDP packet 必须校验会话身份。

### Config
- 配置 schema 事实源是 `schema/config/*.proto`。
- 配置数据事实源是 `data/config/*`。
- 配置打包产物放在 `pack/config/*`，不作为规则事实源，不手工修改。
- Godot config 入口由配置 schema 生成。
- C# typed config、config path 和 config codec 由配置 schema 生成。
- 玩法参数优先配置化。
- 生成配置文件不得作为规则事实源。
- config 的生成合同放在 `csharp/_gen`。

### 表现
- UI 使用 `form + logic + widget`。
- world-space 对象使用 `actor / view / logic / vm`。
- Godot 入口场景放在 `scenes/app`。
- mode 环境场景放在 `scenes/env`。
- 表现资源目录按对象角色拆分为 `prefabs/actor`、`prefabs/form`、`prefabs/widget`、`prefabs/fx`。
- 不使用 `prefabs/ui` 这类混合目录；UI 顶层对象是 `form`，UI 局部对象是 `widget`。
- prefab 根节点脚本必须匹配所在目录角色；例如 `prefabs/actor` 使用 `_actor.gd`，`prefabs/fx` 使用 `_fx.gd`。
- view model 是表现层数据，不是 core 状态。
- `vm_builder` 是纯转换器，只负责把 core/bridge view 转成 Godot VM，可被 system 调用。
- 表现层可以做动画、渐变和缓存，但不得改变 core 结果。
- service 使用领域 API，不使用表现对象生命周期名；例如 FUI 使用 `open / close`，FPool 使用 `spawn / recycle / flush`，FAsset 使用 `load / unload`。
- present object 包括 `actor / form / widget / fx`，对外统一使用 `setup / clear`，内部扩展点统一使用 `on_setup / on_clear`。
- 状态型表现对象使用 `apply(vm, dt)`，包括 `actor / form / widget`。
- 事件型表现对象使用 `play(payload)`，主要用于 `fx`。
- `fx` 必须继承 `FFx` 或遵守同等协议，结束时通过 `finished` signal 通知持有方回收或清理。
- 可交互表现对象使用 `action(name, payload)` 输出交互，不直接调用 core。
- 标准 feature view 使用 `setup(root) / render(root, vm, dt) / clear(root)`，不管理对象生命周期。
- 自包含 visual component 可以使用更窄的 `update_*` API，但只能被上层 object/view 持有，不得读写 system context。
- logic 只编排表现对象，不直接绕过对象协议操作 view。
- `logic` 是表现层逻辑词，不用于 C# core 规则层。
- `view / vm / vm_builder / actor / fx / form / widget` 是表现层角色词，不用于 C# core。
- `ui` 不作为手写文件角色后缀；UI 局部组件统一使用 `widget`。

### 命名
- 文件名使用 `snake_case`。
- GDScript `class_name` 使用 PascalCase。
- C# 类型使用 PascalCase。
- 被 GDScript 按路径加载的 C# 脚本入口例外：类型名必须和 `.cs` 文件名完全一致，这是 Godot C# 运行时约束。
- 私有字段使用 `_camelCase`。
- `fw.toml` 中的普通路径表示工程约定入口，路径名不能随意漂移。
- `fw.toml` 中的 `gen` 表示生成代码根路径，内容不能手改。
- `fw.toml` 中的 `pack` 表示生成数据包路径，内容不能手改。
- 跨 Godot / C# 的共同架构概念：`system`、`context`、`config`、`state`、`event`、`bridge`。
- 应用入口后缀：`app`，用于 Godot 全局入口或纯 C# DS 入口。
- Godot mode 入口后缀：`mode`。
- Godot 表现层后缀：`logic`、`view`、`vm`、`vm_builder`、`actor`、`fx`、`form`、`widget`。
- Godot 工具脚本后缀：`tool`，仅用于 `tools` 下的编辑器或命令行辅助脚本，不参与运行时分层。
- C# core 后缀：`core`、`state`、`system`、`rules`、`intent`、`event`、`config`、`codec`、`const`。
- C# bridge 内部运行层后缀：`runtime`。
- C# DS 兼容层后缀：`compat`，仅用于纯 C# DS 替代 Godot 基础类型或集合 API 的适配层。
- Bridge / 生成后缀：`packet`、`types` 只用于 bridge schema 或 `_gen` 生成产物，手写业务文件不得使用。
- 宿主游戏手写代码文件必须以明确角色后缀结尾；没有明确角色的文件，要么合并到已有角色里，要么先证明它是必要的新角色。
- `fw` 内部基础设施可以使用框架角色词，例如 `root`、`manager`、`refs`、`props`、`binding`、`gen`；这些名字不得扩散到宿主游戏业务代码。
- 领域名可以出现在文件名中，但不得伪装成新的架构角色词。
- 名字应短而明确，避免无意义缩写和冗余后缀。

### 复用
- 具体玩法留在宿主项目。
- 同一 feature 内先局部实现。
- 同一 mode 复用后再上提到 mode shared。
- 跨 mode 复用后再上提到 scripts shared。
- 只有跨游戏复用能力才能进入 `fw`。
