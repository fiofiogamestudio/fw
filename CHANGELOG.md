# Changelog

## Unreleased

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
