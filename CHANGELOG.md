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
