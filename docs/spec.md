# Fw Spec

## 结构
- `fw.toml`：工程路径和工具入口配置。
- `schema/systems.toml`：Godot system 与 C# core system 的统一事实源。
- `schema/bridge/*.proto`：Godot 与 C# 之间的 bridge 合同事实源。
- `schema/config/*.proto`：配置结构事实源。
- `data/config/*`：人工维护的配置源数据。
- `data/map/*`：开发期导出的地图结果，供 C# core 加载为权威地图状态。
- `pack/config/*`：生成的运行时配置包，不手改。
- `map_generation`：地图生成第三方 submodule，只用于开发期/打包期生成地图结果，不作为战局运行时权威。
- `scenes/app`：Godot 应用入口场景，例如 `main.tscn`。
- `scenes/env`：mode 环境场景，例如 `battle_env.tscn`。
- `prefabs/actor`：world-space 长生命周期表现对象资源。
- `prefabs/form`：UI form 资源。
- `prefabs/widget`：UI widget 资源。
- `prefabs/fx`：短生命周期事件表现资源。
- `scripts/_gen`：生成的 GDScript 入口，包括 `_godot_systems.gd`、`_bridge.gd`、`_config.gd`。
- `csharp/_gen`：生成的 C# 入口，包括 `_core_systems.cs`、`_bridge_types.cs`、`_bridge_codec.cs`、`_intent_codec.cs`、`_event_codec.cs`、`_packet_codec.cs`、`_config_contract.cs`、`_config_codec.cs`。
- `csharp/core/game_core.cs`：C# core 对外 facade，bridge 只通过它进入玩法权威层。
- `csharp/core/core_context.cs`：C# core system 共享上下文，使用 `Refs / Config / State`。
- `csharp/core/system`：有 phase 的 core system，由 `schema/systems.toml` 生成注册顺序。
- `csharp/core/state`：C# core 可变权威状态。
- `csharp/core/rules`：无状态领域规则函数。
- `csharp/core/config`：启动配置装配与源数据/pack 数据选择。
- `csharp/core/const`：少量编译期常量。
- `csharp/bridge/game_bridge.cs`：Godot 本地单机可调用 facade，直接持有并推进 `GameCore`。
- `csharp/bridge/net_bridge.cs`：Godot 联机可调用 facade，内部委托给网络 runtime。
- `csharp/bridge/codec`：手写语义 codec，负责复杂结构的合并、拆分和兼容处理。
- `csharp/bridge/codec/wire_codec.cs`：Godot 客户端与纯 C# DS 共享的 UDP wire codec。
- `csharp/bridge/net`：网络 bridge 内部运行层，包括 `net_runtime`、`authority_runtime`、`client_runtime`、`ds_runtime`、`udp_runtime`、`net_context`、`net_config`、`net_state`。
- `ds/ds_app.cs`：纯 C# dedicated server 进程入口，只负责参数、内容检查、主循环和退出。
- `ds/*_compat.cs`：纯 C# DS 对 Godot 基础类型、集合和文件 API 的兼容层。
- `ds/wdc_ds.csproj`：纯 C# dedicated server 工程，不启动 Godot scene；发布时复制 `fw.toml`、`pack/config` 和 `data/map`，保证发布目录可独立作为运行资源根目录。

## System
- `schema/systems.toml` 生成两端 system 注册表。
- `godot.system.<id>` 声明 Godot system 的 phase、script、context 和 refs。
- `core.system.<id>` 声明 C# core system 的 phase 和 type。
- `manual = true` 可用于需要手动装配、不由生成入口自动实例化的 system。
- 当前 Godot 生成入口是 `scripts/_gen/_godot_systems.gd`。
- 当前 C# 生成入口是 `csharp/_gen/_core_systems.cs`。
- Godot 与 C# 共享 `system / context / phase / refs / config / state` 范式。
- Godot system 推进表现层运行阶段。
- C# core system 由 `GameCore` 内部的 `SystemRuntime` 按生成顺序推进玩法权威阶段。
- system 的 `refs` 只指向其他 system 的 context，不直接持有其他 system 本体。

## C# Core
- `bridge` 是 boundary，负责 Godot/C# 边界，不保存玩法权威状态。
- `core` 是玩法权威层，负责 `GameCore` facade、`CoreContext`、core system、state、rules、config 和 const。
- `GameCore` 是 core facade，bridge 只应通过它进入玩法权威层。
- `GameCore` 内部持有 `CoreContext` 与 `SystemRuntime`，负责启动、step、查询和边界方法。
- `CoreContext` 是 core system 共享上下文，结构仍是 `Refs / Config / State`。
- `core/system` 内的 system 可以读写 `CoreContext.State`，复杂计算应拆到 `core/rules`。
- `core/state` 只保存权威数据，不主动 tick。
- `core/rules` 不持有可变字段，不参与 runtime 注册。
- `core/config` 只负责启动配置装配、默认值归一化，以及在编辑器源数据与运行时 pack 数据之间选择。
- `core/const` 只保存少量编译期常量，不保存玩法调参。

