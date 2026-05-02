# Fw Rule

## 简介
本文件定义 Godot + C# 游戏工程的长期规则。
规则只描述工程边界和编码范式，不描述具体玩法、临时实现或操作步骤。

## 规则

### 权威
- C# core 是玩法规则权威。
- Godot / GDScript 是表现层。
- 表现层只能消费 core 的 snapshot、event 和配置。
- 表现层不得保存或推导核心规则真值。

### 分层
- App 只负责全局入口和 mode 切换。
- Mode 只负责场景装配、system 装配和表现层装配。
- System 负责一个稳定阶段的运行逻辑。
- Logic 负责表现层逻辑。
- View 只负责表现。
- Form / Widget 只负责 UI 结构和 UI 局部表现。

### Context
- mode context 和 system context 都使用 `refs / config / state`。
- `refs` 只保存依赖对象引用。
- `config` 只保存启动参数和只读配置。
- `state` 只保存运行期状态。
- system 的 `refs` 只指向其他 system 的 context。
- system 不直接持有其他 system 本体。
- system context 不保存 scene、camera、pool、UI、form、view 等表现层对象。

### System
- system 使用 `id / phase / context / init / tick / shutdown`。
- system 顺序由 phase 决定。
- GDScript system graph 事实源是 `schema/system.toml`。
- C# core system 注册事实源是 `schema/core_system.toml`。
- C# core system 通过 `CoreRuntime` 推进。
- 生成的 system graph 和 system 注册文件不得手改。
- Godot 和 C# 共享 `system / context / phase / refs / config / state` 主干。
- 共享的是运行范式，不是所有文件后缀。

### C# Core
- C# core 只负责玩法规则和权威状态。
- `core` 是对外 facade，只做启动、tick、查询和边界方法。
- `runtime` 只负责注册和推进 core system。
- `system` 只负责有 phase 的运行阶段。
- `context` 只保存 `refs / config / state`。
- `rules` 只保存无状态规则函数，不持有字段，不参与 tick。
- `rules` 只能被 core system 或 core facade 调用。
- `state` 保存可变运行期状态。
- `command` 保存 bridge 输入后的 core 命令。
- `event` 保存 core 输出事件。
- `config` 保存只读配置结构。
- `loader` 只负责启动期加载事实数据。
- `codec` 只负责 Godot 数据和 C# 类型转换。
- `const` 只保存少量编译期常量，不保存玩法调参。
- `query`、`solver` 不作为架构后缀；需要复用的计算归入 `rules`。

### Bridge
- bridge 是 Godot 和 C# core 的唯一运行时边界。
- GDScript 不直接依赖 C# core 内部类型。
- C# core 不依赖 Godot scene、form、view 或 GDScript system。
- bridge 协议事实源是 `schema/bridge/*.proto`。
- bridge 派生的输入命令、事件和字典字段合同由生成器生成。

### Config
- 配置 schema 事实源是 `schema/config/*.proto`。
- 配置数据事实源是 `data/config/*`。
- C# typed config 由配置 schema 生成。
- 玩法参数优先配置化。
- 生成配置文件不得作为规则事实源。

### 表现
- UI 使用 `form + logic`。
- world-space 对象使用 `actor / view / logic / vm`。
- view model 是表现层数据，不是 core 状态。
- 表现层可以做动画、渐变和缓存，但不得改变 core 结果。
- `logic` 是表现层逻辑词，不用于 C# core 规则层。
- `view / vm / actor / fx / form / widget / ui` 是表现层角色词，不用于 C# core。

### 命名
- 文件名使用 `snake_case`。
- GDScript `class_name` 使用 PascalCase。
- C# 类型使用 PascalCase。
- 私有字段使用 `_camelCase`。
- 共同角色后缀：`system`、`context`、`runtime`、`config`、`event`、`bridge`。
- Godot 表现层后缀：`mode`、`logic`、`view`、`vm`、`actor`、`fx`、`form`、`widget`、`ui`。
- C# core 后缀：`core`、`state`、`command`、`rules`、`codec`、`loader`、`const`。
- 领域名可以出现在文件名中，但不得伪装成新的架构角色词。
- 名字应短而明确，避免无意义缩写和冗余后缀。

### 复用
- 具体玩法留在宿主项目。
- 同一 feature 内先局部实现。
- 同一 mode 复用后再上提到 mode shared。
- 跨 mode 复用后再上提到 scripts shared。
- 只有跨游戏复用能力才能进入 `fw`。
