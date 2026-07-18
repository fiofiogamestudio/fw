# Changelog

## Unreleased

- System、Bridge 与 Config schema 共用生成标识符冲突校验，并在写出产物前拒绝 C#/GDScript 名称归一化、保留名和后缀折叠冲突。

## 0.1.2 - 2026-07-18

- schema 在写文件前校验目标端支持类型与生成标识符冲突，避免产出无法编译或无法双端还原的代码。
- 生成锁与路径归属判断遵循平台大小写语义，bridge 入口严格限制为单一 Godot.Node 类型。
- 框架和默认项目把 C# 警告视为错误；CI 增加最小权限、并发取消、超时边界，并使用 Node.js 24 版 checkout action。

## 0.1.1 - 2026-07-18

- 测试工程改用独立的框架源码夹具，避免符号链接路径身份导致 MSBuild reference assembly 竞态。
- Godot .NET 测试统一识别 `GODOT_BIN`、`GODOT` 与 `GODOT4`，并使用无窗口原生进程启动，兼容 Windows CI 的非交互会话。

## 0.1.0 - 2026-07-18

- System runtime 增加显式生命周期、初始化回滚和幂等 shutdown。
- Pool、binding、view store、UI wrapper/form logic、UI stack 和 mode 切换补齐失效对象与失败回滚处理。
- Bridge parser 增加 import/package/oneof 校验，拒绝 import 穿越与歧义；生成器统一 proto3 零值并只解析一次 schema。
- Bridge/Config 生成器按编排、schema、Godot 渲染、C# types/codec 与 config pack 拆分内部实现，生成命令和产物保持兼容。
- 新增纯 C# `WireFrame`，统一版本、长度、压缩上限和 checksum，并加固长度溢出边界。
- Config pack 增加 schema hash、payload checksum、缓存与原子写入；格式编解码收束到纯 C# `FwRuntime.ConfigPack`，并明确 `Fixed32` Q24.8 约定。
- 默认模板改为可运行的 Godot/C# 双向最小闭环，并固定 .NET/Godot 工具链。
- CI 在 Windows/Linux 运行 FwGen、模板、Godot runtime 和主场景测试。
- 补齐 WireFrame、ConfigPack、SystemRuntime 与 proto 数字溢出的边界测试；空白配置 key 和超范围 proto 数字现在会明确失败。
- 明确 SemVer tag、submodule commit、公共 API 与宿主生成产物的兼容升级边界。
- 增加 C# 与 Godot 公共 API 合同测试，并以逐字节确定性变异验证 WireFrame 和 ConfigPack 的损坏拒绝能力。
- Godot .NET 测试探测现在会解析 WinGet/Unix 符号链接并统一校验显式 `GODOT_BIN`，避免 Mono 已安装却被静默跳过。