## Present
- `FUI` 是 UI service，对外使用 `open / close`。
- `FPool` 是对象池 service，对外使用 `spawn / recycle / flush`。
- `FPool.register_prefab` 是幂等注册；`warmup` 表示该 prefab 至少保留的空闲对象数，重复进入 mode 不应重复累积预热节点。
- 无参数 `FPool.flush()` 用于 mode 切换清理，会释放空闲对象并清空 prefab 注册表，避免跨 mode 持有旧资源。
- `FAsset` 是资源 service，对外使用 `load / unload`。
- `FForm / FWidget / FViewRoot` 提供表现对象协议：`setup / clear / apply / action`，内部钩子统一为 `on_setup / on_clear`。
- `FFx` 提供事件型表现对象协议：`setup / clear / play / finished`。
- `fx` 使用 `play(payload)` 播放一次性事件效果，结束时发出 `finished` signal。
- `view` 脚本使用 `setup / render / clear`，由表现对象内部调用。
- `vm_builder` 是纯转换器，把 bridge/core view 转成 Godot VM，不持有表现对象。
- `logic` 读取 system context 中的 vm/event，并只通过表现对象协议驱动表现。

## Bridge
- bridge 是 Godot 表现层与 C# core 的唯一运行时边界。
- `schema/bridge/*.proto` 是 bridge 合同事实源，但当前不是严格 protobuf 运行时。
- 当前 bridge 用 proto 描述合同，由 `fwgen bridge` 生成 Godot wrapper、C# 类型、字段常量、基础 codec 和 packet codec。
- 当前运行时数据是 Godot `Dictionary` 风格结构；UDP 网络传输使用手写 `wire_codec`，避免依赖 Godot 引擎私有二进制格式。
- `wire_codec` 对小包保持 JSON，便于调试；对较大包自动压缩，降低广域网 UDP 分片概率。
- `Packet` 顶层带 `protocol_version` 和 `session_token`；packet codec 在读取 payload 前校验协议版本，client/server 在 join 后用 session token 过滤非本会话包。
- 如果未来需要跨语言公共协议、长期二进制兼容、protobuf 级别的 `oneof` 约束，再引入严格 protobuf packet 层。
- `game_bridge` 用于本地单机，直接调用 `GameCore` 并返回 view/event/map 数据。
- `net_bridge` 用于联机，内部通过 `NetRuntime` 分发到 `AuthorityRuntime` 或 `ClientRuntime`。
- `ds_runtime` 用于纯 C# dedicated server，只启动 `AuthorityRuntime`，不创建本地玩家。
- 纯 C# DS 默认不信任客户端 profile；客户端可在战局内通过 intent 走 core 规则，只有显式调试参数才允许导入客户端 profile。
- `AuthorityRuntime` 是唯一推进 `GameCore` 的网络权威端运行层；`ClientRuntime` 只发送 intent 并消费 view/event/map。
- `UdpRuntime` 只负责 UDP open/send/receive/close，不保存玩法规则或 view 合并逻辑。
- `ClientRuntime` 在收到 `join_accept` 后会短期重发 profile，降低 UDP 丢包导致服务端使用默认 profile 的概率。
- `ClientRuntime` 只处理目标服务器端点发来的包，并校验 session token。
- `ClientRuntime` 已加入后即使没有输入也会按固定间隔发送空 intent 保活，避免 idle 客户端被 DS 超时踢出。
- `AuthorityRuntime` 对已加入 peer 校验 session token，并使用 `net_max_peers` 限制最大 peer 数。
- `AuthorityRuntime` 对重复 join 响应限频，避免完整地图同步被恶意或异常客户端放大。
- `AuthorityRuntime` 对 map chunk 使用 AOI 全量、dirty revision 和周期刷新三层同步；周期刷新用于补偿 UDP 无 ACK 时的 chunk 丢包。
- `UdpRuntime` 每轮最多处理 `net_max_packets_per_poll` 个 UDP 包，避免异常流量拖死 tick。
- `UdpRuntime` 将坏 wire payload、解压失败和 socket 异常按丢包处理，不让单个 UDP 异常中断 DS tick。
- `UdpRuntime` 会对超过安全 UDP payload 的包输出一次性警告；生产环境仍应继续做拆包、压缩或 ACK。

