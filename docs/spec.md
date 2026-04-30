# Fw Spec

## 简介

当前仓库已经把通用框架收敛到根目录 `fw/`，并按独立仓库 / submodule 方式接入。

当前分工是：

- `fw/`
  - 框架本体
- `fw.toml`
  - 当前游戏对框架的接入配置
- `fw/docs/*`
  - 框架自身维护文档

## 当前事实

- `fw/` 当前保留入口 README 和框架维护文档：
  - `fw/README.md`
  - `fw/docs/rule.md`
  - `fw/docs/spec.md`
  - `fw/docs/use.md`
- 框架代码位于：
  - `fw/scripts/fw`
  - `fw/rust/crates/fw`
  - `fw/rust/crates/fw_gen`
  - `fw/tools`
  - `fw/templates`
- `fw/rust/crates/fw/src/sync` 当前已经提供最小统一同步骨架：
  - `SyncScope`
  - `AoiGrid`
  - `PeerSyncState`
  - `PeerValueState`
  - `build_key_delta`
  - `build_value_delta`
- 主仓库游戏代码位于：
  - `scripts/app`
  - `scripts/mode`
  - `scripts/shared`（按需创建）
  - `schema/*`
  - `rust/crates/core`
  - `rust/crates/bridge`

## 当前接入方式

- Godot 项目层通过稳定的 `res://fw/...` 路径依赖框架
- Rust 游戏 crate 通过 path dependency 依赖 `fw/rust/crates/fw`
- 生成和构建通过：
  - `fw/tools/gen.*`
  - `fw/tools/build.*`
  - `fw/rust/crates/fw_gen`

## 当前契约

当前仓库已经按这套契约接入 `fw/`：

1. Godot 负责 presentation，Rust 负责 gameplay
2. Godot 运行时走 `AppRoot -> BaseMode -> SystemManager`
   - `AppRoot` 通过 `_input(event)` 直接把输入转给当前 mode
3. Rust gameplay 统一走 `system-context`
4. 跨端边界只走 `action / snapshot / event`
5. 主 UI 统一走 `xxx_form.tscn + FForm + xxx_logic.gd`
   - 表现层主目录当前固定为 `fw/scripts/fw/vu`
   - `FUI` 负责顶层 UI layer / stack
   - `FWidget` 负责 form 内可复用子部件
   - `FView` 负责 refs / props / binding / view model 的共享表现内核
   - `FViewRoot` 负责让 `Node3D` 场景根节点复用 `FView`
   - `FRefs` 负责节点引用
   - `FProps` 负责 form / widget 参数
   - `Refs / Props` 在 Inspector 里当前直接使用 `Dictionary[String, ...]`，运行时统一归一化成查找表
   - `FBinding` 负责 signal / view model 绑定生命周期
   - `FViewModel` 负责 UI 状态
   - 业务层直接使用 Godot 原生 `Label / Button / LineEdit / TextureRect / PanelContainer`
   - `FList` 当前优先使用直接挂在 list 子节点下的 template item 复制实例；`item_scene` 只保留兼容后备
   - template 在编辑器里保持可见，方便直接调样式；运行时由 `FList` 自动隐藏 template 并复制它来生成真实列表项
6. system 只保留 `refs / config / state`
7. scene / camera / pool / FUI 这类表现层依赖不进入 system context，由 mode、logic 和具体 view 显式装配

## System Context 契约

- `SystemManager` 统一负责 system 的初始化、tick 和 shutdown 顺序。
- system 之间不直接互相调用，跨 system 数据交换通过 context 完成。
- `refs` 指向目标 system 的 context，不指向 system 本体。
- context 只承载：
  - `refs`
  - `config`
  - `state`
- system 是执行者，context 是数据和接口容器。
- GDScript 侧使用长期 context 对象模拟 Rust 侧每次 `run` 临时构造的 `Refs / Context`。
- presentation 可以读取对应 context 的状态，但不应直接改 gameplay 真值。
- UI form 的打开 / 关闭属于 presentation 行为，不进入 Rust core。
- 改变 gameplay 的用户意图统一通过 `action` 进入输入链路，再由 bridge 送进 Rust core。

## 当前模板事实

`fw new` 当前是独立 craft：

- 命令：`craft fw-new`
- 入口：
  - `fw/tools/new.ps1`
  - `fw/tools/new.sh`
- 默认模板：
  - `fw/templates/fw_new/default`

当前默认模板已经按和主工程一致的规则生成：

- system 不再依赖 `args`
- mode、logic 和 view 显式接触 `FUI`
- UI 统一走 `FUI + FForm/FWidget + FRefs/FProps/FBinding/FViewModel`
- 3D prefab / scene root 统一走 `FViewRoot + FView`

## 当前边界

属于 `fw/`：

- Godot 通用运行时
- Godot UI 子框架
- Rust 通用运行时、数学和流程能力
- 生成器、工具脚本、模板

不属于 `fw/`：

- 当前游戏的 `scripts/app`
- 当前游戏的 `scripts/mode`
- 当前游戏的 `scripts/shared`
- 当前游戏的 `schema/*`
- 当前游戏的 `rust/crates/core`
- 当前游戏的 `rust/crates/bridge`