## Bridge Proto
- `value.proto`：公共词典，只放跨 core/intent/view/event/packet 复用的基础类型和枚举；生成的值域常量可被 C# core 使用。
- `intent.proto`：玩家意图，只放表现层提交给 core 的输入、按钮和一次性操作。
- `view.proto`：core 输出给表现层的可见状态投影，只放允许当前客户端知道的数据。
- `event.proto`：core 输出的一次性事件，用于动画、音效、提示和短生命周期反馈。
- `packet.proto`：网络信封，只描述包类型和 payload 承载关系，不承载玩法规则。

## Bridge 约束
- intent 表达“想做什么”，不表达“是否成功”。
- view 表达“能看到什么”，不是 core 内部完整状态。
- event 表达“刚发生什么”，不保存长期状态。
- 生成的 `Event.Bus` 支持同一事件多个监听者，避免多个表现 logic 互相覆盖 callback。
- value 不放配置数值、不放玩法流程、不放 UI 状态。
- core 只能使用 value 生成的值域常量，不使用 bridge field、packet codec 或 Godot Dictionary view 结构。
- packet 不放散乱业务字段；新增网络语义时优先新增明确 payload。
- `PlayerIntent.player_id` 在网络 host 侧必须由连接身份绑定，不信任客户端自报。
- `PlayerButton` 的枚举值作为 bit mask 使用，对应 `buttons_hold/down/up`。
- 高精度视野优先使用 row spans 传输，避免同时传重复的大体积 cell 列表。
- 背包 view 以 `inventory_containers` 为权威结构，不再并行维护旧的扁平 inventory 摘要。

## Packet Payload
- `Packet` 是信封，顶层只保留 `type` 和对应 payload。
- `Packet` 在 schema 中使用 `oneof payload` 表达“一包一种语义”，运行时由 `PacketCodec` 按 `type` 校验对应 payload。
- 运行时代码通过生成的 `PacketCodec` 组包和拆包，不手写 packet payload 字典结构。
- `join`：客户端请求加入，当前 payload 为空。
- `intent.player_intent`：客户端提交给 host 的玩家意图。
- `join_accept.player_id / session_token`：host 分配给客户端的玩家 id 和 UDP 会话 token。
- `map_info.info`：地图基础信息。
- `map_chunks.chunks`：地图 chunk 批量 payload。
- `map_chunk.chunk`：地图单个 chunk payload。
- `sync_frame.view / sync_frame.events`：host 推送给客户端的一帧可见状态和事件。
- `high_view.view / high_view.events`：高频状态包，承载位置、实体、当前可见范围和一次性事件。
- `mid_view.view`：中频状态包，承载背包、交互提示、loot 会话、已探索 fog 等私有低频数据。
- 表现层仍读取合并后的 `WorldView`；网络层可按 channel 频率拆包，客户端由 `ViewCodec` 合并。
- 新增网络包时先新增明确 payload message，不把字段直接散放到 `Packet` 顶层。

## Config
- 配置 schema 事实源是 `schema/config/*.proto`。
- 配置数据事实源是 `data/config/*`。
- 配置打包产物是 `pack/config/*`，不作为规则事实源，不手改。
- C# typed config 由配置 schema 生成。
- C# config codec 由配置 schema 生成，负责配置源数据到 typed config 的字段映射。
- Godot 和 C# config 入口由配置 schema 生成。
- 生成的 C# `ConfigPath` 提供 `AllSourcePaths / AllPackPaths`，DS 和发布校验使用它完整检查配置内容。
- 编辑器下读取 `data/config` 源数据，运行/导出读取 `pack/config` 打包数据。
- 同名配置优先读取 `.json`，否则读取 `.csv.txt`。
- `Fixed32` 使用整数包格式，当前缩放比例为 `256`。
- 玩法参数优先配置化。
- `net_view_rate` 控制高频 view 每秒同步次数。
- `net_mid_view_rate` 控制中频私有 view 每秒同步次数，设为 `0` 可关闭周期同步。
- `net_max_peers` 控制单个 host/DS 最多接受的远端 peer 数。
- `net_max_packets_per_poll` 控制每轮网络 poll 最多处理的 UDP 包数。
- `net_client_timeout_ms` 控制 authority 判定远端 peer 超时的毫秒数。
- `net_client_keepalive_ms` 控制 client 无输入时发送空 intent 保活的间隔。
- `net_join_payload_retry_ms` 控制 authority 对重复 join 回完整入场 payload 的最小间隔。

## 生成
- `_gen` 目录和 `_` 前缀文件都是生成产物，不手改。
- 所有 proto schema 的 message / enum 名必须全局唯一；`fwgen` 遇到重复名直接失败，避免静默覆盖合同。
- 修改 `schema/systems.toml` 后运行 `fwgen system`。
- 修改 `schema/bridge/*.proto` 后运行 `fwgen bridge`。
- 修改 `schema/config/*.proto` 或 `data/config/*` 后运行对应 config 命令。
- 修改 `fw/` 框架或模板后，同步 `fw/docs` 与 `fw/templates/fw_new/default`。
